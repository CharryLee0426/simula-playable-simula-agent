// Configuration: config/default.json <- config/local.json <- --set key=value / CLI flags; secrets from .env or the
// environment. A session stores the config it ran with, so a resumed session never changes behaviour midway.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readJsonIf, shortHash } from "./util/core.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Reasoning = "none" | "minimal" | "low" | "medium" | "high";
export type Config = {
	budget_usd: number;
	models: { planner: string; planner_reasoning: Reasoning; director: string; director_reasoning: Reasoning; judge: string; decider: string };
	browser: { viewport: [number, number]; dpr: number; fps: number; display: "auto" | "headless" | "headed" | "xvfb"; seed: number };
	play: {
		max_game_s: number;
		min_game_s: number;
		max_planner_calls: number;
		boot_max_s: number;
		end_card_hold_s: number;
		tap_cta_at_end: boolean;
		persona: "casual_competent" | "first_timer" | "expert";
		/** "agent" (default) or "random": a model-free random player with machine timing, used to calibrate the evaluator. */
		policy?: "agent" | "random";
		stuck_after: number;
	};
	highlight: { duration_s: number; max_source_s: number; max_speed: number; candidates: number; width: number; height: number; touch_overlay: boolean; include_end_card: boolean };
	index: { decider_sample_s: number; decider_concurrency: number };
	eval: { pairwise: boolean; pass_score: number; judge_samples?: number };
};

function deepMerge<T>(base: T, over: unknown): T {
	if (over === null || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : (over as T);
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
		if (k.startsWith("_")) continue;
		out[k] = k in out && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
	}
	return out as T;
}

export function applyDotted<T>(cfg: T, dotted: Record<string, string>): T {
	const c = JSON.parse(JSON.stringify(cfg)) as Record<string, any>;
	for (const [path, raw] of Object.entries(dotted)) {
		const keys = path.split(".");
		let o = c;
		for (const k of keys.slice(0, -1)) o = o[k] ??= {};
		const last = keys[keys.length - 1]!;
		let v: unknown = raw;
		if (raw === "true" || raw === "false") v = raw === "true";
		else if (raw.trim() !== "" && !Number.isNaN(Number(raw))) v = Number(raw);
		else if (raw.startsWith("[")) v = JSON.parse(raw);
		o[last] = v;
	}
	return c as T;
}

export function loadConfig(dotted: Record<string, string> = {}): Config {
	let cfg = readJson<Config>(join(ROOT, "config", "default.json"));
	const local = readJsonIf<Partial<Config>>(join(ROOT, "config", "local.json"));
	if (local) cfg = deepMerge(cfg, local);
	return applyDotted(cfg, dotted);
}

/** .env -> process.env (never overrides variables already set). */
export function loadDotEnv(): void {
	const p = join(ROOT, ".env");
	if (!existsSync(p)) return;
	for (const line of readFileSync(p, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
		if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
	}
}

export type SessionPaths = ReturnType<typeof sessionPaths>;
export function sessionPaths(dir: string) {
	const j = (...p: string[]) => join(dir, ...p);
	return {
		dir,
		config: j("config.json"),
		state: j("state.json"),
		harness: j("harness.sqlite"),
		trace: j("trace.jsonl"),
		ledger: j("ledger.jsonl"),
		plans: j("plans.jsonl"),
		actions: j("actions.jsonl"),
		decisions: j("decisions.jsonl"),
		observations: j("observations.jsonl"),
		frames: j("frames.jsonl"),
		rawVideo: j("raw_video.mp4"),
		raw: j("raw.mp4"),
		audio: j("audio.wav"),
		audioRms: j("audio_rms.json"),
		session: j("session.json"),
		gameModel: j("game_model.json"),
		moments: j("moments.json"),
		edl: (id: string) => j(`edl_${id}.json`),
		candidate: (id: string) => j("candidates", `cut_${id}.mp4`),
		highlight: j("highlight.mp4"),
		eval: j("eval.json"),
		frictionJson: j("friction.json"),
		frictionMd: j("friction.md"),
		html: j("trace.html"),
		summary: j("summary.json"),
	};
}

/** A stable, readable session id: <playable-name>-<content hash>-<timestamp>. */
export function newSessionId(playable: string): string {
	const name = basename(playable).replace(/\.html?$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
	const h = shortHash(readFileSync(playable), 6);
	const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
	return `${name}-${h}-${ts}`;
}
