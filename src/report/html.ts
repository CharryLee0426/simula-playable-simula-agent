// trace.html: one self-contained page per session, next to its files. Everything the agent saw, decided and spent,
// linked to the exact moment of the raw recording (click any time to seek).
import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { ActionRecord, ObsRecord, SessionSummary } from "../agent/play.ts";
import type { CandidateEval } from "../eval/evaluate.ts";
import { humanTiming } from "../eval/evaluate.ts";
import type { FrictionItem, Signal } from "../friction.ts";
import type { Edl } from "../highlight/cut.ts";
import type { IndexResult } from "../highlight/index.ts";
import { sc } from "../runtime.ts";
import { readJsonIf, readJsonl, writeText } from "../util/core.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const seek = (t: number) => `<a href="#raw" class="t" data-t="${t.toFixed(2)}">${fmt(t)}</a>`;
const KIND_COLOR: Record<string, string> = { hook: "#e5484d", core_loop: "#3e63dd", feature: "#8e4ec6", upgrade: "#8e4ec6", progression: "#12a594", reward: "#f5a524", climax: "#e5484d", fail: "#6e6e6e", tutorial: "#0090ff", end_card: "#30a46c", idle: "#bbbbbb", loading: "#dddddd" };

function chart(ix: IndexResult, actions: ActionRecord[], best?: Edl): string {
	const W = 1000, H = 150, D = Math.max(1, ix.duration);
	const x = (t: number) => (t / D) * W;
	const line = (vals: number[], color: string) => `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${vals.map((v, i) => `${x(ix.bins[i]!.t + 0.25).toFixed(1)},${(H - 30 - v * (H - 50)).toFixed(1)}`).join(" ")}"/>`;
	const motion = ix.bins.map((b) => Math.min(1, b.motion * 25));
	const audio = ix.bins.map((b) => Math.min(1, Math.max(0, (b.audio_db + 60) / 60)));
	const exc = ix.bins.map((b) => (b.excitement ?? 0) / 4);
	const moments = ix.moments.map((m) => `<rect x="${x(m.start)}" y="${H - 22}" width="${Math.max(1, x(m.end) - x(m.start))}" height="8" fill="${KIND_COLOR[m.kind] ?? "#999"}" opacity="0.85"><title>${esc(`${fmt(m.start)}-${fmt(m.end)} ${m.kind}: ${m.label}`)}</title></rect>`).join("");
	const cuts = (best?.clips ?? []).map((c, i) => `<rect x="${x(c.start)}" y="4" width="${Math.max(1, x(c.end) - x(c.start))}" height="${H - 30}" fill="#3e63dd" opacity="0.10"/><text x="${x(c.start) + 2}" y="14" font-size="10" fill="#3e63dd">${i + 1}·${esc(c.role)}</text>`).join("");
	const taps = actions.filter((a) => a.kind !== "wait").map((a) => `<line x1="${x(a.t0)}" x2="${x(a.t0)}" y1="${H - 12}" y2="${H - 2}" stroke="#111" stroke-width="1"><title>${esc(`${fmt(a.t0)} ${a.kind}: ${a.intent}`)}</title></line>`).join("");
	const ticks = Array.from({ length: Math.floor(D / 5) + 1 }, (_, i) => `<text x="${x(i * 5)}" y="${H + 10}" font-size="9" fill="#888">${i * 5}s</text>`).join("");
	return `<svg id="chart" viewBox="0 -2 ${W} ${H + 14}" preserveAspectRatio="none" style="width:100%;height:190px;cursor:pointer">${cuts}${line(motion, "#888")}${line(audio, "#f5a524")}${line(exc, "#e5484d")}${moments}${taps}${ticks}</svg>
<div class="legend"><span style="color:#e5484d">━ excitement (decider)</span> <span style="color:#888">━ motion</span> <span style="color:#f5a524">━ audio</span> <span style="color:#3e63dd">▮ clips of the chosen cut</span> · bars: logged moments · ticks: player inputs · click to seek</div>`;
}

export function writeReport(): void {
	const { cfg, paths, ledger } = sc();
	const rel = (p?: string) => (p ? relative(paths.dir, p) : "");
	const session = readJsonIf<SessionSummary>(paths.session);
	const ix = readJsonIf<IndexResult>(paths.moments);
	const ev = readJsonIf<{ best: string; score: number; pass: boolean; candidates: CandidateEval[]; separation: number | null; pairwise?: any }>(paths.eval);
	const fr = readJsonIf<{ summary: string; items: FrictionItem[]; signals: Signal[] }>(paths.frictionJson);
	const actions = readJsonl<ActionRecord>(paths.actions);
	const obs = readJsonl<ObsRecord>(paths.observations);
	const plans = readJsonl<{ turn: number; obs: number; t: number; ms: number; usd: number; error?: string; plan: any; decider: any }>(paths.plans);
	const edls: Record<string, Edl> = {};
	for (const c of ev?.candidates ?? []) { const e = readJsonIf<Edl>(paths.edl(c.id)); if (e) edls[c.id] = e; }
	const best = ev ? edls[ev.best] : undefined;
	const led = ledger.summary();
	const ht = humanTiming(actions);
	const st = readJsonIf<{ session_id: string; playable: string; phases: Record<string, { ms: number; note?: string }> }>(paths.state);
	const g = ix?.game;

	const candRows = (ev?.candidates ?? []).map((c) => `<tr class="${c.id === ev!.best ? "best" : ""}"><td><b>${esc(c.id)}</b>${c.id === ev!.best ? " ★" : ""}<br><small>${esc(c.strategy)}</small></td>
<td><video src="${esc(rel(c.path))}" controls preload="none" width="135" height="240"></video></td>
<td class="num"><b>${c.score}</b></td><td>${c.gate.ok ? "✓" : `✗ ${esc(c.gate.problems.join("; "))}`}</td>
<td class="num">${c.heuristics.H}<br><small>dead ${(c.heuristics.dead_ratio * 100).toFixed(0)}% · action ${c.heuristics.action} · hook ${c.heuristics.hook_ratio} · coverage ${(c.heuristics.coverage * 100).toFixed(0)}% ${esc(JSON.stringify(c.heuristics.coverage_detail))} · ${c.heuristics.shots} shots</small></td>
<td class="num">${c.judge?.J ?? "-"}${c.judge ? `<br><small>loop ${c.judge.core_loop_clarity} · features ${c.judge.features} · human ${c.judge.human_play} · action ${c.judge.action} · hook ${c.judge.hook} · polish ${c.judge.polish} · run ${c.judge.would_run}</small>` : ""}</td>
<td><small>${esc(c.judge?.summary ?? "")}${c.judge?.worst_moment ? `<br><i>worst @${c.judge.worst_moment.t}s: ${esc(c.judge.worst_moment.issue)}</i>` : ""}</small></td></tr>`).join("");

	const edlTable = best ? `<ol class="edl">${best.clips.map((c) => `<li><b>${esc(c.role)}</b> ${seek(c.start)}–${fmt(c.end)}${c.speed > 1 ? ` @${c.speed}×` : ""} <small>${esc(c.why ?? "")}</small></li>`).join("")}</ol>${best.fixes?.length ? `<details><summary>${best.fixes.length} adjustments made by code</summary><small>${best.fixes.map(esc).join("<br>")}</small></details>` : ""}` : "";

	const frRows = (fr?.items ?? []).map((it) => `<tr><td>${seek(it.t)}${it.end ? `–${fmt(it.end)}` : ""}</td><td>${esc(it.type)}</td><td class="sev-${esc(it.severity)}">${esc(it.severity)}</td><td><b>${esc(it.title)}</b><br><small>${esc(it.evidence)}</small></td><td>${esc(it.suggestion)}</td><td>${it.image ? `<img src="${esc(it.image)}" width="90">` : ""}</td><td><small>${esc(it.signals.join(", "))}</small></td></tr>`).join("");

	const turnRows = plans.map((p) => {
		const o = obs.find((x) => x.n === p.obs && x.turn === p.turn) ?? obs.find((x) => x.n === p.obs);
		const acts = actions.filter((a) => a.turn === p.turn);
		return `<tr><td>${seek(p.t)}<br><small>turn ${p.turn}</small></td><td>${o ? `<img src="${esc(rel(o.marks_path ?? o.path))}" width="96" loading="lazy">` : ""}</td>
<td><b>${esc(p.plan.phase)}</b>${p.decider?.phase ? `<br><small>decider: ${esc(p.decider.phase)} ${((p.decider.phase_p ?? 0) * 100).toFixed(0)}%</small>` : ""}${p.decider?.clarity !== undefined ? `<br><small>clarity ${(p.decider.clarity * 100).toFixed(0)}%</small>` : ""}${p.decider?.effect !== undefined ? `<br><small>last input worked: ${(p.decider.effect * 100).toFixed(0)}%</small>` : ""}</td>
<td><small><b>sees:</b> ${esc(p.plan.screen)}<br><b>progress:</b> ${esc(p.plan.progress)}${p.error ? `<br><span class="err">planner error: ${esc(p.error.slice(0, 200))}</span>` : ""}</small></td>
<td><small>${acts.map((a) => `${seek(a.t0)} <b>${esc(a.kind)}</b>${a.target_label ? ` “${esc(a.target_label.slice(0, 50))}”` : ""} ${esc(a.intent)}${a.reaction_ms ? ` <span class="dim">(+${Math.round(a.reaction_ms)} ms)</span>` : ""}${a.slipped ? " <i>slipped</i>" : ""}`).join("<br>")}</small></td>
<td><small class="dim">${esc(p.plan.notes)}</small></td><td class="num"><small>${(p.ms / 1000).toFixed(1)}s<br>$${(p.usd ?? 0).toFixed(4)}</small></td></tr>`;
	}).join("");

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(g?.title ?? session?.title ?? "session")} · playable agent trace</title>
<style>
:root{--fg:#1b1b1f;--dim:#6b6b76;--bg:#fbfbfc;--card:#fff;--line:#e6e6ea;--accent:#3e63dd}
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--dim:#9b9ba7;--bg:#111114;--card:#18181c;--line:#2b2b31;--accent:#8da4ef}}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px;max-width:1280px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.grid{display:grid;grid-template-columns:300px 1fr;gap:18px}.kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px}.kv div:nth-child(odd){color:var(--dim)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top;text-align:left}th{color:var(--dim);font-weight:500;font-size:12px}
.num{text-align:right;white-space:nowrap}.best{background:rgba(62,99,221,.07)}.dim{color:var(--dim)}small{font-size:12px}.err{color:#e5484d}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-weight:600;font-size:13px}.pass{background:#30a46c22;color:#30a46c}.fail{background:#e5484d22;color:#e5484d}
a.t{color:var(--accent);text-decoration:none;font-variant-numeric:tabular-nums}.legend{font-size:12px;color:var(--dim)}.sev-high{color:#e5484d;font-weight:600}.sev-medium{color:#f5a524}
video{background:#000;border-radius:6px}.edl li{margin:3px 0}#rawwrap{position:sticky;top:10px}
</style></head><body>
<h1>${esc(g?.title ?? session?.title)} <span class="dim" style="font-weight:400">· ${esc(g?.genre ?? "")}</span></h1>
<div class="dim">session <code>${esc(st?.session_id)}</code> · playable <code>${esc(st?.playable)}</code> · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</div>
<div class="card" style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">
<span class="badge ${ev?.pass ? "pass" : "fail"}">score ${ev?.score ?? "-"} / 100 ${ev?.pass ? "· pass" : "· review"}</span>
<span>best cut <b>${esc(ev?.best)}</b></span><span>${session ? `${session.game_s.toFixed(1)} s played · ${session.actions} inputs · ${session.planner_calls} planner turns · ended by ${esc(session.ended_by)}` : ""}</span>
<span>cost <b>$${led.total.toFixed(3)}</b> (${led.calls} model calls)</span>
${ev?.separation !== null && ev?.separation !== undefined ? `<span>vs naive baselines: <b>${ev.separation >= 0 ? "+" : ""}${ev.separation}</b></span>` : ""}
</div>

<div class="grid">
<div><h2>Highlight</h2>${existsSync(paths.highlight) ? `<video src="highlight.mp4" controls width="280" height="498"></video>` : "<i>not rendered</i>"}
<div class="dim"><small>${cfg.highlight.width}×${cfg.highlight.height} · 30 fps · H.264${ix?.has_audio ? " + AAC game audio" : " (the game made no sound)"}</small></div></div>
<div><h2>What the agent learned about the game</h2><div class="card kv">
<div>objective</div><div>${esc(g?.objective)}</div><div>controls</div><div>${esc(g?.controls)}</div><div>core loop</div><div>${esc(g?.core_loop)}</div>
<div>features</div><div>${esc((g?.features ?? []).join(" · "))}</div><div>progression</div><div>${esc(g?.progression)}</div><div>hook idea</div><div>${esc(g?.hook_idea)}</div>
<div>player's notes</div><div class="dim">${esc(session?.notes)}</div>
<div>input timing</div><div>median gap ${ht.median_gap_ms} ms · min ${ht.min_gap_ms} ms · ${ht.robotic} gaps under 150 ms · human-timing score ${ht.score}</div>
<div>persona</div><div>${esc(session?.persona)} · input via ${esc(session?.input_mode)} · GL ${esc(session?.gl)}</div></div>
<h2>Chosen cut (EDL)</h2><div class="card">${edlTable}</div></div></div>

<h2>Candidates and evaluation</h2>
<div class="dim"><small>final = gate × (0.55 × judge J + 0.45 × heuristics H). Baselines (base_*) are naive cuts scored the same way: they show the score separates a real edit from a lazy one.${ev?.pairwise ? ` Pairwise: ${esc(JSON.stringify(ev.pairwise))}` : ""}</small></div>
<table><tr><th>cut</th><th>video</th><th>score</th><th>gate</th><th>H</th><th>J</th><th>judge</th></tr>${candRows}</table>

<h2>Friction for a first-time player</h2><p>${esc(fr?.summary)}</p>
<table><tr><th>time</th><th>type</th><th>severity</th><th>issue</th><th>suggested fix</th><th>evidence</th><th>signals</th></tr>${frRows}</table>

<h2 id="raw">Session timeline</h2>
<div class="grid"><div id="rawwrap"><video id="rawv" src="${existsSync(paths.raw) ? "raw.mp4" : "raw_video.mp4"}" controls width="280" height="498"></video><div class="dim"><small>raw recording, game time</small></div></div>
<div>${ix ? chart(ix, actions, best) : ""}
<table><tr><th>time</th><th>saw</th><th>phase</th><th>planner</th><th>actions (with human reaction time)</th><th>notes</th><th>cost</th></tr>${turnRows}</table></div></div>

<h2>Cost and timing</h2><div class="card kv">${Object.entries(led.by_kind).map(([k, v]) => `<div>${esc(k)}</div><div>$${v.usd.toFixed(4)} · ${v.calls} calls</div>`).join("")}
${Object.entries(st?.phases ?? {}).map(([k, v]) => `<div>phase ${esc(k)}</div><div>${(v.ms / 1000).toFixed(1)} s${v.note ? ` — ${esc(v.note)}` : ""}</div>`).join("")}
<div>models</div><div>${esc(Object.entries(cfg.models).map(([k, v]) => `${k}: ${v}`).join(" · "))}</div></div>
<p class="dim"><small>Files: raw.mp4 · highlight.mp4 · candidates/ · moments.json · game_model.json · edl_*.json · eval.json · friction.json/.md · plans.jsonl · actions.jsonl · observations.jsonl · decisions in plans.jsonl · ledger.jsonl · trace.jsonl · obs/</small></p>
<script>
const v=document.getElementById('rawv');
document.querySelectorAll('a.t').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();v.currentTime=+a.dataset.t;v.play();document.getElementById('raw').scrollIntoView({behavior:'smooth'});}));
const c=document.getElementById('chart');if(c)c.addEventListener('click',e=>{const r=c.getBoundingClientRect();v.currentTime=(e.clientX-r.left)/r.width*${(ix?.duration ?? 1).toFixed(2)};v.play();});
</script></body></html>`;
	writeText(paths.html, html);
}
