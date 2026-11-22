// Cost ledger: every paid model call is one JSONL line. The guard refuses a call that would cross the budget, and the
// callers degrade (fewer planner calls, heuristic EDL, frame-based judging) instead of failing the session.
import { appendJsonl, readJsonl } from "./util/core.ts";

export type CostKind = "planner" | "decider" | "director" | "judge" | "friction";
export type CostEntry = {
	ts: string;
	phase: string;
	kind: CostKind;
	model: string;
	usd: number;
	tokens_in?: number;
	tokens_out?: number;
	ms?: number;
	note?: string;
};

export class BudgetExceeded extends Error {}

export class Ledger {
	private readonly path: string;
	private readonly budget: number;
	private entries: CostEntry[];
	constructor(path: string, budgetUsd: number) {
		this.path = path;
		this.budget = budgetUsd;
		this.entries = readJsonl<CostEntry>(path);
	}
	record(e: Omit<CostEntry, "ts">): void {
		const entry = { ts: new Date().toISOString(), ...e, usd: Math.round(e.usd * 1e6) / 1e6 };
		this.entries.push(entry);
		appendJsonl(this.path, entry);
	}
	total(): number {
		return this.entries.reduce((s, e) => s + e.usd, 0);
	}
	remaining(): number {
		return this.budget - this.total();
	}
	guard(estimateUsd: number, what: string): void {
		if (this.total() + estimateUsd > this.budget) {
			throw new BudgetExceeded(`budget $${this.budget} would be exceeded by ${what} (spent $${this.total().toFixed(3)}, est. $${estimateUsd.toFixed(3)})`);
		}
	}
	summary(): { total: number; calls: number; by_kind: Record<string, { usd: number; calls: number }>; by_phase: Record<string, number> } {
		const by_kind: Record<string, { usd: number; calls: number }> = {};
		const by_phase: Record<string, number> = {};
		for (const e of this.entries) {
			const k = (by_kind[e.kind] ??= { usd: 0, calls: 0 });
			k.usd += e.usd;
			k.calls++;
			by_phase[e.phase] = (by_phase[e.phase] ?? 0) + e.usd;
		}
		return { total: this.total(), calls: this.entries.length, by_kind, by_phase };
	}
	all(): CostEntry[] {
		return [...this.entries];
	}
}
