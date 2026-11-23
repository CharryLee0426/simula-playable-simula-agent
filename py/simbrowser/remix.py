"""Rebuild the audio of a finished session from a replay of it, under the videos already cut.

A session is reproducible: game time is virtual, Math.random is seeded and actions.jsonl has every touch at its
frame. Replaying the touches in the worker gives back the same game, so a fix to how game audio is recorded (Web
Audio rendered by the browser instead of the approximate event-log mix) can be applied to a session that was
already played and cut, with no model calls and no re-cut: the video streams are copied, only the audio is rebuilt
(same clip lists, fades and loudness normalization as simbrowser.render).

  python -m simbrowser.remix <session_or_deliverable_dir> <playable.html> [--verify [--verify-band T:H]] [--work DIR [--reuse]]

--verify also records the replay and compares it frame by frame with the video in raw.mp4: a replay that is not
the same game is reported and nothing is replaced. --verify-band limits the comparison to a strip of the frame (a
HUD), for games whose cosmetic effects draw from the random stream. Writes audio.wav and audio/ into --work
(default: a temporary directory) and replaces the audio track of raw.mp4, highlight.mp4 and candidates/cut_<id>.mp4
in place.

Some recordings had real-time races in them: a live AudioContext's state flipping to "running" on the real clock,
assets (audio, images, fonts, shaders) finishing on the real clock, or a touch move handled a frame late, when the
game's logic or its random draws depend on them. The shim now pins all of these to game frames (README, key decision
1), so a replay is the same game on every run; a recording made before that is one sample of its races, and its
replay may be another game. With --attempts N a diverging replay is abandoned as soon as a checkpoint frame no longer
matches raw.mp4, and replayed again, up to N times; only a replay that passes the full check is used.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image

from simbrowser.audio import mix_session
from simbrowser.render import build_audio_filter
from simbrowser.server import Worker


class Diverged(Exception):
    pass


def checkpoint(raw: Path, fps: float, every: int = 150, floor_db: float = 20.0) -> Callable[[int, bytes], None]:
    """Every `every` frames, the replay's frame against raw.mp4's at 135x240: raises Diverged when it is clearly
    another game (an idle animation at another phase stays near 30 dB; a different game is ~13 dB)."""
    def small(img: Image.Image) -> np.ndarray:
        return np.asarray(img.convert("L").resize((135, 240), Image.BOX), dtype=np.float32)

    def check(f: int, jpeg: bytes) -> None:
        if f < 30 or f % every:
            return
        r = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{f / fps:.4f}", "-i", str(raw), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"],
                           capture_output=True)
        if r.returncode or not r.stdout:
            return
        mse = float(np.mean((small(Image.open(io.BytesIO(jpeg))) - small(Image.open(io.BytesIO(r.stdout)))) ** 2))
        if 10 * np.log10(255 ** 2 / max(mse, 1e-6)) < floor_db:
            raise Diverged(f"frame {f}")
    return check


async def replay(session: Path, playable: Path, work: Path, record: bool, check: Callable[[int, bytes], None] | None = None) -> dict:
    sess = json.loads((session / "session.json").read_text())
    browser = json.loads((session / "config.json").read_text()).get("browser", {}) if (session / "config.json").exists() else {}
    fps = int(browser.get("fps", sess.get("fps", 30)))
    frames = int(sess.get("frames") or round(sess["game_s"] * fps))
    touches: dict[int, list] = {}
    for line in (session / "actions.jsonl").read_text().splitlines():
        for t in json.loads(line).get("touches", []):
            touches.setdefault(int(t["f"]), []).append(t)
    mouse = sess.get("input_mode") == "mouse"
    w = Worker()
    await w.open({"run_dir": str(work), "playable": str(playable), "viewport": browser.get("viewport", [360, 640]), "dpr": browser.get("dpr", 2), "fps": fps,
                  "seed": browser.get("seed", 7), "display": browser.get("display", "auto"), "record": record, "audio": "render", "audio_max_s": frames / fps + 60,
                  **({"epoch": browser["epoch"]} if browser.get("epoch") is not None else {})})
    try:
        for f in range(frames):
            for t in touches.get(f, []):
                if mouse:
                    await w.mouse({"type": {"start": "down", "move": "move", "end": "up"}[t["phase"]], "x": t["x"], "y": t["y"]})
                else:
                    await w.touch({"type": t["phase"], "x": t["x"], "y": t["y"]})
            await w.step({"frames": 1, "capture": record})
            if check and w.rec and w.rec.last_jpeg:
                check(f, w.rec.last_jpeg)
    finally:
        out = await w.close({})
    return {"game_s": frames / fps, "close": out}


def compare_video(replayed: Path, raw: Path, band: tuple[float, float] | None = None) -> dict:
    """Per-frame PSNR of the replay against raw.mp4's video, both shrunk to 135x240: compression noise and an idle
    animation at another phase (a pulsing button: 28-34 dB) stay well above what a different game scores (~13 dB).

    `band` = (top, height) as fractions of the frame: compare only that strip, at 540 px wide (e.g. the HUD of a game
    whose particles and camera shake draw from the random stream while its gameplay does not)."""
    stats = replayed.with_name(f"psnr_{raw.parent.name}.txt")
    if band:
        y, h = int(band[0] * 960) // 2 * 2, max(2, int(band[1] * 960) // 2 * 2)
        fit = f"scale=540:960:flags=area,crop=540:{h}:0:{y}"
        threshold = 22.0
    else:
        fit, threshold = "scale=135:240:flags=area", 25.0
    subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(replayed), "-i", str(raw), "-lavfi",
                    f"[0:v]{fit}[a];[1:v]{fit}[b];[a][b]psnr=shortest=1:stats_file={stats}", "-f", "null", "-"], check=True)
    vals = []
    for line in stats.read_text().splitlines():
        kv = dict(x.split(":", 1) for x in line.split() if ":" in x)
        v = kv.get("psnr_avg", "inf")
        vals.append(99.0 if v == "inf" else float(v))
    body = vals[15:] or vals  # the first half second is boot (assets decoding in real time)
    return {"frames": len(vals), "mean_db": round(sum(body) / len(body), 2), "min_db": round(min(body), 2), "threshold_db": threshold,
            "below": sum(1 for v in body if v < threshold), **({"band": list(band)} if band else {})}


def replace_audio(video: Path, wav: Path, audio: list[str], bitrate: str) -> None:
    """The video stream copied as is, the audio track rebuilt from `wav` (input 1) by `audio` (filter + map)."""
    tmp = video.with_suffix(".remix.mp4")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-i", str(wav), "-map", "0:v", *audio, "-c:v", "copy", "-c:a", "aac", "-b:a", bitrate,
                    "-ar", "48000", "-movflags", "+faststart", str(tmp)], check=True)
    tmp.replace(video)


def cut_audio(video: Path, wav: Path, edl: dict, fps: float, bitrate: str) -> None:
    clips = edl["clips"]
    total_s = sum(int(round((c["end"] - c["start"]) / float(c.get("speed", 1.0)) * fps)) for c in clips) / fps
    replace_audio(video, wav, ["-filter_complex", build_audio_filter(clips, total_s), "-map", "[aout]"], bitrate)


def remix(session: Path, playable: Path, work: Path, verify: bool, band: tuple[float, float] | None = None, reuse: bool = False,
          attempts: int = 1) -> dict:
    fps = float(json.loads((session / "session.json").read_text()).get("fps", 30))
    report: dict = {"attempts": []}
    for attempt in range(max(1, attempts)):
        if reuse and attempt == 0 and (work / "audio" / "audio_log.json").exists() and (not verify or (work / "raw_video.mp4").exists()):
            sess = json.loads((session / "session.json").read_text())
            rep = {"game_s": sess.get("frames", 0) / fps or sess["game_s"], "close": {"audio": "reused"}}
        else:
            # the checkpoint compares the whole frame, so it is off when only a band is verified
            check = checkpoint(session / "raw.mp4", fps) if verify and attempts > 1 and not band else None
            try:
                rep = asyncio.run(replay(session, playable, work, verify, check))
            except Diverged as e:
                report["attempts"].append(f"diverged at {e}")
                continue
        report.update({"audio": rep["close"].get("audio"), "mix": mix_session(work, rep["game_s"])})
        if not verify:
            break
        report["video"] = compare_video(work / "raw_video.mp4", session / "raw.mp4", band)
        if report["video"]["below"] <= 0.02 * report["video"]["frames"]:
            report["attempts"].append("verified")
            break
        report["attempts"].append(f"{report['video']['below']} frames below {report['video']['threshold_db']} dB")
    else:
        report["replaced"] = []
        report["error"] = "no replay was the same game as raw.mp4; nothing replaced"
        return report
    wav = work / "audio.wav"
    replaced = []
    if (session / "raw.mp4").exists():
        replace_audio(session / "raw.mp4", wav, ["-map", "1:a", "-shortest"], "96k")
        replaced.append("raw.mp4")
    ev = json.loads((session / "eval.json").read_text()) if (session / "eval.json").exists() else {}
    if (session / "highlight.mp4").exists() and ev.get("best") and (session / f"edl_{ev['best']}.json").exists():
        cut_audio(session / "highlight.mp4", wav, json.loads((session / f"edl_{ev['best']}.json").read_text()), fps, "192k")
        replaced.append("highlight.mp4")
    for cut in sorted((session / "candidates").glob("cut_*.mp4")) if (session / "candidates").exists() else []:
        edl = session / f"edl_{cut.stem[4:]}.json"
        if edl.exists():
            cut_audio(cut, wav, json.loads(edl.read_text()), fps, "64k")
            replaced.append(f"candidates/{cut.name}")
    report["replaced"] = replaced
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("playable")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--verify-band", help="TOP:HEIGHT, fractions of the frame height: verify only this strip (e.g. the HUD)")
    ap.add_argument("--work")
    ap.add_argument("--reuse", action="store_true", help="use the replay already in --work instead of replaying again")
    ap.add_argument("--attempts", type=int, default=1, help="with --verify: replay up to N times, abandoning a replay at the first checkpoint that diverges")
    a = ap.parse_args()
    band = tuple(float(x) for x in a.verify_band.split(":")) if a.verify_band else None
    if a.work:
        Path(a.work).mkdir(parents=True, exist_ok=True)
        print(json.dumps(remix(Path(a.session), Path(a.playable), Path(a.work), a.verify, band, a.reuse, a.attempts)))
    else:
        with tempfile.TemporaryDirectory() as d:
            print(json.dumps(remix(Path(a.session), Path(a.playable), Path(d), a.verify, band, attempts=a.attempts)))
