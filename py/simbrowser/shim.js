// Injected into every playable before its own scripts run (Playwright addInitScript). Generic: nothing in here
// knows about any particular game. It gives the agent five things:
//
//   1. A virtual clock. requestAnimationFrame, timers, performance.now, Date, event.timeStamp, Web Animations /
//      CSS animations and AudioContext.currentTime all read __sim.now, which only moves when the worker calls
//      __sim.step(). The game is frozen while the model thinks, and every captured frame is exactly 1/30 s of game
//      time apart however slow the machine renders (3D under SwiftShader runs at 2-5 real fps).
//   2. Reproducibility: Math.random is a seeded PRNG.
//   3. A sandbox: ad SDK stubs (mraid, dapi, ExitApi, FbPlayableAd), a WebSocket that never connects, window.open
//      blocked. CTA calls are logged as events: they tell the agent that the playable reached its install button.
//   4. The game's audio, in game time. Web Audio is rendered by the browser's own engine: the game's AudioContext is
//      an OfflineAudioContext on the virtual clock, rendered once when the session closes (envelopes, filters,
//      compressors, pitch sweeps: exactly what a player hears). <audio> elements are logged (play/pause/volume,
//      virtual time) and mixed by the worker.
//   5. Introspection: which input events the game listens to, and (for DOM games) which elements are interactive.
(() => {
	if (window.__sim) return;
	const CFG = Object.assign({ seed: 1, fps: 30, frozen: true, audio: "render", audioMaxS: 300, audioRate: 0 }, window.__SIM_CFG || {});
	// "render": Web Audio rendered offline by the browser (needs the virtual clock). "log": the old event log, mixed
	// approximately by the worker (gain read at start, no envelopes or effects).
	const VIRTUAL_AUDIO = CFG.frozen && CFG.audio !== "log" && !!(window.OfflineAudioContext && window.AudioContext && window.AudioNode && window.AudioParam);
	const realSetTimeout = window.setTimeout.bind(window);
	const realPerfNow = performance.now.bind(performance);
	const RealDate = Date;
	const T0 = RealDate.now();
	const S = (window.__sim = {
		cfg: CFG,
		now: 0, // virtual ms since page start
		frame: 0,
		dt: 1000 / CFG.fps,
		raf: new Map(),
		timers: new Map(),
		nextId: 1,
		errors: [],
		events: [], // {t, kind, ...} — CTA, navigation attempts, game-reported events
		audio: { ctxs: [], buffers: [], log: [], media: [] },
		listeners: {},
	});
	const vnow = () => S.now;

	// ------------------------------------------------------------------ 2. seeded randomness (sfc32)
	{
		let a = 0x9e3779b9 ^ CFG.seed, b = 0x243f6a88 ^ (CFG.seed * 7), c = 0xb7e15162, d = 1;
		const next = () => {
			a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
			let t = (a + b) | 0;
			a = b ^ (b >>> 9);
			b = (c + (c << 3)) | 0;
			c = (c << 21) | (c >>> 11);
			d = (d + 1) | 0;
			t = (t + d) | 0;
			c = (c + t) | 0;
			return (t >>> 0) / 4294967296;
		};
		for (let i = 0; i < 16; i++) next();
		Math.random = next;
	}

	// ------------------------------------------------------------------ 3. sandbox: ad SDKs, sockets, popups
	const logEvent = (kind, data) => S.events.push({ t: S.now, frame: S.frame, kind, ...(data || {}) });
	{
		const mraidL = {};
		const fire = (ev, ...args) => (mraidL[ev] || []).slice().forEach((f) => { try { f(...args); } catch (e) {} });
		window.mraid = {
			getVersion: () => "3.0",
			getState: () => "default",
			getPlacementType: () => "interstitial",
			isViewable: () => true,
			addEventListener: (ev, f) => { (mraidL[ev] = mraidL[ev] || []).push(f); if (ev === "ready") realSetTimeout(() => f(), 0); if (ev === "viewableChange") realSetTimeout(() => f(true), 0); },
			removeEventListener: (ev, f) => { mraidL[ev] = (mraidL[ev] || []).filter((x) => x !== f); },
			open: (url) => logEvent("cta", { via: "mraid.open", url: String(url || "") }),
			close: () => logEvent("close", { via: "mraid.close" }),
			expand: () => {}, resize: () => {}, useCustomClose: () => {}, setOrientationProperties: () => {},
			getMaxSize: () => ({ width: innerWidth, height: innerHeight }),
			getScreenSize: () => ({ width: innerWidth, height: innerHeight }),
			getCurrentPosition: () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }),
			getDefaultPosition: () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }),
			supports: () => false,
			getAudioVolume: () => 100,
			_fire: fire,
		};
		const dapiL = {};
		window.dapi = {
			isReady: () => true,
			isViewable: () => true,
			addEventListener: (ev, f) => { (dapiL[ev] = dapiL[ev] || []).push(f); if (ev === "ready") realSetTimeout(() => f(), 0); if (ev === "viewabilityChange") realSetTimeout(() => f({ isViewable: true }), 0); },
			removeEventListener: () => {},
			getScreenSize: () => ({ width: innerWidth, height: innerHeight }),
			getAudioVolume: () => 1,
			openStoreUrl: () => logEvent("cta", { via: "dapi.openStoreUrl" }),
		};
		window.ExitApi = { exit: () => logEvent("cta", { via: "ExitApi.exit" }) };
		window.FbPlayableAd = { onCTAClick: () => logEvent("cta", { via: "FbPlayableAd.onCTAClick" }) };
		window.open = (url) => { logEvent("cta", { via: "window.open", url: String(url || "") }); return null; };
		class FakeSocket {
			constructor(url) {
				this.url = String(url); this.readyState = 0; this.onopen = this.onclose = this.onerror = this.onmessage = null; this._l = {};
				logEvent("network", { via: "WebSocket", url: this.url.slice(0, 120) });
				realSetTimeout(() => { this.readyState = 3; this._emit("error", {}); this._emit("close", { code: 1006, reason: "offline", wasClean: false }); }, 30);
			}
			_emit(t, e) { try { this["on" + t] && this["on" + t](e); } catch (_) {} (this._l[t] || []).forEach((f) => { try { f(e); } catch (_) {} }); }
			addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
			removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((x) => x !== f); }
			send() {} close() { this.readyState = 3; }
		}
		FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;
		window.WebSocket = FakeSocket;
		// Games often report their own lifecycle to the host page; keep those messages as events (useful signals).
		window.addEventListener("message", (e) => {
			try {
				const d = e.data;
				if (d && typeof d === "object" && typeof d.type === "string") logEvent("game_message", { type: d.type.slice(0, 40), data: JSON.stringify(d).slice(0, 200) });
			} catch (_) {}
		});
		try { Object.defineProperty(document, "hidden", { get: () => false }); Object.defineProperty(document, "visibilityState", { get: () => "visible" }); } catch (_) {}
	}

	// ------------------------------------------------------------------ 5. listener introspection
	const interactive = new WeakSet();
	{
		const INPUT = /^(touch|pointer|mouse|click|dblclick|key|wheel|contextmenu)/;
		const origAdd = EventTarget.prototype.addEventListener;
		EventTarget.prototype.addEventListener = function (type, fn, opts) {
			try {
				if (typeof type === "string" && INPUT.test(type)) {
					const where = this === window ? "window" : this === document ? "document" : this instanceof HTMLCanvasElement ? "canvas" : this instanceof Element ? "element" : "other";
					const k = `${type}@${where}`;
					S.listeners[k] = (S.listeners[k] || 0) + 1;
					if (this instanceof Element) interactive.add(this);
				}
			} catch (_) {}
			return origAdd.call(this, type, fn, opts);
		};
	}

	// ------------------------------------------------------------------ 1. virtual clock
	// Busy-wait guard: a frozen clock never ends `while (performance.now() - t0 < 50) {...}` (CPU benchmarks at boot,
	// frame-budget loops). Past 20k clock reads within one frame the clock creeps forward like a real device's would;
	// the creep is folded into the next frame. Ordinary games read the clock tens of times per frame.
	S.reads = 0;
	S.drift = 0;
	const readClock = () => { if (++S.reads > 20000) S.drift += 0.02; return S.now + S.drift; };
	if (CFG.frozen) {
		performance.now = readClock;
		const VDate = new Proxy(RealDate, {
			construct(target, args) { return args.length ? new target(...args) : new target(T0 + readClock()); },
			apply() { return new RealDate(T0 + readClock()).toString(); },
			get(target, prop) { if (prop === "now") return () => T0 + readClock(); const v = Reflect.get(target, prop); return typeof v === "function" ? v.bind(target) : v; },
		});
		window.Date = VDate;
		try { Object.defineProperty(Event.prototype, "timeStamp", { get: () => S.now, configurable: true }); } catch (_) {}

		window.requestAnimationFrame = (cb) => { const id = S.nextId++; S.raf.set(id, cb); return id; };
		window.cancelAnimationFrame = (id) => { S.raf.delete(id); };
		const addTimer = (cb, ms, repeat, args) => {
			const id = S.nextId++;
			const fn = typeof cb === "function" ? cb : () => (0, eval)(String(cb));
			const delay = Math.max(repeat ? 4 : 0, Number(ms) || 0);
			S.timers.set(id, { at: S.now + delay, every: repeat ? delay : 0, fn, args, seq: id });
			return id;
		};
		window.setTimeout = (cb, ms, ...a) => addTimer(cb, ms, false, a);
		window.setInterval = (cb, ms, ...a) => addTimer(cb, ms, true, a);
		window.clearTimeout = window.clearInterval = (id) => { S.timers.delete(id); };
		window.requestIdleCallback = (cb) => addTimer(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 1, false, []);
		window.cancelIdleCallback = (id) => S.timers.delete(id);

		// "log" audio: AudioContext.currentTime follows the virtual clock (seconds since the context was created).
		// ("render" audio gives the game's context its own clock, below, and leaves the game's own
		// OfflineAudioContexts, used to pre-render sounds, on their native clock.)
		const BAC = window.BaseAudioContext || window.AudioContext;
		if (BAC && !VIRTUAL_AUDIO) {
			const created = new WeakMap();
			const desc = Object.getOwnPropertyDescriptor(BAC.prototype, "currentTime");
			Object.defineProperty(BAC.prototype, "currentTime", {
				configurable: true,
				get() { if (!created.has(this)) created.set(this, S.now); return (S.now - created.get(this)) / 1000; },
			});
			S._ctxCreated = created;
			S._realCurrentTime = desc;
		}
	}

	// Web Animations / CSS animations and transitions: paused and seeked to virtual time on every step. When an
	// animation reaches its end we call finish(), so animationend / transitionend / finish handlers still fire.
	// Tracked in our own set: an animation seeked to (almost) its end drops out of document.getAnimations(), and must
	// still be finished explicitly, or `.finished.then(remove)` never runs and effects stay frozen on screen.
	const anims = new Map();
	function syncAnimations() {
		if (!document.getAnimations) return;
		try { for (const a of document.getAnimations()) if (!anims.has(a)) anims.set(a, null); } catch (_) {}
		for (const [a, prev] of anims) {
			try {
				let st = prev;
				if (!st) {
					st = { start: S.now - (Number(a.currentTime) || 0) / (a.playbackRate || 1) };
					anims.set(a, st);
				}
				if (a.playState === "finished" || a.playState === "idle") { anims.delete(a); continue; }
				if (a.playState === "running") a.pause();
				const timing = a.effect ? a.effect.getComputedTiming() : null;
				const t = (S.now - st.start) * (a.playbackRate || 1);
				const end = timing && Number.isFinite(timing.endTime) ? timing.endTime : Infinity;
				if (t >= end - 0.5) { anims.delete(a); a.finish(); }
				else a.currentTime = Math.max(0, t);
			} catch (_) { anims.delete(a); }
		}
	}

	// A real macrotask boundary (MessageChannel), so promise continuations scheduled by timers/frames run in order.
	const mc = new MessageChannel();
	const waiters = [];
	mc.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
	const yieldTask = () => new Promise((r) => { waiters.push(r); mc.port2.postMessage(0); });

	async function runTimersUntil(target) {
		for (let guard = 0; guard < 5000; guard++) {
			let best = null, bestId = 0;
			for (const [id, t] of S.timers) if (t.at <= target && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) { best = t; bestId = id; }
			if (!best) return;
			S.now = Math.max(S.now, best.at);
			if (best.every) { best.at += best.every; best.seq = S.nextId++; } else S.timers.delete(bestId);
			try { best.fn(...(best.args || [])); } catch (e) { S.errors.push(String(e && e.stack || e).slice(0, 300)); }
			if (guard % 16 === 15) await yieldTask();
		}
	}

	/** Advance n frames of 1/fps seconds each. Resolves when the frame's callbacks (and their microtasks) have run. */
	S.step = async (n = 1) => {
		const t0 = realPerfNow();
		for (let i = 0; i < n; i++) {
			if (S.drift) { S.now += S.drift; S.drift = 0; }
			S.reads = 0;
			const target = S.now + S.dt;
			await runTimersUntil(target);
			S.now = target;
			await yieldTask();
			const q = S.raf;
			S.raf = new Map();
			for (const cb of q.values()) {
				try { cb(S.now); } catch (e) { S.errors.push(String(e && e.stack || e).slice(0, 300)); }
			}
			syncAnimations();
			S.frame++;
			await yieldTask();
		}
		return { now: S.now, frame: S.frame, ms: realPerfNow() - t0, pendingRaf: S.raf.size, timers: S.timers.size };
	};

	// ------------------------------------------------------------------ 4. audio
	const A = S.audio;
	const ids = new WeakMap();
	let nextAudioId = 1;
	const idOf = (o) => { if (!ids.has(o)) ids.set(o, nextAudioId++); return ids.get(o); };
	const RealAC = window.AudioContext;
	const isRealCtx = (c) => !!RealAC && c instanceof RealAC; // not the game's own OfflineAudioContexts (pre-rendering)
	const NATIVE = window.AudioNode ? { connect: AudioNode.prototype.connect, disconnect: AudioNode.prototype.disconnect } : {};
	const graph = new WeakMap(); // node -> Set(destinations)
	const BAC2 = window.BaseAudioContext || window.AudioContext;
	// 4a. "log" audio (fallback): starts/stops of real AudioContexts, with the gain on the path read at start time.
	// Approximate: no envelopes, filters or pitch automation (they are what make synthesized SFX sound right).
	if (window.AudioNode && BAC2) {
		const origConnect = AudioNode.prototype.connect;
		AudioNode.prototype.connect = function (dest, ...rest) {
			try { if (!graph.has(this)) graph.set(this, new Set()); graph.get(this).add(dest); } catch (_) {}
			return origConnect.call(this, dest, ...rest);
		};
		const origDisconnect = AudioNode.prototype.disconnect;
		AudioNode.prototype.disconnect = function (dest, ...rest) {
			try { if (dest === undefined) graph.delete(this); else if (graph.has(this)) graph.get(this).delete(dest); } catch (_) {}
			return origDisconnect.call(this, dest, ...rest);
		};
		// Gain from a node to the destination: max over paths of the product of GainNode gains (depth-capped).
		const pathGain = (node, depth = 0) => {
			if (depth > 12 || !node) return 0;
			if (node instanceof AudioDestinationNode) return 1;
			if (node instanceof AudioParam) return 0;
			const outs = graph.get(node);
			if (!outs || !outs.size) return 0;
			let own = 1;
			if (window.GainNode && node instanceof GainNode) own = Math.max(0, node.gain.value);
			let best = 0;
			for (const d of outs) best = Math.max(best, pathGain(d, depth + 1));
			return own * best;
		};
		const ctxNow = (ctx) => {
			try { return ctx.currentTime; } catch (_) { return S.now / 1000; }
		};
		if (!VIRTUAL_AUDIO) {
			const origDecode = BAC2.prototype.decodeAudioData;
			BAC2.prototype.decodeAudioData = function (data, ok, err) {
				let copy = null;
				try { copy = data.slice(0); } catch (_) {}
				const p = origDecode.call(this, data);
				const out = p.then((buf) => {
					try {
						const id = idOf(buf);
						if (copy && !A.buffers[id]) A.buffers[id] = { id, kind: "encoded", bytes: copy, duration: buf.duration, channels: buf.numberOfChannels, rate: buf.sampleRate };
					} catch (_) {}
					if (ok) try { ok(buf); } catch (_) {}
					return buf;
				}, (e) => { if (err) try { err(e); } catch (_) {} throw e; });
				return out;
			};
		}
		const SRC = window.AudioBufferSourceNode;
		if (SRC) {
			const origStart = SRC.prototype.start;
			SRC.prototype.start = function (when = 0, offset = 0, duration) {
				try {
					const buf = this.buffer;
					if (buf && isRealCtx(this.context)) {
						const bid = idOf(buf);
						if (!A.buffers[bid]) {
							// Built in code (procedural SFX): keep the PCM itself, capped at 20 s.
							const n = Math.min(buf.length, buf.sampleRate * 20);
							const chans = [];
							for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(Array.from(buf.getChannelData(c).subarray(0, n), (v) => Math.round(v * 32767)));
							A.buffers[bid] = { id: bid, kind: "pcm", rate: buf.sampleRate, channels: chans.length, pcm: chans, duration: n / buf.sampleRate };
						}
						const now = ctxNow(this.context);
						const delay = when > now ? when - now : 0;
						A.log.push({ op: "start", node: idOf(this), buf: bid, t: S.now / 1000 + delay, offset: offset || 0, duration: duration === undefined ? null : duration,
							loop: !!this.loop, loopStart: this.loopStart || 0, loopEnd: this.loopEnd || 0, rate: this.playbackRate ? this.playbackRate.value : 1, gain: pathGain(this) });
					}
				} catch (_) {}
				return origStart.apply(this, arguments);
			};
			const origStop = SRC.prototype.stop;
			SRC.prototype.stop = function (when = 0) {
				try {
					if (isRealCtx(this.context)) {
						const now = ctxNow(this.context);
						A.log.push({ op: "stop", node: idOf(this), t: S.now / 1000 + (when > now ? when - now : 0) });
					}
				} catch (_) {}
				return origStop.apply(this, arguments);
			};
		}
		const OSC = window.OscillatorNode;
		if (OSC) {
			const oStart = OSC.prototype.start;
			OSC.prototype.start = function (when = 0) {
				try {
					if (isRealCtx(this.context)) {
						const now = ctxNow(this.context);
						A.log.push({ op: "osc", node: idOf(this), t: S.now / 1000 + (when > now ? when - now : 0), type: this.type, freq: this.frequency.value, gain: pathGain(this) });
					}
				} catch (_) {}
				return oStart.apply(this, arguments);
			};
			const oStop = OSC.prototype.stop;
			OSC.prototype.stop = function (when = 0) {
				try {
					if (isRealCtx(this.context)) {
						const now = ctxNow(this.context);
						A.log.push({ op: "stop", node: idOf(this), t: S.now / 1000 + (when > now ? when - now : 0) });
					}
				} catch (_) {}
				return oStop.apply(this, arguments);
			};
		}
	}

	// 4b. "render" audio. The game gets one OfflineAudioContext dressed as an AudioContext (every `new AudioContext()`
	// returns it), whose currentTime is virtual. Everything the game schedules on the timeline (start/stop, AudioParam
	// automation) goes straight to the engine, with "now" (0 or a time already past) meaning the virtual now. Changes
	// that a real context applies immediately (connect/disconnect, `.value =`, attributes of nodes already sounding)
	// are recorded with their virtual time and replayed at that point of the render (OfflineAudioContext.suspend).
	// Nodes are wired at the time they were made, as in a live context, which also keeps the render fast. When the
	// session closes the worker calls renderAudio(): the browser renders the whole session, exactly as a player would
	// have heard it. `ended` and `statechange` events are delivered in virtual time; the render's own are hidden.
	let V = null;
	if (VIRTUAL_AUDIO) {
		const OAC = window.OfflineAudioContext;
		const BAC = window.BaseAudioContext || OAC;
		const ASN = window.AudioScheduledSourceNode ? AudioScheduledSourceNode.prototype : null;
		const N = {
			suspend: OAC.prototype.suspend, resume: OAC.prototype.resume, startRendering: OAC.prototype.startRendering,
			createGain: BAC.prototype.createGain,
			listener: Object.getOwnPropertyDescriptor(BAC.prototype, "listener"),
			destination: Object.getOwnPropertyDescriptor(BAC.prototype, "destination"),
			onstatechange: Object.getOwnPropertyDescriptor(BAC.prototype, "onstatechange"),
			value: Object.getOwnPropertyDescriptor(AudioParam.prototype, "value"),
		};
		const err = (e) => S.errors.push(String((e && e.stack) || e).slice(0, 300));
		const ctxNow = () => {
			if (!V) return 0;
			if (V.state !== "running") return V.frozenC;
			const r = V.runs[V.runs.length - 1];
			return r.c0 + (S.now - r.v0) / 1000;
		};
		const clampT = (t) => Math.max(Number(t) || 0, ctxNow());
		const later = (fn) => { if (V.rendering) { try { fn(); } catch (_) {} } else V.deferred.push({ c: ctxNow(), fn }); };
		const isOurs = (n) => V !== null && n != null && n.context === V.ctx;
		const vTimer = (delayMs, fn) => { const id = S.nextId++; S.timers.set(id, { at: S.now + delayMs, every: 0, fn, args: [], seq: id }); return id; };

		// Which AudioParams are ours: registered when the game reads them off a node (AudioParam has no .context).
		const ours = new WeakSet();
		const reg = (v) => {
			if (v instanceof AudioParam) ours.add(v);
			else if (window.AudioParamMap && v instanceof AudioParamMap) v.forEach((p) => ours.add(p));
		};
		const nodeClasses = Object.getOwnPropertyNames(window).filter((k) => {
			if (!k.endsWith("Node")) return false;
			try { const C = window[k]; return typeof C === "function" && C.prototype instanceof AudioNode; } catch (_) { return false; }
		}).map((k) => window[k]);
		for (const C of nodeClasses) {
			for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(C.prototype))) {
				if (!d.get || !d.configurable || k === "onended") continue;
				const g = d.get;
				Object.defineProperty(C.prototype, k, { ...d, get() { const v = g.call(this); if (v && typeof v === "object" && V && this.context === V.ctx) reg(v); return v; } });
			}
		}
		if (window.AudioListener) {
			for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(AudioListener.prototype))) {
				if (!d.get || !d.configurable) continue;
				const g = d.get;
				Object.defineProperty(AudioListener.prototype, k, { ...d, get() { const v = g.call(this); if (V && this === V.listener) reg(v); return v; } });
			}
		}

		// AudioParam automation. Times are clamped to now (a live context treats a past time as now). The events are
		// also kept here, so `.value` reads what a live context would report: the automated value at this moment.
		const TL = new WeakMap(); // AudioParam -> { init, ev: [{k, t, v, tc, d, c, at}] }
		const tlOf = (p) => { let r = TL.get(p); if (!r) TL.set(p, (r = { init: N.value.get.call(p), ev: [] })); return r; };
		const insert = (r, e) => { let i = r.ev.length; while (i > 0 && r.ev[i - 1].t > e.t) i--; r.ev.splice(i, 0, e); };
		const valueAt = (r, T) => {
			let pv = r.init, pt = null, tgt = null; // value/time of the previous event; an active setTargetAtTime
			const cur = (t) => (tgt ? tgt.v + (tgt.from - tgt.v) * Math.exp(-Math.max(0, t - tgt.t) / Math.max(1e-6, tgt.tc)) : pv);
			for (const e of r.ev) {
				if (e.k === "lin" || e.k === "exp") {
					const t0 = tgt ? tgt.t : pt !== null ? pt : e.at, v0 = tgt ? tgt.from : pv;
					tgt = null;
					if (T < e.t) {
						if (T <= t0 || e.t <= t0) return v0;
						const x = (T - t0) / (e.t - t0);
						if (e.k === "lin") return v0 + (e.v - v0) * x;
						return v0 !== 0 && v0 * e.v > 0 ? v0 * Math.pow(e.v / v0, x) : v0;
					}
					pv = e.v; pt = e.t;
					continue;
				}
				if (e.t > T) break;
				if (e.k === "set") { tgt = null; pv = e.v; pt = e.t; }
				else if (e.k === "tgt") { const from = cur(e.t); tgt = { v: e.v, tc: e.tc, t: e.t, from }; pv = from; pt = e.t; }
				else if (e.k === "crv") {
					tgt = null;
					const c = e.c, n = c.length;
					if (!n) continue;
					if (T < e.t + e.d) { const x = ((T - e.t) / e.d) * (n - 1), i = Math.floor(x); return i + 1 < n ? c[i] + (c[i + 1] - c[i]) * (x - i) : c[n - 1]; }
					pv = c[n - 1]; pt = e.t + e.d;
				}
			}
			return cur(T);
		};
		const wrapParam = (name, fn) => {
			const orig = AudioParam.prototype[name];
			if (typeof orig !== "function") return;
			AudioParam.prototype[name] = function (...a) { return ours.has(this) ? fn.call(this, orig, a) : orig.apply(this, a); };
		};
		wrapParam("setValueAtTime", function (orig, [v, t]) { const r = tlOf(this), tt = clampT(t), out = orig.call(this, v, tt); insert(r, { k: "set", t: tt, v: +v }); return out; });
		for (const [name, k] of [["linearRampToValueAtTime", "lin"], ["exponentialRampToValueAtTime", "exp"]]) {
			wrapParam(name, function (orig, [v, t]) { const r = tlOf(this), tt = clampT(t), out = orig.call(this, v, tt); insert(r, { k, t: tt, v: +v, at: ctxNow() }); return out; });
		}
		wrapParam("setTargetAtTime", function (orig, [v, t, tc]) { const r = tlOf(this), tt = clampT(t), out = orig.call(this, v, tt, tc); insert(r, { k: "tgt", t: tt, v: +v, tc: +tc }); return out; });
		wrapParam("setValueCurveAtTime", function (orig, [c, t, d]) { const r = tlOf(this), tt = clampT(t), out = orig.call(this, c, tt, d); insert(r, { k: "crv", t: tt, d: +d, c: Float32Array.from(c) }); return out; });
		wrapParam("cancelScheduledValues", function (orig, [t]) { const r = tlOf(this), tt = clampT(t), out = orig.call(this, tt); r.ev = r.ev.filter((e) => e.t < tt); return out; });
		wrapParam("cancelAndHoldAtTime", function (orig, [t]) {
			const r = tlOf(this), tt = clampT(t), hold = valueAt(r, tt), out = orig.call(this, tt);
			r.ev = r.ev.filter((e) => e.t < tt); insert(r, { k: "set", t: tt, v: hold });
			return out;
		});
		Object.defineProperty(AudioParam.prototype, "value", {
			configurable: true, enumerable: N.value.enumerable,
			get() { if (!ours.has(this)) return N.value.get.call(this); const r = TL.get(this); return r && r.ev.length ? valueAt(r, ctxNow()) : N.value.get.call(this); },
			set(v) { if (!ours.has(this) || !Number.isFinite(Number(v))) return N.value.set.call(this, v); this.setValueAtTime(Number(v), ctxNow()); },
		});

		// Graph changes happen at their virtual time in the render.
		const wiredAt = new WeakMap(); // node -> ctx time of its first connection
		const wire = (n, c) => { if (n && !wiredAt.has(n)) wiredAt.set(n, c); };
		const started = new WeakMap(); // source node -> { start, end, timer, done }
		const live = (n) => {
			if (started.has(n)) return true;
			if (ASN && n instanceof AudioScheduledSourceNode) return false; // silent until started
			const w = wiredAt.get(n);
			return w !== undefined && w < ctxNow();
		};
		const prevConnect = AudioNode.prototype.connect, prevDisconnect = AudioNode.prototype.disconnect;
		AudioNode.prototype.connect = function (dest, ...rest) {
			if (!isOurs(this)) return prevConnect.call(this, dest, ...rest);
			const isNode = dest instanceof AudioNode;
			const destOurs = isNode ? dest.context === V.ctx : ours.has(dest);
			if (!destOurs || (rest[0] !== undefined && +rest[0] >= this.numberOfOutputs) || (isNode && rest[1] !== undefined && +rest[1] >= dest.numberOfInputs)) {
				return NATIVE.connect.call(this, dest, ...rest); // throws, as a live context would (other context, bad index)
			}
			const c = ctxNow();
			wire(this, c);
			if (isNode) wire(dest, c);
			if (dest === V.dest) V.toDest.add(this);
			later(() => NATIVE.connect.call(this, dest, ...rest));
			return isNode ? dest : undefined;
		};
		AudioNode.prototype.disconnect = function (...a) {
			if (!isOurs(this)) return prevDisconnect.apply(this, a);
			later(() => NATIVE.disconnect.apply(this, a));
		};
		// Attributes and setter methods: immediate on a node that cannot be sounding yet, else at their time (the
		// getter reports the new value straight away).
		const shadow = new WeakMap();
		const wrapAttr = (C, prop) => {
			const d = C && Object.getOwnPropertyDescriptor(C.prototype, prop);
			if (!d || !d.set || !d.configurable) return;
			Object.defineProperty(C.prototype, prop, {
				configurable: true, enumerable: d.enumerable,
				get() { const sh = shadow.get(this); return sh && prop in sh ? sh[prop] : d.get.call(this); },
				set(v) {
					if (!isOurs(this) || !live(this)) return d.set.call(this, v);
					let sh = shadow.get(this);
					if (!sh) shadow.set(this, (sh = {}));
					sh[prop] = v;
					later(() => { try { d.set.call(this, v); } finally { if (sh[prop] === v) delete sh[prop]; } });
				},
			});
		};
		const wrapMethod = (C, name, owner = isOurs) => {
			const orig = C && C.prototype[name];
			if (typeof orig !== "function") return;
			C.prototype[name] = function (...a) {
				if (!owner(this) || (owner === isOurs && !live(this))) return orig.apply(this, a);
				later(() => orig.apply(this, a));
			};
		};
		const W = window;
		wrapAttr(W.OscillatorNode, "type");
		for (const p of ["buffer", "loop", "loopStart", "loopEnd"]) wrapAttr(W.AudioBufferSourceNode, p);
		wrapAttr(W.BiquadFilterNode, "type");
		for (const p of ["curve", "oversample"]) wrapAttr(W.WaveShaperNode, p);
		for (const p of ["buffer", "normalize"]) wrapAttr(W.ConvolverNode, p);
		for (const p of ["panningModel", "distanceModel", "refDistance", "maxDistance", "rolloffFactor", "coneInnerAngle", "coneOuterAngle", "coneOuterGain"]) wrapAttr(W.PannerNode, p);
		for (const p of ["channelCount", "channelCountMode", "channelInterpretation"]) wrapAttr(W.AudioNode, p);
		wrapMethod(W.OscillatorNode, "setPeriodicWave");
		for (const m of ["setPosition", "setOrientation"]) { wrapMethod(W.PannerNode, m); wrapMethod(W.AudioListener, m, (l) => V !== null && l === V.listener); }

		// start/stop: "now" means the virtual now; `ended` fires in virtual time when the sound is over.
		const armEnded = (n) => {
			const s = started.get(n);
			if (s.timer) { S.timers.delete(s.timer); s.timer = 0; }
			if (s.done || !Number.isFinite(s.end)) return;
			const delay = V.state === "running" ? Math.max(0, (s.end - ctxNow()) * 1000) : S.dt;
			s.timer = vTimer(delay, () => {
				s.timer = 0;
				if (V.state === "closed" || s.done) return;
				if (V.state !== "running" || ctxNow() < s.end - 1e-6) return armEnded(n);
				s.done = true;
				try { n.dispatchEvent(new Event("ended")); } catch (e) { err(e); }
			});
		};
		const onStart = (n, w, rest) => {
			V.starts++;
			let end = Infinity;
			if (W.AudioBufferSourceNode && n instanceof AudioBufferSourceNode) {
				const b = n.buffer;
				if (b) {
					const rate = Math.abs(n.playbackRate.value) || 1;
					const off = Math.max(0, Number(rest[0]) || 0);
					if (rest[1] !== undefined) end = w + Math.max(0, Number(rest[1]) || 0) / rate;
					if (!n.loop) end = Math.min(end, w + Math.max(0, b.duration - off) / rate);
				}
			}
			started.set(n, { start: w, end, timer: 0, done: false });
			armEnded(n);
		};
		const srcProtos = [W.AudioScheduledSourceNode, W.AudioBufferSourceNode, W.OscillatorNode, W.ConstantSourceNode].filter(Boolean).map((C) => C.prototype);
		for (const P of srcProtos) {
			for (const name of ["start", "stop"]) {
				if (!Object.prototype.hasOwnProperty.call(P, name)) continue;
				const prev = P[name];
				P[name] = function (when = 0, ...rest) {
					if (!isOurs(this)) return prev.call(this, when, ...rest);
					const w = clampT(when);
					const out = prev.call(this, w, ...rest);
					if (name === "start") onStart(this, w, rest);
					else { const s = started.get(this); if (s) { s.end = Math.max(w, s.start); armEnded(this); } }
					return out;
				};
			}
		}
		// The render's own (trusted) `ended` / `statechange` events never reach the game: it already had them.
		const wrapped = new WeakMap();
		const untrustedOnly = (fn) => {
			let w = wrapped.get(fn);
			if (!w) {
				w = function (ev) { if (ev && ev.isTrusted) return; return typeof fn === "function" ? fn.call(this, ev) : fn.handleEvent(ev); };
				wrapped.set(fn, w);
			}
			return w;
		};
		const guardEvents = (target, type, attr, owner) => {
			const d = Object.getOwnPropertyDescriptor(attr.proto, attr.name);
			const fns = new WeakMap();
			Object.defineProperty(target, attr.name, {
				configurable: true, enumerable: true,
				get() { return owner(this) ? (fns.get(this) ?? null) : d.get.call(this); },
				set(fn) {
					if (!owner(this)) return d.set.call(this, fn);
					const f = typeof fn === "function" ? fn : null;
					fns.set(this, f);
					d.set.call(this, f ? untrustedOnly(f) : null);
				},
			});
			const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
			Object.defineProperty(target, "addEventListener", { configurable: true, writable: true, value: function (t, fn, o) {
				return add.call(this, t, t === type && fn && owner(this) ? untrustedOnly(fn) : fn, o);
			} });
			Object.defineProperty(target, "removeEventListener", { configurable: true, writable: true, value: function (t, fn, o) {
				return remove.call(this, t, t === type && fn && owner(this) && wrapped.has(fn) ? wrapped.get(fn) : fn, o);
			} });
		};
		if (ASN) guardEvents(ASN, "ended", { proto: ASN, name: "onended" }, isOurs);

		// The context the game gets.
		const P = Object.create(OAC.prototype);
		const def = (k, d) => Object.defineProperty(P, k, { configurable: true, ...(typeof d === "function" ? { writable: true, value: d } : d) });
		const fireState = () => vTimer(0, () => { try { V.ctx.dispatchEvent(new Event("statechange")); } catch (e) { err(e); } });
		const reopen = () => { V.runs.push({ c0: V.frozenC, v0: S.now, v1: null }); V.state = "running"; };
		const halt = () => { V.frozenC = ctxNow(); V.runs[V.runs.length - 1].v1 = S.now; };
		const closedErr = (what) => Promise.reject(new DOMException(`Cannot ${what} a closed AudioContext.`, "InvalidStateError"));
		def("currentTime", { get: ctxNow });
		def("state", { get: () => V.state });
		def("baseLatency", { get: () => 0.01 });
		def("outputLatency", { get: () => 0.02 });
		def("sinkId", { get: () => "" });
		def("onsinkchange", { value: null, writable: true });
		def("resume", function () { if (V.state === "closed") return closedErr("resume"); if (V.state === "suspended") { reopen(); fireState(); } return Promise.resolve(); });
		def("suspend", function () { if (V.state === "closed") return closedErr("suspend"); if (V.state === "running") { halt(); V.state = "suspended"; fireState(); } return Promise.resolve(); });
		def("close", function () { if (V.state === "closed") return closedErr("close"); if (V.state === "running") halt(); V.state = "closed"; fireState(); return Promise.resolve(); });
		def("getOutputTimestamp", function () { return { contextTime: ctxNow(), performanceTime: S.now }; });
		def("setSinkId", function () { return Promise.resolve(); });
		// <audio> routed into the graph: the element is still mixed from the media log (its graph processing is not).
		def("createMediaElementSource", function () { A.mediaInGraph = (A.mediaInGraph || 0) + 1; return N.createGain.call(this); });
		def("createMediaStreamSource", function () { return N.createGain.call(this); });
		def("createMediaStreamTrackSource", function () { return N.createGain.call(this); });
		def("createMediaStreamDestination", function () { const g = N.createGain.call(this); try { g.stream = new MediaStream(); } catch (_) {} return g; });
		def("startRendering", function () { return Promise.reject(new DOMException("Not supported on an AudioContext.", "NotSupportedError")); });
		def(Symbol.toStringTag, { value: "AudioContext" });
		if (N.onstatechange) guardEvents(P, "statechange", { proto: BAC.prototype, name: "onstatechange" }, (x) => V !== null && x === V.ctx);
		const FakeAC = function AudioContext(opts) {
			if (!new.target) throw new TypeError("Failed to construct 'AudioContext': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
			if (!V) {
				// The rate a live context would have (the device's): games size buffers by it, and some fill them with
				// Math.random(), which is the seeded stream the rest of the game draws from.
				let rate = Math.round(Number(opts && opts.sampleRate) || CFG.audioRate || 0);
				if (!rate) { try { const real = new RealAC(); rate = real.sampleRate; real.close(); } catch (_) { rate = 48000; } }
				const len = Math.max(rate, Math.ceil(Math.max(1, (CFG.audioMaxS || 300) - S.now / 1000) * rate));
				const ctx = new OAC({ numberOfChannels: 2, length: len, sampleRate: rate });
				Object.setPrototypeOf(ctx, P);
				V = { ctx, rate, len, t0: S.now, runs: [{ c0: 0, v0: S.now, v1: null }], state: "running", frozenC: 0, deferred: [], toDest: new Set(), starts: 0, rendering: false,
					listener: N.listener.get.call(ctx), dest: N.destination.get.call(ctx) };
			} else if (V.state === "closed") reopen();
			return V.ctx;
		};
		FakeAC.prototype = P;
		Object.defineProperty(P, "constructor", { value: FakeAC, configurable: true, writable: true });
		window.AudioContext = FakeAC;
		if (window.webkitAudioContext) window.webkitAudioContext = FakeAC;

		S.audioState = () => (V ? { state: V.state, now: ctxNow(), sources: V.starts, deferred: V.deferred.length, runs: V.runs.length } : null);
		/** Render the session's Web Audio (once). Resolves to its description; the samples are read with audioChunk. */
		S.renderAudio = async () => {
			if (!V) return null;
			if (V.info) return V.info;
			const ctx = V.ctx, rate = V.rate, Q = 128;
			const endC = Math.min(ctxNow(), (V.len - 1) / rate);
			if (V.state === "running") V.runs[V.runs.length - 1].v1 = S.now;
			const runs = V.runs.map((r) => [r.c0, r.v0 / 1000, (r.v1 === null ? S.now : r.v1) / 1000]);
			const endF = Math.floor((endC * rate) / Q) * Q;
			const groups = new Map();
			let opErrors = 0, failed = 0;
			const apply = (fns) => { for (const fn of fns) { try { fn(); } catch (_) { opErrors++; } } };
			for (const d of V.deferred) {
				const f = Math.floor((d.c * rate) / Q) * Q;
				if (f >= endF) continue; // after the session
				if (f <= 0) { apply([d.fn]); continue; }
				if (!groups.has(f)) groups.set(f, []);
				groups.get(f).push(d.fn);
			}
			V.rendering = true;
			const at = (f, fns) => N.suspend.call(ctx, f / rate).then(() => { apply(fns); return N.resume.call(ctx); }, () => { failed++; });
			for (const [f, fns] of groups) at(f, fns);
			// Past the end of the session nothing is heard: cut the graph so the rest of the render costs nothing.
			if (endF > 0) at(endF, [...V.toDest].map((n) => () => NATIVE.disconnect.call(n, V.dest)));
			const t0 = realPerfNow();
			try {
				const buf = await Promise.race([N.startRendering.call(ctx),
					new Promise((_, rej) => realSetTimeout(() => rej(new Error("audio render timed out")), CFG.audioRenderTimeoutMs || 300000))]);
				V.pcm = [buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)];
				V.info = { rate, frames: Math.min(buf.length, Math.ceil(endC * rate)), runs, t0: V.t0 / 1000, sources: V.starts, deferred: V.deferred.length,
					suspends: groups.size, failed, opErrors, mediaInGraph: A.mediaInGraph || 0, ms: Math.round(realPerfNow() - t0),
					truncated: ctxNow() > (V.len - 1) / rate }; // the session outlasted audioMaxS: the rest is silent
			} catch (e) {
				V.info = { error: String((e && e.message) || e).slice(0, 300), sources: V.starts };
			}
			return V.info;
		};
		/** `n` frames of the render from frame `i0`, interleaved stereo float32 little-endian, base64. */
		S.audioChunk = (i0, n) => {
			const [L, R] = V.pcm;
			const m = Math.max(0, Math.min(n, V.info.frames - i0));
			const f = new Float32Array(m * 2);
			for (let i = 0; i < m; i++) { f[2 * i] = L[i0 + i]; f[2 * i + 1] = R[i0 + i]; }
			const u = new Uint8Array(f.buffer);
			let s = "";
			for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
			return btoa(s);
		};
	}
	if (window.HTMLMediaElement) {
		const MP = HTMLMediaElement.prototype;
		const origPlay = MP.play, origPause = MP.pause;
		MP.play = function () {
			try {
				const src = this.currentSrc || this.src || "";
				const id = idOf(this);
				if (!A.media[id]) A.media[id] = { id, src: src.startsWith("data:") ? src : src.slice(0, 500) };
				A.log.push({ op: "media_play", node: id, media: id, t: S.now / 1000, at: this.currentTime || 0, loop: !!this.loop, volume: this.muted ? 0 : this.volume, rate: this.playbackRate || 1 });
			} catch (_) {}
			return origPlay.call(this);
		};
		MP.pause = function () {
			try { A.log.push({ op: "stop", node: idOf(this), t: S.now / 1000 }); } catch (_) {}
			return origPause.call(this);
		};
		// Volume fades are common for music; sample them as gain changes.
		const vdesc = Object.getOwnPropertyDescriptor(MP, "volume");
		if (vdesc && vdesc.set) {
			Object.defineProperty(MP, "volume", {
				configurable: true,
				get() { return vdesc.get.call(this); },
				set(v) { try { if (ids.has(this)) A.log.push({ op: "media_volume", node: idOf(this), t: S.now / 1000, volume: Number(v) }); } catch (_) {} vdesc.set.call(this, v); },
			});
		}
	}

	/** Export the audio log. Encoded buffers are returned base64-encoded (once each; `skip` lists ids already sent). */
	S.exportAudio = (skip = []) => {
		const b64 = (ab) => { let s = ""; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
		const buffers = [];
		for (const b of A.buffers) {
			if (!b || skip.includes(b.id)) continue;
			if (b.kind === "encoded") buffers.push({ id: b.id, kind: b.kind, b64: b64(b.bytes), duration: b.duration });
			else buffers.push({ id: b.id, kind: b.kind, rate: b.rate, pcm: b.pcm, duration: b.duration });
		}
		return { log: A.log, buffers, media: A.media.filter(Boolean) };
	};

	// ------------------------------------------------------------------ observation helpers
	/** Visible elements that look interactive, with their boxes in CSS pixels (DOM games; canvas games return few). */
	S.domCandidates = (max = 40) => {
		const out = [];
		const vw = innerWidth, vh = innerHeight;
		const els = document.querySelectorAll("button,a,input,select,textarea,[role=button],[onclick],[tabindex],[data-cell],[aria-label],*");
		const seen = new Set();
		for (const el of els) {
			if (out.length >= max * 3) break;
			if (seen.has(el)) continue;
			seen.add(el);
			const tag = el.tagName.toLowerCase();
			if (tag === "html" || tag === "body" || tag === "canvas" || tag === "script" || tag === "style") continue;
			const cs = getComputedStyle(el);
			const isInteractive = interactive.has(el) || /^(button|a|input|select|textarea)$/.test(tag) || el.getAttribute("role") === "button" || el.hasAttribute("onclick") || cs.cursor === "pointer" || el.hasAttribute("data-cell");
			if (!isInteractive) continue;
			if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05 || cs.pointerEvents === "none") continue;
			const r = el.getBoundingClientRect();
			if (r.width < 6 || r.height < 6 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
			const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
			const hit = document.elementFromPoint(cx, cy);
			if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue; // covered
			const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 40);
			out.push({ tag, label, x: r.left, y: r.top, w: r.width, h: r.height });
		}
		// Prefer leaf-ish, labelled, small-to-medium elements.
		out.sort((a, b) => (b.label ? 1 : 0) - (a.label ? 1 : 0) || a.w * a.h - b.w * b.h);
		return out.slice(0, max);
	};

	S.summary = () => ({
		now: S.now, frame: S.frame, raf: S.raf.size, timers: S.timers.size,
		listeners: S.listeners, errors: S.errors.slice(-5), events: S.events.slice(-20),
		audioStarts: S.audio.log.length + (V ? V.starts : 0), canvases: document.querySelectorAll("canvas").length,
		domNodes: document.getElementsByTagName("*").length, title: document.title,
	});
})();
