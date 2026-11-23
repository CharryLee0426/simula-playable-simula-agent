"""Offline mix of a session's game audio, in game time, on a 48 kHz stereo timeline in sync with the 30 fps video.

The game ran on a virtual clock, so the browser's real-time audio output means nothing (and it is muted).

Web Audio: the browser itself rendered the game's audio graph over the whole session (shim.js, "render" audio), so
envelopes, filters, compressors and pitch sweeps sound exactly as they do for a player. The render is in the audio
context's own time; `runs` says where each stretch of it (between suspend/resume) falls in game time.

<audio> elements, and Web Audio in the "log" fallback, come from the shim's event log: each sound is decoded with
ffmpeg and placed at its game-time position (media volume changes are followed). The fallback reads each sound's
gain once at its start and reproduces no envelopes or effects, so synthesized SFX come out flat and loud.

    python -m simbrowser.audio <session_dir> <duration_s>   ->  <session_dir>/audio.wav
"""
from __future__ import annotations

import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000


def decode(path: Path) -> np.ndarray | None:
    """Any container/codec ffmpeg reads -> float32 (n, 2) at SR."""
    try:
        r = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                           capture_output=True, timeout=120)
        if r.returncode != 0 or not r.stdout:
            return None
        return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).copy()
    except Exception:
        return None


def decode_f32(path: Path, rate: int) -> np.ndarray:
    """Interleaved stereo float32 at `rate` -> float32 (n, 2) at SR (ffmpeg's resampler when the rates differ)."""
    if rate == SR:
        return np.fromfile(path, dtype="<f4").reshape(-1, 2)
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(rate), "-ac", "2", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                       capture_output=True, timeout=300, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).copy()


def from_pcm(path: Path, rate: int) -> np.ndarray:
    arr = np.load(path).astype(np.float32) / 32767.0  # (channels, n)
    if arr.ndim == 1:
        arr = arr[None, :]
    st = np.stack([arr[0], arr[1] if arr.shape[0] > 1 else arr[0]], axis=1)
    if rate != SR and len(st) > 1:
        n = int(len(st) * SR / rate)
        x = np.linspace(0, len(st) - 1, n)
        st = np.stack([np.interp(x, np.arange(len(st)), st[:, c]) for c in range(2)], axis=1).astype(np.float32)
    return st


def resample_rate(seg: np.ndarray, rate: float) -> np.ndarray:
    if abs(rate - 1.0) < 1e-3 or len(seg) < 2:
        return seg
    n = max(1, int(len(seg) / rate))
    x = np.linspace(0, len(seg) - 1, n)
    return np.stack([np.interp(x, np.arange(len(seg)), seg[:, c]) for c in range(2)], axis=1).astype(np.float32)


def place(mix: np.ndarray, sig: np.ndarray, t: float, gain: float | np.ndarray = 1.0):
    i0 = int(round(t * SR))
    if i0 >= len(mix) or len(sig) == 0:
        return
    if i0 < 0:
        sig = sig[-i0:]
        if isinstance(gain, np.ndarray):
            gain = gain[-i0:]
        i0 = 0
    n = min(len(sig), len(mix) - i0)
    g = gain[:n, None] if isinstance(gain, np.ndarray) else gain
    mix[i0:i0 + n] += sig[:n] * g


def fade_edges(sig: np.ndarray, ms: float = 4.0) -> np.ndarray:
    k = min(len(sig) // 2, int(SR * ms / 1000))
    if k > 1:
        ramp = np.linspace(0, 1, k, dtype=np.float32)[:, None]
        sig = sig.copy()
        sig[:k] *= ramp
        sig[-k:] *= ramp[::-1]
    return sig


def osc_wave(kind: str, freq: float, n: int) -> np.ndarray:
    t = np.arange(n, dtype=np.float32) / SR
    ph = (t * freq) % 1.0
    if kind == "square":
        w = np.where(ph < 0.5, 1.0, -1.0)
    elif kind == "sawtooth":
        w = 2 * ph - 1
    elif kind == "triangle":
        w = 4 * np.abs(ph - 0.5) - 1
    else:
        w = np.sin(2 * np.pi * ph)
    w = (w * 0.5).astype(np.float32)
    return np.stack([w, w], axis=1)


def mix_session(session: Path, duration: float) -> dict:
    adir = session / "audio"
    man_path = adir / "audio_log.json"
    stats = {"sounds": 0, "skipped": 0, "has_audio": False}
    if not man_path.exists():
        return stats
    man = json.loads(man_path.read_text())
    log = man["log"]
    n_total = int(duration * SR) + SR
    mix = np.zeros((n_total, 2), dtype=np.float32)
    cache: dict[str, np.ndarray | None] = {}

    def load_buf(bid: int) -> np.ndarray | None:
        key = f"b{bid}"
        if key not in cache:
            b = next((x for x in man["buffers"] if x["id"] == bid), None)
            if b is None:
                cache[key] = None
            elif b["kind"] == "encoded":
                cache[key] = decode(adir / b["file"])
            else:
                cache[key] = from_pcm(adir / b["file"], int(b.get("rate", SR)))
        return cache[key]

    def load_media(mid: int) -> np.ndarray | None:
        key = f"m{mid}"
        if key not in cache:
            m = next((x for x in man["media"] if x["id"] == mid), None)
            cache[key] = decode(adir / m["file"]) if m and m.get("file") else None
        return cache[key]

    def stop_time(i: int, node: int, t: float) -> float:
        for e in log[i + 1:]:
            if e.get("node") == node and e["op"] == "stop" and e["t"] >= t - 1e-6:
                return e["t"]
            if e.get("node") == node and e["op"] in ("start", "media_play") and e["t"] > t:
                return e["t"]
        return duration

    wa = man.get("webaudio") or {}
    if wa.get("file") and (adir / wa["file"]).exists():
        try:
            pcm = decode_f32(adir / wa["file"], int(wa.get("rate", SR)))
            for c0, v0, v1 in wa.get("runs", []):
                seg = pcm[int(round(c0 * SR)): int(round((c0 + max(0.0, v1 - v0)) * SR))]
                if len(seg):
                    place(mix, fade_edges(seg, 2.0), v0)
            stats["webaudio_sources"] = int(wa.get("sources", 0))
            stats["sounds"] += int(wa.get("sources", 0))
        except Exception as ex:
            stats.setdefault("errors", []).append(f"webaudio: {ex}"[:200])
    elif wa.get("error"):
        stats.setdefault("errors", []).append(f"webaudio: {wa['error']}"[:200])

    for i, e in enumerate(log):
        op = e["op"]
        try:
            if op == "start":
                buf = load_buf(e["buf"])
                gain = float(min(2.0, max(0.0, e.get("gain", 1.0))))
                if buf is None or gain <= 1e-4:
                    stats["skipped"] += 1
                    continue
                t, rate = e["t"], float(e.get("rate", 1.0) or 1.0)
                end = stop_time(i, e["node"], t)
                off = int(max(0.0, e.get("offset", 0.0)) * SR)
                if e.get("loop"):
                    ls = int((e.get("loopStart") or 0) * SR)
                    le = int((e.get("loopEnd") or 0) * SR) or len(buf)
                    loop_seg = buf[ls:le] if le > ls else buf
                    need = int((end - t) * SR * rate) + 1
                    head = buf[off:le] if off < le else loop_seg
                    reps = max(0, int(np.ceil((need - len(head)) / max(1, len(loop_seg)))))
                    seg = np.concatenate([head] + [loop_seg] * reps)[:need] if reps else head[:need]
                else:
                    seg = buf[off:]
                    if e.get("duration") is not None:
                        seg = seg[: int(e["duration"] * SR)]
                seg = resample_rate(seg, rate)
                seg = seg[: max(0, int((end - t) * SR))]
                place(mix, fade_edges(seg), t, gain)
                stats["sounds"] += 1
            elif op == "media_play":
                buf = load_media(e["media"])
                if buf is None:
                    stats["skipped"] += 1
                    continue
                t = e["t"]
                end = stop_time(i, e["node"], t)
                start = int(max(0.0, e.get("at", 0.0)) * SR)
                need = int((end - t) * SR)
                if e.get("loop") and len(buf) > 0:
                    src = np.concatenate([buf[start:]] + [buf] * (need // max(1, len(buf)) + 1))[:need]
                else:
                    src = buf[start:start + need]
                # volume envelope from media_volume events between t and end
                vols = [(x["t"], x["volume"]) for x in log if x.get("node") == e["node"] and x["op"] == "media_volume" and t <= x["t"] <= end]
                env = np.full(len(src), float(e.get("volume", 1.0)), dtype=np.float32)
                for vt, vv in vols:
                    k = int((vt - t) * SR)
                    if 0 <= k < len(env):
                        env[k:] = vv
                place(mix, fade_edges(src), t, env)
                stats["sounds"] += 1
            elif op == "osc":
                gain = float(min(1.0, max(0.0, e.get("gain", 0.3))))
                if gain <= 1e-4:
                    continue
                t = e["t"]
                end = min(stop_time(i, e["node"], t), t + 3.0)
                n = int((end - t) * SR)
                if n > 0:
                    place(mix, fade_edges(osc_wave(e.get("type", "sine"), float(e.get("freq", 440)), n), 8), t, min(gain, 0.4))
                    stats["sounds"] += 1
        except Exception as ex:  # one bad sound never breaks the mix
            stats["skipped"] += 1
            stats.setdefault("errors", []).append(f"{op}: {ex}"[:200])

    mix = mix[: int(duration * SR)]
    peak = float(np.max(np.abs(mix))) if len(mix) else 0.0
    if peak > 0.89:
        mix *= 0.89 / peak  # headroom; loudness is normalized when the highlight is cut
    stats["has_audio"] = peak > 1e-4
    stats["peak"] = round(peak, 3)
    if stats["has_audio"]:
        pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
        with wave.open(str(session / "audio.wav"), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        # per-100ms RMS (dB) for the indexer
        hop = SR // 10
        rms = [float(np.sqrt(np.mean(mix[i:i + hop] ** 2)) + 1e-9) for i in range(0, len(mix), hop)]
        (session / "audio_rms.json").write_text(json.dumps([round(20 * np.log10(x), 1) for x in rms]))
    return stats


def mux_raw(session: Path, has_audio: bool) -> Path:
    video = session / "raw_video.mp4"
    out = session / "raw.mp4"
    if has_audio:
        cmd = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-i", str(session / "audio.wav"), "-map", "0:v", "-map", "1:a",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", str(out)]
    else:
        cmd = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-c:v", "copy", str(out)]
    subprocess.run(cmd, check=True)
    return out


if __name__ == "__main__":
    s = Path(sys.argv[1])
    st = mix_session(s, float(sys.argv[2]))
    mux_raw(s, st["has_audio"])
    print(json.dumps(st))
