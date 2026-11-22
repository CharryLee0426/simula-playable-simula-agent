// Unit tests for the deterministic parts: humanized gestures, EDL normalization, timing heuristics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Humanizer, PERSONAS } from "../src/agent/humanize.ts";
import { humanTiming } from "../src/eval/evaluate.ts";
import { normalize, type Edl } from "../src/highlight/cut.ts";
import type { IndexResult } from "../src/highlight/index.ts";

test("multi-point drags end on their last waypoint (regression: float rounding fell back to the last segment's start)", () => {
	for (let seed = 0; seed < 300; seed++) {
		const h = new Humanizer(PERSONAS.casual_competent!, seed, 30, [360, 640]);
		const { performed } = h.compile({ kind: "drag", points: [{ x: 80, y: 328 }, { x: 146, y: 328 }, { x: 213, y: 328 }], durationMs: 300 + seed * 5 }, 0);
		const last = performed.touches.at(-1)!;
		assert.equal(last.phase, "end");
		assert.ok(Math.abs(last.x - 213) < 16 && Math.abs(last.y - 328) < 16, `seed ${seed}: ended at ${last.x},${last.y}`);
	}
});

test("taps press for a few frames and reaction times are human (220-1500 ms + reading)", () => {
	const h = new Humanizer(PERSONAS.casual_competent!, 1, 30, [360, 640]);
	for (let i = 0; i < 200; i++) {
		const r = h.reactionMs(false);
		assert.ok(r >= 220 && r <= 2500, `reaction ${r}`);
	}
	const { ops, performed } = h.compile({ kind: "tap", points: [{ x: 100, y: 100 }] }, 10, { allowSlip: false });
	assert.equal(ops[0]!.op, "touch");
	assert.ok(performed.frames >= 3 && performed.frames <= 6, `press frames ${performed.frames}`);
});

function fakeIndex(duration: number, endCard?: number): IndexResult {
	return {
		duration, playable_from: 2, end_card_t: endCard, has_audio: true, moments: [],
		bins: Array.from({ length: Math.ceil(duration / 0.5) }, (_, i) => ({ t: i * 0.5, motion: 0.02, audio_db: -20, touches: 1, luma: 0.5, excitement: 2 })),
		game: { title: "t", genre: "g", objective: "", controls: "", core_loop: "", features: [], progression: "", end_card: !!endCard, tone: "", hook_idea: "" },
	};
}

test("normalize() makes any reasonable EDL exactly 20.0 s, within the footage, speeds 1-1.5, end card last", () => {
	const ix = fakeIndex(60, 52);
	const cases: Edl[] = [
		{ id: "a", strategy: "", title: "", source: "director", clips: [{ start: 30, end: 33, speed: 1, role: "hook" }, { start: 5, end: 14, speed: 1, role: "core_loop" }, { start: 15, end: 30, speed: 1.2, role: "feature" }, { start: 52, end: 54, speed: 1, role: "end_card" }] },
		{ id: "b", strategy: "", title: "", source: "director", clips: [{ start: 0, end: 3, speed: 1, role: "hook" }, { start: 10, end: 13, speed: 1, role: "core_loop" }, { start: 52, end: 53, speed: 1, role: "end_card" }] },
		{ id: "c", strategy: "", title: "", source: "director", clips: [{ start: 3, end: 40, speed: 1, role: "core_loop" }, { start: 41, end: 50, speed: 1, role: "climax" }, { start: 52, end: 55, speed: 1, role: "end_card" }] },
	];
	for (const e of cases) {
		const n = normalize(e, ix, [], { target: 20, maxSpeed: 1.5, fps: 30, includeEnd: true });
		const frames = n.clips.reduce((s, c) => s + Math.round(((c.end - c.start) / c.speed) * 30), 0);
		assert.equal(frames, 600, `${e.id}: ${frames} frames`);
		const src = n.clips.reduce((s, c) => s + (c.end - c.start), 0);
		assert.ok(src <= 30.01, `${e.id}: source ${src}`);
		for (const c of n.clips) {
			assert.ok(c.start >= 2 - 1e-6 && c.end <= 60, `${e.id}: clip ${c.start}-${c.end} outside footage`);
			assert.ok(c.speed >= 1 && c.speed <= 1.5, `${e.id}: speed ${c.speed}`);
		}
		assert.equal(n.clips.at(-1)!.role, "end_card");
		assert.ok(n.clips.at(-1)!.start >= 52);
	}
});

test("normalize() never cuts inside a gesture", () => {
	const ix = fakeIndex(40);
	const actions = [{ i: 0, turn: 1, kind: "drag", intent: "", t0: 9.5, t1: 11.0, f0: 285, f1: 330, touches: [], slipped: false, reaction_ms: 400 }];
	const e: Edl = { id: "a", strategy: "", title: "", source: "director", clips: [{ start: 10, end: 20, speed: 1, role: "core_loop" }, { start: 25, end: 35, speed: 1, role: "climax" }] };
	const n = normalize(e, ix, actions as any, { target: 20, maxSpeed: 1.5, fps: 30, includeEnd: false });
	assert.ok(n.clips[0]!.start <= 9.5, `starts at ${n.clips[0]!.start}, inside the drag`);
});

test("humanTiming() flags robotic input", () => {
	const mk = (gaps: number[]) => { let t = 0; return gaps.map((g, i) => { t += g / 1000; const a = { i, turn: i, kind: "tap", intent: "", t0: t, t1: t + 0.1, f0: 0, f1: 0, touches: [], slipped: false, reaction_ms: g }; t += 0.1; return a; }); };
	const human = humanTiming(mk([0, 420, 610, 380, 900, 350, 1200, 470]) as any);
	const robot = humanTiming(mk([0, 40, 40, 40, 40, 40, 40, 40]) as any);
	assert.ok(human.score > 0.8, `human ${human.score}`);
	assert.ok(robot.score < 0.3, `robot ${robot.score}`);
	assert.equal(robot.robotic, 7);
});
