#!/usr/bin/env node
// Entry point.
//   ./run --playable ./game.html --out highlight.mp4      one playable, end to end (resumable: --session <dir>)
//   ./run batch games/samples/*.html --out-dir deliverables   many playables, one durable session each
//   ./run doctor | setup | report --session <dir>
import { copyFileSync, cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, loadDotEnv, newSessionId, ROOT, sessionPaths, type Config } from "./config.ts";
import { ctx, openHarness, SessionTask, type SessionOutput } from "./durable/session.ts";
import { writeReport } from "./report/html.ts";
import { loadState, makeSessionContext, saveState, setSession, type SessionState } from "./runtime.ts";
import { doctor, setup } from "./setup.ts";
import { ensureDir, errMsg, log, readJson, readJsonIf, run, sha256, writeJson } from "./util/core.ts";
import { readFileSync, writeFileSync } from "node:fs";

type Flags = { _: string[]; sets: string[]; [k: string]: string | boolean | string[] };
function parseArgs(argv: string[]): Flags {
	const f: Flags = { _: [], sets: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
			const val = v !== undefined ? v : argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : true;
			if (k === "set") f.sets.push(String(val));
			else f[k] = val;
		} else f._.push(a);
	}
	return f;
}

function overrides(f: Flags): Record<string, string> {
	const o: Record<string, string> = {};
	if (f["max-game-s"]) o["play.max_game_s"] = String(f["max-game-s"]);
	if (f.budget) o.budget_usd = String(f.budget);
	if (f.seed) o["browser.seed"] = String(f.seed);
	if (f.persona) o["play.persona"] = String(f.persona);
	if (f.dpr) o["browser.dpr"] = String(f.dpr);
	if (f["no-overlay"]) o["highlight.touch_overlay"] = "false";
	if (f["no-end-card"]) o["highlight.include_end_card"] = "false";
	for (const s of f.sets) {
		const [k, v] = s.split("=", 2);
		if (k && v !== undefined) o[k] = v;
	}
	return o;
}

/** Run (or resume) one playable through the durable session task. Returns the session summary. */
const REDO: Record<string, string[]> = {
	play: ["raw.mp4", "raw_video.mp4", "session.json", "audio.wav", "audio_rms.json", "frames.jsonl", "actions.jsonl", "plans.jsonl", "observations.jsonl", "obs", "audio", "index_frames", "index_decider.json", "proxy.mp4"],
	index: ["moments.json", "game_model.json", "proxy.mp4"],
	cut: ["edl_a.json", "edl_b.json", "edl_c.json", "edl_h.json", "edl_base_first.json", "edl_base_random.json"],
	render: ["candidates"],
	eval: ["eval.json", "highlight.mp4"],
	friction: ["friction.json", "friction.md"],
	report: ["summary.json", "trace.html"],
};
const PHASES = ["play", "index", "cut", "render", "eval", "friction", "report"];
function redoFrom(dir: string, phase: string): void {
	const i = PHASES.indexOf(phase);
	if (i < 0) throw new Error(`--redo must be one of ${PHASES.join(", ")}`);
	for (const p of PHASES.slice(i)) for (const f of REDO[p]!) rmSync(join(dir, f), { recursive: true, force: true });
}

export async function runSession(playableArg: string, opts: { session?: string; out?: string; dotted: Record<string, string>; runsDir?: string; redo?: string }): Promise<SessionOutput & { dir: string }> {
	const playable = resolve(playableArg);
	if (!existsSync(playable)) throw new Error(`playable not found: ${playable}`);
	const dir = resolve(opts.session ?? join(opts.runsDir ?? join(ROOT, "runs"), newSessionId(playable)));
	const paths = sessionPaths(dir);
	ensureDir(dir);
	const stored = readJsonIf<Config>(paths.config);
	const cfg: Config = stored ? { ...stored } : loadConfig(opts.dotted);
	if (!stored) writeJson(paths.config, cfg);
	const sctx = makeSessionContext(cfg, dir);
	setSession(sctx);
	let st = loadState(paths);
	if (st && opts.redo) {
		redoFrom(dir, opts.redo);
		st.task = undefined;
		saveState(paths, st);
		log.info(`redo from phase "${opts.redo}": outputs of that phase and later removed`);
	}
	if (!st) {
		st = { session_id: basename(dir), playable, playable_sha: sha256(readFileSync(playable)).slice(0, 16), created_at: new Date().toISOString(), out: opts.out ? resolve(opts.out) : undefined, phases: {} };
		saveState(paths, st);
		sctx.trace.emit("session", "session_start", `session ${st.session_id} for ${basename(playable)}`, { config: cfg }, { quiet: true });
	}
	log.head(`▶ ${basename(playable)} — session ${st.session_id}${stored ? " (resumed)" : ""}`);
	log.info(`dir: ${dir}`);
	const h = await openHarness(paths.harness);
	let closing = false;
	const stop = async () => {
		if (closing) process.exit(130);
		closing = true;
		log.warn(`interrupted — the session is durable. Resume with: ./run --playable ${playableArg} --session ${dir}`);
		await h.close(ctx).catch(() => undefined);
		process.exit(130);
	};
	process.on("SIGINT", stop);
	try {
		let id = st.task;
		const rec = id ? await h.getTask(id as any, ctx) : undefined;
		const terminal = rec && (rec.state as any).status === "terminal";
		const completed = terminal && (rec!.state as any).outcome?.status === "completed";
		if (!rec || (terminal && !completed)) {
			if (terminal) log.info(`previous task ended ${(rec!.state as any).outcome?.status}; starting a new task on the same session (finished phases are reused)`);
			const root = await h.root(ctx);
			id = await h.commit(async (tx: any) => tx.createTask(SessionTask, { playable }, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
			st.task = id;
			saveState(paths, st);
		} else if (!completed) log.info(`resuming task ${id}`);
		h.resume();
		const settled: any = await h.waitForTask(id as any, ctx);
		const outcome = settled.state?.outcome;
		if (outcome?.status !== "completed") throw new Error(`session ${outcome?.status ?? "did not finish"}: ${outcome?.error?.message ?? ""}`);
		const res = outcome.result as SessionOutput;
		const out = opts.out ?? st.out;
		if (out && existsSync(paths.highlight)) {
			ensureDir(dirname(resolve(out)));
			copyFileSync(paths.highlight, resolve(out));
		}
		log.ok(`done: score ${res.score} (cut ${res.best}) · $${res.usd} · highlight ${out ? resolve(out) : paths.highlight} · report ${paths.html}`);
		return { ...res, dir };
	} finally {
		process.off("SIGINT", stop);
		await h.close(ctx).catch(() => undefined);
	}
}

/** Copy the reviewer-facing files of a session into deliverables/<name>/. */
/** Copy a session's reviewer-facing files. The highlight stays full quality; the raw session and the scored
 *  candidates are shipped as 540×960 versions (the full-resolution ones stay in the session directory). */
async function exportDeliverable(dir: string, outDir: string): Promise<void> {
	ensureDir(outDir);
	const files = ["highlight.mp4", "friction.md", "friction.json", "eval.json", "trace.html", "game_model.json", "moments.json", "session.json", "summary.json", "plans.jsonl", "actions.jsonl", "observations.jsonl", "ledger.jsonl", "trace.jsonl", "config.json", "state.json"];
	for (const f of files) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(outDir, f));
	for (const f of readdirSync(dir).filter((x) => /^edl_.*\.json$/.test(x))) copyFileSync(join(dir, f), join(outDir, f));
	if (existsSync(join(dir, "raw.mp4"))) {
		const r = await run("ffmpeg", ["-loglevel", "error", "-y", "-i", join(dir, "raw.mp4"), "-vf", "scale=540:960", "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", join(outDir, "raw.mp4")]);
		if (r.code !== 0) copyFileSync(join(dir, "raw.mp4"), join(outDir, "raw.mp4"));
	}
	if (existsSync(join(dir, "candidates"))) {
		ensureDir(join(outDir, "candidates"));
		for (const f of readdirSync(join(dir, "candidates")).filter((x) => /^cut_[a-z_]+\.mp4$/.test(x))) {
			const proxy = join(dir, "candidates", f.replace(/\.mp4$/, ".judge.mp4"));
			copyFileSync(existsSync(proxy) ? proxy : join(dir, "candidates", f), join(outDir, "candidates", f));
		}
	}
	// screenshots referenced by the trace and the friction report
	if (existsSync(join(dir, "obs"))) cpSync(join(dir, "obs"), join(outDir, "obs"), { recursive: true });
}

/** deliverables/README.md: one row per exported session (folders tagged .samples / .generated / .holdout / .calibration). */
function summarize(dir: string): void {
	const groups = ["samples", "generated", "holdout", "calibration"];
	const groupOf = (n: string) => groups.find((g) => existsSync(join(dir, n, `.${g}`))) ?? "";
	const names = readdirSync(dir)
		.filter((n) => existsSync(join(dir, n, "eval.json")))
		.sort((a, b) => groups.indexOf(groupOf(a)) - groups.indexOf(groupOf(b)) || a.localeCompare(b));
	let total = 0;
	const rows = names.map((n) => {
		const ev = readJson<any>(join(dir, n, "eval.json"));
		const se = readJsonIf<any>(join(dir, n, "session.json"));
		const fr = readJsonIf<any>(join(dir, n, "friction.json"));
		const gm = readJsonIf<any>(join(dir, n, "game_model.json"));
		const st = readJsonIf<any>(join(dir, n, "state.json"));
		const usd = readFileSync(join(dir, n, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).reduce((a, l) => a + Number(JSON.parse(l).usd || 0), 0);
		total += usd;
		const mins = st?.phases ? Object.values(st.phases as Record<string, { ms: number }>).reduce((a, p) => a + p.ms, 0) / 60000 : 0;
		const best = ev.candidates.find((c: any) => c.id === ev.best);
		const vs = ev.vs_baseline ? `${ev.vs_baseline.chosen_wins}/${ev.vs_baseline.of}` : "-";
		const high = fr?.items?.filter((i: any) => i.severity === "high").length ?? 0;
		return `| ${groupOf(n)} | **${n}** | ${gm?.genre ?? ""} | [highlight](${n}/highlight.mp4) · [raw](${n}/raw.mp4) · [trace](${n}/trace.html) · [friction](${n}/friction.md) | **${ev.score}** | ${best?.judge?.J ?? "-"} / ${best?.heuristics?.H ?? "-"} | ${(ev.baselines ?? []).map((b: any) => b.score).join(" / ") || "-"} | ${ev.separation ?? "-"} | ${vs} | ${se ? `${se.game_s.toFixed(0)} s · ${se.actions} inputs · ${se.ended_by}` : ""} | ${fr?.items?.length ?? 0} (${high} high) | $${usd.toFixed(2)} | ${mins.toFixed(0)} min |`;
	});
	const md = [
		"# Deliverables",
		"",
		"One folder per playable: `highlight.mp4` (20 s, 1080×1920, 30 fps, H.264 + AAC), `raw.mp4` (the full session in game time), `friction.md`/`.json`, `eval.json`, `trace.html` (open in a browser), `candidates/` (every cut that was scored, including the naive baselines), and the logs (`plans.jsonl`, `actions.jsonl`, `observations.jsonl`, `ledger.jsonl`, `trace.jsonl`).",
		"",
		"| set | playable | genre (as understood by the agent) | files | score | judge J / heuristics H | baselines (first 20 s / random) | separation | head-to-head vs best baseline | session | friction items | cost | wall time |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
		`Total model spend: $${total.toFixed(2)}. Score = gate × (0.55 × J + 0.45 × H). Separation = chosen cut − best baseline.`,
	].join("\n");
	writeFileSync(join(dir, "README.md"), md + "\n");
	log.ok(`${join(dir, "README.md")} (${rows.length} rows)`);
}

async function main(): Promise<void> {
	loadDotEnv();
	const f = parseArgs(process.argv.slice(2));
	const cmd = f._[0] && !f._[0].endsWith(".html") ? f._[0] : "run";
	const dotted = overrides(f);
	switch (cmd) {
		case "run": {
			const playable = (f.playable as string) ?? f._.find((x) => x.endsWith(".html"));
			if (!playable) throw new Error("usage: ./run --playable ./game.html --out highlight.mp4");
			if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing: put it in .env (see .env.example) or run ./run setup");
			const r = await runSession(playable, { session: f.session as string | undefined, out: f.out as string | undefined, dotted, redo: f.redo as string | undefined });
			if (f.export) await exportDeliverable(r.dir, resolve(String(f.export)));
			break;
		}
		case "batch": {
			const list = f._.slice(1).flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((x) => x.endsWith(".html")).map((x) => join(p, x)) : [p]));
			const outDir = resolve(String(f["out-dir"] ?? join(ROOT, "deliverables")));
			const results: Record<string, unknown> = readJsonIf(join(outDir, String(f.state ?? "batch.json"))) ?? {};
			for (const p of list) {
				const name = basename(p).replace(/\.html?$/i, "");
				const prev = results[name] as { dir?: string; status?: string } | undefined;
				try {
					const reuse = prev?.dir && existsSync(prev.dir) ? prev.dir : undefined;
					const r = await runSession(p, { session: reuse, dotted, out: join(outDir, name, "highlight.mp4"), redo: reuse && f.redo ? String(f.redo) : undefined });
					await exportDeliverable(r.dir, join(outDir, name));
					if (f.group) writeFileSync(join(outDir, name, `.${String(f.group)}`), "");
					results[name] = { status: "ok", dir: r.dir, score: r.score, best: r.best, usd: r.usd };
				} catch (e) {
					log.err(`${name}: ${errMsg(e)}`);
					results[name] = { ...(prev ?? {}), status: "failed", error: errMsg(e).slice(0, 400) };
				}
				writeJson(join(outDir, String(f.state ?? "batch.json")), results);
			}
			log.head("batch summary");
			for (const [k, v] of Object.entries(results)) log.info(`${k.padEnd(28)} ${JSON.stringify(v)}`);
			break;
		}
		case "export": {
			if (!f.session || !f.to) throw new Error("usage: ./run export --session <dir> --to <dir>");
			await exportDeliverable(resolve(String(f.session)), resolve(String(f.to)));
			if (f.group) writeFileSync(join(resolve(String(f.to)), `.${String(f.group)}`), "");
			break;
		}
		case "report": {
			const dir = resolve(String(f.session));
			const cfg = readJson<Config>(join(dir, "config.json"));
			setSession(makeSessionContext(cfg, dir));
			writeReport();
			log.ok(`report → ${join(dir, "trace.html")}`);
			break;
		}
		case "summarize":
			summarize(resolve(String(f.dir ?? join(ROOT, "deliverables"))));
			break;
		case "doctor":
			await doctor();
			break;
		case "setup":
			await setup();
			break;
		default:
			throw new Error(`unknown command ${cmd}`);
	}
}

main().then(() => process.exit(0), (e) => {
	log.err(errMsg(e));
	if (process.env.DEBUG) console.error(e);
	process.exit(1);
});


