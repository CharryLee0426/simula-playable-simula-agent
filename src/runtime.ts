// Process-wide services for the current session. Durable task phases are code + checkpoints; everything they talk
// to (config, paths, ledger, trace) is rebuilt from the session directory when a process (re)opens the session.
import { resolve } from "node:path";
import { sessionPaths, type Config, type SessionPaths } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Trace } from "./trace.ts";
import { readJsonIf, writeJson } from "./util/core.ts";

export type SessionState = {
	session_id: string;
	playable: string;
	playable_sha: string;
	created_at: string;
	out?: string;
	task?: any; // Pi Durable task id (stored raw)
	phases: Record<string, { at: string; ms: number; note?: string }>;
	best?: string;
};

export type SessionContext = { cfg: Config; paths: SessionPaths; ledger: Ledger; trace: Trace };

let current: SessionContext | undefined;
export function setSession(c: SessionContext): void {
	current = c;
}
export function sc(): SessionContext {
	if (!current) throw new Error("session context not initialized");
	return current;
}
export function makeSessionContext(cfg: Config, dir: string): SessionContext {
	const paths = sessionPaths(resolve(dir));
	return { cfg, paths, ledger: new Ledger(paths.ledger, cfg.budget_usd), trace: new Trace(paths.trace) };
}
export function loadState(paths: SessionPaths): SessionState | undefined {
	return readJsonIf<SessionState>(paths.state);
}
export function saveState(paths: SessionPaths, s: SessionState): void {
	writeJson(paths.state, s);
}
export function markPhase(phase: string, ms: number, note?: string): void {
	const { paths } = sc();
	const st = loadState(paths);
	if (!st) return;
	if (note?.includes("reused") && st.phases[phase]) return; // keep the timing of the run that did the work
	st.phases[phase] = { at: new Date().toISOString(), ms, ...(note ? { note } : {}) };
	saveState(paths, st);
}
