# Goal 5 — Running this on hundreds of new playables a week

The prototype already has the shape of the production system: one playable = one durable session task, every phase
idempotent against its output directory, every paid call in a ledger, every decision in a trace. Production adds a
queue, isolation, caching, budgets and a human in the loop for the cases the evaluator is unsure about.

## Throughput and cost (measured on this prototype)

| | 2D/DOM game (Word Hunt) | 3D WebGL game, CPU only |
| --- | --- | --- |
| play (capture at 720×1280, 30 fps) | ~2 min | 10–20 min (llvmpipe rasterization ≈ 0.16–0.25 s/frame across Raid, West and Boom Castle) |
| index + cut + render + eval + friction | ~4 min | ~5 min |
| model spend | ~$0.25 | ~$0.4–0.6 |

The capture cost is dominated by software rendering. On a GPU node the same virtual-clock capture runs at ~20–30
frames/s of game time (the screenshot becomes the bottleneck), so a 60 s session captures in 1–2 minutes. Model
latency never adds to video length (the game clock is frozen while the model thinks), only to wall time, so sessions
can be packed densely: while one session waits on a planner call, the node renders another.

**Sizing:** 500 playables/week ≈ 3 per hour. With GPU workers (≈8 min/session end to end) one 4-session-wide node
handles ~30 sessions/hour, so a single node covers the load with room for 3 candidate seeds per playable. Model spend
≈ $0.3–0.6 per session → **≈ $150–300/week** at 500 playables, plus compute.

## Architecture

```
upload (S3 / GCS)                                   ┌──────────────── worker pool (containers) ────────────────┐
  └─► intake ──► queue (SQS / Pub/Sub / Temporal) ─►│ Chromium + Xvfb/GPU + ffmpeg + agent                      │
        │  content hash, dedupe, priority          │  Pi Durable session task: play → index → cut → render     │
        │  static lint (size, network calls, SDKs)  │  → eval → friction → report (checkpoint per phase)         │
        ▼                                           └───────────────┬──────────────────────────────────────────┘
   metadata DB (Postgres): playable, session, phase checkpoints,   │ artifacts → object store (raw.mp4, highlight.mp4,
   ledger rows, eval scores, friction items, review decisions       │ candidates, trace.html, jsonl logs)
        ▲                                                           ▼
        └──── review UI (trace.html + approve / re-cut / reject) ◄── routing: score ≥ pass & gate ok → auto-publish
                                                                      borderline / judge-heuristic disagreement → human
                                                                      fail → retry with another seed / persona, then human
```

- **Isolation.** One container per session (Chromium is the attack surface: playables are third-party code). No
  network egress from the browser (already enforced: every non-file request is aborted, WebSocket/ad SDKs are stubs).
  CPU/memory/time limits per container; a hung page is killed by the phase timeout and retried once.
- **Durability.** Locally Pi Durable on SQLite gives phase-level resume. In production the same task graph maps onto
  Temporal (or Pi Durable on Postgres): a crashed worker resumes the session at its last committed phase, never
  re-paying for finished model calls or re-capturing finished footage.
- **Determinism and caching.** The virtual clock + seeded `Math.random` make a session reproducible from
  (playable hash, seed, persona, model versions). Cache keys:
  - `playable_sha` → game model, moments, friction (re-used when only the ad copy around the playable changes);
  - `playable_sha + seed + persona` → raw capture (re-cutting with a new editor prompt or a new duration costs only
    the cut/render/eval phases, ~$0.05);
  - re-uploads of an identical file are deduped at intake.
- **Multiple takes.** Run 2–3 sessions per playable with different seeds/personas in parallel and let the evaluator
  choose across all candidates. A second take is the cheapest fix for an unlucky session (died early, got stuck).
- **Budgets.** Per-session cap (`budget_usd`, enforced before every call); per-customer weekly caps in the scheduler.
  Over budget, phases degrade instead of failing: fewer planner turns, heuristic EDL, heuristic-only scoring.
- **Model routing.** The planner runs every turn and is the main cost: route to a cheap VLM by default and escalate to
  a stronger one only when the decider reports low clarity or the agent is stuck. The decider (free/cheap, 0.3 s)
  already absorbs the high-frequency checks.

## Quality control

- **Automatic gate** (ffprobe spec) is a hard fail; the composite score (judge + heuristics) routes the rest.
- **Disagreement routing:** when the VLM judge and the heuristics disagree by more than ~20 points, or pairwise
  contradicts the absolute ranking, send to review — those are the cases where one of the two is wrong.
- **Calibration loop:** every human decision (approve / re-cut / reject + reason) is stored next to the scores. Weekly,
  refit the weights of the composite score (logistic regression on approve/reject) and re-check that naive baselines
  still score far below approved cuts. Track drift per model version.
- **Online feedback:** highlights that ship get CTR/IPM from the ad server; feed them back as the real target. The
  creative-loop system from the previous take-home is exactly the A/B machinery for this: the highlight's EDL is a
  manifest (hook clip, order, pacing, end card), so variants of the cut can be tested against each other.
- **Friction reports** go to the playable's creators with the same trace links; recurring friction types across many
  playables (e.g. "no tutorial hand for drag controls") become design guidelines.

## Operations

- Dashboards: sessions/hour, phase durations, failure rate per phase, $/session, score distribution, review rate.
- Alerts: phase failure spikes (a model or Chromium regression), cost per session above budget, review queue age.
- Regression suite: the 4 samples + generated + hold-out playables run nightly with fixed seeds; any score drop > 5
  points on any game blocks a prompt or model change (the same rule used during development).
- Versioning: each session records config, model ids and code version (in `config.json` / `state.json`), so any
  highlight can be reproduced or re-cut later.

## What would change first at scale

1. GPU capture nodes (10× faster play phase) — the single biggest cost/latency win.
2. A cheaper planner with escalation (above), and caching the game model per playable family (same template, new art).
3. Carry what a session learned about a game into the next take: reflex zone depth (learned from hits), learned walls,
   the policy situations that worked — keyed by playable hash, so take 2 starts where take 1's lessons left off.
4. Hierarchical play: a policy cache per genre ("drag-to-aim" games, "word grid" games) learned from verified sessions,
   used as hints for the planner — kept genre-level, never per-game rules.
