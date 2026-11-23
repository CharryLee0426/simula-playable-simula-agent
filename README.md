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
 │   seeded Math.random · ad SDK stubs (mraid, dapi, ExitApi…) · no network · Web Audio rendered offline │
 │   introspection: which input events the game listens to; interactive DOM elements                    │
 │ every stepped frame → JPEG → ffmpeg (30 fps H.264)        audio render + media log → mix → raw.mp4     │
 └───────────────────────────────▲─────────────────────────────────────────┬──────────────────────────────┘
               JSON lines: step / touch / observe                          │ screenshots, DOM, listeners
 ┌───────────────────────────────┴───── agent (TypeScript · Pi Durable) ───▼──────────────────────────────┐
 │ play      observe ─► planner VLM ‖ decider checks ─► validate ─► humanize ─► act ─► watch (loop)       │
 │           fast games: planner writes a reflex policy, decider picks the situation every 0.1 s          │
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
| decider | `perplexity/pplx-decider-v1.3:free` (Decisions API) | typed, probabilistic answers in ~0.3 s: screen phase, "did that input work" (before/after images), "would a first-timer know what to do", frame excitement — and the reflexes of fast games: "which of these situations is happening right now", every 0.1 s of game time |
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

**2. Game audio rendered in game time, by the browser.** Real-time audio is meaningless under a virtual clock. The
game's `AudioContext` is an `OfflineAudioContext` whose `currentTime` is the virtual clock: everything the game puts on
the audio timeline (`start`/`stop`, gain envelopes, filter and pitch sweeps) goes straight to Chromium's engine, and
what a live context would apply immediately (`connect`/`disconnect`, `.value =`, attributes of a sounding node) is
replayed at its game time during the render (`suspend(t)`). When the session closes, Chromium renders the whole
session's graph once (≈0.1 s for a 30 s session), so compressors, filters and envelopes sound exactly as they do for a
player. `ended`/`statechange` events are delivered in game time, `.value` reads the automated value, `suspend()`
freezes the context clock, decoded buffers arrive in the next stepped frame whatever the machine's speed, and the
context reports the device's sample rate (games size noise buffers by it and fill them from the seeded `Math.random`,
so it has to match or the replay diverges). `<audio>` elements are logged
(play/pause/volume) and mixed by the worker. The soundtrack is frame-accurate with the video by construction.
An earlier version re-synthesized Web Audio in Python from an event log: it read each sound's gain once at its start
(before any envelope ran, so usually 1.0) and dropped filters and pitch sweeps, so synthesized SFX came out as flat,
loud, unfiltered square/saw beeps up to 28 dB above the music. That path remains as the `audio: "log"` fallback, and
`python -m simbrowser.remix` rebuilt the shipped deliverables' audio from verified replays of their sessions (nine of
thirteen; the others had real-time races in their recordings and do not replay exactly, see `deliverables/README.md`).

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

**9. Reflexes for fast games: a brain and a spinal cord.** One decision per screenshot is too slow for runners and
dodgers. For those the planner writes a *reflex policy* instead of a gesture: an attention **zone** (the strip just
ahead of the player, so "inside the zone" already means "close") and 2–5 **situations**, each with the gesture that
answers it ("a pink block in the car's lane, left lane empty → swipe left"; "an orange barrier across all lanes →
swipe up"). The executor then steps the frozen game 3 frames (0.1 s) at a time and asks the decider, on the cropped
frame, which situation is happening — one multi-option call, free, invisible on video. It fires when an action clearly
beats "nothing needs a reaction", after a human reflex delay (~210 ms, occasionally late), commits to a swerve for
0.4 s instead of flip-flopping, and every 0.5 s glances at the whole screen: a crash/popup, or *anything the policy
doesn't cover* (a new obstacle type, a new tutorial prompt, a power-up), hands control back to the planner, which sees
the new thing while the game is frozen and writes a better policy. Every check and fire is in `reflexes.jsonl` and
in `trace.html`.

The zone **follows the player**. The planner also says where the object it controls is (`"player": [y, x]`); the
worker cuts a small template there and finds it again in every check by normalized cross-correlation within a window
around its last position (numpy, a few ms; the template adapts slowly while matches are confident; a weak match holds
the last position instead of jumping to a look-alike). The zone moves with the player's displacement, so the decider
always sees a crop with the player in it — "to the player's left" is simply the left of the crop — and it also gets
the player's screen position as text. Gestures can follow the player too (`"relative_to_player": true`, e.g. a drag
that starts on the ship). And walls are learned, not known: a reflex that should move the player sideways but leaves
a confidently tracked position unchanged hit an edge, so it is suppressed for 1.5 s and the best other action is
taken instead. The frame each reflex reacted to is kept as evidence in the trace.

How far ahead the zone looks is **learned from getting hit** (`src/agent/zone.ts`). The worker flags two generic
impact signatures in the recorded frames: a *flash* (a spike of on-screen change with a jump in brightness, how games
sell an impact) and a *freeze* (the screen of a moving game suddenly stops — a crash popup pauses the world). Pickups
flash and tutorial prompts pause too, so one decider question on the whole screen confirms it ("hit or crashed, not a
pickup or a tutorial pause?"); the periodic full-screen look asks the same question for hits neither signature
caught, and the worker dates those from the frames since the previous look. A confirmed freeze also ends the policy
at once (no frozen dead air on video). The lead time of the last reaction then says what went wrong: it fired
< 0.5 s before the hit (or the hazard was never flagged) → seen too late, the zone's far edge moves out by 15 % of
its depth; > 1.2 s before → too early (a jump that lands before the barrier), the edge moves in; in between, the
reaction itself was wrong, and swerving into a hazard for a pickup (situations marked `"pickup": true`) is a
judgement error — neither changes the depth, and the planner is told which it was so it can fix the situations
instead. The far edge is the side opposite the player (the top for runners, the right for side-scrollers); the
adjustment is session-wide because the game's speed carries over from one policy to the next. Hits, their evidence
frame and each depth change are in `reflexes.jsonl` and `trace.html`.

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

Full table with links to every highlight, raw session, trace and friction report: **[deliverables/README.md](deliverables/README.md)**.
All runs: default config, seed 7, one take per playable, CPU-only Linux VM (4 cores, no GPU).

| set | playable | how it's played (agent's own words, condensed) | session | score | judge · heuristics | baselines (first 20 s / random) | head-to-head |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sample | Boom Castle (3D WebGL) | drag from the cannon to aim at goblin waves; pick upgrade cards between waves | 71 s, 56 inputs, 3 upgrades | **82.7** | 82.1 · 83.5 | 63.2 / 73.9 | 2/2 |
| sample | Word Hunt (DOM) | swipe through letter tiles to form target words; 3 rounds | 26 s, game over → end card | **85.5** | 82.3 · 89.5 | 83.6 / 69.7 | 0/2 (ties) |
| sample | Raid: Shard Market (3D) | joystick-drag to mine shards, sell at the market, buy worker/mine upgrades | 92 s, 25 inputs | **79.7** | 81.5 · 77.5 | 53.3 / 60.4 | 2/2 |
| sample | West Game II (3D) | joystick-drag near outlaws to auto-shoot, collect gold, build defenses on pads | 93 s, 20 inputs | **83.4** | 81.5 · 85.7 | 40.6 / 64.9 | 2/2 |
| generated | Castle Toss (2D physics) | pull back and release the catapult; tap mid-air to split; upgrades between levels | 47 s, all 3 levels → end card | **88.2** | 88.2 · 88.3 | 69.1 / 65.3 | 2/2 |
| generated | Bakery Rush (DOM idle) | tap the cake, buy upgrades, rush order, frenzy | 49 s, 64 inputs → end card | **84.9** | 81.2 · 89.5 | 59.9 / 50.7 | 2/2 |
| generated | Neon Lanes (raw WebGL 3D runner) | swipe lanes / jump — played with **reflex policies + a zone that follows the car and learns its depth from hits** | 32 s, 22 inputs, 64 coins; crashed at 13 s (revive) and 23 s → end card; both crashes detected, zone deepened twice | **91.8** | 86.8 · 97.8 | 78.2 / 77.9 | 2/2 |
| generated | Orb Merge (2D physics) | drag to aim and drop orbs, merge equal values, bomb power-up | 59 s → end card | **87.2** | 86.2 · 88.4 | 69.5 / 59.9 | 2/2 |
| hold-out | Gem Swap (match-3) | swipe gems into lines of 3–4, cascades, row blaster, fever | 25 s, target smashed → end card | **89.9** | 87.9 · 92.4 | 81.5 / 71.5 | 2/2 |
| hold-out | Sky Stack (raw WebGL 3D stacker) | tap to drop a sliding slab onto the tower | 29 s, 7 floors, missed, retry, missed → end card | **80.3** | 78.1 · 82.9 | 72.8 / 60.8 | 2/2 |
| hold-out | Comet Dodge (2D reflex dodger, hold left/right) | hold a side to steer; dodge comet walls, zig-zags, catch stars — with reflex policies | 46 s, 35 inputs; first ship lost at 20 s, retry → end card | **84.3** | 80.8 · 88.5 | 68.5 / 64.1 | 2/2 |
| ablation | Comet Dodge, planner only (`play.reflex_actions=false`) | precise drags to exact x positions, one decision per screenshot | 56 s, 21 inputs; first ship lost at 28 s, retry → end card | **86.4** | 84.4 · 88.8 | 71.3 / 68.3 | 2/2 |
| calibration | Word Hunt, *random player* | random taps/drags with machine timing, no model | 46 s | **54.4** | 28.3 · 86.4 | 48.8 / 50.9 | — |

What the numbers say:

- **It plays games it has never seen**, across 2D canvas, DOM and WebGL 3D, tap/swipe/drag/joystick/slingshot
  controls, with no per-game code: it read every tutorial, used upgrades/power-ups when offered, reached the end card
  in 8 of 11 games (the three that did not — Boom Castle, Raid, West — simply last longer than the 90 s cap), and recovered from fail
  screens via retry/revive.
- **The evaluator separates real edits from lazy ones**: the chosen cut beat the best naive baseline head to head
  in 10 of 11 games, by +7.5 to +25 points. The exception is informative: Word Hunt's whole game lasts 26 s, so "the
  first 20 s" already *is* the story; the evaluator calls it a tie, correctly.
- **It catches bad play, not just bad editing**: the random player on Word Hunt scores 54.4 (judge 28.3: "no
  coherent play") vs 85.5 for the agent. The heuristics alone don't (86.4 — random taps still produce motion), which
  is why the judge carries the larger weight.
- **Two weaknesses surfaced by the generated/hold-out games** (both genres the samples don't have): *pure timing*
  (Sky Stack: tap when the slab is aligned) and *fast reflexes* (Neon Lanes: dodge in time). Both come from the
  decide → react → watch cadence being slower than the game's events. The judge still rates those highlights well (a
  crash and a retry make good drama), which is itself a limitation worth knowing: the judge scores the video, not the
  player's competence — so for these games I compare *play* (survival, inputs) directly.
- **Reflex policies (decision 9) fix much of the fast-game problem — where the game is really fast.** On Neon Lanes,
  without reflexes the agent made 6 inputs and crashed at 11 s and 20 s; across three reflex runs it made 17–19 inputs,
  executed the jumps the game teaches, picked up coins, and first crashed at 13–16 s. The "anything new?" hand-back
  fired exactly when the game introduced barriers and a power-up. On the reflex hold-out (Comet Dodge, a different
  control scheme, written after the reflex code and never used for tuning) the policies transferred without changes
  — but a planner-only ablation did as well or better (first ship lost at 28 s vs 20 s): its comets fall slowly enough
  that the frozen-clock planner can position the ship *exactly*, which coarse reflexes cannot; a second planner-only
  run lost its first ship at 21 s, so the gap is within run-to-run noise. The resulting rule, now in the planner's
  instructions: play turn by turn with a short watch time, and escalate to reflexes only when things reach the player
  between screenshots or the world rushes at it (runners). On re-runs the planner chose reflexes for Neon Lanes and
  precise turn-by-turn play for Comet Dodge.
- **Following the player** (decision 9) fixed the decider's main spatial confusion. Offline, on the same Neon Lanes
  frames, the static zone flagged "dodge" for a block in the *next* lane (0.5–0.76) and missed the block that appeared
  in the car's new lane; the following zone answered "none" and then saw the new block. Live (one run per variant, so
  read the trend, not the decimals): no reflexes — first crash 11 s, game over 20 s, 21 coins; static-zone reflexes —
  13–16 s, 23–25 s, 25–35 coins; following zone — 17 s, 27 s, 79 coins. The tracker held the car with median match
  confidence 0.74–0.94 per policy.
- **Learning the zone depth from hits** took three live runs to get the *detection* right, which is the hard part:
  the first run found neither crash (Neon Lanes does not flash on a crash — its popup stops the world, hence the
  freeze signature); the second found the game-over but also "hit" on a REVIVED banner and missed a crash in a
  policy's last moments; the third found both crashes (the freeze at 13.1 s ended the policy at once; the game-over
  at 23.4 s was caught by the full-screen look and dated by the freeze) with no false hits. Both lessons were
  "seen too late" (the reflex fired 0.13 s and 0.10 s before impact), so the far edge moved out 44, then 95/1000.
  The evidence frames agree with the first: when the dodge fired, the block already filled the bottom of the zone.
  Survival in that run (13 s / 23 s) is inside the spread of the previous reflex runs, so I make no claim that
  depth learning made it play better — a game that ends after two crashes leaves one lesson to act on. The deliverable
  is this run.
- **A negative result, kept honest.** I tried a generic fix for timing: `tap_when`, where the planner describes the
  visual moment ("the sliding block is exactly above the tower") and the executor steps the frozen game frame by
  frame, asking the decider until that moment comes (free and invisible on video). The decider's probability does
  peak periodically as the slab passes, but a per-frame classifier is not precise enough for a stacker's tolerance:
  re-runs reached 2 and 1 floors vs 7 without it. It ships **off by default** (`--set play.timing_actions=true`
  to try it). The better next step is to estimate the moving object's phase from pixel motion over one period and
  time the tap from that. (Sky Stack is no longer a clean hold-out for timing work after this.)
- **Cost and time**: $0.29–0.71 per playable (median ≈ $0.35); 6–11 min wall time for 2D/DOM games, 17–20 min for
  the 3D samples on CPU (capture is ~0.2–0.4 s per frame on llvmpipe; a GPU worker removes most of that). The three 3D
  samples were re-cut once after evaluator changes (play reused), so their cost includes both cut/eval passes.

---

## What I learned building it (bugs the system found in itself)

| symptom | found by | cause | generic fix |
| --- | --- | --- | --- |
| 3D samples at 1–2 fps, a 90 s session would take an hour | probe benchmark | headless Chromium forces SwiftShader | headed Chrome on an auto-started Xvfb uses Mesa llvmpipe (multi-threaded): 3.5× faster; the virtual clock makes speed irrelevant to the video |
| Raid hung at boot | worker timeout | a CPU-benchmark busy-wait (`while (performance.now() - t0 < …)`) never ends on a frozen clock | after 20k clock reads in one frame the clock creeps forward, as on a real device |
| Word Hunt: the first swipe of a word never registered | the decider's "did that work" (≈0.2) and the planner's own notes ("SUN did not register") | my Bézier sampler fell back to the start of the last segment on the final frame (floating-point rounding) | fixed + unit test over 300 seeds |
| floating "+$0.30" labels frozen on screen | the VLM judge's "worst moment" | a Web Animation seeked to 999.99 of 1000 ms drops out of `document.getAnimations()` and never finishes, so the game's `.finished.then(remove)` never runs | the shim tracks animations itself and finishes them |
| heuristics scored random clips above the real edit on an action-heavy game | baseline control | every 3 s of a tower-defense game "has action" | moment quality (intensity of what the cut shows vs the best available) and arc (ends on a payoff) |
| upgrade-card taps looked "instant, robotic" | the judge | dead-air trimming removed the player's reading pause on static popups | popups/menus exempt; ~1 s of pause always kept |
| friction report claimed "no tutorial" where there was one | reading the report | the writer only saw signals and a few frames | it now also gets the player's own turn-by-turn screen descriptions and must not contradict them |
| director EDLs failed on one game (`finish_reason: length`) | trace | reasoning tokens used up the output budget | larger budgets + automatic retry with more tokens and less reasoning; heuristic EDL as the last fallback |
| cutting from a late hook back to tutorial footage felt jarring | the judge | the editor treated tutorial footage as ordinary core-loop footage | editor rule: at most one short tutorial clip, never after later gameplay |
| reflex v1 bounced between lanes and drove into the block it was dodging | crash frames + per-check decider log | situations without distance fired on far obstacles; with both side lanes free, "left" and "right" split ~0.4/0.4 and alternated | attention **zone** crop (offline test on the crash frames: jump fires 0.5 s before impact instead of 1.7 s); fire on "action vs none" not "winner vs runner-up"; commit to a swerve |
| reflex v2 hit a jump barrier it had never seen | crash frames | the policy was written before the game introduced barriers, so every check said "none" | every 0.5 s a full-screen "is there anything this policy does not cover?" check hands back to the planner — it then read the jump tutorial and jumped |
| reflex v2 missed a dodge of a new block | per-check log | the anti-flip-flop commitment (0.7 s) was too sticky | 0.4 s, overridden by strong danger |
| a static zone kept shouting "dodge" at a block in the *next* lane, and missed one in the car's new lane | offline decider runs on crash frames | a fixed crop does not know which lane the car is in | the zone follows the tracked player (offline on the same frames: false dodges → "none", the missed block → seen) |
| "snap the template to the most contrasted patch near the planner's point" | offline tracking from 5 start points | the most contrasted patch was road lines and headlight glow, not the car | removed: plain tracking held the car from all 5 starts (error ≤ 56/1000); with the snap it lost it from 3 |
| a working lane change was learned as a "wall" | per-check log (track confidence 0.39) | coin sparkles and glow lowered the match; a held stale position looked like "did not move" | wall learning only trusts a confident track (≥ 0.6) before and after the move |
| "were you just hit?" asked on the zone crop | offline decider runs on crash frames | 0.28 at the impact vs up to 0.51 on normal frames: the crop shows too little of the aftermath | impact signatures in the recorded frames, confirmed on the whole screen |
| hit detection saw none of the Neon Lanes crashes live | per-frame change/brightness around the crashes | that game does not flash on a crash — its popup *stops the world* | a freeze signature next to the flash one (replayed on 6 recorded sessions: every first crash found), plus the same question on the periodic full-screen look for game-overs that fade in |
| the first look of a new policy "saw a hit" (0.88) | trace | it read the "REVIVED! Go go go!" banner after the previous crash as a hit | no hit on a policy's first look (nothing to date it from), and the question excludes "revived, keep going" messages (0.03); crash screens stay at 0.99–1.00 |
| a crash in a policy's last moments taught nothing | trace (the planner saw CRASHED, the policy had "ended by duration") | the freeze needs 5 still frames to be sure, and the next policy forgets older impacts | one more full-screen look when a policy runs out |

**Time allocation (80/20).** Most of the effort went into the capture layer (virtual clock, audio, sandbox), because
it is what makes both "30 fps" and "looks like a person" possible on any machine, and into the evaluator, because
it is what makes the system improvable without watching every video. The editor is deliberately simple: the model
picks the story, code enforces the rules.

## Limitations and next steps

- **One take per playable.** A second take with another seed/persona is the cheapest fix for an unlucky session
  (died early, got stuck); run 2–3 in parallel and let the evaluator pick across all candidates.
- **Session length vs end card.** Some playables only show their end card after a long level; with a 90 s cap the
  agent sometimes ends first (the cut then ends on its best payoff instead). An adaptive cap (extend while the game
  is still escalating, stop when it loops) would fix most of these.
- **Evaluator.** One judge model (sampled twice and averaged; it still moves a few points between runs) and
  hand-set heuristic weights. In production both get calibrated on human review decisions and online CTR/IPM.
- **The decider is a classifier, not a planner.** Its "did that work" check is less reliable in games where the
  whole screen moves all the time (scrolling 3D); the pixel-change fallback is weaker there too.
- **Reflexes are still limited by perception.** The player-following zone fixed "is the danger in *my* lane?", and
  learned walls fix repeated moves into an edge, but the decider still picks the wrong *first* direction near a wall
  sometimes, and the tracker can lose lock under heavy particle effects (it then holds the last position). Zone depth
  is now learned from hits, but a game that ends after two crashes gives it one lesson at most, so its effect on
  survival is not measurable from a handful of runs; the lead-time thresholds (0.5 / 1.2 s) are set by hand and
  belong in the same calibration loop as the evaluator. Next: re-acquire a lost track from the frame difference
  right after the player's own move, and carry learned depth across sessions of the same game.
- **Audio edge cases.** Web Audio is rendered once at the end of the session, so anything that reads the audio while
  the game runs sees silence (an `AnalyserNode` visualizer stays flat), and `ScriptProcessor`/`AudioWorklet` code runs
  during the final render rather than live. An `<audio>` element routed into Web Audio
  (`createMediaElementSource`) is mixed from the media log, without its graph processing. `<audio>` elements play on
  the real clock, so the loop position music resumes at can differ slightly between runs.
- **Speed on CPU.** 3D capture is 0.2–0.4 s per frame on llvmpipe; a GPU worker makes it ~10× faster.
- **Planner cost/latency.** Every decision is a VLM call (3–20 s, ~$0.006). A cheap model by default with escalation
  to a stronger one when the decider reports low clarity or the agent is stuck would cut both.

---

## Running it

Requirements: Node ≥ 22.19, Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), ffmpeg, an OpenRouter key.
On Linux, `Xvfb` (optional) makes WebGL capture ~3.5× faster.

```bash
./run setup          # python env (playwright, numpy, pillow), chromium, key → .env; then doctor
./run doctor         # checks tools, key, model ids, decider
npm test             # unit tests: gestures, EDL normalization, timing, reflex plans (node) + player tracker, game audio (python)
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
py/simbrowser/shim.js    virtual clock, sandbox, game audio (Web Audio rendered offline), introspection (injected)
py/simbrowser/server.py  browser worker (Playwright, CDP touch, 30 fps capture)
py/simbrowser/audio.py   game-audio mix (rendered Web Audio + <audio> elements)
py/simbrowser/remix.py   rebuild a finished session's audio from a verified replay
py/simbrowser/render.py  EDL → highlight with touch indicator
games/samples/           the 4 provided playables
games/generated/         playables I generated (2D, DOM, 3D)
games/holdout/           generated playables never used during development
docs/                    productionization
```
