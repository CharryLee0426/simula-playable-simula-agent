// Injected into every playable before its own scripts run (Playwright addInitScript). Generic: nothing in here
// knows about any particular game. It gives the agent five things:
//
//   1. A virtual clock. requestAnimationFrame, timers, performance.now, Date, event.timeStamp, Web Animations /
//      CSS animations and AudioContext.currentTime all read __sim.now, which only moves when the worker calls
//      __sim.step(). The game is frozen while the model thinks, and every captured frame is exactly 1/30 s of game
//      time apart however slow the machine renders (3D under SwiftShader runs at 2-5 real fps). Work that finishes
//      on the real clock (decoding pictures and audio, data:/blob: fetches and blob reads, fonts, scripts and blob
//      modules) is waited for and delivered at the start of the next frame (1b), and input sent before a step is
//      handled before it (counted on both sides), so a replay of the same touches is the same game on any machine.
//   2. Reproducibility: Math.random is a seeded PRNG, and Date starts at a fixed epoch.
//   3. A sandbox: ad SDK stubs (mraid, dapi, ExitApi, FbPlayableAd), a WebSocket that never connects, window.open
//      blocked. CTA calls are logged as events: they tell the agent that the playable reached its install button.
//   4. The game's audio, in game time. Web Audio is rendered by the browser's own engine: the game's AudioContext is
//      an OfflineAudioContext on the virtual clock, rendered once when the session closes (envelopes, filters,
//      compressors, pitch sweeps: exactly what a player hears). <audio> elements are logged (play/pause/volume,
//      virtual time) and mixed by the worker.
//   5. Introspection: which input events the game listens to, and (for DOM games) which elements are interactive.
(() => {
	if (window.__sim) return;
	// epoch: what Date.now() reads at game time 0. Fixed, like the random seed: a game that seeds itself from the date
	// (Boom Castle seeds its simulation from Date.now()) would otherwise be another game on every run.
	const CFG = Object.assign({ seed: 1, fps: 30, frozen: true, audio: "render", audioMaxS: 300, audioRate: 0, epoch: Date.UTC(2026, 0, 1, 12) }, window.__SIM_CFG || {});
	// "render": Web Audio rendered offline by the browser (needs the virtual clock). "log": the old event log, mixed
	// approximately by the worker (gain read at start, no envelopes or effects).
	const VIRTUAL_AUDIO = CFG.frozen && CFG.audio !== "log" && !!(window.OfflineAudioContext && window.AudioContext && window.AudioNode && window.AudioParam);
	const realSetTimeout = window.setTimeout.bind(window);
	const realClearTimeout = window.clearTimeout.bind(window);
	const realPerfNow = performance.now.bind(performance);
	const RealDate = Date;
	const T0 = Number.isFinite(CFG.epoch) && CFG.frozen ? CFG.epoch : RealDate.now();
	const nativeAddListener = EventTarget.prototype.addEventListener;
	const nativeTimeStamp = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp").get;
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
		S.randCalls = 0; // how far the game is into its random stream (two replays of a session draw the same numbers)
		Math.random = () => { S.randCalls++; return next(); };
	}

	// ------------------------------------------------------------------ 3. sandbox: ad SDKs, sockets, popups
	const logEvent = (kind, data) => S.events.push({ t: S.now, frame: S.frame, kind, ...(data || {}) });
	// The stubs answer later, on the game's clock (a virtual timer under the virtual clock, section 1).
	const soon = (fn, ms) => (S.timeout || realSetTimeout)(fn, ms);
	{
		const mraidL = {};
		const fire = (ev, ...args) => (mraidL[ev] || []).slice().forEach((f) => { try { f(...args); } catch (e) {} });
		window.mraid = {
			getVersion: () => "3.0",
			getState: () => "default",
			getPlacementType: () => "interstitial",
			isViewable: () => true,
			addEventListener: (ev, f) => { (mraidL[ev] = mraidL[ev] || []).push(f); if (ev === "ready") soon(() => f(), 0); if (ev === "viewableChange") soon(() => f(true), 0); },
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
			addEventListener: (ev, f) => { (dapiL[ev] = dapiL[ev] || []).push(f); if (ev === "ready") soon(() => f(), 0); if (ev === "viewabilityChange") soon(() => f({ isViewable: true }), 0); },
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
				soon(() => { this.readyState = 3; this._emit("error", {}); this._emit("close", { code: 1006, reason: "offline", wasClean: false }); }, 30);
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
		S.timeout = (fn, ms) => addTimer(fn, ms, false, []);
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
	// Until we first see an animation it runs on the compositor's real clock, so how far it got says nothing about game
	// time: one made by a style change (a CSS transition or animation) starts when we see it, at the end of the frame
	// that made it, as a browser would start it at its next rendering; one made by element.animate() is paused as it is
	// made, so it only moves when the game seeks it.
	const anims = new Map();
	const styleMade = (a) => (window.CSSTransition && a instanceof CSSTransition) || (window.CSSAnimation && a instanceof CSSAnimation);
	if (CFG.frozen && window.Element && typeof Element.prototype.animate === "function") {
		const nAnimate = Element.prototype.animate;
		Element.prototype.animate = function (...a) {
			const anim = nAnimate.apply(this, a);
			try { anim.pause(); } catch (_) {}
			return anim;
		};
	}
	function syncAnimations() {
		if (!document.getAnimations) return;
		try { for (const a of document.getAnimations()) if (!anims.has(a)) anims.set(a, null); } catch (_) {}
		for (const [a, prev] of anims) {
			try {
				let st = prev;
				if (!st) {
					st = { start: S.now - (styleMade(a) ? 0 : (Number(a.currentTime) || 0) / (a.playbackRate || 1)) };
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

	// Asset work (section 1b) the virtual clock waits for: requested, finished on the real clock, delivered in game time.
	const ops = []; // in request order
	const assetStats = { requested: 0, delivered: 0, late: 0, waits: 0, waitMs: 0, maxWaitMs: 0, kinds: {} };
	const STALL_MS = CFG.assetStallMs || 10000;
	/** `job` (a promise of native work) is an op: `deliver({v} | {e})` runs from a virtual timer at the start of the first
	 *  frame stepped after it finished. Its timer sequence number is taken now, so deliveries keep request order.
	 *  `blocking()`: whether the clock waits for it yet (a script only loads once it is in the document). */
	const track = (kind, job, deliver, blocking) => {
		const op = { seq: S.nextId++, kind, frame: S.frame, done: false, r: null, deliver, late: false, cancelled: false, blocking };
		assetStats.requested++;
		assetStats.kinds[kind] = (assetStats.kinds[kind] || 0) + 1;
		op.wait = Promise.resolve(job).then((v) => { op.done = true; op.r = { v }; }, (e) => { op.done = true; op.r = { e }; });
		ops.push(op);
		return op;
	};
	/** A promise for native work that settles in game time (see track). */
	const defer = (kind, job) => new Promise((res, rej) => { track(kind, job, (r) => ("e" in r ? rej(r.e) : res(r.v))); });
	let fontsLoading = null; // () => native document.fonts.ready while fonts load (CSS @font-face fetched on first use)
	// Modules the page builds from blobs (section 1b): how many were made and have run, when one last finished running,
	// and since when a sync point watches for one (a frame that delivered work may have imported the first of a chain).
	const JS_GAP_MS = CFG.moduleGapMs || 200;
	const js = { made: 0, ran: 0, lastRan: -Infinity, watch: -Infinity, armed: false, waits: 0, waitMs: 0 };
	const jsBusy = () => realPerfNow() < Math.max(js.lastRan, js.watch) + JS_GAP_MS;
	/** Wait (real time) until every op requested so far has finished, and any font the page started loading is in.
	 *  An op the game itself holds up (a stream it feeds from a timer, an image whose src is removed) would never
	 *  finish: when STALL_MS pass with none finishing, the ones still open are marked late and no longer waited for;
	 *  they are delivered whenever they finish, the one place where real time still shows (counted in assetStats). */
	async function settle() {
		const t0 = realPerfNow();
		let waited = false;
		for (;;) {
			const open = ops.filter((o) => !o.done && !o.late && (!o.blocking || o.blocking()));
			const fonts = fontsLoading && fontsLoading();
			if (!open.length && !fonts) {
				// A chain of imports in progress: wait until none has finished running for JS_GAP_MS, then look again
				// (a module may have asked for asset work).
				const quiet = Math.max(js.lastRan, js.watch) + JS_GAP_MS - realPerfNow();
				if (quiet <= 0) break;
				const m0 = realPerfNow();
				await new Promise((r) => realSetTimeout(r, quiet));
				js.waits++; js.waitMs += realPerfNow() - m0;
				continue;
			}
			waited = true;
			let timer = 0;
			const stall = new Promise((r) => { timer = realSetTimeout(() => r(false), STALL_MS); });
			const finished = [...open.map((o) => o.wait), ...(fonts ? [fonts] : [])].map((p) => Promise.resolve(p).then(() => true, () => true));
			const any = await Promise.race([...finished, stall]);
			realClearTimeout(timer);
			if (!any) {
				for (const o of open) if (!o.done) { o.late = true; assetStats.late++; S.errors.push(`asset ${o.kind} still loading after ${STALL_MS} ms: delivered when it finishes`); }
				if (fonts) fontsLoading = null; // fonts that never finish loading: stop waiting for them
				break;
			}
		}
		if (waited) {
			const ms = realPerfNow() - t0;
			assetStats.waits++; assetStats.waitMs += ms; assetStats.maxWaitMs = Math.max(assetStats.maxWaitMs, ms);
		}
	}
	/** A sync point: microtasks run (their requests join `ops`), then everything in flight finishes before game code
	 *  runs again. Real-clock side effects (a script executing, a font or picture becoming drawable) happen here, at a
	 *  fixed point of game time, never in the middle of a frame at a moment that depends on the machine. */
	const sync = async (afterTimers = false) => {
		await yieldTask();
		if (afterTimers && js.armed) { js.armed = false; js.watch = realPerfNow(); }
		if (ops.length || fontsLoading || jsBusy()) await settle();
	};
	S.assetLog = []; // [kind, frame requested, frame delivered] (the first 4000)
	/** Ops finished by now land in this frame: virtual timers at the frame's start, in request order. */
	function deliverDone() {
		let w = 0;
		for (const op of ops) {
			if (!op.done) { ops[w++] = op; continue; }
			if (op.cancelled || !op.deliver) continue;
			assetStats.delivered++;
			if (js.made > js.ran) js.armed = true;
			if (S.assetLog.length < 4000) S.assetLog.push([op.kind, op.frame, S.frame]);
			S.timers.set(op.seq, { at: S.now, every: 0, fn: () => op.deliver(op.r), args: [], seq: op.seq });
		}
		ops.length = w;
	}
	S.assetStats = () => ({ ...assetStats, open: ops.length, pending: ops.filter((o) => !o.done).map((o) => o.kind).slice(0, 20),
		modules: { made: js.made, ran: js.ran, waits: js.waits, waitMs: Math.round(js.waitMs) } });

	async function runTimersUntil(target) {
		for (let guard = 0; guard < 5000; guard++) {
			let best = null, bestId = 0;
			for (const [id, t] of S.timers) if (t.at <= target && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) { best = t; bestId = id; }
			if (!best) return;
			S.now = Math.max(S.now, best.at);
			if (best.every) { best.at += best.every; best.seq = S.nextId++; } else S.timers.delete(bestId);
			try { best.fn(...(best.args || [])); } catch (e) { S.errors.push(String(e && e.stack || e).slice(0, 300)); }
			if (guard % 16 === 15) await sync();
		}
	}

	// Input. Chrome hands touch and mouse moves to the page at one of its real rendering frames, which for a 3D page can
	// come hundreds of ms after the worker's CDP call has returned: a move sent before a step was seen before the frame,
	// during it or after it, depending on the machine. So the page counts the input it receives (each event Chrome
	// hands over once: its pointer and touch events share a timestamp; mouse events are left out, as a tap's
	// compatibility mouse events are not the worker's), touch and mouse apart (headless Chrome moves the mouse to 0,0
	// on its own), the worker counts what it sent, and a step first waits (real time, capped) until the two agree. The
	// counts are returned so the worker can resync after an event Chrome dropped.
	const INPUT_WAIT_MS = CFG.inputWaitMs || 2000;
	const inputStats = { touch: 0, mouse: 0, waits: 0, waitMs: 0, maxWaitMs: 0, timeouts: 0 };
	const lastTs = { touch: -1, mouse: -1 };
	let inputWaiter = null;
	const inputIn = (want) => inputStats.touch >= want.touch && inputStats.mouse >= want.mouse;
	const countInput = (e) => {
		if (!e.isTrusted) return;
		const kind = e.pointerType === undefined ? "touch" : e.pointerType; // a TouchEvent has no pointerType
		if (kind !== "touch" && kind !== "mouse") return;
		const ts = nativeTimeStamp.call(e);
		if (ts === lastTs[kind]) return;
		lastTs[kind] = ts;
		inputStats[kind]++;
		if (inputWaiter && inputIn(inputWaiter.want)) inputWaiter.done();
	};
	for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel"]) {
		nativeAddListener.call(window, t, countInput, { capture: true, passive: true });
	}
	const inputHandled = (want) => new Promise((r) => {
		const t0 = realPerfNow();
		const end = (timedOut) => {
			realClearTimeout(timer);
			inputWaiter = null;
			const ms = realPerfNow() - t0;
			inputStats.waits++; inputStats.waitMs += ms; inputStats.maxWaitMs = Math.max(inputStats.maxWaitMs, ms);
			if (timedOut) inputStats.timeouts++;
			r();
		};
		const timer = realSetTimeout(() => end(true), INPUT_WAIT_MS);
		inputWaiter = { want, done: () => end(false) };
	});
	S.inputStats = () => ({ ...inputStats });

	/** Advance n frames of 1/fps seconds each. Resolves when the frame's callbacks (and their microtasks) have run,
	 *  and the asset work they started has finished (it is delivered in the next frame). `input`: how many touch and
	 *  mouse events the worker has sent so far, {touch, mouse}; they are handled before the frame starts. */
	S.step = async (n = 1, input = null) => {
		const t0 = realPerfNow();
		if (input && !inputIn(input)) await inputHandled(input);
		if (S.frame === 0 && js.made > js.ran) js.watch = realPerfNow(); // modules the page started importing as it loaded
		for (let i = 0; i < n; i++) {
			await sync(); // work started since the last frame (touch handlers, page load) finishes...
			deliverDone(); // ... and everything finished lands in this frame
			if (S.drift) { S.now += S.drift; S.drift = 0; }
			S.reads = 0;
			const target = S.now + S.dt;
			await runTimersUntil(target);
			S.now = target;
			await sync(true);
			const q = S.raf;
			S.raf = new Map();
			for (const cb of q.values()) {
				try { cb(S.now); } catch (e) { S.errors.push(String(e && e.stack || e).slice(0, 300)); }
			}
			syncAnimations();
			S.frame++;
			await sync(); // the screenshot after this step sees the frame's work done, whatever the machine's speed
		}
		return { now: S.now, frame: S.frame, ms: realPerfNow() - t0, pendingRaf: S.raf.size, timers: S.timers.size, input: { touch: inputStats.touch, mouse: inputStats.mouse } };
	};

	// ------------------------------------------------------------------ 1b. asset work in game time
	// Decoding pictures, reading data:/blob: URLs and blobs, loading fonts and scripts all finish on the real clock: when,
	// in game frames, depends on the machine, and a game whose boot (and so every random draw after it) follows them
	// plays out differently on every run. Under the virtual clock each request is an op (track, above): the frame waits
	// at its sync points until the work is done, and the result (promise, load/error event, callback) is delivered from
	// a virtual timer at the start of the next frame, in request order. A chain (fetch -> blob -> createImageBitmap)
	// takes one frame per link, whatever the machine.
	if (CFG.frozen) {
		const W = window;
		const wrapAsync = (proto, name, kind) => {
			const orig = proto && proto[name];
			if (typeof orig === "function") proto[name] = function (...a) { return defer(kind, orig.apply(this, a)); };
		};
		if (typeof W.createImageBitmap === "function") { const n = W.createImageBitmap; W.createImageBitmap = function (...a) { return defer("createImageBitmap", n.apply(W, a)); }; }
		if (typeof W.fetch === "function") { const n = W.fetch; W.fetch = function (...a) { return defer("fetch", n.apply(W, a)); }; }
		for (const m of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
			wrapAsync(W.Response && Response.prototype, m, "response." + m);
			wrapAsync(W.Request && Request.prototype, m, "request." + m);
		}
		for (const m of ["arrayBuffer", "bytes", "text"]) wrapAsync(W.Blob && Blob.prototype, m, "blob." + m);
		wrapAsync(W.HTMLImageElement && HTMLImageElement.prototype, "decode", "img.decode");
		wrapAsync(W.OffscreenCanvas && OffscreenCanvas.prototype, "convertToBlob", "convertToBlob");
		if (W.HTMLCanvasElement && typeof HTMLCanvasElement.prototype.toBlob === "function") {
			const n = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = function (cb, ...a) {
				let res;
				const job = new Promise((r) => { res = r; });
				n.call(this, (b) => res(b), ...a); // throws (a tainted canvas) before anything is tracked
				track("toBlob", job, (r) => { if (typeof cb === "function") cb(r.v); });
			};
		}
		// Fonts: FontFaceSet.load / .ready and FontFace.load / .loaded. Fonts a stylesheet starts loading on first use are
		// waited for too (settle), so text is drawn in its font from a fixed frame on.
		if (W.FontFaceSet) {
			const FS = FontFaceSet.prototype;
			wrapAsync(FS, "load", "fonts.load");
			const rd = Object.getOwnPropertyDescriptor(FS, "ready"), sd = Object.getOwnPropertyDescriptor(FS, "status");
			if (rd && rd.get && rd.configurable) {
				Object.defineProperty(FS, "ready", { ...rd, get() { return defer("fonts.ready", rd.get.call(this)); } });
				if (sd && sd.get) fontsLoading = () => { const f = document.fonts; return f && sd.get.call(f) === "loading" ? rd.get.call(f) : null; };
			}
		}
		if (W.FontFace) {
			wrapAsync(FontFace.prototype, "load", "font.load");
			const ld = Object.getOwnPropertyDescriptor(FontFace.prototype, "loaded");
			if (ld && ld.get && ld.configurable) Object.defineProperty(FontFace.prototype, "loaded", { ...ld, get() { return defer("font.loaded", ld.get.call(this)); } });
		}
		// <img> and <script src> load/error events. Our capture listener at the element runs before the game's own: it
		// stops the browser's event and the op dispatches it again (untrusted) when delivered. A new src before the
		// picture finished replaces the op, as the browser drops the old request.
		const held = new WeakMap(); // element -> its current load op
		const listening = new WeakSet();
		function hold(ev) {
			const op = held.get(this);
			if (!ev.isTrusted || !op) return;
			ev.stopImmediatePropagation();
			op.finish(ev.type);
		}
		const drop = (el) => { const op = held.get(el); if (op && !op.done) { op.cancelled = true; op.finish(null); held.delete(el); } };
		const trackLoad = (el, kind, blocking) => {
			const prev = held.get(el);
			if (prev && !prev.done) { prev.cancelled = true; prev.finish(null); }
			let finish;
			const op = track(kind, new Promise((r) => { finish = r; }), (r) => {
				if (held.get(el) === op) held.delete(el);
				if (r.v) el.dispatchEvent(new Event(r.v));
			}, blocking);
			op.finish = finish;
			held.set(el, op);
			if (!listening.has(el)) { listening.add(el); nativeAddListener.call(el, "load", hold, true); nativeAddListener.call(el, "error", hold, true); }
		};
		const startImg = (el) => { if (el.loading !== "lazy") trackLoad(el, "img", null); }; // a lazy picture off screen never loads
		// A script loads once it is in the document; one already in it with a src has run (a new src does nothing).
		const startScript = (el) => { if (!el.isConnected) trackLoad(el, "script", () => el.isConnected); };
		const onSet = (C, props, start) => {
			for (const prop of props) {
				const d = C && Object.getOwnPropertyDescriptor(C.prototype, prop);
				if (d && d.set && d.configurable) Object.defineProperty(C.prototype, prop, { ...d, set(v) { try { start(this); } catch (_) {} return d.set.call(this, v); } });
			}
		};
		onSet(W.HTMLImageElement, ["src", "srcset"], startImg);
		onSet(W.HTMLScriptElement, ["src"], startScript);
		const nSetAttr = Element.prototype.setAttribute, nRemoveAttr = Element.prototype.removeAttribute;
		Element.prototype.setAttribute = function (name, value) {
			try {
				const k = String(name).toLowerCase();
				if ((k === "src" || k === "srcset") && W.HTMLImageElement && this instanceof HTMLImageElement) startImg(this);
				else if (k === "src" && W.HTMLScriptElement && this instanceof HTMLScriptElement) startScript(this);
			} catch (_) {}
			return nSetAttr.apply(this, arguments);
		};
		Element.prototype.removeAttribute = function (name) {
			try { // a picture left without a source fires no event
				const k = String(name).toLowerCase();
				if ((k === "src" || k === "srcset") && W.HTMLImageElement && this instanceof HTMLImageElement && !this.hasAttribute(k === "src" ? "srcset" : "src")) drop(this);
			} catch (_) {}
			return nRemoveAttr.apply(this, arguments);
		};
		// KHR_parallel_shader_compile: COMPLETION_STATUS_KHR, polled from a (virtual) timer by three.js's compileAsync,
		// turns true some real milliseconds after the compile starts. It reports done on the first poll: the program
		// still compiles in parallel, and its first use waits for it.
		for (const C of [W.WebGLRenderingContext, W.WebGL2RenderingContext]) {
			if (!C) continue;
			for (const m of ["getProgramParameter", "getShaderParameter"]) {
				const n = C.prototype[m];
				if (typeof n === "function") C.prototype[m] = function (obj, pname) { return pname === 0x91b1 ? true : n.call(this, obj, pname); };
			}
		}
		// requestIdleCallback is already a virtual timer (section 1).

		// import() of a module built from a blob (playables that pack their code) loads and runs on the real clock, and
		// the import itself cannot be seen from here. Each JavaScript blob gets a last statement that reports its run
		// (valid in a classic script and in a module); a sync point waits for a chain of them to go quiet: after a module
		// ran, and, while some have yet to run, after a frame's delivered work (whose continuation may import the first).
		const JS_TYPE = /^\s*(text|application)\/(x-)?(javascript|ecmascript|jscript)\b/i;
		const NBlob = W.Blob;
		if (NBlob) {
			S._jsRan = () => { js.ran++; js.lastRan = realPerfNow(); };
			const SimBlob = function Blob(parts, opts) {
				if (!new.target) throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
				try {
					if (opts && JS_TYPE.test(String(opts.type || "")) && parts != null && typeof parts[Symbol.iterator] === "function") {
						parts = [...parts, "\n;globalThis.__sim && __sim._jsRan && __sim._jsRan();\n"];
						js.made++;
					}
				} catch (_) {}
				return Reflect.construct(NBlob, opts === undefined ? [parts] : [parts, opts], new.target === SimBlob ? NBlob : new.target);
			};
			SimBlob.prototype = NBlob.prototype;
			try { Object.defineProperty(NBlob.prototype, "constructor", { value: SimBlob, configurable: true, writable: true }); } catch (_) {}
			W.Blob = SimBlob;
		}
	}

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

		// decodeAudioData finishes on the real clock: a game that skips a sound until its buffer is ready (drawing its
		// random pitch only when it plays) would play out differently on every run. It is asset work like any other
		// (section 1b): finished before the next frame is stepped, delivered in it.
		const nDecode = BAC.prototype.decodeAudioData;
		BAC.prototype.decodeAudioData = function (data, ok, fail) {
			if (!V || this !== V.ctx) return nDecode.apply(this, arguments);
			let settle;
			const out = new Promise((res, rej) => { settle = { res, rej }; });
			track("decodeAudioData", nDecode.call(this, data), (r) => {
				if ("v" in r) { settle.res(r.v); if (typeof ok === "function") try { ok(r.v); } catch (e) { err(e); } }
				else { settle.rej(r.e); if (typeof fail === "function") try { fail(r.e); } catch (e) { err(e); } }
			});
			return out;
		};

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
