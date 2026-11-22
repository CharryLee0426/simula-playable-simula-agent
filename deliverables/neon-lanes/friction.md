# Friction report — Neon Lanes

The first-time experience is smooth overall, with clear lane-switching and jumping tutorials that let the player quickly grasp the core loop. Minor friction occurs on the final Game Over screen, which lacks any prompt or button before transitioning to the end card.

| time | type | severity | issue | suggested fix |
| --- | --- | --- | --- | --- |
| 0:24.9–0:26.9 | ui | medium | **Game Over screen lacks a prompt or button** — At t=24.9s, the GAME OVER screen appears over the frozen highway with no buttons or instructions (46% clarity), and the player's last input had no visible effect before the end card appeared 2 seconds later. | Add a brief 'Loading results...' indicator or a 'Continue' / 'Tap to continue' prompt on the GAME OVER screen so players know the end card is about to appear rather than thinking the playable froze. |
| 0:13.4 | frustration | low | **Abrupt crash transition ignores final swipe** — At t=13.4s, the player's last input had no visible effect right as the car hit a pink X block and transitioned to the CRASHED! Revive popup. | Add a brief hit-stop or impact flash (e.g., 0.2s) before showing the CRASHED! popup so the player clearly registers the collision rather than feeling their last swipe was ignored. |
| 0:00.0–0:02.0 | pacing | low | **2.0s delay before first successful lane switch** — The car starts moving immediately at SPD 53 with the 'Swipe to switch lanes!' prompt and hand hint, taking 2.0s before the first input visibly works. | Allow swipe inputs to register immediately from t=0.0s and consider starting the car slightly slower during the first 1-2 seconds so the first lane switch feels instant. |

## Evidence

**0:24.9 · Game Over screen lacks a prompt or button** (signals S2, S4, S6, S7)

![Game Over screen lacks a prompt or button](obs/obs_0013.jpg)

**0:13.4 · Abrupt crash transition ignores final swipe** (signals S3, S5)

![Abrupt crash transition ignores final swipe](obs/obs_0009.jpg)

**0:00.0 · 2.0s delay before first successful lane switch** (signals S1)

![2.0s delay before first successful lane switch](obs/obs_0005.jpg)

## Signals extracted from the session

- `S1` 0:00.0 [time_to_first_success] 2.0 s from the first playable frame until an input visibly worked
- `S2` 0:24.9 [unclear_screen] decider: only 46% that a first-time player knows what to do (screen: fail)
- `S3` 0:13.4 [no_effect] previous input had no visible effect (decider 14%, 44.3% of pixels changed) — the player had tried: 3-lane runner gameplay, GREAT JUMP! text, car in right lane, pink X block ahead 
- `S4` 0:24.9 [no_effect] previous input had no visible effect (decider 14%, 52.7% of pixels changed) — the player had tried: 3-lane runner gameplay at 288m, SPD 82, car in left lane, pink X blocks ahead in
- `S5` 0:13.4 [fail_screen] a fail / game-over screen
- `S6` 0:24.9 [fail_screen] a fail / game-over screen
- `S7` 0:26.9 [end_card] end card appeared at 26.9 s (session 31.9 s)
