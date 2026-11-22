"""Render a highlight from an edit decision list (EDL).

  python -m simbrowser.render <session_dir> <edl.json> <out.mp4> [--width 1080 --height 1920 --no-overlay]

The session's raw video is 30 fps of game time. Each EDL clip [start, end] at `speed` (1.0-1.5) becomes
round((end-start)/speed*30) output frames sampled from the source frames, so a speed-up drops frames rather than
blending them (that keeps it crisp, like a sped-up screen recording). The touch indicator is drawn from the
session's action log (exact frame numbers), in the style of a phone's "show touches" option: a soft dot while the
finger is down, a short trail on drags, a ripple on release. Audio is cut with the same clip list (atempo keeps
pitch), joined with tiny fades so cuts never click, loudness-normalized to -16 LUFS, and padded or trimmed to the
exact video length. Output: H.264 High / yuv420p / 30 fps / AAC 48 kHz, faststart.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def probe(path: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
                        "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    j = json.loads(r.stdout)
    s = j["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {"w": int(s["width"]), "h": int(s["height"]), "fps": float(num) / float(den), "duration": float(j["format"]["duration"])}


def read_frames(video: Path, start_f: int, n: int, w: int, h: int, fps: float) -> list[np.ndarray]:
    """Decode n frames starting at frame index start_f (accurate seek)."""
    t = max(0.0, start_f / fps)
    cmd = ["ffmpeg", "-loglevel", "error", "-ss", f"{t:.4f}", "-i", str(video), "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    size = w * h * 3
    frames = [np.frombuffer(raw[i:i + size], dtype=np.uint8).reshape(h, w, 3) for i in range(0, len(raw) - size + 1, size)]
    return frames


class Touches:
    """Finger state per source frame, from actions.jsonl (CSS px -> video px via `scale`)."""

    def __init__(self, actions_path: Path, scale: float):
        self.scale = scale
        self.down: dict[int, tuple[float, float]] = {}
        self.releases: list[tuple[int, float, float]] = []
        if not actions_path.exists():
            return
        for line in actions_path.read_text().splitlines():
            if not line.strip():
                continue
            a = json.loads(line)
            ts = a.get("touches") or []
            if not ts:
                continue
            # interpolate the finger position for every frame between consecutive touch samples
            for p, q in zip(ts, ts[1:]):
                if p["phase"] == "end":
                    continue
                for f in range(p["f"], max(p["f"] + 1, q["f"])):
                    u = (f - p["f"]) / max(1, q["f"] - p["f"])
                    self.down[f] = (p["x"] + (q["x"] - p["x"]) * u, p["y"] + (q["y"] - p["y"]) * u)
            end = ts[-1]
            self.releases.append((end["f"], end["x"], end["y"]))

    def draw(self, img: Image.Image, f: int, r: float):
        d = ImageDraw.Draw(img, "RGBA")
        s = self.scale
        # trail (last few frames of a drag)
        trail = [self.down[k] for k in range(f - 6, f) if k in self.down]
        for i, (x, y) in enumerate(trail):
            a = int(40 + 90 * (i + 1) / max(1, len(trail)))
            rr = r * (0.45 + 0.4 * (i + 1) / max(1, len(trail)))
            d.ellipse([x * s - rr, y * s - rr, x * s + rr, y * s + rr], fill=(255, 255, 255, a // 2))
        if f in self.down:
            x, y = self.down[f]
            d.ellipse([x * s - r, y * s - r, x * s + r, y * s + r], fill=(255, 255, 255, 120), outline=(255, 255, 255, 210), width=max(2, int(r / 9)))
        for (rf, x, y) in self.releases:
            k = f - rf
            if 0 <= k < 9:
                rr = r * (1.0 + 0.09 * k * 1.6)
                a = int(200 * (1 - k / 9))
                d.ellipse([x * s - rr, y * s - rr, x * s + rr, y * s + rr], outline=(255, 255, 255, a), width=max(2, int(r / 8)))


def build_audio_filter(clips: list[dict], total_s: float) -> str:
    parts, labels = [], []
    for i, c in enumerate(clips):
        sp = float(c.get("speed", 1.0))
        dur = (c["end"] - c["start"]) / sp
        fade = min(0.015, dur / 4)
        tempo = f",atempo={sp:.4f}" if abs(sp - 1) > 1e-3 else ""
        parts.append(f"[1:a]atrim={c['start']:.4f}:{c['end']:.4f},asetpts=PTS-STARTPTS{tempo},afade=t=in:d={fade:.3f},afade=t=out:st={max(0, dur - fade):.3f}:d={fade:.3f}[a{i}]")
        labels.append(f"[a{i}]")
    parts.append(f"{''.join(labels)}concat=n={len(clips)}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:{total_s:.4f},afade=t=out:st={max(0, total_s - 0.35):.3f}:d=0.35[aout]")
    return ";".join(parts)


def render(session: Path, edl: dict, out: Path, width: int, height: int, overlay: bool) -> dict:
    video = session / "raw_video.mp4"
    audio = session / "audio.wav"
    info = probe(video)
    fps = 30.0
    w, h = info["w"], info["h"]
    cfg = json.loads((session / "config.json").read_text()) if (session / "config.json").exists() else {}
    css_w = (cfg.get("browser", {}).get("viewport") or [360, 640])[0]
    touches = Touches(session / "actions.jsonl", w / css_w) if overlay else None
    radius = w * 0.042
    clips = edl["clips"]
    out_frames_total = sum(int(round((c["end"] - c["start"]) / float(c.get("speed", 1.0)) * fps)) for c in clips)
    total_s = out_frames_total / fps
    has_audio = audio.exists()
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(int(fps)), "-i", "-"]
    if has_audio:
        cmd += ["-i", str(audio), "-filter_complex", build_audio_filter(clips, total_s), "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    cmd += ["-vf", f"scale={width}:{height}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "18",
            "-r", str(int(fps)), "-g", str(int(fps)), "-movflags", "+faststart", str(out)]
    out.parent.mkdir(parents=True, exist_ok=True)
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    written = 0
    src_map = []  # output frame -> source frame (for the evaluator and the trace)
    for c in clips:
        sp = float(c.get("speed", 1.0))
        f0 = int(round(c["start"] * fps))
        f1 = int(round(c["end"] * fps))
        n_out = int(round((c["end"] - c["start"]) / sp * fps))
        frames = read_frames(video, f0, max(1, f1 - f0 + 1), w, h, info["fps"])
        if not frames:
            raise RuntimeError(f"no frames decoded for clip {c}")
        for k in range(n_out):
            sf = min(len(frames) - 1, int(round(k * sp)))
            arr = frames[sf]
            if touches is not None:
                im = Image.fromarray(arr).convert("RGB")
                touches.draw(im, f0 + sf, radius)
                arr = np.asarray(im)
            enc.stdin.write(np.ascontiguousarray(arr).tobytes())
            src_map.append(f0 + sf)
            written += 1
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError("ffmpeg encode failed")
    return {"out": str(out), "frames": written, "duration": round(written / fps, 3), "has_audio": has_audio, "src_map": src_map}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("edl")
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=1080)
    ap.add_argument("--height", type=int, default=1920)
    ap.add_argument("--no-overlay", action="store_true")
    a = ap.parse_args()
    res = render(Path(a.session), json.loads(Path(a.edl).read_text()), Path(a.out), a.width, a.height, not a.no_overlay)
    Path(a.out).with_suffix(".map.json").write_text(json.dumps(res["src_map"]))
    res.pop("src_map")
    print(json.dumps(res))
