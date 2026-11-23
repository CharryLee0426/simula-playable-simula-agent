"""Rebuild the audio of a finished session from a replay of it, under the videos already cut.

A session is reproducible: game time is virtual, Math.random is seeded and actions.jsonl has every touch at its
frame. Replaying the touches in the worker gives back the same game, so a fix to how game audio is recorded (Web
Audio rendered by the browser instead of the approximate event-log mix) can be applied to a session that was
already played and cut, with no model calls and no re-cut: the video streams are copied, only the audio is rebuilt
(same clip lists, fades and loudness normalization as simbrowser.render).

  python -m simbrowser.remix <session_or_deliverable_dir> <playable.html> [--verify] [--work DIR]

--verify also records the replay and compares it frame by frame with the video in raw.mp4: a replay that is not
the same game is reported and nothing is replaced. Writes audio.wav and audio/ into --work (default: a temporary
directory) and replaces the audio track of raw.mp4, highlight.mp4 and candidates/cut_<id>.mp4 in place.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import tempfile
from pathlib import Path

from simbrowser.audio import mix_session
from simbrowser.render import build_audio_filter
from simbrowser.server import Worker


async def replay(session: Path, playable: Path, work: Path, record: bool) -> dict:
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
                  "seed": browser.get("seed", 7), "display": browser.get("display", "auto"), "record": record, "audio": "render", "audio_max_s": frames / fps + 60})
    try:
        for f in range(frames):
            for t in touches.get(f, []):
                if mouse:
                    await w.mouse({"type": {"start": "down", "move": "move", "end": "up"}[t["phase"]], "x": t["x"], "y": t["y"]})
                else:
                    await w.touch({"type": t["phase"], "x": t["x"], "y": t["y"]})
            await w.step({"frames": 1, "capture": record})
    finally:
        out = await w.close({})
    return {"game_s": frames / fps, "close": out}


def compare_video(replayed: Path, raw: Path) -> dict:
    """Per-frame PSNR of the replay against raw.mp4's video, both shrunk to 135x240: compression noise and an idle
    animation at another phase (a pulsing button: 28-34 dB) stay well above what a different game scores (~13 dB)."""
    stats = replayed.with_name(f"psnr_{raw.parent.name}.txt")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(replayed), "-i", str(raw), "-lavfi",
                    f"[0:v]scale=135:240:flags=area[a];[1:v]scale=135:240:flags=area[b];[a][b]psnr=stats_file={stats}", "-f", "null", "-"], check=True)
    vals = []
    for line in stats.read_text().splitlines():
        kv = dict(x.split(":", 1) for x in line.split() if ":" in x)
        v = kv.get("psnr_avg", "inf")
        vals.append(99.0 if v == "inf" else float(v))
    body = vals[15:] or vals  # the first half second is boot (assets decoding in real time)
    return {"frames": len(vals), "mean_db": round(sum(body) / len(body), 2), "min_db": round(min(body), 2), "below_25db": sum(1 for v in body if v < 25)}


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


def remix(session: Path, playable: Path, work: Path, verify: bool) -> dict:
    rep = asyncio.run(replay(session, playable, work, verify))
    report: dict = {"audio": rep["close"].get("audio"), "mix": mix_session(work, rep["game_s"])}
    if verify:
        report["video"] = compare_video(work / "raw_video.mp4", session / "raw.mp4")
        if report["video"]["below_25db"] > 0.02 * report["video"]["frames"]:
            report["replaced"] = []
            report["error"] = "the replay is not the same game as raw.mp4; nothing replaced"
            return report
    wav = work / "audio.wav"
    fps = float(json.loads((session / "session.json").read_text()).get("fps", 30))
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
    ap.add_argument("--work")
    a = ap.parse_args()
    if a.work:
        Path(a.work).mkdir(parents=True, exist_ok=True)
        print(json.dumps(remix(Path(a.session), Path(a.playable), Path(a.work), a.verify)))
    else:
        with tempfile.TemporaryDirectory() as d:
            print(json.dumps(remix(Path(a.session), Path(a.playable), Path(d), a.verify)))
