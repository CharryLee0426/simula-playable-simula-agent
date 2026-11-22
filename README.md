# Simula Playable Simulation Agent

Give it any HTML5 playable it has never seen. It loads the game in a phone-sized browser, works out how to play from
the screen, plays it like a person, records every frame at 30 fps with the game's own audio, cuts a 20-second 9:16
highlight that sells the game, writes a friction report for first-time players, and scores its own work.

```bash
./run --playable ./game.html --out highlight.mp4
```

No per-game code, rules or coordinates: everything game-specific is discovered at run time from pixels, the DOM (when
there is one) and the input events the game listens to.

> 中文简介见 [README.zh-CN.md](README.zh-CN.md).

**Deliverables for every sample and generated playable:** [`deliverables/`](deliverables/) — `highlight.mp4`,
`raw.mp4` (full session), `friction.md`, `eval.json`, `trace.html` (open it in a browser: the whole session,
decision by decision), plus the logs. Results: [Results](#results).

---

## How it works

```
 game.html
    │
    ▼
 ┌─────────────────────────── browser worker (Python · Playwright · Chromium) ───────────────────────────┐
 │ injected before the game runs (py/simbrowser/shim.js):                                                │
 │   virtual clock: rAF, timers, performance.now, Date, event.timeStamp, CSS/Web animations,             │
 │                  AudioContext.currentTime — all advance only when the agent steps a frame             │
 │   seeded Math.random · ad SDK stubs (mraid, dapi, ExitApi…) · no network · audio event log            │
 │   introspection: which input events the game listens to; interactive DOM elements                    │
 │ every stepped frame → JPEG → ffmpeg (30 fps H.264)        audio log → offline mix → raw.mp4            │
 └───────────────────────────────▲─────────────────────────────────────────┬──────────────────────────────┘
               JSON lines: step / touch / observe                          │ screenshots, DOM, listeners
 ┌───────────────────────────────┴───── agent (TypeScript · Pi Durable) ───▼──────────────────────────────┐
 │ play      observe ─► planner VLM ‖ decider checks ─► validate ─► humanize ─► act ─► watch (loop)       │
 │ index     per-0.5 s signals (motion, audio, touches, decider phase + excitement) + director VLM       │
 │           watches the time-stamped session → game model + labelled moments                            │
 │ cut       director writes 3 EDLs (3 editing strategies) → code makes them exact (20.0 s, ≤1.5×,       │
 │           ≤30 s of source, no mid-gesture cuts, dead air removed, end card last)                       │
 │ render    EDL → 1080×1920 30 fps H.264 + AAC, touch indicator from the action log                      │
 │ eval      spec gate + heuristics + VLM judge + pairwise; naive baseline cuts as a control             │
 │ friction  signals from the session (clarity, failed inputs, stuck, idle…) → report with fixes          │
 │ report    trace.html                                                                                  │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Each playable is one durable `SessionTask` (Pi Durable on SQLite, in the session directory). Every phase commits a
checkpoint and skips work whose output already exists, so a crash or Ctrl-C resumes where it stopped
(`./run --playable game.html --session runs/<id>`), and `--redo <phase>` re-runs from any phase without re-playing.

### Models

One OpenRouter key. Defaults (`config/default.json`, all overridable):

| role | model | used for |
| --- | --- | --- |
| planner | `google/gemini-4-hydrogen` (low reasoning) | one call per decision: reads the screenshot, keeps running notes, returns 1–4 gestures |
| decider | `perplexity/pplx-decider-v1.3:free` (Decisions API) | typed, probabilistic answers in ~0.3 s: screen phase, "did that input work" (before/after images), "would a first-timer know what to do", frame excitement |
| director | `google/gemini-4-hydrogen` (video in) | watches the whole session once → game model + moments; writes the EDLs; writes the friction report |
| judge | `google/gemini-4-hydrogen` (video in) | scores each candidate highlight; pairwise comparisons |

Typical cost: **$0.25–0.6 per playable** (budget cap per session, default $2, enforced before every call).

---

## Key decisions (and why)

**1. A virtual clock instead of real time.** The obvious approach (let the game run, ask a model what to do, act)
fails twice: model latency of 3–20 s freezes the player on video, and on a CPU-only machine the 3D samples render at
2–5 fps, so a real-time recording can't be 30 fps. The shim replaces every clock the game can read, so the game only
advances when the agent steps a frame. While the model thinks the game is frozen; every captured frame is exactly
1/30 s of game time apart however slow the machine is; the only pauses on video are the humanizer's reaction times.
Two generic guards keep it robust: busy-wait loops (CPU benchmarks at boot) are detected and given a creeping clock,
and Web Animations are tracked and finished explicitly so `animationend`/`.finished` handlers still fire.
Consequence: the recording is deterministic and machine-independent; the cost is wall time on slow machines
(~0.2–0.4 s per 3D frame on llvmpipe; headed Chrome on Xvfb is ~3.5× faster than headless SwiftShader, so the worker
starts Xvfb automatically on Linux).

**2. Game audio reconstructed in game time.** Real-time audio is meaningless under a virtual clock, so the shim logs
every sound the game starts (decoded buffers, buffer sources with the gain on their path to the speakers, `<audio>`
elements and their volume fades, oscillators) with its game time, and the worker mixes it offline. The soundtrack is
frame-accurate with the video by construction.

**3. See like a player, with generic help.** The main observation is the screenshot. Two generic signals make it
reliable: for DOM games, interactive elements are drawn as numbered tags (set-of-marks) so the planner can say
"drag through 2, 3, 4" exactly; and the list of input events the game registered tells the planner whether drags are
possible. The agent never reads a game's internal variables.

**4. Slow, smart planner + fast, cheap checks.** The planner (VLM) makes the decisions. The decider (a Decisions-API
model: probabilities, not prose, ~0.3 s, free) runs alongside on the same frozen frame and answers typed questions
that code thresholds: phase (end card? fail?), whether the last input visibly worked, whether a first-timer would
know what to do. Those feed stuck detection, end-card handling, the friction report and the index.

**5. A human hand.** Gestures are compiled into touch streams with person-like motor behaviour: lognormal reaction
times plus reading time after big screen changes, Fitts-law movement times, curved Bézier drag paths with an
ease-in-out speed profile and jitter, presses that last a few frames, imprecise taps and the occasional slip
("competent but not perfect"). The highlight renders a phone-style touch indicator from the exact action log, so the
viewer sees what the finger does — the core loop reads in seconds.

**6. The model decides the story, code guarantees the numbers.** The director writes three EDLs with different
strategies (hook-first, learn-then-escalate, feature montage). Code then enforces everything that must hold: exactly
20.0 s, speed 1.0–1.5×, ≤ 30 s of source, playable footage only, no cut while the finger is mid-gesture, dead air
(≥ 1.5 s with no motion and no input) cut down to a short natural pause, the end card last and capped at 3 s.

**7. Several candidates, an evaluator, and a control group.** Every candidate passes a hard spec gate, gets cheap
explainable heuristics and a VLM judge score; close calls are settled pairwise in both orders. Two naive cuts (the
first 20 s; random clips) are scored the same way: if the evaluator can't rank them clearly below the real edit, it
isn't measuring anything. See [Goal 4](#goal-4--evaluating-without-watching).

**8. The end card is part of the ad.** The agent lets the playable's end card breathe for 2.5 s, then taps its CTA
once (the SDK stubs log it); the editor ends every cut on it when the game showed one.

---

## Goal 3 — Friction

The agent *is* a first-time player, so its session is the evidence. Code extracts signals with ids — the decider's
"would a first-timer know what to do" on every screen the agent decided on, inputs with no visible effect (decider
before/after + pixel change), stuck streaks, time to the first input that worked, idle stretches, forced waits, fail
screens, slips, end-card timing, and the agent's own words ("did not register"). The model writes 3–8 items
(timestamp, type, severity, evidence, concrete fix) and **must cite signal ids**; uncited items are dropped.
Output: `friction.md` (with screenshots) and `friction.json`.

## Goal 4 — Evaluating without watching

`score = gate × (0.55 × J + 0.45 × H)`, 0–100, in `eval.json`:

- **Gate** (ffprobe, hard fail): 9:16, ≤ 1080×1920, H.264, 30 fps, 20 ± 0.5 s, audio track iff the game has audio.
- **H — heuristics** (free, explainable; each output second is mapped back through the EDL to the session's signals):
  dead-air ratio, loading/menu ratio, action level (decider excitement), hook strength (first 2 s vs average),
  coverage of core loop / features / progression / end card, moment quality (intensity of what the cut shows vs the
  best 20 s available), arc (ends on a payoff), input-timing humanness, shot pacing.
- **J — VLM judge**, on the brief's own words: core loop clarity, features shown, looks like a real person, action,
  hook, polish, would we run it — plus its worst moment, which points straight at problems (it caught a capture bug
  of mine: floating reward labels frozen on screen, now fixed in the shim).
- **Pairwise** when the top two are within 6 points (both orders, to cancel position bias).
- **Control:** baseline cuts must score well below the chosen cut, and the chosen cut must beat the strongest
  baseline head to head. The separation is reported per game (`eval.json → separation, vs_baseline`).

There is also a model-free **random player** (`--set play.policy=random`: random gestures, machine timing) for
calibrating the evaluator on bad *play*, not just bad editing.

## Goal 5 — Productionization

See [docs/productionization.md](docs/productionization.md): queue → isolated browser containers → durable session
tasks → object store + Postgres; caching by playable hash and seed; budgets that degrade instead of failing;
GPU capture nodes as the first scaling lever; routing by score and judge/heuristic disagreement to human review;
calibration from review decisions and online CTR/IPM.

---

## Results

_Filled in from the final batch run — see [deliverables/](deliverables/)._

---

## Running it

Requirements: Node ≥ 22.19, Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), ffmpeg, an OpenRouter key.
On Linux, `Xvfb` (optional) makes WebGL capture ~3.5× faster.

```bash
./run setup          # python env (playwright, numpy, pillow), chromium, key → .env; then doctor
./run doctor         # checks tools, key, model ids, decider
./run --playable games/samples/word-hunt.html --out highlight.mp4
./run batch games/samples games/generated --out-dir deliverables     # many playables, resumable
./run --playable game.html --session runs/<id> --redo cut            # re-cut without re-playing
```

Useful flags: `--max-game-s 90` (session length), `--budget 2`, `--seed 7`, `--persona casual_competent|first_timer|expert`,
`--dpr 3` (native 1080×1920 capture on a fast machine), `--no-overlay`, `--set key=value` (any config field).
Behind an HTTPS proxy `./run` sets `NODE_USE_ENV_PROXY=1`.

Each session directory (`runs/<playable>-<hash>-<time>/`) holds: `highlight.mp4`, `raw.mp4`, `candidates/`,
`trace.html`, `eval.json`, `friction.md/.json`, `game_model.json`, `moments.json`, `edl_*.json`, `session.json`,
`plans.jsonl` (every planner turn: what it saw, its notes, its actions, the decider's answers), `actions.jsonl`
(every gesture, frame by frame), `observations.jsonl`, `ledger.jsonl` (every paid call), `trace.jsonl`, `obs/`.

## Repository

```
run                      one-command entry (node src/cli.ts)
src/cli.ts               run / batch / export / report / doctor / setup
src/durable/session.ts   the Pi Durable session task (phases, checkpoints, retries)
src/agent/play.ts        the play loop (planner, decider, end card, stuck handling)
src/agent/humanize.ts    personas and motor model
src/highlight/index.ts   signals + director moments
src/highlight/cut.ts     EDL strategies, normalization, baselines
src/eval/evaluate.ts     gate, heuristics, judge, pairwise
src/friction.ts          friction signals and report
src/report/html.ts       trace.html
src/llm.ts               OpenRouter chat (images/video → JSON) and Decisions API
py/simbrowser/shim.js    virtual clock, sandbox, audio log, introspection (injected)
py/simbrowser/server.py  browser worker (Playwright, CDP touch, 30 fps capture)
py/simbrowser/audio.py   offline game-audio mix
py/simbrowser/render.py  EDL → highlight with touch indicator
games/samples/           the 4 provided playables
games/generated/         playables I generated (2D, DOM, 3D)
games/holdout/           generated playables never used during development
docs/                    productionization
```
