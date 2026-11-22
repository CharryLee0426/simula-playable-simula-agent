// `./run setup` (idempotent: Python env, Chromium for Playwright, .env) and `./run doctor` (read-only checks).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, loadDotEnv, ROOT } from "./config.ts";
import { log, run } from "./util/core.ts";

const ENV = join(ROOT, ".env");
const PY = join(ROOT, "py");
const VENV_PY = join(PY, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

async function have(cmd: string, args = ["--version"]): Promise<string | null> {
	try {
		const r = await run(cmd, args);
		return r.code === 0 ? (r.stdout || r.stderr).split("\n")[0]!.trim() : null;
	} catch {
		return null;
	}
}

export async function setup(): Promise<void> {
	log.head("1/4 tools");
	const [maj, min] = process.versions.node.split(".").map(Number) as [number, number];
	if (maj < 22 || (maj === 22 && min < 19)) throw new Error(`Node ${process.versions.node} is too old; need >= 22.19`);
	log.ok(`node ${process.versions.node}`);
	for (const t of ["ffmpeg", "ffprobe"]) {
		const v = await have(t, ["-version"]);
		if (!v) throw new Error(`${t} not found (macOS: brew install ffmpeg · Ubuntu: sudo apt-get install -y ffmpeg)`);
		log.ok(v);
	}
	const uv = await have("uv");
	if (!uv) throw new Error("uv not found: curl -LsSf https://astral.sh/uv/install.sh | sh  (or brew install uv)");
	log.ok(uv);
	log.head("2/4 python env (py/.venv: playwright, numpy, pillow)");
	const s = await run("uv", ["sync", "--project", PY]);
	if (s.code !== 0) throw new Error(`uv sync failed: ${s.stderr.slice(-400)}`);
	log.ok("uv sync");
	log.head("3/4 chromium for playwright");
	if (process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) log.ok(`using browsers in ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
	else {
		const r = await run(VENV_PY, ["-m", "playwright", "install", "chromium"]);
		if (r.code !== 0) throw new Error(`playwright install failed: ${r.stderr.slice(-400)}`);
		log.ok("chromium installed");
	}
	log.head("4/4 OpenRouter key (.env, never committed)");
	loadDotEnv();
	if (process.env.OPENROUTER_API_KEY) log.ok("OPENROUTER_API_KEY is set");
	else if (process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const k = (await rl.question("OpenRouter API key (https://openrouter.ai/keys): ")).trim();
		rl.close();
		if (k) {
			const prev = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
			writeFileSync(ENV, `${prev.replace(/^OPENROUTER_API_KEY=.*$/m, "").trim()}\nOPENROUTER_API_KEY=${k}\n`.trimStart());
			chmodSync(ENV, 0o600);
			process.env.OPENROUTER_API_KEY = k;
			log.ok("saved to .env");
		}
	} else log.warn("set OPENROUTER_API_KEY in .env (see .env.example)");
	await doctor();
}

export async function doctor(): Promise<void> {
	loadDotEnv();
	const cfg = loadConfig();
	let ok = true;
	const check = (good: boolean, msg: string, fix?: string) => {
		if (good) log.ok(msg);
		else { ok = false; log.err(`${msg}${fix ? ` → ${fix}` : ""}`); }
	};
	log.head("doctor");
	check(!!(await have("ffmpeg", ["-version"])), "ffmpeg", "install ffmpeg");
	check(existsSync(VENV_PY), "python env (py/.venv)", "./run setup");
	if (existsSync(VENV_PY)) {
		const r = await run(VENV_PY, ["-c", "import playwright, numpy, PIL; print('ok')"]);
		check(r.code === 0, "python packages (playwright, numpy, pillow)", "./run setup");
	}
	if (process.platform === "linux" && !process.env.DISPLAY) check(!!(await have("Xvfb", ["-help"])) || true, `display: ${(await have("which", ["Xvfb"])) ? "Xvfb available (headed Chrome with Mesa llvmpipe, ~3x faster WebGL)" : "no Xvfb: headless SwiftShader (slower)"}`);
	const key = process.env.OPENROUTER_API_KEY;
	check(!!key, "OPENROUTER_API_KEY", "put it in .env");
	if (key) {
		try {
			const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
			const j: any = await r.json();
			const ids = new Set((j.data ?? []).map((m: any) => m.id));
			for (const k of ["planner", "director", "judge"] as const) check(ids.has(cfg.models[k]), `model ${k}: ${cfg.models[k]}`, "pick another id in config/local.json");
			const d = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: cfg.models.decider, state: ["ping"], questions: { ok: { type: "noul", instructions: "This text says ping." } } }), signal: AbortSignal.timeout(20_000) });
			check(d.ok, `decider: ${cfg.models.decider}`, "the decider is optional: the agent falls back to pixel heuristics");
		} catch (e) {
			check(false, `OpenRouter reachable (${String(e).slice(0, 120)})`, "check network / proxy (set NODE_USE_ENV_PROXY=1 behind a proxy)");
		}
	}
	if (!ok) throw new Error("doctor found problems");
}
