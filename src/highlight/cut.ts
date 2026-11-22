// Cut: the director writes edit decision lists (EDLs) for a few distinct strategies; code makes them exact.
//
// Division of labour: the model decides the story (what to open on, which moments show the core loop and the
// features, how to end); code owns every number that must hold — total 20.0 s, speed 1.0-1.5x, at most 30 s of
// source, no cut in the middle of a gesture, no loading frames, the end card last. A heuristic EDL is the fallback.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ActionRecord } from "../agent/play.ts";
import { ROOT } from "../config.ts";
import { chatJson } from "../llm.ts";
import { sc } from "../runtime.ts";
import { ensureDir, readJsonl, run, writeJson } from "../util/core.ts";
import type { IndexResult } from "./index.ts";

export type ClipRole = "hook" | "core_loop" | "feature" | "progression" | "climax" | "end_card";
export type Clip = { start: number; end: number; speed: number; role: ClipRole; why?: string };
export type Edl = { id: string; strategy: string; title: string; clips: Clip[]; source: "director" | "heuristic" | "baseline"; fixes?: string[] };

const ROLES: ClipRole[] = ["hook", "core_loop", "feature", "progression", "climax", "end_card"];

const STRATEGIES = [
	{ id: "a", name: "hook-first", brief: "Open on the single most exciting moment (1.5-2.5 s), then show the core loop clearly 2-3 times with rising stakes, one or two features/upgrades, a climax, then the end card." },
	{ id: "b", name: "learn-then-escalate", brief: "Tell the session as a short story: a quick, clear first action that teaches how to play (skip any slow tutorial text), then escalation: features, bigger rewards, a climax, then the end card. Mostly chronological." },
	{ id: "c", name: "feature-montage", brief: "Fast-paced montage: many short shots (1.5-3 s) that each show a different mechanic, feature or reward, held together by the core loop; speed up the slower stretches (up to 1.5x); end card last." },
];

function editorSystem(target: number, maxSpeed: number, includeEnd: boolean): string {
	return `You are a senior editor cutting ${target}-second vertical highlight videos of mobile games for ads. The footage is a real play session (with a touch indicator showing where the finger is). The ad must look like a real person playing a fun game: natural pacing, high action, the core loop obvious within the first seconds, the major features visible.

You write edit decision lists (EDLs). Each clip is a time range [start, end] of the raw session (seconds, one decimal) played at speed 1.0-${maxSpeed} (use speed > 1 only to tighten slow stretches; 1.0 for the key moments). Clips play in the order you list them; the hook may come from late in the session, after that prefer chronological order so progression makes sense.

Rules:
- Total output (sum of (end-start)/speed) about ${target} s; code adjusts it to exactly ${target}.0 s, so aim for ${target - 1}-${target + 1} s.
- 3-8 clips, each at least 1.2 s of output. No overlapping source ranges.
- Avoid loading screens, idle stretches, menus and repeated identical moves; never cut while the finger is mid-gesture.
- Tutorial footage (instruction banners, tutorial hands; phase "tutorial") makes an ad look like an onboarding screen: use at most one short tutorial clip, only if it is the clearest way to show the controls, and never jump back to tutorial footage after showing later gameplay. Prefer core_loop clips from after the tutorial.
- roles: hook | core_loop | feature | progression | climax | end_card.${includeEnd ? "\n- If the session has an end card, the LAST clip is role end_card showing it for 1.5-2.5 s (it is the ad's call to action)." : ""}

Reply with JSON: {"edls": [{"id": "a"|"b"|"c", "title": "one-line description of the cut", "clips": [{"start": s, "end": s, "speed": x, "role": "...", "why": "short"}]}]}`;
}

/** Structural problems the model must fix itself (numbers are fixed by normalize()). */
function edlProblems(e: Edl, ix: IndexResult, includeEnd: boolean, maxSpeed: number): string[] {
	const p: string[] = [];
	const k = `EDL ${e.id}`;
	if (!Array.isArray(e.clips) || e.clips.length < 3 || e.clips.length > 9) return [`${k}: needs 3-8 clips`];
	e.clips.forEach((c, i) => {
		if (typeof c.start !== "number" || typeof c.end !== "number" || c.end <= c.start) p.push(`${k} clip ${i + 1}: start/end must be numbers with end > start`);
		else if (c.start < 0 || c.end > ix.duration + 0.05) p.push(`${k} clip ${i + 1}: outside the recording (0-${ix.duration.toFixed(1)} s)`);
		if (!ROLES.includes(c.role)) p.push(`${k} clip ${i + 1}: role must be one of ${ROLES.join("|")}`);
		if (typeof c.speed !== "number" || c.speed < 1 || c.speed > maxSpeed) p.push(`${k} clip ${i + 1}: speed must be 1.0-${maxSpeed}`);
	});
	if (p.length) return p;
	const out = e.clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0);
	if (out < 14 || out > 27) p.push(`${k}: total output is ${out.toFixed(1)} s; aim for about 20 s`);
	if (!e.clips.some((c) => c.role === "core_loop")) p.push(`${k}: needs at least one core_loop clip (the viewer must see how the game is played)`);
	if (includeEnd && ix.end_card_t !== undefined && e.clips[e.clips.length - 1]!.role !== "end_card") p.push(`${k}: the last clip must be the end card (it starts at ${ix.end_card_t.toFixed(1)} s)`);
	const sorted = [...e.clips].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end - 0.3) p.push(`${k}: clips ${sorted[i - 1]!.start}-${sorted[i - 1]!.end} and ${sorted[i]!.start}-${sorted[i]!.end} overlap`);
	return p;
}

/** Make an EDL exact: inside the playable footage, no mid-gesture cuts, no overlaps, exactly `target` seconds. */
export function normalize(e: Edl, ix: IndexResult, actions: ActionRecord[], opts: { target: number; maxSpeed: number; fps: number; includeEnd: boolean }): Edl {
	const fixes: string[] = [];
	const lo = ix.playable_from;
	const hi = ix.duration - 1 / opts.fps;
	const gestures = actions.filter((a) => a.kind !== "wait");
	let clips = e.clips.map((c) => ({ ...c, speed: Math.min(opts.maxSpeed, Math.max(1, c.speed || 1)) }));
	// end card: make sure the last clip is on it and ends at the end of the footage
	if (opts.includeEnd && ix.end_card_t !== undefined) {
		const last = clips[clips.length - 1]!;
		if (last.role === "end_card") {
			last.start = Math.max(last.start, ix.end_card_t);
			last.end = Math.min(hi, Math.max(last.end, last.start + 1.8));
			last.speed = 1;
		}
	}
	for (const c of clips) {
		const s0 = c.start, e0 = c.end;
		c.start = Math.max(lo, Math.min(hi - 0.5, c.start));
		c.end = Math.min(hi, Math.max(c.start + 0.8, c.end));
		// snap out of gestures: start just before the finger lands, end just after it lifts
		for (const g of gestures) {
			if (c.start > g.t0 && c.start < g.t1) c.start = Math.max(lo, g.t0 - 0.12);
			if (c.end > g.t0 && c.end < g.t1) c.end = Math.min(hi, g.t1 + 0.18);
		}
		if (Math.abs(s0 - c.start) > 0.05 || Math.abs(e0 - c.end) > 0.05) fixes.push(`clip ${s0.toFixed(1)}-${e0.toFixed(1)} → ${c.start.toFixed(2)}-${c.end.toFixed(2)} (bounds/gesture snap)`);
	}
	// overlaps: trim the clip that comes later in the edit
	for (let i = 0; i < clips.length; i++) for (let j = 0; j < i; j++) {
		const a = clips[j]!, b = clips[i]!;
		if (b.start < a.end && b.end > a.start) {
			if (b.start >= a.start) b.start = a.end; else b.end = a.start;
			fixes.push(`overlap trimmed (${b.role})`);
		}
	}
	clips = clips.filter((c) => c.end - c.start >= 0.5);
	// Tighten: a long dead stretch inside a clip (no motion, no finger, nothing exciting) becomes a jump cut that keeps
	// a short pause on each side — a person pausing to read looks natural, two seconds of a frozen board does not.
	const deadAt = (t: number) => {
		const b = ix.bins[Math.floor(t / 0.5)];
		// Dead air is about change, not content. Popups/menus are exempt: a player reading an upgrade card IS the
		// human pause the viewer should see (the judge flagged instant-looking card taps when these were tightened).
		return !!b && b.motion < 0.0025 && b.touches === 0 && !["end_card", "reward", "level_end", "title", "tutorial", "fail"].includes(b.phase ?? "");
	};
	const tight: Clip[] = [];
	for (const c of clips) {
		if (c.role === "end_card" || c.role === "hook") { tight.push(c); continue; }
		let segStart = c.start;
		let runStart: number | undefined;
		for (let t = Math.ceil(c.start * 2) / 2; t <= c.end; t += 0.5) {
			const d = t < c.end && deadAt(t);
			if (d && runStart === undefined) runStart = t;
			if (!d && runStart !== undefined) {
				const runEnd = Math.min(t, c.end);
				if (runEnd - runStart >= 1.5) {
					const cutA = runStart + 0.4, cutB = runEnd - 0.55; // keep ~1 s of pause in total: reading time before the next move
					if (cutA - segStart >= 0.6) tight.push({ ...c, start: segStart, end: cutA });
					fixes.push(`dead air ${runStart.toFixed(1)}-${runEnd.toFixed(1)} s cut out of a ${c.role} clip`);
					segStart = cutB;
				}
				runStart = undefined;
			}
		}
		if (c.end - segStart >= 0.6) tight.push({ ...c, start: segStart, end: c.end });
	}
	clips = tight;
	const outLen = () => clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0);
	const flex = () => clips.filter((c) => c.role !== "end_card" && c.role !== "hook");
	let guard = 0;
	// too long: speed up flexible clips, then trim them (longest first)
	while (outLen() > opts.target + 1e-3 && guard++ < 400) {
		const f = flex().filter((c) => c.speed < opts.maxSpeed - 1e-3).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
		if (f) { f.speed = Math.min(opts.maxSpeed, f.speed + 0.05); continue; }
		const t = [...flex(), ...clips.filter((c) => c.role === "hook")].filter((c) => c.end - c.start > 1.4).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
		if (!t) break;
		t.end -= Math.min(0.2, (outLen() - opts.target) * t.speed + 1e-3);
	}
	// too short: slow down to 1.0, then extend into neighbouring footage (never into another clip)
	while (outLen() < opts.target - 1e-3 && guard++ < 800) {
		const f = flex().filter((c) => c.speed > 1 + 1e-3)[0];
		if (f) { f.speed = Math.max(1, f.speed - 0.05); continue; }
		const need = opts.target - outLen();
		const cands = [...clips].sort((a, b) => (a.role === "end_card" ? 1 : 0) - (b.role === "end_card" ? 1 : 0));
		let grown = false;
		for (const c of cands) {
			const nextStart = Math.min(hi, ...clips.filter((o) => o !== c && o.start >= c.end - 1e-6).map((o) => o.start));
			let room = nextStart - c.end;
			if (c.role !== "end_card" && deadAt(c.end + 0.01)) room = 0; // never grow back into dead air
			const cap = c.role === "end_card" ? 3.0 : c.role === "hook" ? 3.5 : Infinity; // a CTA or a hook that overstays drags
			room = Math.min(room, cap - (c.end - c.start));
			if (room > 0.05) { c.end += Math.min(room, need * c.speed, 0.5); grown = true; break; }
			const prevEnd = Math.max(lo, ...clips.filter((o) => o !== c && o.end <= c.start + 1e-6).map((o) => o.end));
			let back = c.start - prevEnd;
			if (deadAt(c.start - 0.26)) back = 0;
			back = Math.min(back, cap - (c.end - c.start));
			if (back > 0.05 && c.role !== "end_card") { c.start -= Math.min(back, need * c.speed, 0.5); grown = true; break; }
		}
		if (!grown) {
			// Out of lively footage: allow a pause rather than a short video.
			const c = clips.find((x) => x.role !== "end_card" && x.role !== "hook" && Math.min(hi, ...clips.filter((o) => o !== x && o.start >= x.end - 1e-6).map((o) => o.start)) - x.end > 0.05);
			if (!c) break; // not enough footage at all: the gate will flag the length
			const nextStart = Math.min(hi, ...clips.filter((o) => o !== c && o.start >= c.end - 1e-6).map((o) => o.start));
			c.end += Math.min(nextStart - c.end, need * c.speed, 0.5);
		}
	}
	// exact frame count: adjust the last flexible clip by the remainder
	const frames = clips.reduce((s, c) => s + Math.round(((c.end - c.start) / c.speed) * opts.fps), 0);
	const want = Math.round(opts.target * opts.fps);
	const adj = [...flex()].pop() ?? clips[0];
	if (adj && frames !== want) adj.end = Math.min(hi, adj.end + ((want - frames) / opts.fps) * adj.speed);
	for (const c of clips) { c.start = Math.round(c.start * 1000) / 1000; c.end = Math.round(c.end * 1000) / 1000; c.speed = Math.round(c.speed * 100) / 100; }
	return { ...e, clips, fixes };
}

/** Fallback / baseline: best-scoring windows, chronological, end card last. */
export function heuristicEdl(ix: IndexResult, id: string, target: number, includeEnd: boolean): Edl {
	const v = ix.bins.map((b) => ((b.excitement ?? 1) / 4) * 0.45 + Math.min(1, b.motion * 25) * 0.3 + Math.min(1, b.touches) * 0.15 + Math.min(1, Math.max(0, (b.audio_db + 50) / 40)) * 0.1);
	const endT = includeEnd && ix.end_card_t !== undefined ? ix.end_card_t : ix.duration;
	const usable = (t: number) => t >= ix.playable_from && t < endT - 0.5;
	const win = 6; // 3 s windows of 0.5 s bins
	const scored: { t: number; s: number }[] = [];
	for (let i = 0; i + win <= ix.bins.length; i++) if (usable(ix.bins[i]!.t) && usable(ix.bins[i + win - 1]!.t)) scored.push({ t: ix.bins[i]!.t, s: v.slice(i, i + win).reduce((a, b) => a + b, 0) / win });
	scored.sort((a, b) => b.s - a.s);
	const picked: { t: number; s: number }[] = [];
	const endLen = includeEnd && ix.end_card_t !== undefined ? 2.2 : 0;
	for (const w of scored) {
		if (picked.length * 3 >= target - endLen) break;
		if (picked.every((p) => Math.abs(p.t - w.t) >= 3)) picked.push(w);
	}
	const best = picked[0];
	const rest = picked.slice(1).sort((a, b) => a.t - b.t);
	const clips: Clip[] = [];
	if (best) clips.push({ start: best.t, end: best.t + 2.5, speed: 1, role: "hook" });
	for (const w of rest) clips.push({ start: w.t, end: w.t + 3, speed: 1, role: "core_loop" });
	if (endLen) clips.push({ start: ix.end_card_t!, end: Math.min(ix.duration, ix.end_card_t! + endLen), speed: 1, role: "end_card" });
	return { id, strategy: "heuristic", title: "top-scoring windows (signals only)", clips, source: "heuristic" };
}

/** Naive cuts used only to check that the evaluator can tell a good highlight from a lazy one. */
export function baselineEdls(ix: IndexResult, target: number): Edl[] {
	const lo = ix.playable_from;
	const first: Edl = { id: "base_first", strategy: "baseline: first 20 s", title: "the first 20 s after loading, uncut", source: "baseline",
		clips: ([{ start: lo, end: Math.min(ix.duration, lo + target), speed: 1, role: "core_loop" }, { start: Math.min(ix.duration, lo + target), end: Math.min(ix.duration, lo + target + 0.1), speed: 1, role: "core_loop" }] as Clip[]).filter((c) => c.end > c.start) };
	const span = Math.max(1, ix.duration - lo - 4);
	const rnd: Clip[] = [];
	for (let i = 0; i < 5; i++) { const s = lo + ((i * 0.61803 * span) % span); rnd.push({ start: s, end: s + 4, speed: 1, role: "core_loop" }); }
	return [first, { id: "base_random", strategy: "baseline: random clips", title: "five random 4 s clips", source: "baseline", clips: rnd }];
}

export async function writeEdls(ix: IndexResult): Promise<Edl[]> {
	const { cfg, paths, ledger, trace } = sc();
	const H = cfg.highlight;
	const actions = readJsonl<ActionRecord>(paths.actions);
	const includeEnd = H.include_end_card;
	const strategies = STRATEGIES.slice(0, Math.max(1, Math.min(3, H.candidates)));
	const binsText = ix.bins.filter((_, i) => i % 2 === 0).map((b) => `${b.t.toFixed(0).padStart(3)}s ${b.phase ?? "?"} exc=${b.excitement?.toFixed(1) ?? "-"} motion=${(b.motion * 100).toFixed(1)} audio=${b.audio_db.toFixed(0)}dB touches=${b.touches}`).join("\n");
	const momentsText = ix.moments.map((m) => `${m.start.toFixed(1)}-${m.end.toFixed(1)}s [${m.kind}${m.feature ? `: ${m.feature}` : ""}] intensity ${m.intensity}: ${m.label}`).join("\n");
	const gestures = actions.filter((a) => a.kind !== "wait").map((a) => `${a.t0.toFixed(1)}-${a.t1.toFixed(1)} ${a.kind}`).join(", ");
	const text = [
		`Game: ${JSON.stringify(ix.game)}`,
		`Recording: ${ix.duration.toFixed(1)} s. Playable footage starts at ${ix.playable_from.toFixed(1)} s.${ix.end_card_t !== undefined ? ` End card from ${ix.end_card_t.toFixed(1)} s to the end.` : " No end card."} ${ix.has_audio ? "Has game audio." : "No audio."}`,
		`Logged moments:\n${momentsText}`,
		`Signals per second (phase, excitement 0-4, motion, audio, touches):\n${binsText}`,
		`Finger gestures (do not cut inside these): ${gestures}`,
		`Write ${strategies.length} EDLs, one per strategy:\n${strategies.map((s) => `- id "${s.id}" (${s.name}): ${s.brief}`).join("\n")}`,
	].join("\n\n");
	let edls: Edl[] = [];
	try {
		const r = await chatJson<{ edls: Edl[] }>({
			model: cfg.models.director, reasoning: cfg.models.director_reasoning, system: editorSystem(H.duration_s, H.max_speed, includeEnd), ledger, phase: "cut", kind: "director",
			parts: [{ text }], maxTokens: 16000, estimateUsd: 0.04,
			validate: (v) => {
				if (!Array.isArray(v?.edls) || v.edls.length < 1) return ["return {\"edls\": [...]}"];
				return v.edls.flatMap((e) => edlProblems({ ...e, source: "director", strategy: "" }, ix, includeEnd, H.max_speed));
			},
		});
		edls = r.value.edls.map((e, i) => ({ ...e, id: strategies[i]?.id ?? e.id, strategy: strategies.find((s) => s.id === e.id)?.name ?? strategies[i]?.name ?? "director", source: "director" as const }));
		trace.emit("cut", "edl", `director wrote ${edls.length} EDLs (${r.attempts} attempt${r.attempts > 1 ? "s" : ""})`, { titles: edls.map((e) => `${e.id}: ${e.title}`), cost: r.usd });
	} catch (e) {
		trace.emit("cut", "warn", `director EDLs failed (${String(e).slice(0, 200)}); using the heuristic cut`);
	}
	if (!edls.length) edls = [heuristicEdl(ix, "h", H.duration_s, includeEnd)];
	const norm = edls.map((e) => normalize(e, ix, actions, { target: H.duration_s, maxSpeed: H.max_speed, fps: cfg.browser.fps, includeEnd }));
	for (const e of norm) {
		writeJson(paths.edl(e.id), e);
		trace.emit("cut", "edl", `EDL ${e.id} (${e.strategy}): ${e.clips.map((c) => `${c.role} ${c.start.toFixed(1)}-${c.end.toFixed(1)}${c.speed > 1 ? `@${c.speed}x` : ""}`).join(" | ")}${e.fixes?.length ? ` · ${e.fixes.length} code fixes` : ""}`, e, { quiet: false });
	}
	return norm;
}

export async function renderEdl(e: Edl, out: string): Promise<{ duration: number; frames: number; has_audio: boolean }> {
	const { cfg, paths } = sc();
	ensureDir(join(paths.dir, "candidates"));
	const edlPath = join(paths.dir, "candidates", `edl_${e.id}.json`);
	writeJson(edlPath, e);
	const py = join(ROOT, "py");
	const args = ["-m", "simbrowser.render", paths.dir, edlPath, out, "--width", String(cfg.highlight.width), "--height", String(cfg.highlight.height)];
	if (!cfg.highlight.touch_overlay) args.push("--no-overlay");
	const r = await run(join(py, ".venv", "bin", "python"), args, { cwd: py });
	if (r.code !== 0 || !existsSync(out)) throw new Error(`render ${e.id} failed: ${r.stderr.slice(-400)}`);
	return JSON.parse(r.stdout.trim().split("\n").pop()!);
}
