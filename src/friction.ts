// Friction report: where a first-time player gets confused, stuck or bored, with a timestamp and a suggested fix.
//
// The agent *was* a first-time player, so its own session is the evidence. Code first extracts candidate signals:
//   - the decider's "would a first-time player know what to do" score on every screen the agent decided on,
//   - inputs that had no visible effect (decider before/after check + pixel change) and stuck streaks,
//   - how long it took until the first input that worked,
//   - idle stretches where nothing moved and nobody touched, fail screens, and the agent's own words ("did not register").
// The model then writes the report, and every item must cite at least one signal id: an item without evidence is dropped.
import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { ActionRecord, ObsRecord, SessionSummary } from "./agent/play.ts";
import type { IndexResult } from "./highlight/index.ts";
import { chatJson, type Part } from "./llm.ts";
import { sc } from "./runtime.ts";
import { readJson, readJsonl, writeJson, writeText } from "./util/core.ts";

export type Signal = { id: string; t: number; end?: number; kind: string; detail: string; obs?: number; image?: string };
export type FrictionItem = { t: number; end?: number; type: string; severity: "low" | "medium" | "high"; title: string; evidence: string; suggestion: string; signals: string[]; image?: string };

const TYPES = ["confusion", "stuck", "boredom", "frustration", "unclear_goal", "ui", "pacing"];

export function frictionSignals(ix: IndexResult): Signal[] {
	const { paths } = sc();
	const obs = readJsonl<ObsRecord>(paths.observations).filter((o) => o.turn > 0);
	const plans = readJsonl<{ turn: number; t: number; obs: number; plan: { progress?: string; screen?: string; phase?: string } }>(paths.plans);
	const actions = readJsonl<ActionRecord>(paths.actions);
	const session = readJson<SessionSummary>(paths.session);
	const sig: Signal[] = [];
	const add = (s: Omit<Signal, "id">) => sig.push({ id: `S${sig.length + 1}`, ...s });
	// first input that visibly worked
	const firstOk = obs.find((o) => (o.effect ?? 0) >= 0.5 || o.changed_frac > 0.08);
	if (firstOk) {
		const wait = firstOk.t - ix.playable_from;
		add({ t: ix.playable_from, end: firstOk.t, kind: "time_to_first_success", detail: `${wait.toFixed(1)} s from the first playable frame until an input visibly worked`, obs: firstOk.n, image: firstOk.path });
	}
	// unclear screens (merge consecutive)
	for (const o of obs) {
		if (o.clarity !== undefined && o.clarity < 0.5) add({ t: o.t, kind: "unclear_screen", detail: `decider: only ${(o.clarity * 100).toFixed(0)}% that a first-time player knows what to do (screen: ${o.planner_phase ?? o.phase})`, obs: o.n, image: o.marks_path ?? o.path });
	}
	// inputs without effect, and streaks
	let streak: ObsRecord[] = [];
	const flush = () => {
		if (streak.length >= 2) add({ t: streak[0]!.t, end: streak[streak.length - 1]!.t, kind: "stuck", detail: `${streak.length} consecutive turns where the player's input had no visible effect`, obs: streak[0]!.n, image: streak[0]!.path });
		streak = [];
	};
	for (const o of obs) {
		const failed = (o.effect !== undefined && o.effect < 0.3) || (o.effect === undefined && o.changed_frac < 0.005 && o.turn > 1);
		if (failed) {
			streak.push(o);
			const p = plans.find((x) => x.turn === o.turn - 1);
			add({ t: o.t, kind: "no_effect", detail: `previous input had no visible effect (decider ${o.effect !== undefined ? (o.effect * 100).toFixed(0) + "%" : "n/a"}, ${(o.changed_frac * 100).toFixed(1)}% of pixels changed)${p ? ` — the player had tried: ${p.plan.screen?.slice(0, 80)}` : ""}`, obs: o.n, image: o.path });
		} else flush();
	}
	flush();
	// the agent's own words
	for (const p of plans) {
		const txt = `${p.plan.progress ?? ""}`;
		if (/(did ?n[o']t|not) (work|register|respond|react)|no effect|nothing happen|unclear|confus|not sure|can't find|cannot find|stuck|failed/i.test(txt)) add({ t: p.t, kind: "player_comment", detail: `player: "${txt.slice(0, 160)}"`, obs: p.obs });
	}
	// idle stretches (>= 3 s with no motion and no touches) — boredom risk
	let run0: number | undefined;
	for (const b of ix.bins) {
		const idle = b.motion < 0.0025 && b.touches === 0 && b.t >= ix.playable_from && b.phase !== "end_card";
		if (idle && run0 === undefined) run0 = b.t;
		if (!idle && run0 !== undefined) { if (b.t - run0 >= 3) add({ t: run0, end: b.t, kind: "idle", detail: `${(b.t - run0).toFixed(1)} s with no on-screen motion and no input` }); run0 = undefined; }
	}
	// long waits the player chose (the game made them wait)
	for (const a of actions.filter((x) => x.kind === "wait" && x.t1 - x.t0 >= 2.5)) add({ t: a.t0, end: a.t1, kind: "forced_wait", detail: `player waited ${(a.t1 - a.t0).toFixed(1)} s: ${a.intent}` });
	// fail screens, slips
	for (const o of obs.filter((x) => x.phase === "fail" || x.planner_phase === "fail")) add({ t: o.t, kind: "fail_screen", detail: "a fail / game-over screen", obs: o.n, image: o.path });
	const slips = actions.filter((a) => a.slipped);
	if (slips.length) add({ t: slips[0]!.t0, kind: "slips", detail: `${slips.length} imprecise tap(s) by the player (targets may be small)` });
	if (ix.end_card_t !== undefined) add({ t: ix.end_card_t, kind: "end_card", detail: `end card appeared at ${ix.end_card_t.toFixed(1)} s (session ${session.game_s.toFixed(1)} s)` });
	else add({ t: session.game_s, kind: "no_end_card", detail: `no end card within ${session.game_s.toFixed(0)} s of play` });
	return sig;
}

const SYSTEM = `You are a UX researcher for playable ads. An AI agent played this playable as a first-time player; you get code-extracted signals from its session (with ids) and a few screenshots. Write the friction report: where a real first-time player would get confused, stuck or bored, each with a concrete, actionable fix for the playable's designers.

Rules: 3-8 items, most important first. Every item cites the signal ids it is based on ("signals": ["S3", ...]); do not invent problems that no signal supports. Use the signal's time. If the session went smoothly, say so with fewer, low-severity items. Fixes are specific (what to change on which screen), not generic advice.

Reply with JSON: {"summary": "two sentences on the first-time experience", "items": [{"t": seconds, "end": seconds|null, "type": "confusion|stuck|boredom|frustration|unclear_goal|ui|pacing", "severity": "low|medium|high", "title": "short", "evidence": "what happened, citing what the player saw/did", "suggestion": "the fix", "signals": ["S1"]}]}`;

export async function writeFriction(ix: IndexResult): Promise<{ summary: string; items: FrictionItem[]; signals: Signal[] }> {
	const { cfg, paths, ledger, trace } = sc();
	const signals = frictionSignals(ix);
	const session = readJson<SessionSummary>(paths.session);
	const ids = new Set(signals.map((s) => s.id));
	const images = signals.filter((s) => s.image && existsSync(s.image)).slice(0, 6);
	const parts: Part[] = [
		{ text: `Game: ${JSON.stringify(ix.game)}\nSession: ${session.game_s.toFixed(1)} s, playable from ${ix.playable_from.toFixed(1)} s, ${session.actions} inputs, ended by ${session.ended_by}.\nPlayer's final notes: ${session.notes}\n\nSignals:\n${signals.map((s) => `${s.id} t=${s.t.toFixed(1)}${s.end !== undefined ? `-${s.end.toFixed(1)}` : ""}s [${s.kind}] ${s.detail}${s.image ? " (screenshot attached)" : ""}`).join("\n")}` },
		...images.flatMap((s) => [{ text: `Screenshot for ${s.id} (t=${s.t.toFixed(1)}s):` } as Part, { image: s.image! } as Part]),
	];
	let summary = "";
	let items: FrictionItem[] = [];
	try {
		const r = await chatJson<{ summary: string; items: FrictionItem[] }>({
			model: cfg.models.director, reasoning: "low", system: SYSTEM, ledger, phase: "friction", kind: "friction", parts, maxTokens: 4000, estimateUsd: 0.03,
			validate: (v) => {
				const e: string[] = [];
				if (!Array.isArray(v?.items)) return ["items must be an array"];
				v.items.forEach((it, i) => {
					if (!TYPES.includes(it.type)) e.push(`item ${i + 1}: type must be one of ${TYPES.join("|")}`);
					if (!Array.isArray(it.signals) || !it.signals.some((s) => ids.has(s))) e.push(`item ${i + 1}: must cite at least one existing signal id`);
					if (typeof it.t !== "number" || it.t < 0 || it.t > session.game_s + 1) e.push(`item ${i + 1}: t must be within the session`);
				});
				return e;
			},
		});
		summary = r.value.summary;
		items = r.value.items.filter((it) => it.signals.some((s) => ids.has(s))).map((it) => {
			const s = signals.find((x) => it.signals.includes(x.id) && x.image);
			return { ...it, image: s?.image ? relative(paths.dir, s.image) : undefined };
		});
	} catch (e) {
		trace.emit("friction", "warn", `friction model failed (${String(e).slice(0, 160)}); writing signals only`);
		items = signals.filter((s) => ["stuck", "unclear_screen", "idle", "time_to_first_success"].includes(s.kind)).slice(0, 6).map((s) => ({
			t: s.t, end: s.end, type: s.kind === "idle" ? "boredom" : s.kind === "stuck" ? "stuck" : "confusion", severity: "medium" as const, title: s.kind.replace(/_/g, " "), evidence: s.detail, suggestion: "(model unavailable)", signals: [s.id], image: s.image ? relative(paths.dir, s.image) : undefined,
		}));
	}
	const report = { summary, items, signals };
	writeJson(paths.frictionJson, report);
	const md = [
		`# Friction report — ${ix.game.title}`,
		"",
		summary,
		"",
		"| time | type | severity | issue | suggested fix |",
		"| --- | --- | --- | --- | --- |",
		...items.map((it) => `| ${fmtT(it.t)}${it.end ? `–${fmtT(it.end)}` : ""} | ${it.type} | ${it.severity} | **${it.title}** — ${it.evidence.replace(/\|/g, "/")} | ${it.suggestion.replace(/\|/g, "/")} |`),
		"",
		"## Evidence",
		"",
		...items.filter((it) => it.image).map((it) => `**${fmtT(it.t)} · ${it.title}** (signals ${it.signals.join(", ")})\n\n![${it.title}](${it.image})\n`),
		"## Signals extracted from the session",
		"",
		...signals.map((s) => `- \`${s.id}\` ${fmtT(s.t)} [${s.kind}] ${s.detail}`),
	].join("\n");
	writeText(paths.frictionMd, md + "\n");
	trace.emit("friction", "friction", `${items.length} friction items (${items.filter((i) => i.severity === "high").length} high) from ${signals.length} signals`, { items: items.map((i) => `${fmtT(i.t)} ${i.type}: ${i.title}`) });
	return report;
}

export const fmtT = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
