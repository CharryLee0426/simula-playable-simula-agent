// Index: turn a recorded session into a timeline the editor can reason about.
//   - cheap signals per 0.5 s bin: on-screen motion, audio loudness, touches, the decider's screen phase and an
//     "excitement" score for a sampled frame (free, ~0.3 s per call, run 4-wide);
//   - one director call (VLM with video input) that watches a low-res proxy with the game time burned into the
//     corner, together with the agent's own action log, and returns a game model plus labelled moments.
// Code clamps and checks everything the model says; the editor only ever sees validated times.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chatJson, choice, decide, score } from "../llm.ts";
import { sc } from "../runtime.ts";
import type { ActionRecord, ObsRecord, SessionSummary } from "../agent/play.ts";
import { readJson, readJsonIf, readJsonl, run, Semaphore, writeJson } from "../util/core.ts";

export type Bin = { t: number; motion: number; audio_db: number; touches: number; luma: number; phase?: string; excitement?: number; frame?: string };
export const MOMENT_KINDS = ["hook", "core_loop", "feature", "upgrade", "progression", "reward", "climax", "fail", "tutorial", "end_card", "idle", "loading"] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];
export type Moment = { start: number; end: number; kind: MomentKind; label: string; intensity: number; feature?: string };
export type GameModel = {
	title: string; genre: string; objective: string; controls: string; core_loop: string; features: string[]; progression: string;
	end_card: boolean; tone: string; hook_idea: string;
};
export type IndexResult = { duration: number; bins: Bin[]; moments: Moment[]; game: GameModel; end_card_t?: number; playable_from: number; has_audio: boolean };

const FONTS = [
	"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
	"/System/Library/Fonts/Supplemental/Arial Bold.ttf",
	"/System/Library/Fonts/Supplemental/Arial.ttf",
	"/Library/Fonts/Arial.ttf",
	"C:/Windows/Fonts/arialbd.ttf",
];

const DIRECTOR_SYSTEM = `You are a senior video editor for mobile game ads. You are given the full raw screen recording of one play session of a playable ad (the game time in seconds is burned into the top-left corner of every frame), plus the player's action log. Your job is to understand the game and log every moment an editor would care about.

Return one JSON object:
{"game": {"title": str, "genre": str, "objective": str, "controls": "how the player interacts, concretely", "core_loop": "the repeated action -> result -> reward cycle, one sentence", "features": ["each distinct mechanic/feature visible: upgrades, unit types, abilities, combos, power-ups, shop, level-ups..."], "progression": "how the game escalates (waves, levels, bigger numbers, new areas)", "end_card": true|false, "tone": "visual/emotional tone in a few words", "hook_idea": "the single most attention-grabbing moment for the first 2 seconds of an ad, with its time"},
 "moments": [{"start": s, "end": s, "kind": "hook|core_loop|feature|upgrade|progression|reward|climax|fail|tutorial|end_card|idle|loading", "label": "what happens, concretely", "intensity": 1-5, "feature": "feature name if kind is feature/upgrade"}]}

Rules for moments:
- Use the burned-in timestamps; start/end in seconds with one decimal; each moment 0.8-8 s long; cover the whole session (idle and loading stretches too, so the editor knows what to avoid).
- "core_loop": clear examples of the main action producing its result (the clearest ones get intensity >= 3).
- "feature"/"upgrade": first time a mechanic, upgrade, new unit/item or ability is used or shown.
- "progression"/"reward"/"climax": level-ups, waves cleared, big payouts, explosions, boss, combos, victory.
- "end_card": the final install/play screen if it appears.
- intensity: 1 = nothing happening, 3 = solid gameplay, 5 = the most exciting moment of the session.
- 8-30 moments.`;

function fontPath(): string | undefined {
	return FONTS.find((f) => existsSync(f));
}

export async function buildIndex(): Promise<IndexResult> {
	const { cfg, paths, ledger, trace } = sc();
	const session = readJson<SessionSummary>(paths.session);
	const duration = session.game_s;
	const fps = session.fps;
	const BIN = 0.5;
	const nb = Math.ceil(duration / BIN);
	const frames = readJsonl<{ f: number; t: number; motion: number; luma: number }>(paths.frames);
	const rms = readJsonIf<number[]>(paths.audioRms) ?? [];
	const actions = readJsonl<ActionRecord>(paths.actions);
	const obs = readJsonl<ObsRecord>(paths.observations);
	const bins: Bin[] = Array.from({ length: nb }, (_, i) => ({ t: i * BIN, motion: 0, audio_db: -90, touches: 0, luma: 0 }));
	for (const b of bins) {
		const fs = frames.filter((f) => f.t >= b.t && f.t < b.t + BIN);
		b.motion = fs.length ? fs.reduce((s, f) => s + f.motion, 0) / fs.length : 0;
		b.luma = fs.length ? fs.reduce((s, f) => s + f.luma, 0) / fs.length : 0;
		const r = rms.slice(Math.floor(b.t * 10), Math.floor((b.t + BIN) * 10));
		b.audio_db = r.length ? Math.max(...r) : -90;
		b.touches = actions.filter((a) => a.kind !== "wait" && a.t0 < b.t + BIN && a.t1 >= b.t).length;
		const o = [...obs].reverse().find((x) => x.t <= b.t + BIN);
		if (o?.phase) b.phase = o.phase;
	}

	// ---- decider: phase + excitement on frames sampled every `decider_sample_s`
	const fdir = join(paths.dir, "index_frames");
	mkdirSync(fdir, { recursive: true });
	const step = cfg.index.decider_sample_s;
	if (!readdirSync(fdir).length) {
		await run("ffmpeg", ["-loglevel", "error", "-y", "-i", paths.rawVideo, "-vf", `fps=${1 / step},scale=360:-2`, "-q:v", "5", join(fdir, "f_%05d.jpg")]);
	}
	const files = readdirSync(fdir).filter((f) => f.endsWith(".jpg")).sort();
	const cachePath = join(paths.dir, "index_decider.json");
	const cache = readJsonIf<Record<string, { phase?: string; excitement?: number }>>(cachePath) ?? {};
	const sem = new Semaphore(cfg.index.decider_concurrency);
	let ok = 0;
	await Promise.all(files.map((f, i) => sem.run(async () => {
		if (cache[f]) { ok++; return; }
		const r = await decide({ model: cfg.models.decider, ledger, phase: "index", state: ["A frame from a mobile game screen recording:", { image: join(fdir, f) }], questions: {
			phase: { type: "choice", instructions: "What kind of screen is this?", criteria: { loading: "loading/splash/blank", title: "title/start screen", tutorial: "gameplay with tutorial hints", gameplay: "gameplay", reward: "reward/upgrade/shop popup", level_end: "level complete/victory/results", fail: "game over/fail", end_card: "install/download call-to-action end card", other: "other" } },
			excitement: { type: "score", instructions: "How action-packed and visually exciting is this frame for a mobile game ad?", criteria: ["static, nothing happening", "a little activity", "steady gameplay", "lots of action", "intense, explosive, rewarding"] },
		} });
		if (r) { cache[f] = { phase: choice(r.answers.phase), excitement: score(r.answers.excitement) }; ok++; }
		void i;
	})));
	writeJson(cachePath, cache);
	files.forEach((f, i) => {
		const t = i * step + step / 2;
		const b = bins[Math.min(nb - 1, Math.floor(t / BIN))];
		if (!b) return;
		b.frame = join("index_frames", f);
		if (cache[f]?.phase) b.phase = cache[f]!.phase;
		if (cache[f]?.excitement !== undefined) b.excitement = cache[f]!.excitement;
	});
	trace.emit("index", "index", `signals: ${nb} bins of ${BIN}s · decider tagged ${ok}/${files.length} frames`);

	// ---- where the playable is actually on screen, and where its end card starts
	const firstPlay = bins.find((b) => b.phase && !["loading"].includes(b.phase) && b.luma > 0.04);
	const playableFrom = firstPlay ? firstPlay.t : Math.min(2, duration / 4);
	const endBins = bins.filter((b) => b.phase === "end_card");
	let endCardT: number | undefined = session.end_card_at;
	if (endBins.length >= 2) {
		// the start of the last contiguous run of end-card bins
		let i = bins.length - 1;
		while (i >= 0 && bins[i]!.phase !== "end_card") i--;
		while (i > 0 && bins[i - 1]!.phase === "end_card") i--;
		if (i >= 0 && bins[i]!.t > duration * 0.3) endCardT = Math.min(endCardT ?? Infinity, bins[i]!.t);
	}

	// ---- director: watch the proxy, read the log, return game model + moments
	const proxy = join(paths.dir, "proxy.mp4");
	if (!existsSync(proxy)) {
		const font = fontPath();
		const stamp = font ? `,drawtext=fontfile='${font}':text='t=%{pts\\:flt}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.65` : "";
		const hasAudio = existsSync(paths.audio);
		await run("ffmpeg", ["-loglevel", "error", "-y", "-i", hasAudio ? paths.raw : paths.rawVideo, "-vf", `fps=10,scale=360:640${stamp}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
			...(hasAudio ? ["-c:a", "aac", "-b:a", "48k", "-ac", "1"] : ["-an"]), proxy]);
	}
	const log = actions.filter((a) => a.kind !== "wait").map((a) => `t=${a.t0.toFixed(1)}-${a.t1.toFixed(1)}s ${a.kind}${a.target_label ? ` "${a.target_label}"` : ""}: ${a.intent}`).join("\n");
	const plans = readJsonl<{ t: number; plan: { screen: string; phase: string } }>(paths.plans).map((p) => `t=${p.t.toFixed(1)}s [${p.plan.phase}] ${p.plan.screen}`).join("\n");
	const text = [
		`Session: "${session.title}", ${duration.toFixed(1)} s of game time, recorded at ${fps} fps.`,
		`The playable is on screen from about t=${playableFrom.toFixed(1)}s.${endCardT !== undefined ? ` An end card appears around t=${endCardT.toFixed(1)}s.` : " No end card was detected."}`,
		`The player's notes at the end: ${session.notes || "(none)"}`,
		`What the player saw at each decision (its own words):\n${plans}`,
		`Player actions (game time):\n${log || "(none)"}`,
	].join("\n\n");
	let game: GameModel = { title: session.title, genre: "unknown", objective: "", controls: "", core_loop: "", features: [], progression: "", end_card: endCardT !== undefined, tone: "", hook_idea: "" };
	let moments: Moment[] = [];
	try {
		const r = await chatJson<{ game: GameModel; moments: Moment[] }>({
			model: cfg.models.director, reasoning: cfg.models.director_reasoning, system: DIRECTOR_SYSTEM, ledger, phase: "index", kind: "director",
			parts: [{ text }, { video: proxy }], maxTokens: 16000, estimateUsd: 0.08, timeoutMs: 240_000,
			validate: (v) => {
				const e: string[] = [];
				if (!v?.game || typeof v.game !== "object") e.push("missing game");
				if (!Array.isArray(v?.moments) || v.moments.length < 3) e.push("need at least 3 moments");
				(v?.moments ?? []).forEach((m, i) => {
					if (typeof m.start !== "number" || typeof m.end !== "number" || m.end <= m.start) e.push(`moment ${i + 1}: start/end must be numbers with end > start`);
					else if (m.start < 0 || m.start > duration + 0.5) e.push(`moment ${i + 1}: start outside 0-${duration.toFixed(1)}`);
					if (!MOMENT_KINDS.includes(m.kind)) e.push(`moment ${i + 1}: kind must be one of ${MOMENT_KINDS.join("|")}`);
				});
				return e;
			},
		});
		game = { ...game, ...r.value.game, features: Array.isArray(r.value.game.features) ? r.value.game.features.slice(0, 12) : [] };
		moments = r.value.moments.map((m) => ({ ...m, start: Math.max(0, m.start), end: Math.min(duration, m.end), intensity: Math.min(5, Math.max(1, Math.round(Number(m.intensity) || 2))) })).filter((m) => m.end - m.start >= 0.3);
		trace.emit("index", "index", `director: ${game.genre} — "${game.core_loop}" · ${moments.length} moments · features: ${game.features.join(", ") || "none"}`, { game, cost: r.usd, ms: r.ms });
	} catch (e) {
		trace.emit("index", "warn", `director failed (${String(e).slice(0, 200)}); moments from signals only`);
		moments = signalMoments(bins, playableFrom);
	}
	if (endCardT !== undefined && !moments.some((m) => m.kind === "end_card")) moments.push({ start: endCardT, end: duration, kind: "end_card", label: "end card", intensity: 2 });
	moments.sort((a, b) => a.start - b.start);
	const result: IndexResult = { duration, bins, moments, game, end_card_t: endCardT, playable_from: playableFrom, has_audio: existsSync(paths.audio) };
	writeJson(paths.moments, result);
	writeJson(paths.gameModel, game);
	return result;
}

/** Fallback when the director is unavailable: contiguous stretches of high signal become core_loop moments. */
export function signalMoments(bins: Bin[], from: number): Moment[] {
	const v = bins.map((b) => (b.excitement ?? 1) / 4 * 0.5 + Math.min(1, b.motion * 25) * 0.3 + Math.min(1, b.touches) * 0.2);
	const out: Moment[] = [];
	for (let i = 0; i < bins.length; i += 6) {
		const seg = bins.slice(i, i + 6);
		if (!seg.length || seg[0]!.t < from) continue;
		const s = v.slice(i, i + 6).reduce((a, b) => a + b, 0) / seg.length;
		out.push({ start: seg[0]!.t, end: seg[seg.length - 1]!.t + 0.5, kind: s > 0.35 ? "core_loop" : "idle", label: "gameplay", intensity: Math.max(1, Math.min(5, Math.round(s * 6))) });
	}
	return out;
}
