#!/usr/bin/env node
// Entry point.
//   ./run --playable ./game.html --out highlight.mp4      one playable, end to end (resumable: --session <dir>)
//   ./run batch games/samples/*.html --out-dir deliverables   many playables, one durable session each
//   ./run doctor | setup | report --session <dir>
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, loadDotEnv, newSessionId, ROOT, sessionPaths, type Config } from "./config.ts";
import { ctx, openHarness, SessionTask, type SessionOutput } from "./durable/session.ts";
import { writeReport } from "./report/html.ts";
import { loadState, makeSessionContext, saveState, setSession, type SessionState } from "./runtime.ts";
import { doctor, setup } from "./setup.ts";
import { ensureDir, errMsg, log, readJson, readJsonIf, sha256, writeJson } from "./util/core.ts";
import { readFileSync } from "node:fs";

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
export async function runSession(playableArg: string, opts: { session?: string; out?: string; dotted: Record<string, string>; runsDir?: string }): Promise<SessionOutput & { dir: string }> {
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
function exportDeliverable(dir: string, outDir: string): void {
	ensureDir(outDir);
	const files = ["highlight.mp4", "raw.mp4", "friction.md", "friction.json", "eval.json", "trace.html", "game_model.json", "moments.json", "session.json", "summary.json", "plans.jsonl", "actions.jsonl", "observations.jsonl", "ledger.jsonl", "trace.jsonl", "config.json", "state.json"];
	for (const f of files) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(outDir, f));
	for (const f of readdirSync(dir).filter((x) => /^edl_.*\.json$/.test(x))) copyFileSync(join(dir, f), join(outDir, f));
	if (existsSync(join(dir, "candidates"))) {
		ensureDir(join(outDir, "candidates"));
		for (const f of readdirSync(join(dir, "candidates")).filter((x) => /^cut_[a-z_]+\.mp4$/.test(x))) copyFileSync(join(dir, "candidates", f), join(outDir, "candidates", f));
	}
	// screenshots referenced by the trace and the friction report
	if (existsSync(join(dir, "obs"))) cpSync(join(dir, "obs"), join(outDir, "obs"), { recursive: true });
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
			const r = await runSession(playable, { session: f.session as string | undefined, out: f.out as string | undefined, dotted });
			if (f.export) exportDeliverable(r.dir, resolve(String(f.export)));
			break;
		}
		case "batch": {
			const list = f._.slice(1).flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((x) => x.endsWith(".html")).map((x) => join(p, x)) : [p]));
			const outDir = resolve(String(f["out-dir"] ?? join(ROOT, "deliverables")));
			const results: Record<string, unknown> = readJsonIf(join(outDir, "batch.json")) ?? {};
			for (const p of list) {
				const name = basename(p).replace(/\.html?$/i, "");
				const prev = results[name] as { dir?: string; status?: string } | undefined;
				try {
					const r = await runSession(p, { session: prev?.dir && existsSync(prev.dir) ? prev.dir : undefined, dotted, out: join(outDir, name, "highlight.mp4") });
					exportDeliverable(r.dir, join(outDir, name));
					results[name] = { status: "ok", dir: r.dir, score: r.score, best: r.best, usd: r.usd };
				} catch (e) {
					log.err(`${name}: ${errMsg(e)}`);
					results[name] = { ...(prev ?? {}), status: "failed", error: errMsg(e).slice(0, 400) };
				}
				writeJson(join(outDir, "batch.json"), results);
			}
			log.head("batch summary");
			for (const [k, v] of Object.entries(results)) log.info(`${k.padEnd(28)} ${JSON.stringify(v)}`);
			break;
		}
		case "export": {
			if (!f.session || !f.to) throw new Error("usage: ./run export --session <dir> --to <dir>");
			exportDeliverable(resolve(String(f.session)), resolve(String(f.to)));
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


