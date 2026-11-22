// One playable = one durable SessionTask (Pi Durable). Every phase commits a checkpoint before the next starts, and
// every phase is idempotent against the session directory (it skips work whose output exists), so a crash, a
// Ctrl-C or a failed model call resumes at the phase it stopped in without redoing paid or slow work.
//
//   play ─► index ─► cut ─► render ─► eval ─► friction ─► report
//   (browser, 30 fps capture, audio mix)  (signals + VLM moments)  (3 EDLs)  (candidates)  (gate+heuristics+judge)
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { existsSync } from "node:fs";
import { playSession } from "../agent/play.ts";
import { evaluateCandidates, heuristics, specGate, type CandidateEval } from "../eval/evaluate.ts";
import { writeFriction } from "../friction.ts";
import { baselineEdls, renderEdl, writeEdls, type Edl } from "../highlight/cut.ts";
import { buildIndex, type IndexResult } from "../highlight/index.ts";
import { writeReport } from "../report/html.ts";
import { loadState, markPhase, saveState, sc } from "../runtime.ts";
import { errMsg, log, readJson, readJsonIf, readJsonl, writeJson } from "../util/core.ts";
import { join } from "node:path";

export const ctx = BACKGROUND_CONTEXT;
type Ctx = Parameters<Parameters<typeof defineTask>[0]["abort"]>[2];
const running = <S>(checkpoint: S) => ({ status: "running" as const, checkpoint });
const done = <R>(result: R) => ({ status: "terminal" as const, outcome: { status: "completed" as const, result } });
const failed = (message: string) => ({ status: "terminal" as const, outcome: { status: "failed" as const, error: { message } } });

export type SessionInput = { playable: string };
export type SessionOutput = { highlight: string; score: number; best: string; usd: number };
type Phase = "play" | "index" | "cut" | "render" | "eval" | "friction" | "report";
type State = { phase: Phase; attempt: number };
const ORDER: Phase[] = ["play", "index", "cut", "render", "eval", "friction", "report"];
const next = (p: Phase): State => ({ phase: ORDER[ORDER.indexOf(p) + 1]!, attempt: 0 });

/** Wraps a phase: timing, trace, checkpoint, bounded retries, failure as a committed outcome. */
function phase(name: Phase, maxAttempts: number, work: () => Promise<string | void>) {
	return async (task: any, rt: any, c: Ctx) => {
		const { trace } = sc();
		const attempt: number = task.state.checkpoint.attempt ?? 0;
		const t0 = Date.now();
		trace.emit(name, "phase", `▶ ${name}${attempt ? ` (retry ${attempt})` : ""}`, undefined, { quiet: true });
		try {
			const note = await work();
			const ms = Date.now() - t0;
			markPhase(name, ms, note || undefined);
			log.ok(`${name} done in ${(ms / 1000).toFixed(1)} s${note ? ` — ${note}` : ""}`);
			if (name === "report") return void (await rt.commit(() => done(readJson<SessionOutput>(sc().paths.summary)), c));
			await rt.commit(() => running(next(name)), c);
		} catch (e) {
			const msg = errMsg(e);
			trace.emit(name, "error", `${name} failed: ${msg.slice(0, 400)}`);
			if (attempt + 1 < maxAttempts) await rt.commit(() => running({ phase: name, attempt: attempt + 1 }), c);
			else await rt.commit(() => failed(`${name}: ${msg}`), c);
		}
	};
}

const loadIndex = () => readJson<IndexResult>(sc().paths.moments);
const edlIds = () => {
	const { cfg } = sc();
	return ["a", "b", "c", "h"].slice(0, 4).filter((id) => existsSync(sc().paths.edl(id))).slice(0, Math.max(1, cfg.highlight.candidates));
};

export const SessionTask = defineTask<SessionInput, State, SessionOutput>({
	name: "playable.session",
	version: 1,
	initial: () => ({ phase: "play", attempt: 0 }),
	phases: {
		play: phase("play", 2, async () => {
			const { paths } = sc();
			if (existsSync(paths.raw) && existsSync(paths.session)) return "raw recording exists (reused)";
			const st = loadState(paths)!;
			const s = await playSession(st.playable);
			return `${s.game_s.toFixed(1)} s recorded, ${s.actions} inputs, ${s.planner_calls} planner turns, ended by ${s.ended_by}`;
		}),
		index: phase("index", 2, async () => {
			const { paths } = sc();
			if (existsSync(paths.moments)) return "index exists (reused)";
			const ix = await buildIndex();
			return `${ix.moments.length} moments, genre: ${ix.game.genre}`;
		}),
		cut: phase("cut", 2, async () => {
			if (edlIds().length) return `${edlIds().length} EDLs exist (reused)`;
			const e = await writeEdls(loadIndex());
			return `${e.length} EDLs`;
		}),
		render: phase("render", 2, async () => {
			const { paths, cfg, trace } = sc();
			const edls: Edl[] = edlIds().map((id) => readJson<Edl>(paths.edl(id)));
			if (cfg.eval.pairwise !== undefined) for (const b of baselineEdls(loadIndex(), cfg.highlight.duration_s)) edls.push(b);
			for (const e of edls) {
				const out = paths.candidate(e.id);
				if (existsSync(out)) continue;
				const ix = loadIndex();
				// baselines go through the same normalizer so they are judged on content, not on length
				const { normalize } = await import("../highlight/cut.ts");
				const ne = e.source === "baseline" ? normalize(e, ix, readJsonl(paths.actions), { target: cfg.highlight.duration_s, maxSpeed: cfg.highlight.max_speed, fps: cfg.browser.fps, includeEnd: false }) : e;
				if (e.source === "baseline") writeJson(paths.edl(e.id), ne);
				const r = await renderEdl(ne, out);
				trace.emit("render", "render", `rendered ${e.id} (${e.strategy}): ${r.duration} s, ${r.frames} frames${r.has_audio ? ", with audio" : ""}`);
			}
			return `${edls.length} candidates`;
		}),
		eval: phase("eval", 2, async () => {
			const { paths, cfg } = sc();
			if (existsSync(paths.eval) && existsSync(paths.highlight)) return "eval exists (reused)";
			const ix = loadIndex();
			const ids = [...edlIds(), "base_first", "base_random"].filter((id) => existsSync(paths.edl(id)) && existsSync(paths.candidate(id)));
			const cands = ids.map((id) => ({ edl: readJson<Edl>(paths.edl(id)), path: paths.candidate(id) }));
			const r = await evaluateCandidates(cands, ix);
			const st = loadState(paths)!;
			st.best = r.best.id;
			saveState(paths, st);
			const base = r.evals.filter((e) => e.source === "baseline");
			writeJson(paths.eval, {
				best: r.best.id, score: r.best.score, pass: r.best.score >= cfg.eval.pass_score, pairwise: r.pairwise, vs_baseline: r.vsBaseline,
				candidates: r.evals, baselines: base.map((b) => ({ id: b.id, score: b.score })),
				separation: base.length ? Math.round((r.best.score - Math.max(...base.map((b) => b.score))) * 10) / 10 : null,
				weights: { final: "gate × (0.55 × judge J + 0.45 × heuristics H)", note: "J and H are 0-100" },
			});
			return `best ${r.best.id} (${r.best.strategy}) score ${r.best.score}`;
		}),
		friction: phase("friction", 2, async () => {
			const { paths } = sc();
			if (existsSync(paths.frictionJson)) return "friction exists (reused)";
			const f = await writeFriction(loadIndex());
			return `${f.items.length} items`;
		}),
		report: phase("report", 2, async () => {
			const { paths, ledger } = sc();
			const ev = readJson<{ best: string; score: number; pass: boolean; candidates: CandidateEval[] }>(paths.eval);
			const st = loadState(paths)!;
			const summary: SessionOutput & Record<string, unknown> = { highlight: paths.highlight, score: ev.score, best: ev.best, usd: Math.round(ledger.total() * 10000) / 10000, pass: ev.pass, phases: st.phases };
			writeJson(paths.summary, summary);
			writeReport();
			return `trace.html written · total spend $${ledger.total().toFixed(3)}`;
		}),
	} as any,
	abort: (async (_t: unknown, rt: any, c: Ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c)) as any,
});

export async function openHarness(dbPath: string): Promise<Harness> {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "playable-agent", tasks: [SessionTask] as any }));
	const models = createModels();
	models.setProvider(openrouterProvider());
	const storage = await openNodeSqliteStorage(dbPath);
	return Harness.open(storage, {
		models,
		registry,
		identity: { attribution: { name: "simula-playable-agent", url: "https://github.com/" } },
		settings: { retry: { maxRetries: 2 }, afterFailedRun: "continue" },
		onReport: (rep: any) => {
			if (rep.kind === "listener_error") return;
			log.warn(`harness ${rep.kind}${rep.task ? ` (${rep.task.kind})` : ""}: ${rep.error?.message ?? rep.reason ?? ""}`);
		},
	} as any, ctx);
}


