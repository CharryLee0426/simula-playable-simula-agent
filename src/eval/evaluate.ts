// Evaluate highlight candidates without a person watching each one.
//
//   1. Gate (ffprobe): 9:16, <= 1080x1920, H.264, 30 fps, 20 s (±0.5), audio iff the game has audio. Fail = 0.
//   2. Heuristics (free, explainable): computed by mapping every output second back to the source through the EDL
//      and reading the signals the index already has — dead air, loading/menu frames, action level, hook strength,
//      coverage of the core loop / features / progression / end card, and how human the input timing is.
//   3. VLM judge: watches the candidate and scores the brief's own criteria (core loop clear, features shown,
//      looks like a real person, high action, hook, polish, would we run it), with its worst moment.
//   4. Pairwise: when the top two are close, the judge compares them directly, in both orders (position bias).
// Naive baseline cuts (first 20 s; random clips) are scored the same way to show the score separates good from lazy.
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ActionRecord } from "../agent/play.ts";
import type { Edl } from "../highlight/cut.ts";
import type { IndexResult } from "../highlight/index.ts";
import { chatJson } from "../llm.ts";
import { sc } from "../runtime.ts";
import { readJsonl, run } from "../util/core.ts";

export type Gate = { ok: boolean; problems: string[]; width?: number; height?: number; fps?: number; duration?: number; vcodec?: string; acodec?: string | null };
export type Heuristics = {
	dead_ratio: number; loading_ratio: number; action: number; hook_ratio: number; coverage: number; coverage_detail: Record<string, boolean>;
	human_timing: number; shots: number; avg_shot_s: number; touches_per_10s: number; H: number;
};
export type Judge = {
	core_loop_clarity: number; features: number; human_play: number; action: number; hook: number; polish: number; would_run: number;
	worst_moment?: { t: number; issue: string }; best_moment?: { t: number; why: string }; summary: string; J: number;
};
export type CandidateEval = { id: string; strategy: string; source: string; path: string; gate: Gate; heuristics: Heuristics; judge?: Judge; score: number; wins?: number };

export async function specGate(path: string, opts: { target: number; hasAudio: boolean; maxW: number; maxH: number; fps: number }): Promise<Gate> {
	const r = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate", "-show_entries", "format=duration", "-of", "json", path]);
	if (r.code !== 0) return { ok: false, problems: [`ffprobe failed: ${r.stderr.slice(0, 200)}`] };
	const j = JSON.parse(r.stdout);
	const v = j.streams.find((s: any) => s.codec_type === "video");
	const a = j.streams.find((s: any) => s.codec_type === "audio");
	const [n, d] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
	const g: Gate = { ok: true, problems: [], width: v?.width, height: v?.height, fps: n! / (d || 1), duration: Number(j.format?.duration), vcodec: v?.codec_name, acodec: a?.codec_name ?? null };
	if (!v) g.problems.push("no video stream");
	if (v && Math.abs(v.width / v.height - 9 / 16) > 0.005) g.problems.push(`aspect ${v.width}x${v.height} is not 9:16`);
	if (v && (v.width > opts.maxW || v.height > opts.maxH)) g.problems.push(`${v.width}x${v.height} exceeds ${opts.maxW}x${opts.maxH}`);
	if (v?.codec_name !== "h264") g.problems.push(`codec ${v?.codec_name} is not H.264`);
	if (Math.abs((g.fps ?? 0) - opts.fps) > 0.01) g.problems.push(`${g.fps} fps, expected ${opts.fps}`);
	if (Math.abs((g.duration ?? 0) - opts.target) > 0.5) g.problems.push(`duration ${g.duration?.toFixed(2)} s, expected ${opts.target} ± 0.5`);
	if (opts.hasAudio && !a) g.problems.push("the game has audio but the video has no audio track");
	g.ok = g.problems.length === 0;
	return g;
}

/** Human-likeness of the input timing over the whole session (gaps between gestures, reaction to screen changes). */
export function humanTiming(actions: ActionRecord[]): { score: number; median_gap_ms: number; min_gap_ms: number; gaps: number; robotic: number } {
	const g = actions.filter((a) => a.kind !== "wait");
	const gaps: number[] = [];
	for (let i = 1; i < g.length; i++) gaps.push((g[i]!.t0 - g[i - 1]!.t1) * 1000);
	if (!gaps.length) return { score: 0.5, median_gap_ms: 0, min_gap_ms: 0, gaps: 0, robotic: 0 };
	const sorted = [...gaps].sort((a, b) => a - b);
	const robotic = gaps.filter((x) => x < 150).length;
	const natural = gaps.filter((x) => x >= 150 && x <= 4000).length / gaps.length;
	const cv = Math.sqrt(gaps.reduce((s, x) => s + (x - sorted[sorted.length >> 1]!) ** 2, 0) / gaps.length) / Math.max(1, sorted[sorted.length >> 1]!);
	const variety = Math.min(1, cv / 0.35); // perfectly regular timing looks scripted
	return { score: Math.round((0.7 * natural + 0.3 * variety) * 1000) / 1000, median_gap_ms: Math.round(sorted[sorted.length >> 1]!), min_gap_ms: Math.round(sorted[0]!), gaps: gaps.length, robotic };
}

export function heuristics(edl: Edl, ix: IndexResult, actions: ActionRecord[]): Heuristics {
	// Map each 0.5 s of output back to a source bin.
	const out: { bin: (typeof ix.bins)[number]; outT: number }[] = [];
	let outT = 0;
	for (const c of edl.clips) {
		const len = (c.end - c.start) / c.speed;
		for (let k = 0; k < len; k += 0.5) {
			const src = c.start + k * c.speed;
			const bin = ix.bins[Math.min(ix.bins.length - 1, Math.floor(src / 0.5))];
			if (bin) out.push({ bin, outT: outT + k });
		}
		outT += len;
	}
	const n = Math.max(1, out.length);
	const exc = (b: (typeof ix.bins)[number]) => (b.excitement ?? 1.2) / 4;
	const dead = out.filter(({ bin }) => bin.motion < 0.0035 && bin.touches === 0 && (bin.excitement ?? 1) < 1.2 && bin.phase !== "end_card").length / n;
	const loading = out.filter(({ bin }) => bin.phase === "loading" || bin.luma < 0.03).length / n;
	const action = out.reduce((s, { bin }) => s + exc(bin), 0) / n;
	const energy = (b: (typeof ix.bins)[number]) => exc(b) * 0.7 + Math.min(1, b.motion * 25) * 0.3;
	const first = out.filter((o) => o.outT < 2);
	const hookRatio = first.length ? first.reduce((s, o) => s + energy(o.bin), 0) / first.length / Math.max(0.05, out.reduce((s, o) => s + energy(o.bin), 0) / n) : 0;
	// coverage: which logged moment kinds are inside the cut
	const inCut = (m: { start: number; end: number }) => edl.clips.some((c) => Math.min(c.end, m.end) - Math.max(c.start, m.start) >= Math.min(0.8, (m.end - m.start) * 0.5));
	const kinds = (ks: string[]) => ix.moments.filter((m) => ks.includes(m.kind));
	const has = (ks: string[]) => kinds(ks).length > 0;
	const detail: Record<string, boolean> = { core_loop: kinds(["core_loop", "hook", "climax"]).some(inCut) };
	if (has(["feature", "upgrade"])) detail.feature = kinds(["feature", "upgrade"]).some(inCut);
	if (has(["progression", "reward", "climax"])) detail.progression = kinds(["progression", "reward", "climax"]).some(inCut);
	if (ix.end_card_t !== undefined) detail.end_card = edl.clips.some((c) => c.end > ix.end_card_t! + 0.8);
	const vals = Object.values(detail);
	const coverage = vals.filter(Boolean).length / Math.max(1, vals.length);
	const used = actions.filter((a) => a.kind !== "wait" && edl.clips.some((c) => a.t0 >= c.start && a.t0 < c.end));
	const total = outT;
	const ht = humanTiming(actions);
	const shots = edl.clips.length;
	const avgShot = total / Math.max(1, shots);
	const pace = avgShot >= 1.4 && avgShot <= 5 ? 1 : avgShot < 1.4 ? avgShot / 1.4 : Math.max(0, 1 - (avgShot - 5) / 10);
	const H = 100 * (0.18 * (1 - Math.min(1, dead * 2)) + 0.2 * Math.min(1, action / 0.6) + 0.14 * Math.min(1, hookRatio / 1.1) + 0.24 * coverage + 0.1 * ht.score + 0.08 * (1 - Math.min(1, loading * 3)) + 0.06 * pace);
	const r3 = (x: number) => Math.round(x * 1000) / 1000;
	return { dead_ratio: r3(dead), loading_ratio: r3(loading), action: r3(action), hook_ratio: r3(hookRatio), coverage: r3(coverage), coverage_detail: detail, human_timing: ht.score,
		shots, avg_shot_s: r3(avgShot), touches_per_10s: r3((used.length / Math.max(1, total)) * 10), H: Math.round(H * 10) / 10 };
}

const JUDGE_SYSTEM = `You review highlight videos of mobile games for an ad network. A good highlight: about 20 seconds, shows a high-action stretch, makes the core loop obvious, shows the game's major features (upgrades, actions, goals, progression), and looks like a real person playing: natural timing, short pauses to read the screen, competent but not perfect, no instant robotic decisions. The white dot is the player's finger (touch indicator). Be strict and specific; a 10 is rare.

Reply with JSON:
{"core_loop_clarity": 1-10, "features": 1-10, "human_play": 1-10, "action": 1-10, "hook": 1-10, "polish": 1-10, "would_run": 1-10,
 "worst_moment": {"t": seconds, "issue": "..."}, "best_moment": {"t": seconds, "why": "..."}, "summary": "two sentences"}
core_loop_clarity: after watching, a viewer knows how to play. features: major mechanics/progression visible. human_play: looks like a real person. action: exciting, no dead air. hook: the first 2 seconds grab attention. polish: sensible order, clean cuts, no loading/menus/glitches, call to action at the end if the game has one. would_run: would you run it as this game's ad highlight.`;

async function judgeProxy(path: string): Promise<string> {
	const p = path.replace(/\.mp4$/, ".judge.mp4");
	if (!existsSync(p)) await run("ffmpeg", ["-loglevel", "error", "-y", "-i", path, "-vf", "scale=540:960", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "64k", p]);
	return p;
}

export async function judge(path: string, game: unknown): Promise<Judge> {
	const { cfg, ledger } = sc();
	const keys = ["core_loop_clarity", "features", "human_play", "action", "hook", "polish", "would_run"] as const;
	const r = await chatJson<Judge>({
		model: cfg.models.judge, reasoning: "low", system: JUDGE_SYSTEM, ledger, phase: "eval", kind: "judge", estimateUsd: 0.03, maxTokens: 2500, temperature: 0.1,
		parts: [{ text: `The game, as described by the agent that played it: ${JSON.stringify(game)}` }, { video: await judgeProxy(path) }],
		validate: (v) => keys.filter((k) => typeof v?.[k] !== "number" || v[k] < 1 || v[k] > 10).map((k) => `${k} must be a number 1-10`),
	});
	const v = r.value;
	const w = { core_loop_clarity: 0.18, features: 0.14, human_play: 0.16, action: 0.14, hook: 0.1, polish: 0.1, would_run: 0.18 };
	v.J = Math.round(keys.reduce((s, k) => s + (v[k] as number) * w[k], 0) * 100) / 10;
	return v;
}

export async function pairwise(a: string, b: string): Promise<"A" | "B" | "tie"> {
	const { cfg, ledger } = sc();
	const r = await chatJson<{ winner: string; reason: string }>({
		model: cfg.models.judge, reasoning: "low", ledger, phase: "eval", kind: "judge", estimateUsd: 0.04, temperature: 0,
		system: "You compare two highlight videos of the same mobile game made for an ad. Pick the one you would run: clearer core loop, more action, more features shown, more natural human play, better hook and pacing. Reply with JSON {\"winner\": \"A\"|\"B\"|\"tie\", \"reason\": \"one sentence\"}.",
		parts: [{ text: "Video A:" }, { video: await judgeProxy(a) }, { text: "Video B:" }, { video: await judgeProxy(b) }],
		validate: (v) => (["A", "B", "tie"].includes(v?.winner) ? [] : ['winner must be "A", "B" or "tie"']),
	});
	return r.value.winner as "A" | "B" | "tie";
}

export async function evaluateCandidates(cands: { edl: Edl; path: string }[], ix: IndexResult): Promise<{ evals: CandidateEval[]; best: CandidateEval; pairwise?: unknown }> {
	const { cfg, paths, trace } = sc();
	const actions = readJsonl<ActionRecord>(paths.actions);
	const evals: CandidateEval[] = [];
	for (const c of cands) {
		const gate = await specGate(c.path, { target: cfg.highlight.duration_s, hasAudio: ix.has_audio, maxW: 1080, maxH: 1920, fps: cfg.browser.fps });
		const h = heuristics(c.edl, ix, actions);
		let j: Judge | undefined;
		try { j = await judge(c.path, ix.game); } catch (e) { trace.emit("eval", "warn", `judge failed for ${c.edl.id}: ${String(e).slice(0, 160)}`); }
		const score = gate.ok ? Math.round((j ? 0.55 * j.J + 0.45 * h.H : h.H) * 10) / 10 : 0;
		evals.push({ id: c.edl.id, strategy: c.edl.strategy, source: c.edl.source, path: c.path, gate, heuristics: h, judge: j, score });
		trace.emit("eval", "eval", `${c.edl.id} (${c.edl.strategy}): score ${score} · gate ${gate.ok ? "ok" : `FAIL ${gate.problems.join("; ")}`} · H ${h.H} · J ${j?.J ?? "-"}${j ? ` (loop ${j.core_loop_clarity}, features ${j.features}, human ${j.human_play}, action ${j.action}, run ${j.would_run})` : ""}`, { id: c.edl.id, score, gate, h, j });
	}
	const real = evals.filter((e) => e.source !== "baseline").sort((a, b) => b.score - a.score);
	let best = real[0]!;
	let pw: unknown;
	if (cfg.eval.pairwise && real.length >= 2 && real[0]!.score - real[1]!.score < 6 && real[1]!.gate.ok) {
		try {
			const [x, y] = [real[0]!, real[1]!];
			const r1 = await pairwise(x.path, y.path);
			const r2 = await pairwise(y.path, x.path);
			const xw = (r1 === "A" ? 1 : 0) + (r2 === "B" ? 1 : 0), yw = (r1 === "B" ? 1 : 0) + (r2 === "A" ? 1 : 0);
			x.wins = xw; y.wins = yw;
			if (yw > xw) best = y;
			pw = { a: x.id, b: y.id, a_first: r1, b_first: r2, winner: best.id };
			trace.emit("eval", "eval", `pairwise ${x.id} vs ${y.id}: ${xw}-${yw} → ${best.id}`, pw);
		} catch (e) { trace.emit("eval", "warn", `pairwise failed: ${String(e).slice(0, 160)}`); }
	}
	copyFileSync(best.path, paths.highlight);
	return { evals, best, pairwise: pw };
}


