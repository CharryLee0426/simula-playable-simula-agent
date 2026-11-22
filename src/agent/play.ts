// The play phase: load the playable, learn it and play it like a person, record every frame.
//
//   boot ─► loop { observe ─► [planner (VLM) ‖ decider checks] ─► validate ─► humanize ─► act ─► watch } ─► end card
//
// The game clock is frozen between worker calls, so model latency never appears on video; the only delays the viewer
// sees are the humanizer's reaction/reading times. Nothing in here knows any particular game: the planner reads the
// screen, the DOM (when there is one) and which input events the game listens to, and keeps its own notes.
import { join, resolve } from "node:path";
import { BrowserWorker, type DomCandidate, type Observation, type Op } from "../browser/worker.ts";
import { BudgetExceeded } from "../ledger.ts";
import { chatJson, choice, decide, noul, type Answer } from "../llm.ts";
import { sc } from "../runtime.ts";
import { ROOT } from "../config.ts";
import { appendJsonl, errMsg, Rng, run, writeJson } from "../util/core.ts";
import { Humanizer, PERSONAS, type Gesture, type Performed, type Pt } from "./humanize.ts";

export type PlanAction = {
	type: "tap" | "drag" | "hold" | "swipe" | "wait";
	point?: [number, number];
	target?: number;
	path?: [number, number][];
	path_targets?: number[];
	duration_ms?: number;
	direction?: "up" | "down" | "left" | "right";
	intent?: string;
};
export type Plan = { screen: string; phase: string; progress: string; notes: string; actions: PlanAction[]; watch_ms: number };
export type ActionRecord = {
	i: number; turn: number; kind: string; intent: string; t0: number; t1: number; f0: number; f1: number;
	touches: Performed["touches"]; slipped: boolean; reaction_ms: number; target_label?: string;
};
export type ObsRecord = {
	n: number; turn: number; t: number; frame: number; path: string; marks_path?: string; change: number; changed_frac: number;
	luma: number; dom: number; phase?: string; phase_p?: number; clarity?: number; effect?: number; planner_phase?: string;
};
export type SessionSummary = {
	game_s: number; frames: number; fps: number; planner_calls: number; planner_failures: number; actions: number; turns: number;
	end_card_at?: number; cta_tapped: boolean; ended_by: string; input_mode: "touch" | "mouse"; persona: string; gl: string | null;
	listeners: Record<string, number>; events: unknown[]; audio: unknown; perf: unknown; title: string; frame_size: [number, number];
	notes: string; stuck_events: number;
};

const PHASES = ["loading", "title", "tutorial", "gameplay", "reward", "level_end", "fail", "end_card", "other"];

const SYSTEM = `You are playing a mobile HTML5 game (a "playable ad") on a phone, like a real person who has never seen it before, so that a gameplay video can be recorded. The game is paused while you think. You see one screenshot per turn.

What a good session looks like:
1. You work out how to play from what is on screen: tutorial hands and arrows, instruction text, buttons, the layout. Follow tutorial hints first.
2. You play competently and keep the action going: engage with the core loop, make progress toward the game's goal, and use the game's features when they appear (upgrades, new units, abilities, merges, purchases, power-ups). A real player tries what the game offers instead of repeating one move forever.
3. When a popup or reward appears, deal with it like a player (claim, continue, choose).
4. When the game shows its end card (install / download / play-now call to action), report phase "end_card". Your final action there is ONE tap on the main install/play button.

Coordinates: every point is [y, x] in normalized 0-1000 screen coordinates (0,0 = top-left, 1000,1000 = bottom-right). If numbered interactive elements are listed (also drawn as pink numbered tags on the image), you may use "target": n instead of a point; prefer targets when they exist.

Gestures (the "actions" list, executed in order with natural human timing between them):
- {"type":"tap","point":[y,x]} or {"type":"tap","target":n}
- {"type":"drag","path":[[y,x],[y,x],...],"duration_ms":N} press at the first point, move through the others, release at the last. Use it to aim/launch/slingshot (pull away from the target), steer with a virtual joystick (press on the stick and move toward the direction; long duration = keep moving), draw, drag items, or connect tiles/letters (a path through the tile centres; "path_targets":[n,...] connects numbered elements).
- {"type":"hold","point":[y,x],"duration_ms":N}
- {"type":"swipe","point":[y,x],"direction":"up|down|left|right"} a quick flick.
- {"type":"wait","duration_ms":N} watch without touching (rewards animating, enemies approaching, a shot flying).
Give 1-4 actions per turn: several when you are confident (a sequence of taps, several words, a steering path), one when the next step depends on the result. Every action gets a short "intent".
"watch_ms" (300-2500) is how long the game runs after your actions before your next screenshot: short for fast action, longer when something needs time to play out.

Reply with one JSON object:
{"screen": "what is on screen now, short",
 "phase": "loading|title|tutorial|gameplay|reward|level_end|fail|end_card|other",
 "progress": "did my last actions work, what changed (short)",
 "notes": "your running notes about THIS game, rewritten every turn, <= 500 chars: goal, controls that work, what failed, features seen, what to try next",
 "actions": [...],
 "watch_ms": N}`;

function describeListeners(L: Record<string, number>): string {
	const keys = Object.keys(L);
	const has = (re: RegExp) => keys.some((k) => re.test(k));
	const out: string[] = [];
	if (has(/^(touchmove|pointermove|mousemove)@/)) out.push("tracks finger movement (drag / aim / joystick / swipe gestures are supported)");
	if (has(/^(touchstart|pointerdown|mousedown|click)@/)) out.push("reacts to presses and taps");
	if (has(/^wheel@/)) out.push("has a wheel/zoom handler");
	if (has(/^key/)) out.push("has keyboard handlers (not available on a phone: ignore)");
	return out.length ? out.join("; ") : "no input listeners registered yet (still booting, or input handled elsewhere)";
}

function domList(dom: DomCandidate[], vw: number, vh: number): string {
	return dom.map((c, i) => `${i + 1}) ${c.tag}${c.label ? ` "${c.label}"` : ""} at [${Math.round(((c.y + c.h / 2) / vh) * 1000)}, ${Math.round(((c.x + c.w / 2) / vw) * 1000)}] size ${Math.round(c.w)}x${Math.round(c.h)}px`).join("\n");
}

function validatePlan(p: Plan, domCount: number): string[] {
	const e: string[] = [];
	if (!p || typeof p !== "object") return ["answer must be a JSON object"];
	if (!PHASES.includes(p.phase)) e.push(`phase must be one of ${PHASES.join("|")}`);
	if (!Array.isArray(p.actions)) return [...e, "actions must be an array"];
	if (p.actions.length > 6) e.push("at most 6 actions per turn");
	if (p.actions.length === 0 && p.phase !== "end_card" && p.phase !== "loading") e.push("give at least one action (use wait if you want to watch)");
	const pt = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && n >= 0 && n <= 1000);
	p.actions.forEach((a, i) => {
		const k = `action ${i + 1} (${a?.type})`;
		if (!a || !["tap", "drag", "hold", "swipe", "wait"].includes(a.type)) return void e.push(`${k}: type must be tap|drag|hold|swipe|wait`);
		const tgtOk = (t: unknown) => typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= domCount;
		if (a.type === "tap" || a.type === "hold" || a.type === "swipe") {
			if (!pt(a.point) && !tgtOk(a.target)) e.push(`${k}: needs "point":[y,x] in 0-1000${domCount ? ` or "target":1..${domCount}` : ""}`);
		}
		if (a.type === "swipe" && !["up", "down", "left", "right"].includes(String(a.direction))) e.push(`${k}: direction must be up|down|left|right`);
		if (a.type === "drag") {
			const okPath = Array.isArray(a.path) && a.path.length >= 2 && a.path.every(pt);
			const okT = Array.isArray(a.path_targets) && a.path_targets.length >= 2 && a.path_targets.every(tgtOk);
			if (!okPath && !okT) e.push(`${k}: needs "path" with >= 2 [y,x] points in 0-1000${domCount ? ` or "path_targets" with >= 2 element numbers` : ""}`);
		}
		if (a.duration_ms !== undefined && (typeof a.duration_ms !== "number" || a.duration_ms < 0 || a.duration_ms > 6000)) e.push(`${k}: duration_ms must be 0-6000`);
	});
	return e;
}

/** Plan action (normalized coords / element numbers) -> gesture in CSS px. */
function toGesture(a: PlanAction, dom: DomCandidate[], vw: number, vh: number): { g: Gesture; label?: string } {
	const P = (v: [number, number]): Pt => ({ x: (v[1] / 1000) * vw, y: (v[0] / 1000) * vh });
	const T = (n: number) => dom[n - 1]!;
	const center = (c: DomCandidate): Pt => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
	if (a.type === "wait") return { g: { kind: "wait", points: [], durationMs: Math.min(4000, Math.max(200, a.duration_ms ?? 800)) } };
	if (a.type === "drag") {
		if (a.path_targets?.length && a.path_targets.every((n) => dom[n - 1])) {
			return { g: { kind: "drag", points: a.path_targets.map((n) => center(T(n))), durationMs: a.duration_ms ?? 260 * a.path_targets.length }, label: a.path_targets.map((n) => T(n).label).join(" → ") };
		}
		return { g: { kind: "drag", points: a.path!.map(P), durationMs: a.duration_ms } };
	}
	const tgt = a.target && dom[a.target - 1] ? dom[a.target - 1] : undefined;
	const p0 = tgt ? center(tgt) : P(a.point!);
	if (a.type === "swipe") {
		const d = 0.22 * Math.min(vw, vh) * 1.6;
		const dir = { up: [0, -d], down: [0, d], left: [-d, 0], right: [d, 0] }[a.direction ?? "up"]!;
		return { g: { kind: "swipe", points: [p0, { x: p0.x + dir[0]!, y: p0.y + dir[1]! }] }, label: tgt?.label };
	}
	return { g: { kind: a.type, points: [p0], durationMs: a.duration_ms, target: tgt ? { x: tgt.x, y: tgt.y, w: tgt.w, h: tgt.h } : undefined }, label: tgt?.label };
}

/** The calibration baseline's policy: uniform random taps and drags anywhere on screen. */
function randomPlan(rng: Rng): Plan {
	const p = (): [number, number] => [Math.round(100 + rng.next() * 800), Math.round(60 + rng.next() * 880)];
	const actions: PlanAction[] = Array.from({ length: 1 + rng.int(3) }, () => (rng.next() < 0.6 ? { type: "tap", point: p(), intent: "random tap" } : { type: "drag", path: [p(), p()], duration_ms: 250, intent: "random drag" }));
	return { screen: "(random policy)", phase: "other", progress: "", notes: "", actions, watch_ms: 200 };
}

/** Generic probes for when the planner is unavailable: they exercise the common control schemes. */
function fallbackPlan(turn: number): Plan {
	const probes: PlanAction[][] = [
		[{ type: "tap", point: [500, 500], intent: "probe: tap centre" }],
		[{ type: "drag", path: [[700, 500], [450, 500]], duration_ms: 500, intent: "probe: drag up" }],
		[{ type: "tap", point: [780, 500], intent: "probe: tap lower centre" }],
		[{ type: "drag", path: [[650, 300], [650, 700]], duration_ms: 600, intent: "probe: drag sideways" }],
	];
	return { screen: "(planner unavailable)", phase: "other", progress: "", notes: "", actions: probes[turn % probes.length]!, watch_ms: 900 };
}

export async function playSession(playable: string): Promise<SessionSummary> {
	const { cfg, paths, ledger, trace } = sc();
	const [vw, vh] = cfg.browser.viewport;
	const fps = cfg.browser.fps;
	const persona = PERSONAS[cfg.play.persona] ?? PERSONAS.casual_competent!;
	const hz = new Humanizer(persona, `${cfg.browser.seed}|human`, fps, [vw, vh]);
	const w = new BrowserWorker(join(paths.dir, "worker.log"));
	const tNow = (o: { summary: { now: number } }) => o.summary.now / 1000;
	let plannerCalls = 0, plannerFailures = 0, stuckEvents = 0, actionsDone = 0;
	let notes = "";
	let endCardAt: number | undefined;
	let ctaTapped = false;
	let endedBy = "time_limit";
	const history: ActionRecord[] = [];
	// Calibration baseline: "random" plays uniformly random gestures with machine timing and no model at all.
	const robot = cfg.play.policy === "random";
	const rng = new Rng(`${cfg.browser.seed}|random-policy`);

	const opened = await w.open({ playable: resolve(playable), run_dir: paths.dir, viewport: [vw, vh], dpr: cfg.browser.dpr, fps, seed: cfg.browser.seed, display: cfg.browser.display });
	trace.emit("play", "boot", `loaded in ${opened.load_s}s · ${opened.frame_size.join("×")} @ ${fps} fps · GL: ${opened.gl ?? "none"} · "${opened.summary.title}"`, opened);

	const deciderObs = async (o: Observation, before?: Observation, intents?: string): Promise<Record<string, Answer> | null> => {
		const questions: Record<string, any> = {
			phase: { type: "choice", instructions: "What kind of screen is this mobile game showing?", criteria: {
				loading: "loading or progress screen, splash", title: "title or start screen waiting for the player", tutorial: "gameplay with tutorial hints (hand, arrow, highlighted target, instruction text)",
				gameplay: "normal gameplay", reward: "reward, upgrade, level-up or shop popup", level_end: "level complete / victory / results screen", fail: "game over / fail / retry screen",
				end_card: "end card: install / download / play-now call to action for the full game", other: "something else" } },
			clarity: { type: "noul", instructions: "A first-time player looking at this screen would know what to do next." },
		};
		const state: any[] = ["Screenshot of a mobile game (portrait phone):", { image: o.path }];
		if (before && intents) {
			questions.effect = { type: "noul", instructions: `Compared with the BEFORE screenshot, the player's actions (${intents.slice(0, 200)}) visibly had their intended effect.` };
			state.unshift("BEFORE the player's last actions:", { image: before.path });
		}
		const r = await decide({ model: cfg.models.decider, state, questions, ledger, phase: "play" });
		return r?.answers ?? null;
	};

	const recordObs = (o: Observation, turn: number, d: Record<string, Answer> | null, plannerPhase?: string): ObsRecord => {
		const ph = d?.phase;
		const rec: ObsRecord = {
			n: o.n, turn, t: tNow(o), frame: o.summary.frame, path: o.path, marks_path: o.marks_path, change: o.change, changed_frac: o.changed_frac, luma: o.luma,
			dom: o.dom?.length ?? 0, phase: choice(ph), phase_p: ph && ph.type === "choice" ? ph.probabilities[ph.choice] : undefined,
			clarity: noul(d?.clarity), effect: noul(d?.effect), planner_phase: plannerPhase,
		};
		appendJsonl(paths.observations, rec);
		return rec;
	};

	try {
		// ---------------------------------------------------------------- boot: run until the loading screen is gone
		let obs = await w.observe({ width: vw, dom: true });
		for (let t = 0; t < cfg.play.boot_max_s; t += 0.5) {
			await w.step(Math.round(fps / 2));
			obs = await w.observe({ width: vw, dom: true });
			if (tNow(obs) < 1.5) continue;
			const d = await deciderObs(obs);
			const ph = choice(d?.phase);
			recordObs(obs, 0, d);
			if ((ph && ph !== "loading") || (!d && obs.change < 0.02)) break;
		}
		const L = obs.summary.listeners;
		const keys = Object.keys(L);
		const inputMode: "touch" | "mouse" = !keys.some((k) => /^(touch|pointer)/.test(k)) && keys.some((k) => /^mouse/.test(k)) ? "mouse" : "touch";
		trace.emit("play", "boot", `ready at t=${tNow(obs).toFixed(1)}s · input ${inputMode} · listeners: ${describeListeners(L)}`, { listeners: L, dom: obs.dom?.length ?? 0 }, { game_t: tNow(obs) });

		// ---------------------------------------------------------------- the loop
		let prevObs: Observation | undefined;
		let lastIntents = "";
		let noEffectStreak = 0;
		for (let turn = 1; ; turn++) {
			const t = tNow(obs);
			if (t >= cfg.play.max_game_s) { endedBy = "time_limit"; break; }
			if (plannerCalls >= cfg.play.max_planner_calls) { endedBy = "planner_call_limit"; break; }
			const dom = obs.dom ?? [];
			const recent = history.slice(-6).map((a) => `- t=${a.t0.toFixed(1)}s ${a.kind}${a.target_label ? ` "${a.target_label}"` : ""}: ${a.intent}${a.slipped ? " (finger slipped)" : ""}`).join("\n");
			const events = obs.summary.events.filter((e) => e.kind !== "network").slice(-5).map((e) => `${e.kind}${e.type ? ` ${e.type}` : ""}${e.via ? ` via ${e.via}` : ""} at t=${(e.t / 1000).toFixed(1)}s`);
			const text = [
				`Turn ${turn}. Game time ${t.toFixed(1)}s (the session ends at ${cfg.play.max_game_s}s). Planner turns left: ${cfg.play.max_planner_calls - plannerCalls}.`,
				`The game ${describeListeners(obs.summary.listeners)}.`,
				notes ? `Your notes so far:\n${notes}` : "This is your first look at the game.",
				recent ? `Your recent actions:\n${recent}` : "",
				prevObs ? `Visible change since your last screenshot: ${(obs.changed_frac * 100).toFixed(0)}% of the screen.` : "",
				noEffectStreak >= cfg.play.stuck_after ? `WARNING: your last ${noEffectStreak} turns had no visible effect. Do something different: another location, another gesture type (drag instead of tap, or the reverse), or look for a button/hint you missed.` : "",
				events.length ? `Signals from the game: ${events.join("; ")}.` : "",
				dom.length ? `Numbered interactive elements (HTML):\n${domList(dom, vw, vh)}` : "",
			].filter(Boolean).join("\n\n");

			// Planner (VLM) and decider checks run concurrently on the same frozen frame.
			let plan: Plan;
			let planMs = 0, planUsd = 0, planErr: string | undefined;
			const [dec, planRes] = robot ? [null, { value: randomPlan(rng), ms: 0, usd: 0 }] : await Promise.all([
				deciderObs(obs, prevObs, lastIntents).catch(() => null),
				chatJson<Plan>({ model: cfg.models.planner, reasoning: cfg.models.planner_reasoning, system: SYSTEM, ledger, phase: "play", kind: "planner",
					parts: [{ text }, { image: obs.marks_path ?? obs.path }], validate: (p) => validatePlan(p, dom.length), maxTokens: 4000, estimateUsd: 0.015 })
					.then((r) => r, (e) => e as Error),
			]);
			if (!robot) plannerCalls++;
			if (planRes instanceof Error) {
				plannerFailures++;
				planErr = errMsg(planRes);
				if (planRes instanceof BudgetExceeded) { trace.emit("play", "warn", `budget reached: ${planErr}`, undefined, { game_t: t }); endedBy = "budget"; break; }
				trace.emit("play", "warn", `planner failed (${planErr.slice(0, 160)}); using a generic probe`, undefined, { game_t: t });
				plan = fallbackPlan(turn);
			} else {
				plan = planRes.value;
				planMs = planRes.ms;
				planUsd = planRes.usd;
				notes = String(plan.notes ?? notes).slice(0, 700);
			}
			const orec = recordObs(obs, turn, dec, plan.phase);
			if (orec.effect !== undefined && prevObs) noEffectStreak = orec.effect < 0.3 && obs.changed_frac < 0.03 ? noEffectStreak + 1 : 0;
			else if (prevObs) noEffectStreak = obs.changed_frac < 0.01 ? noEffectStreak + 1 : 0;
			if (noEffectStreak === cfg.play.stuck_after) { stuckEvents++; trace.emit("play", "stuck", `no visible effect for ${noEffectStreak} turns`, { last: lastIntents }, { game_t: t }); }
			appendJsonl(paths.plans, { turn, obs: obs.n, t, ms: planMs, usd: planUsd, error: planErr, plan, decider: { phase: orec.phase, phase_p: orec.phase_p, clarity: orec.clarity, effect: orec.effect } });
			trace.emit("play", "plan", `turn ${turn} [${plan.phase}] ${plan.screen?.slice(0, 90)} → ${plan.actions.map((a) => `${a.type}${a.intent ? `(${a.intent.slice(0, 40)})` : ""}`).join(", ") || "no action"}`,
				{ turn, obs: obs.n, ms: planMs, decider_phase: orec.phase, clarity: orec.clarity, effect: orec.effect }, { game_t: t });

			// ------------------------------------------------------------ end card: let it breathe, tap the CTA once, stop
			const deciderEnd = orec.phase === "end_card" && (orec.phase_p ?? 0) > 0.7;
			const ctaEvent = obs.summary.events.some((e) => e.kind === "cta");
			if (plan.phase === "end_card" || (deciderEnd && plan.phase !== "gameplay" && plan.phase !== "tutorial") || ctaEvent) {
				endCardAt ??= t;
				const hold = cfg.play.end_card_hold_s - (t - endCardAt);
				if (hold > 0) await w.step(hz.framesFor(hold * 1000));
				trace.emit("play", "end_card", `end card on screen since t=${endCardAt.toFixed(1)}s${ctaEvent ? " (the game already opened its store link)" : ""}`, undefined, { game_t: tNow(obs) + Math.max(0, hold) });
				const tap = plan.actions.find((a) => a.type === "tap");
				if (cfg.play.tap_cta_at_end && tap && !ctaEvent) {
					const { g, label } = toGesture(tap, dom, vw, vh);
					const pre = hz.reactionMs(false);
					await w.step(hz.framesFor(pre));
					const st = await w.call("eval", { expr: "__sim.frame" });
					const { ops, performed } = hz.compile(g, st.value, { allowSlip: false, mouse: inputMode === "mouse" });
					const r = await w.ops(ops);
					ctaTapped = true;
					history.push({ i: history.length, turn, kind: "tap", intent: tap.intent ?? "tap the install button", t0: (st.value / fps), t1: r.now / 1000, f0: st.value, f1: r.frame, touches: performed.touches, slipped: false, reaction_ms: pre, target_label: label });
					appendJsonl(paths.actions, history[history.length - 1]);
				}
				await w.step(Math.round(fps * 1.2));
				endedBy = "end_card";
				break;
			}

			// ------------------------------------------------------------ act
			const intents: string[] = [];
			for (let k = 0; k < plan.actions.length; k++) {
				const a = plan.actions[k]!;
				const delay = robot ? 1000 / fps : k === 0 ? hz.reactionMs(obs.changed_frac > 0.25 || turn === 1, turn === 1) : hz.chainGapMs();
				if (a.type !== "wait") await w.step(hz.framesFor(delay));
				const { g, label } = toGesture(a, dom, vw, vh);
				const st = await w.call<{ value: number }>("eval", { expr: "__sim.frame" });
				const { ops, performed } = hz.compile(g, st.value, { mouse: inputMode === "mouse", allowSlip: !robot });
				const r = await w.ops(ops);
				const rec: ActionRecord = { i: history.length, turn, kind: a.type, intent: a.intent ?? "", t0: st.value / fps, t1: r.now / 1000, f0: st.value, f1: r.frame, touches: performed.touches, slipped: performed.slipped, reaction_ms: a.type === "wait" ? 0 : delay, target_label: label };
				history.push(rec);
				appendJsonl(paths.actions, rec);
				if (a.type !== "wait") actionsDone++;
				intents.push(`${a.type}${label ? ` "${label}"` : ""}: ${a.intent ?? ""}`);
			}
			lastIntents = intents.join("; ");
			// ------------------------------------------------------------ watch
			const watch = robot ? 200 : Math.min(2500, Math.max(300, Number(plan.watch_ms) || 800));
			await w.step(hz.framesFor(watch));
			prevObs = obs;
			obs = await w.observe({ width: vw, dom: true });
		}

		// Never end on a cut-off action: a short tail of whatever is on screen.
		await w.step(Math.round(fps * 0.6));
		const closed = await w.close();
		const frames: number = closed.frames ?? 0;
		const gameS = frames / fps;
		trace.emit("play", "recording", `recorded ${frames} frames (${gameS.toFixed(1)}s of game time) · ${actionsDone} actions over ${plannerCalls} planner turns · ended by ${endedBy}`, { perf: closed.perf, audio: closed.audio });
		// Offline audio mix in game time, muxed with the video -> raw.mp4
		const py = join(ROOT, "py");
		const mix = await run(join(py, ".venv", "bin", "python"), ["-m", "simbrowser.audio", paths.dir, String(gameS)], { cwd: py }).catch((e) => ({ code: 1, stdout: "", stderr: errMsg(e) }));
		let audio: any = { has_audio: false };
		try { audio = JSON.parse(mix.stdout.trim().split("\n").pop() || "{}"); } catch { audio = { has_audio: false, error: mix.stderr.slice(-300) }; }
		trace.emit("play", "recording", `audio: ${audio.has_audio ? `${audio.sounds} sounds mixed (peak ${audio.peak})` : "no game audio captured"}${audio.skipped ? `, ${audio.skipped} skipped` : ""}`, audio);
		const summary: SessionSummary = {
			game_s: gameS, frames, fps, planner_calls: plannerCalls, planner_failures: plannerFailures, actions: actionsDone, turns: plannerCalls,
			end_card_at: endCardAt, cta_tapped: ctaTapped, ended_by: endedBy, input_mode: inputMode, persona: persona.name, gl: opened.gl,
			listeners: closed.summary?.listeners ?? L, events: closed.events ?? [], audio, perf: closed.perf, title: opened.summary.title,
			frame_size: opened.frame_size, notes, stuck_events: stuckEvents,
		};
		writeJson(paths.session, summary);
		return summary;
	} catch (e) {
		w.kill();
		throw e;
	}
}
