// The play phase: load the playable, learn it and play it like a person, record every frame.
//
//   boot ─► loop { observe ─► [planner (VLM) ‖ decider checks] ─► validate ─► humanize ─► act ─► watch } ─► end card
//
// The game clock is frozen between worker calls, so model latency never appears on video; the only delays the viewer
// sees are the humanizer's reaction/reading times. Nothing in here knows any particular game: the planner reads the
// screen, the DOM (when there is one) and which input events the game listens to, and keeps its own notes.
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserWorker, type DomCandidate, type Observation, type Op } from "../browser/worker.ts";
import { BudgetExceeded } from "../ledger.ts";
import { chatJson, choice, decide, noul, type Answer } from "../llm.ts";
import { sc } from "../runtime.ts";
import { ROOT } from "../config.ts";
import { appendJsonl, errMsg, Rng, run, writeJson } from "../util/core.ts";
import { Humanizer, PERSONAS, type Gesture, type Performed, type Pt } from "./humanize.ts";
import { applyDepth, depthLesson, depthStep, type CheckLog, type Fire } from "./zone.ts";

export type PlanAction = {
	type: "tap" | "drag" | "hold" | "swipe" | "wait" | "tap_when" | "react";
	/** react: a reflex policy for fast real-time play — situations watched every ~0.1 s, each with the gesture to fire. */
	situations?: Situation[];
	cooldown_ms?: number;
	/** react: attention window [y0, x0, y1, x1] (0-1000) — where a hazard must be to need a reaction now. */
	zone?: [number, number, number, number];
	/** react: centre [y, x] (0-1000) of the object the player controls; the zone then follows it. */
	player?: [number, number];
	player_size?: [number, number];
	/** a reflex gesture whose points move with the tracked player (e.g. drag the ship from where it is now). */
	relative_to_player?: boolean;
	/** tap_when: a visual condition checked frame by frame; the tap fires on the first frame where it holds. */
	condition?: string;
	timeout_ms?: number;
	point?: [number, number];
	target?: number;
	path?: [number, number][];
	path_targets?: number[];
	duration_ms?: number;
	direction?: "up" | "down" | "left" | "right";
	intent?: string;
};
export type Situation = { name: string; when: string; do?: PlanAction; /** going for a reward, not avoiding a hazard */ pickup?: boolean };
export type Plan = { screen: string; phase: string; progress: string; notes: string; actions: PlanAction[]; watch_ms: number };
export type ActionRecord = {
	i: number; turn: number; kind: string; intent: string; t0: number; t1: number; f0: number; f1: number;
	touches: Performed["touches"]; slipped: boolean; reaction_ms: number; target_label?: string;
	/** reflex actions: the frame the reflex reacted to */
	evidence?: string;
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

const TIMING_GESTURE = `- {"type":"tap_when","point":[y,x],"condition":"the sliding block is exactly above the tower","timeout_ms":N} for TIMING: when success depends on tapping at the right moment (a moving/sliding/swinging target, a power or timing meter, a rhythm cue), describe the visual moment to tap; the game is watched frame by frame and the tap fires when the condition holds (or at the timeout, max 6000).`;
const REFLEX_GESTURE = `- {"type":"react","duration_ms":N,"player":[y,x],"zone":[y0,x0,y1,x1],"situations":[{"name":"dodge_left","when":"a red block is in the same lane as the car and the lane to its left is empty","do":{"type":"swipe","point":[750,500],"direction":"left"}}, ...],"intent":"..."} when turn-by-turn play is TOO SLOW for the game: things reach the player between your screenshots (you got hit by something you had not seen yet), or the world rushes at the player at high speed (runners, tap-to-fly). For slower dodging prefer precise turn-by-turn moves with a short watch_ms (300-600): you can position exactly with drag/hold, which reflexes cannot. You define reflexes; the game is then watched every ~0.1 s and the gesture of whichever situation appears fires, with human reaction time, for duration_ms (1000-8000) or until play is interrupted (crash, popup, menu).
  "player" is the centre of the object YOU control on this screenshot (car, ship, character); it is tracked frame by frame and the zone moves with it, so the close-up always shows the player and what is around and ahead of it. Optional "player_size":[h,w] (0-1000, default [100,140]).
  "zone" is the attention window, drawn on this screenshot: the region where a hazard must be for it to need a reaction NOW — usually the area just ahead of the player and a little to each side, covering what reaches the player within ~0.5 s, including the player itself. Only that crop is watched, so "inside the zone" already means "close"; do not add distance words. Because the zone follows the player, describe situations relative to the player ("directly ahead of the player", "on the player's left").
  A "do" gesture with "relative_to_player": true moves with the player (e.g. a drag that starts on the ship).
  "situations": 2-5, mutually exclusive, each describing what is visible INSIDE the zone (what, which lane/side relative to the player) with a "do" gesture (tap|swipe|drag|hold). Cover every hazard type you have seen or the tutorial mentioned (e.g. a barrier you must jump, a block you must dodge), plus pickups if worth it (mark those "pickup": true). "none" is added automatically. If something new appears the policy hands control back to you early.
  Give react as the only action of its turn. Keep policies short (2000-3500 ms) while you are still learning the game, longer once it is familiar. The zone's depth is tuned automatically from hits (deeper when a hazard was seen too late, shallower when reactions came too early), so keep drawing it the same way; when a hit was a wrong reaction, fix the situations instead.`;
/** The planner prompt: reflex policies on by default (play.reflex_actions), the timing gesture only when play.timing_actions is on. */
const systemPrompt = (timing: boolean, reflex: boolean) =>
	SYSTEM.replace("Give 1-4 actions per turn", `${reflex ? `${REFLEX_GESTURE}\n` : ""}${timing ? `${TIMING_GESTURE}\n` : ""}Give 1-4 actions per turn`);
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

export function validatePlan(p: Plan, domCount: number): string[] {
	const e: string[] = [];
	if (!p || typeof p !== "object") return ["answer must be a JSON object"];
	if (!PHASES.includes(p.phase)) e.push(`phase must be one of ${PHASES.join("|")}`);
	if (!Array.isArray(p.actions)) return [...e, "actions must be an array"];
	if (p.actions.length > 6) e.push("at most 6 actions per turn");
	if (p.actions.length === 0 && p.phase !== "end_card" && p.phase !== "loading") e.push("give at least one action (use wait if you want to watch)");
	const pt = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && n >= 0 && n <= 1000);
	p.actions.forEach((a, i) => validateAction(a, `action ${i + 1} (${a?.type})`, domCount, e, true));
	if (p.actions.some((a) => a?.type === "react") && p.actions.length > 1) e.push("react must be the only action of its turn");
	return e;
}

function validateAction(a: PlanAction, k: string, domCount: number, e: string[], top: boolean): void {
		const pt = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && n >= 0 && n <= 1000);
		if (!a || !["tap", "drag", "hold", "swipe", "wait", "tap_when", "react"].includes(a.type)) return void e.push(`${k}: type must be tap|drag|hold|swipe|wait|tap_when|react`);
		if (a.type === "react") {
			if (!top) return void e.push(`${k}: a situation's "do" must be tap|swipe|drag|hold`);
			if (typeof a.duration_ms !== "number" || a.duration_ms < 500 || a.duration_ms > 8000) e.push(`${k}: react needs "duration_ms" 500-8000`);
			if (!Array.isArray(a.situations) || a.situations.length < 1 || a.situations.length > 6) return void e.push(`${k}: react needs 1-6 "situations"`);
			if (a.player !== undefined && !pt(a.player)) e.push(`${k}: "player" must be [y, x] in 0-1000 (the centre of the object you control)`);
			if (a.player_size !== undefined && !(Array.isArray(a.player_size) && a.player_size.length === 2 && a.player_size.every((n) => typeof n === "number" && n >= 20 && n <= 500))) e.push(`${k}: "player_size" must be [h, w] with values 20-500`);
			if (a.zone !== undefined && !(Array.isArray(a.zone) && a.zone.length === 4 && a.zone.every((n) => typeof n === "number" && n >= 0 && n <= 1000) && a.zone[2] - a.zone[0] >= 80 && a.zone[3] - a.zone[1] >= 80)) e.push(`${k}: "zone" must be [y0, x0, y1, x1] in 0-1000 with y1-y0 >= 80 and x1-x0 >= 80`);
			const names = new Set<string>();
			a.situations.forEach((s, j) => {
				const sk = `${k} situation ${j + 1}`;
				if (!s || typeof s.name !== "string" || !/^[a-z0-9_]{1,24}$/.test(s.name) || s.name === "none") e.push(`${sk}: "name" must be a short snake_case id (not "none")`);
				else if (names.has(s.name)) e.push(`${sk}: duplicate name ${s.name}`);
				else names.add(s.name);
				if (typeof s?.when !== "string" || s.when.trim().length < 8) e.push(`${sk}: "when" must describe the visual situation`);
				if (s?.pickup !== undefined && typeof s.pickup !== "boolean") e.push(`${sk}: "pickup" must be true or false`);
				if (!s?.do || !["tap", "swipe", "drag", "hold"].includes(s.do.type)) e.push(`${sk}: "do" must be a tap|swipe|drag|hold gesture`);
				else validateAction(s.do, `${sk} do`, domCount, e, false);
			});
			return;
		}
		if (!top && !["tap", "swipe", "drag", "hold"].includes(a.type)) return void e.push(`${k}: must be tap|swipe|drag|hold`);
		if (a.type === "tap_when" && (typeof a.condition !== "string" || a.condition.trim().length < 6)) e.push(`${k}: tap_when needs a "condition" describing the visual moment to tap`);
		if (a.type === "tap_when" && a.timeout_ms !== undefined && (typeof a.timeout_ms !== "number" || a.timeout_ms < 200 || a.timeout_ms > 6000)) e.push(`${k}: timeout_ms must be 200-6000`);
		const tgtOk = (t: unknown) => typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= domCount;
		if (a.type === "tap" || a.type === "hold" || a.type === "swipe" || a.type === "tap_when") {
			if (!pt(a.point) && !tgtOk(a.target)) e.push(`${k}: needs "point":[y,x] in 0-1000${domCount ? ` or "target":1..${domCount}` : ""}`);
		}
		if (a.type === "swipe" && !["up", "down", "left", "right"].includes(String(a.direction))) e.push(`${k}: direction must be up|down|left|right`);
		if (a.type === "drag") {
			const okPath = Array.isArray(a.path) && a.path.length >= 2 && a.path.every(pt);
			const okT = Array.isArray(a.path_targets) && a.path_targets.length >= 2 && a.path_targets.every(tgtOk);
			if (!okPath && !okT) e.push(`${k}: needs "path" with >= 2 [y,x] points in 0-1000${domCount ? ` or "path_targets" with >= 2 element numbers` : ""}`);
		}
		if (a.duration_ms !== undefined && (typeof a.duration_ms !== "number" || a.duration_ms < 0 || a.duration_ms > 6000)) e.push(`${k}: duration_ms must be 0-6000`);
}

/** Move a gesture's points by the player's displacement [dy, dx] (0-1000), clamped to the screen. */
function shiftAction(a: PlanAction, delta: [number, number]): PlanAction {
	const mv = (p: [number, number]): [number, number] => [Math.min(1000, Math.max(0, p[0] + delta[0])), Math.min(1000, Math.max(0, p[1] + delta[1]))];
	return { ...a, ...(a.point ? { point: mv(a.point) } : {}), ...(a.path ? { path: a.path.map(mv) } : {}) };
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
	return { g: { kind: a.type === "tap_when" || a.type === "react" ? "tap" : a.type, points: [p0], durationMs: a.duration_ms, target: tgt ? { x: tgt.x, y: tgt.y, w: tgt.w, h: tgt.h } : undefined }, label: tgt?.label };
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

	// ---------------------------------------------------------------- reflexes
	// A reflex policy (react): the planner named the situations and the gesture for each; now the game is stepped a few
	// frames at a time and the decider, on the frozen frame, says which situation is happening (one multi-option call,
	// ~0.3-0.7 s of wall time, invisible on video). A situation that wins fires its gesture after a human reflex delay,
	// then a short cooldown lets the move play out. Play interrupted (crash, popup, menu) hands control back to the planner.
	// How far beyond the planner's far edge the zone looks, learned from hits (0-1000 units). Session-wide: the game's
	// speed carries over from one policy to the next, and the planner keeps drawing the zone the same way.
	let depthAdj = 0;
	let hitCount = 0;
	const runReflex = async (a: PlanAction, turn: number, dom: DomCandidate[], inputMode: "touch" | "mouse") => {
		const sits = (a.situations ?? []).filter((x) => x.do);
		const criteria: Record<string, string> = {};
		for (const x of sits) criteria[x.name] = x.when;
		criteria.none = "none of the other situations: nothing needs a reaction right now";
		const checkEvery = Math.max(1, Math.round((cfg.play.reflex_check_ms ?? 100) / (1000 / fps)));
		const threshold = cfg.play.reflex_threshold ?? 0.33;
		let frame = (await w.call<{ value: number }>("eval", { expr: "__sim.frame" })).value;
		const startT = frame / fps;
		const end = frame + hz.framesFor(Math.min(8000, Math.max(500, a.duration_ms ?? 4000)));
		const counts: Record<string, number> = {};
		const log: Record<string, unknown>[] = [];
		let checks = 0, fired = 0, ended = "duration";
		let lastFired: { name: string; frame: number } | undefined;
		// Follow the player: the planner said where the object it controls is; the worker tracks it frame to frame and
		// moves the attention zone with it, so the decider always sees the area around and ahead of the player.
		const tracking = !!a.player && cfg.play.reflex_follow_player !== false;
		let template: string | undefined;
		if (tracking) template = (await w.call<{ template: string }>("track_init", { point: a.player, size: a.player_size ?? [100, 140] })).template;
		let delta: [number, number] = [0, 0]; // player displacement since the policy started, [dy, dx] in 0-1000
		let player: [number, number] | undefined = a.player;
		const side = (x: number) => (x < 333 ? "left third" : x > 667 ? "right third" : "middle");
		// Walls are learned, not known: a reflex that should move the player sideways but leaves the tracked position
		// unchanged hit an edge — suppress it for a while and take the best other action instead (a person pressing
		// against the wall notices and goes the other way).
		const blocked = new Map<string, number>();
		let pending: { name: string; sign: number; x0: number; conf: number } | undefined;
		let lastConf = 1;
		// Getting hit teaches the zone's depth. The worker flags two generic impact signatures in the recorded frames — a
		// flash/shake (a spike of on-screen change with a jump in brightness) and a sudden freeze (a crash popup stops
		// the world) — and one decider question on the whole screen confirms it, because pickups flash and tutorial
		// prompts pause too. The periodic full-screen look asks the same question, for hits neither signature caught;
		// the worker then dates the impact from the frames since the previous look. The lead time of the last reaction
		// says whether the zone saw the hazard too late (deeper) or reacted too early (shallower); see zone.ts.
		const learn = !!a.zone && cfg.play.reflex_learn_depth !== false;
		const startF = frame;
		const depth0 = depthAdj;
		const fires: Fire[] = [];
		const hits: Record<string, unknown>[] = [];
		let lastHitF = -Infinity, lastCandF = -Infinity, lastGlanceF = frame;
		if (learn) await w.call("impacts", {}); // forget impacts from before this policy
		const HIT_Q = { type: "noul" as const, instructions: "The player was just hit or crashed: an explosion, crash or damage effect at the player, a crash / fail / revive / game-over screen, or a life lost. Not a pickup, a reward, a tutorial pause or an ordinary menu." };
		const zoneNow = () => (a.zone && learn ? applyDepth(a.zone, depthAdj, a.player) : a.zone);
		const learnFrom = (hitF: number, how: string, pHit: number, evidence?: string) => {
			lastHitF = hitF;
			const lesson = depthLesson(log as unknown as CheckLog[], fires, hitF, fps, startF);
			const before = depthAdj;
			if (lesson.delta) depthAdj = Math.max(-400, Math.min(400, depthAdj + lesson.delta * depthStep(a.zone!, a.player)));
			const h = { f: hitF, t: Math.round((hitF / fps) * 100) / 100, confirmed: how, p_hit: Math.round(pHit * 100) / 100, delta: lesson.delta, reason: lesson.reason, lead: lesson.lead, depth: [before, depthAdj], zone: zoneNow(), evidence };
			hits.push(h);
			log.push({ f: hitF, hit: how });
			trace.emit("play", "decide", `hit at ${(hitF / fps).toFixed(1)} s (${how}, p=${pHit.toFixed(2)}): ${lesson.reason}${lesson.delta ? ` → zone ${lesson.delta > 0 ? "deeper" : "shallower"} (${before} → ${depthAdj}/1000 beyond the drawn far edge)` : ""}`, h, { game_t: hitF / fps });
		};
		const lateralSign = (g: PlanAction): number => {
			if (g.type === "swipe") return g.direction === "left" ? -1 : g.direction === "right" ? 1 : 0;
			if (g.type === "drag" && g.path && g.path.length >= 2) { const dx = g.path[g.path.length - 1]![1] - g.path[0]![1]; return Math.abs(dx) > 50 ? Math.sign(dx) : 0; }
			if (g.type === "hold" && g.point) return g.point[1] < 420 ? -1 : g.point[1] > 580 ? 1 : 0;
			return 0;
		};
		while (frame < end) {
			const glance = (a.zone || tracking) && checks % 5 === 0;
			const pk = a.zone || tracking
				? await w.call<{ path: string; full_path?: string; player?: [number, number]; conf?: number; delta?: [number, number]; zone?: number[]; impacts?: { kind: "flash" | "freeze"; f: number; motion: number }[] }>("peek_track", { zone: zoneNow(), width: 480, full: glance, follow: tracking })
				: await w.peek(vw);
			const tconf = "conf" in pk && typeof pk.conf === "number" ? pk.conf : 1;
			if ("delta" in pk && pk.delta) { delta = pk.delta; player = pk.player; }
			if (learn && "impacts" in pk && pk.impacts) {
				const imp = pk.impacts.filter((x) => x.f > startF);
				// a freeze right after a hit is that hit's crash screen: hand back to the planner without asking again
				if (imp.some((x) => x.kind === "freeze" && x.f - lastHitF <= hz.framesFor(1500))) { ended = "hit"; break; }
				const cand = imp.find((x) => x.f - lastHitF > hz.framesFor(1500) && x.f - lastCandF > hz.framesFor(1000));
				if (cand) {
					lastCandF = cand.f;
					const full = "full_path" in pk && pk.full_path ? pk.full_path : (await w.peek(vw)).path;
					const evidence = join(paths.dir, "obs", `hit_${++hitCount}.jpg`);
					try { copyFileSync(full, evidence); } catch { /* best-effort */ }
					const hq = await decide({ model: cfg.models.decider, ledger, phase: "play", state: [`Current screen of a fast real-time mobile game (portrait phone), a moment after the screen suddenly ${cand.kind === "freeze" ? "stopped moving" : "flashed or shook"}:`, { image: full }], questions: { hit: HIT_Q } });
					const pHit = noul(hq?.answers.hit) ?? 0;
					log.push({ f: cand.f, impact: cand.kind, p_hit: Math.round(pHit * 100) / 100 });
					if (pHit >= 0.5) {
						learnFrom(cand.f, cand.kind, pHit, evidence);
						// the world stopped: a crash screen is up, and the planner deals with it (no frozen dead air on video)
						if (cand.kind === "freeze") { ended = "hit"; break; }
					}
				}
			}
			// Only a confident track can tell a wall from a lost track.
			if (pending && player && (tconf < 0.6 || pending.conf < 0.6)) pending = undefined;
			if (pending && player) {
				if ((player[1] - pending.x0) * pending.sign < 12) {
					blocked.set(pending.name, frame + hz.framesFor(1500));
					log.push({ f: frame, blocked: pending.name, x: player[1] });
				}
				pending = undefined;
			}
			// Every ~0.5 s, a look at the whole screen: is play interrupted, or did something appear that the policy does
			// not cover (a new hazard type, a new instruction, a power-up)? Then hand back to the planner — the game is
			// frozen, so the planner sees the new thing before it can hurt.
			if (glance && "full_path" in pk && pk.full_path) {
				const g = await decide({ model: cfg.models.decider, ledger, phase: "play", state: ["Current screen of a fast real-time mobile game (portrait phone):", { image: pk.full_path }],
					questions: {
						interrupted: { type: "noul", instructions: "Normal play is interrupted: a crash, game over, popup, menu, level-complete or end screen is showing." },
						novel: { type: "noul", instructions: `Something is on screen that none of these covers and that may need a different reaction (a new kind of obstacle, a new instruction or tutorial prompt, a power-up to grab): ${sits.map((x) => x.when).join(" / ")}` },
						...(learn ? { hit: HIT_Q } : {}),
					} });
				// A hit neither impact signature caught (e.g. a game-over that fades in): date it from the frames since
				// the previous look — where the screen froze or changed most — else halfway between the two looks.
				const pHit = noul(g?.answers.hit) ?? 0;
				if (learn && pHit >= 0.5 && frame - lastHitF > hz.framesFor(1500)) {
					const on = await w.call<{ f: number | null; how?: string }>("impact_onset", { since_f: lastGlanceF });
					const hitF = on.f ?? Math.round((lastGlanceF + frame) / 2);
					const evidence = join(paths.dir, "obs", `hit_${++hitCount}.jpg`);
					try { copyFileSync(pk.full_path, evidence); } catch { /* best-effort */ }
					log.push({ f: hitF, impact: `glance${on.how ? `/${on.how}` : ""}`, p_hit: Math.round(pHit * 100) / 100 });
					learnFrom(hitF, `look${on.how ? `, dated by ${on.how}` : ""}`, pHit, evidence);
				}
				lastGlanceF = frame;
				if ((noul(g?.answers.interrupted) ?? 0) > 0.7) { ended = "interrupted"; break; }
				if ((noul(g?.answers.novel) ?? 0) > 0.7 && checks > 0) { ended = "something_new"; break; }
			}
			const state: any[] = [
				a.zone ? (tracking ? "Close-up that follows the player in a fast real-time mobile game (the player-controlled object is in it; left/right in this image = left/right of the player):" : "Close-up of the area just in front of the player in a fast real-time mobile game:") : "Current frame of a fast real-time mobile game (portrait phone):",
				{ image: pk.path },
			];
			if (tracking && player) state.push(`The player-controlled object is in the ${side(player[1])} of the screen (x=${(player[1] / 1000).toFixed(2)} of the width).`);
			const d = await decide({ model: cfg.models.decider, ledger, phase: "play", state,
				questions: {
					now: { type: "choice", instructions: "Which of these situations is happening right now?", criteria },
					...(a.zone || tracking ? {} : { interrupted: { type: "noul", instructions: "Normal play is interrupted: a crash, game over, popup, menu, level-complete or end screen is showing." } }),
				} });
			checks++;
			if (!d) { ended = "decider_unavailable"; break; }
			const now = d.answers.now;
			let c = choice(now) ?? "none";
			const probs = now && now.type === "choice" ? now.probabilities : {};
			let redirected = false;
			if ((blocked.get(c) ?? -1) > frame) {
				const alt = Object.entries(probs).filter(([k]) => k !== "none" && k !== c && !((blocked.get(k) ?? -1) > frame)).sort((x, y) => y[1] - x[1])[0];
				if (alt && alt[1] >= 0.2) { c = alt[0]; redirected = true; } else c = "none";
			}
			const p = probs[c] ?? 0;
			const second = Math.max(0, ...Object.entries(probs).filter(([k]) => k !== c).map(([, v]) => v));
			lastConf = tconf;
			log.push({ f: frame, c, p: Math.round(p * 100) / 100, m: Math.round((p - second) * 100) / 100, ...(tracking && "conf" in pk ? { px: player?.[1], py: player?.[0], tc: pk.conf } : {}) });
			if ((noul(d.answers.interrupted) ?? 0) > 0.7) { ended = "interrupted"; break; }
			const sit = sits.find((x) => x.name === c);
			// Fire when something clearly needs a reaction (little mass on "none") and an action is the top answer; two
			// equally good actions (dodge left / dodge right with both lanes free) split their probability, so the action
			// itself only has to be the argmax. Right after a move, a *different* reflex needs strong evidence: a person
			// commits to a swerve instead of flip-flopping (which steers straight back into danger).
			const pNone = probs.none ?? 0;
			const committed = lastFired !== undefined && lastFired.name !== c && frame - lastFired.frame < hz.framesFor(400);
			const fire = !!sit && (redirected ? pNone <= 0.4 : committed ? (p >= 0.6 && p - second >= 0.25) || (p >= 0.5 && pNone <= 0.2) : p >= threshold && pNone <= 0.4);
			if (sit && fire) {
				// The frame the reflex reacted to, kept as evidence for the trace.
				const evidence = join(paths.dir, "obs", `reflex_t${turn}_${fired + 1}.jpg`);
				try { copyFileSync(pk.path, evidence); } catch { /* evidence is best-effort */ }
				const { ms, late } = hz.reflexMs();
				await w.step(hz.framesFor(ms));
				// A gesture marked relative_to_player moves with the player (e.g. drag the ship from where it is now).
				const act = sit.do!.relative_to_player && tracking ? shiftAction(sit.do!, delta) : sit.do!;
				const { g, label } = toGesture(act, dom, vw, vh);
				const st = await w.call<{ value: number }>("eval", { expr: "__sim.frame" });
				fires.push({ f: st.value, name: sit.name, pickup: sit.pickup });
				const { ops, performed } = hz.compile(g, st.value, { mouse: inputMode === "mouse", allowSlip: false });
				const r = await w.ops(ops);
				const rec: ActionRecord = { i: history.length, turn, kind: g.kind, intent: `reflex ${sit.name}${late ? " (late)" : ""}${redirected ? " (other way: wall)" : ""}: ${sit.when.slice(0, 90)}`, t0: st.value / fps, t1: r.now / 1000, f0: st.value, f1: r.frame, touches: performed.touches, slipped: false, reaction_ms: ms, target_label: label, evidence };
				history.push(rec);
				appendJsonl(paths.actions, rec);
				fired++;
				counts[sit.name] = (counts[sit.name] ?? 0) + 1;
				lastFired = { name: sit.name, frame: r.frame };
				const sign = tracking && player ? lateralSign(sit.do!) : 0;
				if (sign) pending = { name: sit.name, sign, x0: player![1], conf: lastConf };
				frame = (await w.step(hz.framesFor(Math.min(1500, Math.max(100, a.cooldown_ms ?? 250))))).frame;
			} else frame = (await w.step(checkEvery)).frame;
		}
		if (tracking) await w.call("track_stop", {});
		const moved = tracking ? ` · player tracked (moved ${Math.round(Math.hypot(delta[0], delta[1]))}/1000)` : "";
		const hitNote = hits.length
			? ` · hit ${hits.length}×: ${hits.map((h) => h.reason).join("; ")}${depthAdj !== depth0 ? ` (zone depth adjusted automatically: ${depth0} → ${depthAdj}/1000 beyond the far edge you drew)` : ""}`
			: "";
		const summary = `${checks} checks over ${(frame / fps - startT).toFixed(1)} s, fired ${fired}${fired ? ` (${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")})` : ""}, ended by ${ended}${moved}${hitNote}`;
		appendJsonl(join(paths.dir, "reflexes.jsonl"), { turn, t: startT, zone: a.zone, zone_used: zoneNow(), depth: [depth0, depthAdj], player: a.player, template, situations: sits.map((x) => ({ name: x.name, when: x.when, do: x.do, pickup: x.pickup })), checks, fired, counts, ended, hits, log });
		trace.emit("play", "decide", `reflex policy (${sits.map((x) => x.name).join(", ")}): ${summary}`, { counts, ended, checks }, { game_t: startT });
		return { fired, checks, ended, summary };
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
		let lastReflex = "";
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
				lastReflex ? `Your last reflex policy: ${lastReflex}.` : "",
				dom.length ? `Numbered interactive elements (HTML):\n${domList(dom, vw, vh)}` : "",
			].filter(Boolean).join("\n\n");
			lastReflex = ""; // reported once, on the turn right after the policy ran

			// Planner (VLM) and decider checks run concurrently on the same frozen frame.
			let plan: Plan;
			let planMs = 0, planUsd = 0, planErr: string | undefined;
			const [dec, planRes] = robot ? [null, { value: randomPlan(rng), ms: 0, usd: 0 }] : await Promise.all([
				deciderObs(obs, prevObs, lastIntents).catch(() => null),
				chatJson<Plan>({ model: cfg.models.planner, reasoning: cfg.models.planner_reasoning, system: systemPrompt(!!cfg.play.timing_actions, cfg.play.reflex_actions !== false), ledger, phase: "play", kind: "planner",
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
				if (a.type === "react") {
					const rr = await runReflex(a, turn, dom, inputMode);
					actionsDone += rr.fired;
					lastReflex = rr.summary;
					intents.push(`react (${rr.summary})`);
					continue;
				}
				const delay = robot ? 1000 / fps : k === 0 ? hz.reactionMs(obs.changed_frac > 0.25 || turn === 1, turn === 1) : hz.chainGapMs();
				let timing = "";
				if (a.type === "tap_when") {
					// Timing: watch the (frozen-between-checks) game every 2 frames and ask the decider whether the moment
					// has come; tap on the first frame it has. Checks cost nothing on video; the decider is fast and free.
					const maxFrames = hz.framesFor(Math.min(6000, Math.max(300, a.timeout_ms ?? 3000)));
					// The decider's probability for "the moment is now" rises and falls as the moving thing passes; its
					// absolute scale depends on the question (peaks of ~0.5 are typical for spatial alignment), so fire on a
					// rising probability past 0.42, and check every frame once it starts to climb.
					const checks: number[] = [];
					let prev = 0, stride = 2;
					for (let f = 0; f < maxFrames; f += stride) {
						const pk = await w.peek(vw);
						const d = await decide({ model: cfg.models.decider, ledger, phase: "play", state: ["Current frame of a mobile game (portrait):", { image: pk.path }],
							questions: { now: { type: "noul", instructions: `Exactly at this moment: ${a.condition}` } } });
						const p = noul(d?.answers.now);
						if (p === undefined) break; // no decider: tap now
						checks.push(Math.round(p * 100) / 100);
						if (p >= 0.42 && p >= prev) break;
						stride = p >= 0.22 && p > prev ? 1 : 2;
						prev = p;
						await w.step(stride);
					}
					timing = ` [tap_when after ${checks.length} checks, last p=${checks.at(-1) ?? "n/a"}]`;
					trace.emit("play", "decide", `tap_when "${a.condition?.slice(0, 60)}": ${checks.length} frame checks → tap (p ${checks.slice(-4).join(", ")})`, { checks }, { quiet: true });
				} else if (a.type !== "wait") await w.step(hz.framesFor(delay));
				const { g, label } = toGesture(a, dom, vw, vh);
				const st = await w.call<{ value: number }>("eval", { expr: "__sim.frame" });
				const { ops, performed } = hz.compile(g, st.value, { mouse: inputMode === "mouse", allowSlip: !robot && a.type !== "tap_when" });
				const r = await w.ops(ops);
				const rec: ActionRecord = { i: history.length, turn, kind: a.type, intent: (a.intent ?? "") + timing, t0: st.value / fps, t1: r.now / 1000, f0: st.value, f1: r.frame, touches: performed.touches, slipped: performed.slipped, reaction_ms: a.type === "wait" || a.type === "tap_when" ? 0 : delay, target_label: label };
				history.push(rec);
				appendJsonl(paths.actions, rec);
				if (a.type !== "wait") actionsDone++;
				intents.push(`${a.type}${label ? ` "${label}"` : ""}: ${a.intent ?? ""}`);
			}
			lastIntents = intents.join("; ");
			// ------------------------------------------------------------ watch
			const watch = robot ? 200 : Math.min(2500, Math.max(300, Number(plan.watch_ms) || 800));
			if (!plan.actions.some((a) => a.type === "react")) await w.step(hz.framesFor(watch)); // a reflex policy already watched
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
