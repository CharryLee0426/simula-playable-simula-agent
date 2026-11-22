// Model access over OpenRouter. Two kinds of calls:
//   chatJson()  — a VLM/LLM that answers with one JSON object (images and video in, JSON out), retried on transport,
//                 parse and validation errors; validation errors are sent back to the model to fix.
//   decide()    — the Decisions API (typed, probabilistic answers: noul / choice / score), used for the cheap,
//                 high-frequency judgments: screen phase, "did that tap work", excitement of a frame, clarity.
// Every call is written to the ledger (cost, tokens, latency) and guarded by the budget.
import { readFileSync } from "node:fs";
import type { Reasoning } from "./config.ts";
import type { CostKind, Ledger } from "./ledger.ts";
import { errMsg, log, sleep } from "./util/core.ts";

const OR = "https://openrouter.ai/api";

function headers() {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set (put it in .env or the environment)");
	return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/simula-playable-agent", "X-Title": "simula-playable-agent" };
}

export type Part = { text: string } | { image: string | Buffer; mime?: string } | { video: string | Buffer };

function toContent(parts: Part[]): unknown[] {
	return parts.map((p) => {
		if ("text" in p) return { type: "text", text: p.text };
		if ("image" in p) {
			const buf = typeof p.image === "string" ? readFileSync(p.image) : p.image;
			return { type: "image_url", image_url: { url: `data:${p.mime ?? "image/jpeg"};base64,${buf.toString("base64")}` } };
		}
		const buf = typeof p.video === "string" ? readFileSync(p.video) : p.video;
		return { type: "video_url", video_url: { url: `data:video/mp4;base64,${buf.toString("base64")}` } };
	});
}

export function extractJson(text: string): unknown {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fence ? fence[1]! : text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("no JSON object in model answer");
	return JSON.parse(body.slice(start, end + 1));
}

export type ChatResult<T> = { value: T; raw: string; ms: number; usd: number; tokens_in: number; tokens_out: number; attempts: number };

export async function chatJson<T>(args: {
	model: string;
	system: string;
	parts: Part[];
	ledger: Ledger;
	phase: string;
	kind: CostKind;
	reasoning?: Reasoning;
	validate?: (v: T) => string[];
	maxAttempts?: number;
	maxTokens?: number;
	temperature?: number;
	estimateUsd?: number;
	timeoutMs?: number;
}): Promise<ChatResult<T>> {
	const messages: any[] = [{ role: "system", content: args.system }, { role: "user", content: toContent(args.parts) }];
	let lastErr = "";
	let usd = 0, tin = 0, tout = 0;
	const t0 = Date.now();
	const maxAttempts = args.maxAttempts ?? 3;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		args.ledger.guard(args.estimateUsd ?? 0.02, `${args.kind} call`);
		let text = "";
		const ts = Date.now();
		try {
			const body: Record<string, unknown> = {
				model: args.model,
				messages,
				temperature: args.temperature ?? 0.4,
				max_tokens: args.maxTokens ?? 3000,
				response_format: { type: "json_object" },
			};
			if (args.reasoning) body.reasoning = args.reasoning === "none" ? { enabled: false } : { effort: args.reasoning };
			const r = await fetch(`${OR}/v1/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(args.timeoutMs ?? 120_000) });
			const j: any = await r.json().catch(() => ({}));
			if (j.usage) {
				const c = Number(j.usage.cost ?? 0);
				usd += c; tin += j.usage.prompt_tokens ?? 0; tout += j.usage.completion_tokens ?? 0;
				args.ledger.record({ phase: args.phase, kind: args.kind, model: args.model, usd: c, tokens_in: j.usage.prompt_tokens, tokens_out: j.usage.completion_tokens, ms: Date.now() - ts });
			}
			text = j.choices?.[0]?.message?.content ?? "";
			if (!r.ok || !text) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j.error ?? j.choices?.[0]?.finish_reason ?? j).slice(0, 240)}`);
		} catch (e) {
			lastErr = errMsg(e);
			if (attempt < maxAttempts) await sleep(1200 * attempt);
			continue;
		}
		try {
			const v = extractJson(text) as T;
			const problems = args.validate?.(v) ?? [];
			if (problems.length === 0) return { value: v, raw: text, ms: Date.now() - t0, usd, tokens_in: tin, tokens_out: tout, attempts: attempt };
			lastErr = problems.join("; ");
			messages.push({ role: "assistant", content: text }, { role: "user", content: `Your JSON has problems:\n- ${problems.join("\n- ")}\nReturn the corrected full JSON object only.` });
		} catch (e) {
			lastErr = errMsg(e);
			messages.push({ role: "assistant", content: text }, { role: "user", content: `I could not parse that (${lastErr}). Return exactly one JSON object.` });
		}
	}
	throw new Error(`${args.kind}: no valid answer after ${maxAttempts} attempts: ${lastErr}`);
}

// ---------------------------------------------------------------------------------------------- Decisions API
export type Question =
	| { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string; criteria: string[] };
export type Answer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
	| { type: "score"; score: number; probabilities?: number[] };
export type StateItem = string | { image: string | Buffer; mime?: string };

let deciderDown = 0; // consecutive failures: after a few, callers fall back to heuristics for the rest of the session

export async function decide(args: {
	model: string;
	state: StateItem[];
	questions: Record<string, Question>;
	ledger: Ledger;
	phase: string;
	maxAttempts?: number;
}): Promise<{ answers: Record<string, Answer>; ms: number } | null> {
	if (deciderDown >= 6) return null;
	const state = args.state.map((s) => (typeof s === "string" ? s : { type: "image_url", image_url: { url: `data:${s.mime ?? "image/jpeg"};base64,${(typeof s.image === "string" ? readFileSync(s.image) : s.image).toString("base64")}` } }));
	const t0 = Date.now();
	let last = "";
	for (let attempt = 1; attempt <= (args.maxAttempts ?? 3); attempt++) {
		try {
			const r = await fetch(`${OR}/alpha/decisions`, { method: "POST", headers: headers(), body: JSON.stringify({ model: args.model, state, questions: args.questions }), signal: AbortSignal.timeout(45_000) });
			const j: any = await r.json().catch(() => ({}));
			if (r.ok && j.answers) {
				deciderDown = 0;
				args.ledger.record({ phase: args.phase, kind: "decider", model: args.model, usd: Number(j.usage?.cost ?? 0), tokens_in: j.usage?.input_tokens, ms: Date.now() - t0 });
				return { answers: j.answers, ms: Date.now() - t0 };
			}
			last = `HTTP ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`;
			if (r.status === 400) break; // our request is wrong; retrying will not help
			await sleep((r.status === 429 ? 2500 : 800) * attempt);
		} catch (e) {
			last = errMsg(e);
			await sleep(800 * attempt);
		}
	}
	deciderDown++;
	log.warn(`decider failed (${deciderDown}): ${last}`);
	return null;
}

export const noul = (a: Answer | undefined): number | undefined => (a && a.type === "noul" ? a.noul : undefined);
export const choice = (a: Answer | undefined): string | undefined => (a && a.type === "choice" ? a.choice : undefined);
export const score = (a: Answer | undefined): number | undefined => (a && a.type === "score" ? a.score : undefined);
