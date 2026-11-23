// Client for the Python browser worker (py/simbrowser/server.py): one child process per session, JSON lines over
// stdio. The worker owns Chromium, the virtual clock and the recorder; this side only sends requests and waits.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.ts";

export type DomCandidate = { tag: string; label: string; x: number; y: number; w: number; h: number };
export type PageSummary = {
	now: number;
	frame: number;
	raf: number;
	timers: number;
	listeners: Record<string, number>;
	errors: string[];
	events: { t: number; frame: number; kind: string; via?: string; type?: string; url?: string; data?: string }[];
	audioStarts: number;
	canvases: number;
	domNodes: number;
	title: string;
};
export type Observation = { path: string; marks_path?: string; n: number; change: number; changed_frac: number; luma: number; summary: PageSummary; dom?: DomCandidate[] };
export type StepResult = { now: number; frame: number; recorded: number };
export type Op = { op: "step"; frames: number; capture?: boolean } | { op: "touch"; type: "start" | "move" | "end" | "cancel"; x?: number; y?: number } | { op: "mouse"; type: "down" | "move" | "up"; x: number; y: number } | { op: "key"; key: string };

export class BrowserWorker {
	private proc: ChildProcess;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
	private buf = "";
	private exited = false;

	constructor(logPath: string) {
		const py = join(ROOT, "py");
		const venvPy = join(py, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
		const [cmd, args] = existsSync(venvPy) ? [venvPy, ["-m", "simbrowser.server"]] : ["uv", ["run", "--project", py, "python", "-m", "simbrowser.server"]];
		this.proc = spawn(cmd, args, { cwd: py, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
		const logStream = createWriteStream(logPath, { flags: "a" });
		this.proc.stderr!.pipe(logStream);
		this.proc.stdout!.setEncoding("utf8");
		this.proc.stdout!.on("data", (d: string) => {
			this.buf += d;
			let i: number;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 1);
				if (!line.trim()) continue;
				let msg: any;
				try { msg = JSON.parse(line); } catch { continue; }
				const p = this.pending.get(msg.id);
				if (!p) continue;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(`worker ${p.method}: ${msg.error}`));
				else p.resolve(msg.result);
			}
		});
		this.proc.on("exit", (code) => {
			this.exited = true;
			for (const p of this.pending.values()) p.reject(new Error(`browser worker exited (code ${code}) during ${p.method}; see worker.log`));
			this.pending.clear();
		});
	}

	call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<T> {
		if (this.exited) return Promise.reject(new Error("browser worker is not running"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`worker ${method} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, method });
			this.proc.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}

	open(p: { playable: string; run_dir: string; viewport: [number, number]; dpr: number; fps: number; seed: number; display: string; record?: boolean; audio?: "render" | "log"; audio_max_s?: number }) {
		return this.call<{ load_s: number; frame_size: [number, number]; gl: string | null; summary: PageSummary }>("open", p, 180_000);
	}
	step(frames: number, capture = true) {
		return this.call<StepResult>("step", { frames, capture });
	}
	ops(ops: Op[]) {
		return this.call<StepResult>("ops", { ops });
	}
	observe(p: { width?: number; quality?: number; dom?: boolean; marks?: boolean } = {}) {
		return this.call<Observation>("observe", p, 120_000);
	}
	/** Quick screenshot for frame-by-frame checks; `zone` = [y0, x0, y1, x1] (0-1000) crops to an attention window. */
	peek(width = 360, zone?: [number, number, number, number]) {
		return this.call<{ path: string; frame: number }>("peek", { width, ...(zone ? { zone } : {}) }, 60_000);
	}
	async close(): Promise<any> {
		if (this.exited) return {};
		try {
			return await this.call("close", {}, 900_000);
		} finally {
			setTimeout(() => { if (!this.exited) this.proc.kill("SIGKILL"); }, 5000).unref();
		}
	}
	kill(): void {
		if (!this.exited) this.proc.kill("SIGKILL");
	}
}
