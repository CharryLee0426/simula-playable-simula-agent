# Recording outline (10–15 min)

A suggested script for the walkthrough. Times are targets; every claim points at a file you can show.

## 0. The result first (1 min)
- Play one highlight full-screen (e.g. `deliverables/boom-castle/highlight.mp4`), then a second game of a different
  kind (a DOM word puzzle or a 3D game). Point out: the touch indicator, the game audio, the end card.
- One sentence: "One command, any playable, no per-game code: it learns the game, plays it like a person, cuts this,
  writes a friction report and scores itself."

## 1. The problem as I framed it (1.5 min)
- Four hard parts: (1) generality — 2D canvas, DOM, WebGL 3D, all touch; (2) looking human; (3) model latency vs a
  real-time game; (4) knowing whether a video is good without watching it.
- The 80/20: spend the time on play + capture + the evaluator; keep the editor simple and let code enforce the rules.

## 2. The key insight: a virtual clock (2.5 min)
- Show the probe numbers: the 3D samples render at 2–5 fps on a CPU-only machine; a VLM takes 3–20 s per decision.
  Real-time play + screen recording can't give a smooth 30 fps video of a person playing.
- The shim (`py/simbrowser/shim.js`): every clock the game can read only moves when the agent steps a frame. The
  game freezes while the model thinks; every frame is exactly 1/30 s apart; the only pauses on video are the
  humanizer's reaction times. Deterministic and machine-independent (same session on a laptop or a GPU node).
- The two things that broke and how they were fixed generically: a CPU benchmark busy-loop at boot (Raid) → creeping
  clock after 20k reads per frame; floating reward labels frozen on screen (Word Hunt) → animations tracked and
  finished explicitly. The second one was found by the VLM judge ("worst moment: frozen '+$0.30' text").
- Audio: the game's Web Audio graph is rendered by Chromium itself on the virtual clock (envelopes, filters, compressor
  intact), `<audio>` elements are logged in game time → frame-accurate soundtrack that sounds like the game.

## 3. How it plays (2.5 min)
- Open a `trace.html`, scroll the turn table: screenshot → what the planner saw → its running notes → gestures with
  reaction times → the decider's answers (phase, "did that work", clarity).
- Generic perception: screenshot + numbered DOM elements (set-of-marks) for DOM games + which input events the game
  listens to. Never reads game state.
- Planner (Gemini 4 Hydrogen) vs decider (Perplexity Decider: probabilities in 0.3 s, free) — why two models.
- Humanizer: lognormal reactions, reading time after big screen changes, Fitts, Bézier drags, slips.
- Show one failure and recovery (e.g. the word game's first swipe not registering → it used the hint → solved it;
  that was also a real bug in my Bézier sampler, now a unit test).

## 3b. Reflexes for fast games (1 min)
- Show `deliverables/neon-lanes/trace.html`: a reflex policy (zone + situations), its checks and fires with reflex
  times and evidence crops; then the "something new" hand-back (README lessons table, "reflex v2"): the game introduced
  jump barriers mid-policy → the hand-back let the planner read the tutorial and jump.
- The evidence: Neon Lanes 6 inputs / crash at 11 s without reflexes vs 17–19 inputs / first crash at 13–16 s with them.
- The honest twist: on the slower hold-out dodger a planner-only ablation did as well (frozen clock = exact
  positioning), so reflexes became an escalation, not a default.
- The zone that follows the player: show the tracked-car template and the evidence crops in the trace; the offline
  comparison (static zone: false dodges for the next lane's block; following zone: "none", then sees the real one);
  the learned walls; and the idea that failed (snapping the template to the most contrasted patch lost the car 3/5).
- Zone depth learned from hits: a flash or a sudden freeze in the recorded frames, confirmed by one question on the
  whole screen → the lead time of the last reaction decides deeper / shallower / "not a depth problem" (wrong
  reaction, greedy pickup). Show the two ⚡ hit rows in `deliverables/neon-lanes/trace.html` (evidence frame, lesson,
  0 → 44 → 95). The story is the detection: run 1 found no crash (this game freezes instead of flashing), run 2 had a
  false "hit" on the REVIVED banner, run 3 found both with none false. And the honest part: no survival claim.

## 4. The cut (1.5 min)
- Index: per-0.5 s signals + one director call watching the timestamped session → game model + moments.
- Three EDL strategies; code enforces 20.0 s / ≤1.5× / ≤30 s source / no mid-gesture cuts / dead air trimmed /
  end card last. Show `edl_*.json` with the code's `fixes`.
- Taste decisions: touch indicator, hook first, keep ~1 s reading pauses (the judge flagged instant-looking taps when
  I trimmed them), end card capped at 3 s.

## 5. Evaluation (2 min) — Goal 4
- `score = gate × (0.55 J + 0.45 H)`; show a candidates table in `trace.html`.
- The control group: "first 20 s" and "random clips" cuts go through the same evaluator. Show the separation column
  in `deliverables/README.md` and the head-to-head wins. Mention the first version's heuristics could NOT tell random
  clips from a real edit on an action-packed game, and what fixed it (moment quality, arc).
- The random *player* calibration session (bad play, not just bad editing).
- Honest limits: one judge model, judge variance between runs (± a few points), heuristics hand-weighted —
  production would calibrate them on human review decisions.

## 6. Friction (1 min) — Goal 3
- Show `friction.md` for one game: every item cites signal ids from the session; uncited items are dropped. Mention
  the false positive I caught (it claimed "no tutorial" where the agent had seen one) and the fix (the writer sees the
  player's own screen descriptions).

## 7. Generality (1 min)
- Generated playables across genres (slingshot physics, DOM idle tapper, raw-WebGL 3D runner, merge puzzle) and two
  hold-out games never used during development (match-3, 3D stacker). Show their scores next to the samples.

## 8. Production (1.5 min) — Goal 5
- `docs/productionization.md`: queue → isolated containers → durable sessions; caching by playable hash + seed; GPU
  capture nodes; budgets that degrade; routing to human review on low score or judge/heuristic disagreement; weekly
  calibration from review decisions and CTR/IPM; nightly regression suite.
- Cost/time per playable today and at scale.

## 9. Next steps (30 s)
- Multiple takes per playable (seeds/personas) and pick across all candidates; a cheaper planner with escalation;
  genre-level policy hints learned from verified sessions; calibrate the evaluator on human labels; GPU workers.
