// Trace: one JSONL event per meaningful step, stamped with wall-clock time and, where it applies, game time.
// trace.html is rendered from it; every other artifact (plans, actions, decisions, ledger) is linked by ids.
import { appendJsonl, log, readJsonl } from "./util/core.ts";

export type TraceType =
	| "session_start"
	| "phase"
	| "boot"
	| "observe"
	| "plan"
	| "act"
	| "decide"
	| "stuck"
	| "end_card"
	| "recording"
	| "index"
	| "edl"
	| "render"
	| "eval"
	| "friction"
	| "error"
	| "warn"
	| "note"
	| "done";

export type TraceEvent = { ts: string; phase: string; type: TraceType; msg: string; game_t?: number; data?: unknown };

export class Trace {
	private readonly path: string;
	constructor(path: string) {
		this.path = path;
	}
	emit(phase: string, type: TraceType, msg: string, data?: unknown, opts: { game_t?: number; quiet?: boolean } = {}): void {
		const ev: TraceEvent = { ts: new Date().toISOString(), phase, type, msg };
		if (opts.game_t !== undefined) ev.game_t = Math.round(opts.game_t * 1000) / 1000;
		if (data !== undefined) ev.data = data;
		appendJsonl(this.path, ev);
		if (!opts.quiet) {
			const gt = opts.game_t !== undefined ? ` t=${opts.game_t.toFixed(1)}s` : "";
			if (type === "error") log.err(`[${phase}]${gt} ${msg}`);
			else if (type === "warn") log.warn(`[${phase}]${gt} ${msg}`);
			else log.step(`[${phase}]${gt} ${msg}`);
		}
	}
	all(): TraceEvent[] {
		return readJsonl<TraceEvent>(this.path);
	}
}
