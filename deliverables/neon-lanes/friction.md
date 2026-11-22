# Friction report — Neon Lanes

The core 3-lane runner loop and jump tutorial worked well, taking the player to 246m with 21 coins. However, late-registering swipes caused frustrating crashes, and both the revive popup and game-over transition suffered from low-contrast UI and dead-air delays.

| time | type | severity | issue | suggested fix |
| --- | --- | --- | --- | --- |
| 0:11.1–0:20.2 | frustration | high | **Swipes fail to register before crashing into tall blocks** — At t=11.1s and t=20.2s, the player saw tall pink X blocks ahead and attempted to swipe away, but crashed before the input registered (no_effect). | Increase swipe input responsiveness and add input buffering during lane transitions, or slightly increase the spacing before tall pink X blocks at higher speeds. |
| 0:20.2–0:22.2 | ui | medium | **Faint Game Over screen with no buttons before end card** — At t=20.2s, the screen showed faint, low-contrast 'GAME OVER' text with SPD 0 and no actionable buttons, leaving a 2-second dead-air gap until the end card appeared at t=22.2s. | Make the 'GAME OVER' text high-contrast immediately on crash and transition directly to the end card or display a 'PLAY NOW' button right away. |
| 0:11.1 | ui | medium | **Low-contrast Revive button on crash popup** — On the 'CRASHED! Keep your run going?' popup at t=11.1s, the central 'REVIVE' button is dark and blends into the road, while 'No thanks' is bright white and underlined. | Style the 'REVIVE (1 FREE)' button with a bright neon fill and glowing border so it clearly stands out as the primary action over 'No thanks'. |
| 0:00.0–0:02.0 | pacing | low | **Slight delay to first successful lane switch** — It took 2.0s from the first playable frame for the player's first swipe to visibly register during the 'Swipe to switch lanes!' tutorial. | Trigger the lane-switch tutorial prompt immediately at 0.0s with a slightly slower initial car speed so first-time players can complete their first dodge within 1 second. |

## Evidence

**0:11.1 · Swipes fail to register before crashing into tall blocks** (signals S3, S4)

![Swipes fail to register before crashing into tall blocks](obs/obs_0010.jpg)

**0:20.2 · Faint Game Over screen with no buttons before end card** (signals S2, S6, S7)

![Faint Game Over screen with no buttons before end card](obs/obs_0014.jpg)

**0:11.1 · Low-contrast Revive button on crash popup** (signals S5)

![Low-contrast Revive button on crash popup](obs/obs_0010.jpg)

**0:00.0 · Slight delay to first successful lane switch** (signals S1)

![Slight delay to first successful lane switch](obs/obs_0005.jpg)

## Signals extracted from the session

- `S1` 0:00.0 [time_to_first_success] 2.0 s from the first playable frame until an input visibly worked
- `S2` 0:20.2 [unclear_screen] decider: only 30% that a first-time player knows what to do (screen: fail)
- `S3` 0:11.1 [no_effect] previous input had no visible effect (decider 9%, 30.2% of pixels changed) — the player had tried: Car in right lane approaching tall pink X block; coins in middle lane
- `S4` 0:20.2 [no_effect] previous input had no visible effect (decider 2%, 29.6% of pixels changed) — the player had tried: 241m, car in middle lane, tall pink X block directly ahead, coins in right lane
- `S5` 0:11.1 [fail_screen] a fail / game-over screen
- `S6` 0:20.2 [fail_screen] a fail / game-over screen
- `S7` 0:22.2 [end_card] end card appeared at 22.2 s (session 26.9 s)
