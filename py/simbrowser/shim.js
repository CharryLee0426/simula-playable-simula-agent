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
//   4. An audio event log: decoded buffers, buffer-source starts/stops (with the gain on the path to the speakers),
//      media elements and oscillators, all stamped with virtual time, so the worker can mix the game's audio
//      offline and lay it under the 30 fps video in sync.
//   5. Introspection: which input events the game listens to, and (for DOM games) which elements are interactive.
(() => {
	if (window.__sim) return;
	const CFG = Object.assign({ seed: 1, fps: 30, frozen: true }, window.__SIM_CFG || {});
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

		// AudioContext.currentTime follows the virtual clock (seconds since the context was created).
		const BAC = window.BaseAudioContext || window.AudioContext;
		if (BAC) {
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
	const anims = new WeakMap();
	function syncAnimations() {
		if (!document.getAnimations) return;
		let list;
		try { list = document.getAnimations(); } catch (_) { return; }
		for (const a of list) {
			try {
				let st = anims.get(a);
				if (!st) {
					st = { start: S.now - (Number(a.currentTime) || 0) / (a.playbackRate || 1), done: false };
					anims.set(a, st);
					if (a.playState === "running") a.pause();
				}
				if (st.done || a.playState === "finished") continue;
				const timing = a.effect ? a.effect.getComputedTiming() : null;
				const t = (S.now - st.start) * (a.playbackRate || 1);
				const end = timing && Number.isFinite(timing.endTime) ? timing.endTime : Infinity;
				if (t >= end) { st.done = true; a.finish(); }
				else { if (a.playState === "running") a.pause(); a.currentTime = Math.max(0, t); }
			} catch (_) {}
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

	// ------------------------------------------------------------------ 4. audio event log
	const A = S.audio;
	const ids = new WeakMap();
	let nextAudioId = 1;
	const idOf = (o) => { if (!ids.has(o)) ids.set(o, nextAudioId++); return ids.get(o); };
	const graph = new WeakMap(); // node -> Set(destinations)
	const BAC2 = window.BaseAudioContext || window.AudioContext;
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
		const SRC = window.AudioBufferSourceNode;
		if (SRC) {
			const origStart = SRC.prototype.start;
			SRC.prototype.start = function (when = 0, offset = 0, duration) {
				try {
					const buf = this.buffer;
					if (buf) {
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
				return origStart.call(this, when, offset, duration);
			};
			const origStop = SRC.prototype.stop;
			SRC.prototype.stop = function (when = 0) {
				try {
					const now = ctxNow(this.context);
					A.log.push({ op: "stop", node: idOf(this), t: S.now / 1000 + (when > now ? when - now : 0) });
				} catch (_) {}
				return origStop.call(this, when);
			};
		}
		const OSC = window.OscillatorNode;
		if (OSC) {
			const oStart = OSC.prototype.start;
			OSC.prototype.start = function (when = 0) {
				try {
					const now = ctxNow(this.context);
					A.log.push({ op: "osc", node: idOf(this), t: S.now / 1000 + (when > now ? when - now : 0), type: this.type, freq: this.frequency.value, gain: pathGain(this) });
				} catch (_) {}
				return oStart.call(this, when);
			};
			const oStop = OSC.prototype.stop;
			OSC.prototype.stop = function (when = 0) {
				try {
					const now = ctxNow(this.context);
					A.log.push({ op: "stop", node: idOf(this), t: S.now / 1000 + (when > now ? when - now : 0) });
				} catch (_) {}
				return oStop.call(this, when);
			};
		}
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
		audioStarts: S.audio.log.length, canvases: document.querySelectorAll("canvas").length,
		domNodes: document.getElementsByTagName("*").length, title: document.title,
	});
})();
