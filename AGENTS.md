# Agent instructions

This repository takes an HTML5 playable ad, plays it in a virtual-clock browser, records it, cuts a 20-second 9:16 highlight, writes a friction report, and scores the result. See [README.md](README.md) for the design.

These instructions are for coding agents such as Codex and Claude Code.

## When the user says "set it up"

Treat "set it up", "install this", "get this running", and similar requests as a request to complete the steps below in order. Setup is finished when `./run doctor` and `npm test` both pass.

Follow these rules throughout:

- **Ask before installing system packages.** Show the exact command first. Project dependencies (`npm ci`, `./run setup`) need no extra approval.
- **Ask before any paid run.** `./run doctor` and `npm test` are free. Anything that plays a game spends the user's OpenRouter credit.
- **Never ask for the API key in chat**, and never print, log, or commit `.env`. The user puts the key in `.env` themselves.
- **Do not overwrite `deliverables/`.** It is tracked in git. Write new output under `runs/`, which is ignored.

### 1. Put the right ffmpeg on PATH

Shell state may not persist between agent commands, so start **every** command that runs `./run` with this line. It is harmless where the directories do not exist.

```bash
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/usr/local/opt/ffmpeg-full/bin:$PATH"
```

### 2. Check the prerequisites

```bash
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/usr/local/opt/ffmpeg-full/bin:$PATH"
node -v
uv --version
ffprobe -version | sed -n 1p
ffmpeg -hide_banner -filters 2>/dev/null | grep -F ' drawtext '
```

You need Node 22.19 or newer, `uv`, `ffprobe`, and an ffmpeg that prints a `drawtext` line. **The default Homebrew `ffmpeg` has no `drawtext`**, and `./run doctor` does not detect this. Without it, every game silently loses its Director step (see [Check every run](#check-every-run)).

Install only what is missing, after asking:

| Platform | Command |
| --- | --- |
| macOS, ffmpeg | `brew install ffmpeg-full` (keg-only, sits beside any existing ffmpeg, adds many dependencies) |
| macOS, Node and uv | `brew install node uv` |
| Ubuntu or Debian, ffmpeg and fonts | `sudo apt-get update && sudo apt-get install -y ffmpeg fonts-dejavu-core xvfb` |
| Linux, uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Linux, Node | Install Node 22.19 or newer with the user's preferred version manager |

Windows is untested. `./run` is a bash script, so use WSL2 and follow the Linux steps.

### 3. Install the project

```bash
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/usr/local/opt/ffmpeg-full/bin:$PATH"
npm ci --no-fund --no-audit
./run setup </dev/null
```

`./run setup` creates `py/.venv` and installs Chromium, then runs the doctor. **If no key is set yet, it exits non-zero with only `OPENROUTER_API_KEY` marked as failed. That is expected.** Any other failure needs fixing. `npm ci` may warn about unapproved install scripts; no action is needed.

On Linux, if Chromium reports missing shared libraries, ask before running:

```bash
sudo py/.venv/bin/python -m playwright install-deps chromium
```

### 4. Add the OpenRouter key

Create the file if it does not exist:

```bash
[ -f .env ] || cp .env.example .env
chmod 600 .env
```

Check the key without printing it:

```bash
set -a; . ./.env; set +a
printf 'Authorization: Bearer %s\n' "$OPENROUTER_API_KEY" | curl -s -o /dev/null -w '%{http_code}\n' -H @- https://openrouter.ai/api/v1/key
```

`200` means the key is valid. For anything else, stop and ask the user to open `.env` and set `OPENROUTER_API_KEY` to a key from <https://openrouter.ai/keys>. Repeat the check when they confirm.

### 5. Verify

```bash
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/usr/local/opt/ffmpeg-full/bin:$PATH"
./run doctor
npm test
```

A placeholder or invalid key can appear in the doctor as only a `decider` failure, so do not read that line alone. If the key check in step 4 returned `200` and `decider` is the only failure, the free decider model is unavailable. The pipeline can fall back to pixel heuristics, so tell the user and continue.

### 6. Report and offer a smoke test

Tell the user what was installed and that setup passed. Then offer one real run, which takes about 5 to 10 minutes and costs about $0.30. Run it only if they agree, and run it in the background because it outlasts most tool timeouts:

```bash
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/usr/local/opt/ffmpeg-full/bin:$PATH"
./run --playable games/samples/word-hunt.html --out runs/smoke/highlight.mp4 --set browser.display=headless
```

Then apply [Check every run](#check-every-run).

## Running the pipeline

Start each command with the `export PATH` line from step 1.

```bash
# One game
./run --playable games/samples/word-hunt.html --out runs/one/highlight.mp4 --set browser.display=headless

# All games (about $7.50 and, one at a time, about 2 to 3 hours)
./run batch games/samples games/generated games/holdout --out-dir runs/all/deliverables --set browser.display=headless

# Redo a finished session from a later phase without replaying the game
./run --playable games/samples/word-hunt.html --session runs/<session-id> --redo index
```

- Games usually cost $0.30 to $0.70 each. The default cap is $2 per game, and every paid call is recorded in the session's `ledger.jsonl`.
- Before a batch, confirm the cost with the user and test one game first.
- `--set browser.display=headless` stops Chrome windows from opening on the user's screen. It applies when a session is created; resumed sessions keep their stored config.
- To run batches in parallel, give each process its own game list and its own `--state batch-<name>.json`, with the same `--out-dir`.
- `--redo` accepts `play`, `index`, `cut`, `render`, `eval`, `friction`, or `report`. Redoing from `index` or later keeps the recording, so it skips the planner cost.

## Check every run

A successful exit code does not prove a good run. `./run batch` exits 0 even when a game fails, and a Director failure only produces a warning.

```bash
# Every game must show "status": "ok"
cat runs/all/deliverables/batch.json

# Must print nothing. Any path printed is a session whose Director failed.
grep -El '"genre": *"unknown"' runs/all/deliverables/*/game_model.json

# Must report 20 seconds, 1080x1920, 30 fps, h264 and aac
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of csv=p=0 runs/all/deliverables/<game>/highlight.mp4
```

For a single run, check `runs/<session-id>/game_model.json` and `runs/<session-id>/highlight.mp4` the same way.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `genre` is `unknown`, or the log says `director failed ... proxy.mp4` | ffmpeg has no `drawtext`. Fix PATH (step 1), then rerun with `--redo index`. |
| The doctor fails only on `decider` | Usually a placeholder or invalid key. Run the key check in step 4. |
| `Node ... is too old` | Install Node 22.19 or newer. |
| Chromium fails to launch on Linux | Run the `playwright install-deps` command from step 3. |
| Occasional `HTTP 429` from the decider | The free model is rate limited. Isolated failures are retried or skipped. |
| OpenRouter unreachable behind a proxy | Set `HTTPS_PROXY`. `./run` then enables Node's proxy support. |

## Working in this repository

- Tests: `npm test`. Type check: `npm run typecheck`.
- Keep the pipeline game-agnostic. Do not add per-game rules, coordinates, or code.
- Never commit `.env`, `config/local.json`, `runs/`, or `cache/`.
