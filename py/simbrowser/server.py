"""Browser worker: one playable, one Chromium page, driven over JSON lines on stdin/stdout.

The TypeScript agent owns the decisions; this process owns the browser, the virtual clock and the recording.
Every method is synchronous from the caller's point of view (one request, one response), so the agent's view of
game time is exact: nothing moves between two `step` calls.

Protocol: request  {"id": 1, "method": "open", "params": {...}}
          response {"id": 1, "result": {...}}  or  {"id": 1, "error": "message"}
Logs go to stderr.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

try:  # as a module (python -m simbrowser.server) or from tests that put py/ on the path
    from simbrowser.track import Tracker, shift_zone, to_small_gray
except ImportError:  # pragma: no cover
    from .track import Tracker, shift_zone, to_small_gray

HERE = Path(__file__).resolve().parent
SHIM = (HERE / "shim.js").read_text()

CHROME_ARGS = [
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
]


def log(*a):
    print("[worker]", *a, file=sys.stderr, flush=True)


def thumb_from_jpeg(data: bytes, size=(72, 128)) -> np.ndarray:
    im = Image.open(io.BytesIO(data))
    im.draft("L", (size[0] * 2, size[1] * 2))
    return np.asarray(im.convert("L").resize(size, Image.BILINEAR), dtype=np.float32)


class Recorder:
    """Pipes JPEG frames into ffmpeg (30 fps, H.264) and keeps per-frame motion/luma stats."""

    def __init__(self, out: Path, fps: int, width: int, height: int):
        self.out = out
        self.fps = fps
        self.size = (width, height)
        self.frames = 0
        self.stats: list[dict] = []
        self.prev: np.ndarray | None = None
        self.last_jpeg: bytes | None = None
        self.proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
             "-vf", f"scale={width}:{height}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "17", "-g", str(fps), "-r", str(fps), str(out)],
            stdin=subprocess.PIPE,
        )

    def add(self, jpeg: bytes, t_ms: float):
        self.proc.stdin.write(jpeg)
        self.last_jpeg = jpeg
        th = thumb_from_jpeg(jpeg)
        motion = float(np.mean(np.abs(th - self.prev)) / 255.0) if self.prev is not None else 0.0
        self.prev = th
        self.stats.append({"f": self.frames, "t": round(t_ms / 1000.0, 4), "motion": round(motion, 5), "luma": round(float(th.mean()) / 255.0, 4)})
        self.frames += 1

    def repeat_last(self, n: int, t_ms: float, dt_ms: float):
        for i in range(n):
            if self.last_jpeg is None:
                return
            self.add(self.last_jpeg, t_ms + i * dt_ms)

    def close(self):
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait(timeout=600)


class Worker:
    def __init__(self):
        self.pw = None
        self.browser = None
        self.page = None
        self.cdp = None
        self.rec: Recorder | None = None
        self.run_dir: Path | None = None
        self.cfg: dict = {}
        self.prev_obs: np.ndarray | None = None
        self.obs_n = 0
        self.touch_active = False
        self.console: list[str] = []
        self.step_ms: list[float] = []
        self.tracker: Tracker | None = None
        self.flash_scan = 0  # recorder frame index up to which hit flashes were scanned
        self.freeze_scan = 0  # ... and sudden freezes
        self.frozen = False
        self.shot_ms: list[float] = []
        self.input_sent = {"touch": 0, "mouse": 0}  # events sent that Chrome hands to the page: a step waits until it has them
        self.pointer_at: tuple[float, float] | None = None  # where the last touch/mouse event left the pointer

    # ------------------------------------------------------------------ lifecycle
    async def open(self, p: dict) -> dict:
        self.cfg = p
        self.run_dir = Path(p["run_dir"])
        (self.run_dir / "obs").mkdir(parents=True, exist_ok=True)
        vw, vh = p.get("viewport", [360, 640])
        dpr = float(p.get("dpr", 2))
        fps = int(p.get("fps", 30))
        self.pw = await async_playwright().start()
        headless = self._display(p.get("display", "auto"))
        self.browser = await self.pw.chromium.launch(args=CHROME_ARGS + [f"--window-size={vw},{vh + 120}"], headless=headless,
                                                     env=dict(os.environ, DISPLAY=os.environ.get("DISPLAY", "")) if not headless else None)
        self.gl_renderer = None
        ctx = await self.browser.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=dpr, is_mobile=True, has_touch=True,
                                             user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")
        cfg = {"seed": int(p.get("seed", 1)), "fps": fps, "frozen": bool(p.get("frozen", True)),
               "audio": str(p.get("audio", "render")), "audioMaxS": float(p.get("audio_max_s", 300)),
               "assetStallMs": float(p.get("asset_stall_ms", 10000))}
        await ctx.add_init_script(script=f"window.__SIM_CFG = {json.dumps(cfg)};\n{SHIM}")

        async def route(r):
            url = r.request.url
            if url.startswith(("file:", "data:", "blob:")):
                await r.continue_()
            else:
                await r.abort("internetdisconnected")

        await ctx.route("**/*", route)
        self.page = await ctx.new_page()
        self.page.on("console", lambda m: self.console.append(f"{m.type}: {m.text[:300]}") if len(self.console) < 400 else None)
        self.page.on("pageerror", lambda e: self.console.append(f"pageerror: {str(e)[:300]}") if len(self.console) < 400 else None)
        self.page.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
        self.cdp = await ctx.new_cdp_session(self.page)
        out_w, out_h = int(round(vw * dpr)), int(round(vh * dpr))
        if p.get("record", True):
            self.rec = Recorder(self.run_dir / "raw_video.mp4", fps, out_w, out_h)
        t0 = time.time()
        playable = Path(p["playable"]).resolve()
        await self.page.goto(playable.as_uri(), wait_until="load", timeout=120_000)
        summary = await self.page.evaluate("__sim.summary()")
        try:
            self.gl_renderer = await self.page.evaluate("""() => { const c=document.createElement('canvas'); const gl=c.getContext('webgl2')||c.getContext('webgl');
                if(!gl) return null; const d=gl.getExtension('WEBGL_debug_renderer_info'); return d? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }""")
        except Exception:
            pass
        return {"load_s": round(time.time() - t0, 2), "frame_size": [out_w, out_h], "gl": self.gl_renderer, "summary": summary}

    def _display(self, mode: str) -> bool:
        """Returns `headless`. Headed Chrome on a virtual X display renders WebGL with Mesa llvmpipe (multi-threaded),
        about 3-4x faster than headless SwiftShader on CPU-only machines; on a desktop with a GPU, headed uses it."""
        if mode == "headless":
            return True
        if os.environ.get("DISPLAY") or sys.platform == "darwin" or sys.platform == "win32":
            return False if mode in ("auto", "headed", "xvfb") else True
        if mode in ("auto", "xvfb") and shutil.which("Xvfb"):
            disp = f":{90 + (os.getpid() % 500)}"
            self.xvfb = subprocess.Popen(["Xvfb", disp, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.6)
            os.environ["DISPLAY"] = self.xvfb_display = disp
            return False
        return True

    async def close(self, p: dict) -> dict:
        out: dict = {}
        if self.page:
            try:
                out["audio"] = await self.export_audio()
            except Exception as e:  # never lose the video because of audio
                out["audio_error"] = str(e)
            try:
                out["summary"] = await self.page.evaluate("__sim.summary()")
                out["events"] = await self.page.evaluate("__sim.events")
            except Exception as e:
                out["summary_error"] = str(e)
        if self.rec:
            self.rec.close()
            (self.run_dir / "frames.jsonl").write_text("\n".join(json.dumps(s) for s in self.rec.stats) + "\n")
            out["frames"] = self.rec.frames
            out["raw_video"] = str(self.rec.out)
        (self.run_dir / "console.log").write_text("\n".join(self.console))
        out["perf"] = {"step_ms_avg": round(float(np.mean(self.step_ms)), 1) if self.step_ms else None,
                       "shot_ms_avg": round(float(np.mean(self.shot_ms)), 1) if self.shot_ms else None}
        if self.browser:
            await self.browser.close()
        if self.pw:
            await self.pw.stop()
        if getattr(self, "xvfb", None):
            self.xvfb.terminate()
            try:
                self.xvfb.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.xvfb.kill()
            self.xvfb = None
            if os.environ.get("DISPLAY") == getattr(self, "xvfb_display", None):
                os.environ.pop("DISPLAY")  # a later worker in this process starts its own display
        self.page = None
        return out

    # ------------------------------------------------------------------ time
    async def _shot(self, quality: int = 88, scale: float | None = None) -> bytes:
        t = time.time()
        params = {"format": "jpeg", "quality": quality, "optimizeForSpeed": True}
        if scale:
            vw, vh = self.cfg.get("viewport", [360, 640])
            params["clip"] = {"x": 0, "y": 0, "width": vw, "height": vh, "scale": scale}
        r = await self.cdp.send("Page.captureScreenshot", params)
        self.shot_ms.append((time.time() - t) * 1000)
        return base64.b64decode(r["data"])

    async def step(self, p: dict) -> dict:
        n = int(p.get("frames", 1))
        capture = bool(p.get("capture", True)) and self.rec is not None
        last = {}
        for _ in range(n):
            t = time.time()
            last = await self.page.evaluate(f"__sim.step(1, {json.dumps(self.input_sent)})")
            self.input_sent = dict(last.get("input") or self.input_sent)  # what the page received (resync after a drop)
            self.step_ms.append((time.time() - t) * 1000)
            if capture:
                self.rec.add(await self._shot(), last["now"])
        return {"now": last.get("now"), "frame": last.get("frame"), "recorded": self.rec.frames if self.rec else 0}

    # ------------------------------------------------------------------ input
    async def touch(self, p: dict) -> dict:
        typ = p["type"]  # start | move | end | cancel
        x, y = float(p.get("x", 0)), float(p.get("y", 0))
        cdp_type = {"start": "touchStart", "move": "touchMove", "end": "touchEnd", "cancel": "touchCancel"}[typ]
        points = [] if typ in ("end", "cancel") else [{"x": x, "y": y, "radiusX": 6, "radiusY": 6, "force": 0.6, "id": 0}]
        if typ == "move" and self.pointer_at == (x, y):
            return {"ok": True, "same_point": True}  # Chrome drops a move that goes nowhere
        await self.cdp.send("Input.dispatchTouchEvent", {"type": cdp_type, "touchPoints": points})
        self.touch_active = typ in ("start", "move")
        self.pointer_at = (x, y) if self.touch_active else None
        self.input_sent["touch"] += 1
        return {"ok": True}

    async def mouse(self, p: dict) -> dict:
        typ = p["type"]  # down | move | up
        x, y = float(p.get("x", 0)), float(p.get("y", 0))
        t = {"down": "mousePressed", "move": "mouseMoved", "up": "mouseReleased"}[typ]
        params = {"type": t, "x": x, "y": y, "button": "left" if typ != "move" else ("left" if self.touch_active else "none"), "clickCount": 1}
        if typ == "move" and self.touch_active:
            params["buttons"] = 1
        if typ == "move" and self.pointer_at == (x, y):
            return {"ok": True, "same_point": True}
        await self.cdp.send("Input.dispatchMouseEvent", params)
        self.pointer_at = (x, y)
        self.input_sent["mouse"] += 1
        self.touch_active = typ in ("down",) or (typ == "move" and self.touch_active)
        if typ == "up":
            self.touch_active = False
        return {"ok": True}

    async def key(self, p: dict) -> dict:
        await self.page.keyboard.press(p["key"])  # acknowledged once the page has handled it
        return {"ok": True}

    async def ops(self, p: dict) -> dict:
        """A batch of {op: touch|mouse|step|key, ...} executed in order (one round trip for a whole gesture)."""
        last = {}
        for op in p["ops"]:
            kind = op["op"]
            if kind == "step":
                last = await self.step({"frames": op.get("frames", 1), "capture": op.get("capture", True)})
            elif kind == "touch":
                await self.touch(op)
            elif kind == "mouse":
                await self.mouse(op)
            elif kind == "key":
                await self.key(op)
        return last or {"now": await self.page.evaluate("__sim.now")}

    # ------------------------------------------------------------------ observation
    async def observe(self, p: dict) -> dict:
        """Screenshot for the model (small JPEG on disk) + change vs the previous observation + page summary."""
        width = int(p.get("width", 360))
        vw, vh = self.cfg.get("viewport", [360, 640])
        jpeg = await self._shot(quality=int(p.get("quality", 70)), scale=width / vw)
        self.obs_n += 1
        path = self.run_dir / "obs" / f"obs_{self.obs_n:04d}.jpg"
        path.write_bytes(jpeg)
        th = thumb_from_jpeg(jpeg)
        change = float(np.mean(np.abs(th - self.prev_obs)) / 255.0) if self.prev_obs is not None else 1.0
        changed_frac = float(np.mean(np.abs(th - self.prev_obs) > 18)) if self.prev_obs is not None else 1.0
        self.prev_obs = th
        res = {"path": str(path), "n": self.obs_n, "change": round(change, 4), "changed_frac": round(changed_frac, 4),
               "luma": round(float(th.mean()) / 255.0, 3), "summary": await self.page.evaluate("__sim.summary()")}
        if p.get("dom", True):
            res["dom"] = await self.page.evaluate("__sim.domCandidates(40)")
            if p.get("marks", True) and res["dom"]:
                res["marks_path"] = str(self._draw_marks(jpeg, res["dom"], width / vw, path))
        return res

    def _draw_marks(self, jpeg: bytes, dom: list, scale: float, path: Path) -> Path:
        """Set-of-marks: numbered tags on interactive DOM elements, so the model can answer "tap 7" exactly."""
        from PIL import ImageDraw
        im = Image.open(io.BytesIO(jpeg)).convert("RGB")
        d = ImageDraw.Draw(im, "RGBA")
        for i, c in enumerate(dom, 1):
            x0, y0, x1, y1 = c["x"] * scale, c["y"] * scale, (c["x"] + c["w"]) * scale, (c["y"] + c["h"]) * scale
            d.rectangle([x0, y0, x1, y1], outline=(255, 40, 160, 200), width=1)
            tag = str(i)
            tw = 7 * len(tag) + 4
            d.rectangle([x0, y0, x0 + tw, y0 + 12], fill=(255, 40, 160, 230))
            d.text((x0 + 2, y0), tag, fill=(255, 255, 255, 255))
        out = path.with_name(path.stem + "_marks.jpg")
        im.save(out, quality=80)
        return out

    async def peek(self, p: dict) -> dict:
        """A quick screenshot for a frame-by-frame check (timing actions); does not move the observation baseline."""
        width = int(p.get("width", 360))
        vw, vh = self.cfg.get("viewport", [360, 640])
        zone = p.get("zone")  # [y0, x0, y1, x1] normalized 0-1000: an attention window, e.g. the area just ahead of the player
        if zone:
            y0, x0, y1, x1 = [float(v) / 1000.0 for v in zone]
            clip = {"x": x0 * vw, "y": y0 * vh, "width": max(8.0, (x1 - x0) * vw), "height": max(8.0, (y1 - y0) * vh)}
            clip["scale"] = min(2.0, width / clip["width"])
            t = time.time()
            r = await self.cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": int(p.get("quality", 70)), "optimizeForSpeed": True, "clip": clip})
            self.shot_ms.append((time.time() - t) * 1000)
            jpeg = base64.b64decode(r["data"])
        else:
            jpeg = await self._shot(quality=int(p.get("quality", 65)), scale=width / vw)
        path = self.run_dir / "obs" / ("peek_zone.jpg" if zone else "peek.jpg")
        path.write_bytes(jpeg)
        return {"path": str(path), "frame": await self.page.evaluate("__sim.frame")}

    # ------------------------------------------------------------------ player tracking (reflex attention zones)
    async def _grab_rgb(self) -> np.ndarray:
        t = time.time()
        r = await self.cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 82, "optimizeForSpeed": True})
        self.shot_ms.append((time.time() - t) * 1000)
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(r["data"]))).convert("RGB"))

    async def track_init(self, p: dict) -> dict:
        """Start following the player-controlled object at point [y, x] (0-1000), box size [h, w] (0-1000)."""
        rgb = await self._grab_rgb()
        g = to_small_gray(rgb)
        gh, gw = g.shape
        py, px = [float(v) for v in p["point"]]
        sh, sw = [float(v) for v in p.get("size", [100, 140])]
        self.tracker = Tracker(g, (px / 1000 * gw, py / 1000 * gh), (sw / 1000 * gw, sh / 1000 * gh))
        # a picture of what is being tracked, for the trace
        h, w = rgb.shape[:2]
        y0, y1 = int(max(0, (py - sh / 2) / 1000 * h)), int(min(h, (py + sh / 2) / 1000 * h))
        x0, x1 = int(max(0, (px - sw / 2) / 1000 * w)), int(min(w, (px + sw / 2) / 1000 * w))
        tpath = self.run_dir / "obs" / f"track_{int(time.time() * 1000) % 10_000_000}.jpg"
        Image.fromarray(rgb[y0:y1, x0:x1]).save(tpath, quality=85)
        return {"player": [py, px], "template": str(tpath)}

    async def peek_track(self, p: dict) -> dict:
        """One screenshot per reflex check: update the player track, crop the attention zone moved with the player,
        optionally save a full-screen copy (for the periodic "anything new?" look)."""
        rgb = await self._grab_rgb()
        h, w = rgb.shape[:2]
        out: dict = {"frame": await self.page.evaluate("__sim.frame"), "impacts": self._impacts()}
        dx = dy = 0.0
        if self.tracker is not None:
            cx, cy, conf = self.tracker.update(to_small_gray(rgb))
            dx, dy = self.tracker.displacement()
            out["player"] = [round(cy / self.tracker.h * 1000, 1), round(cx / self.tracker.w * 1000, 1)]
            out["conf"] = round(conf, 3)
            out["delta"] = [round(dy * 1000, 1), round(dx * 1000, 1)]
        if p.get("zone"):
            z = shift_zone([float(v) for v in p["zone"]], dx, dy) if p.get("follow", True) else [float(v) for v in p["zone"]]
            out["zone"] = [round(v, 1) for v in z]
            y0, x0, y1, x1 = z
            crop = Image.fromarray(rgb[int(y0 / 1000 * h):int(y1 / 1000 * h), int(x0 / 1000 * w):int(x1 / 1000 * w)])
            maxw = int(p.get("width", 480))
            if crop.width > maxw:
                crop = crop.resize((maxw, max(8, int(crop.height * maxw / crop.width))), Image.BILINEAR)
            path = self.run_dir / "obs" / "peek_zone.jpg"
            crop.save(path, quality=80)
            out["path"] = str(path)
        if p.get("full") or not p.get("zone"):
            full = Image.fromarray(rgb).resize((360, int(360 * h / w)), Image.BILINEAR)
            fpath = self.run_dir / "obs" / "peek.jpg"
            full.save(fpath, quality=70)
            out["full_path"] = str(fpath)
            out.setdefault("path", str(fpath))
        return out

    def _impacts(self) -> list[dict]:
        """Hit candidates recorded since the last scan, two generic signatures of an impact (frames in game frames):
        "flash" — on-screen change spikes well above the recent baseline together with a jump in brightness (the
        flash/shake games use to sell an impact; pickups flash too); "freeze" — the screen of a moving game suddenly
        stops for 5+ frames (a crash/revive popup pauses the world; so do tutorial prompts). The caller confirms both."""
        if not self.rec:
            return []
        st, fps = self.rec.stats, self.rec.fps
        gf = lambda s: int(round(s["t"] * fps))
        out = []
        for i in range(max(self.flash_scan, 15), len(st)):
            prev = st[i - 15:i]
            base = float(np.median([x["motion"] for x in prev]))
            lbase = float(np.median([x["luma"] for x in prev]))
            m, dl = st[i]["motion"], st[i]["luma"] - lbase
            if m > 0.03 and m > 2.5 * max(base, 0.004) and dl >= 0.04:
                out.append({"kind": "flash", "f": gf(st[i]), "t": st[i]["t"], "motion": round(m, 4), "dl": round(dl, 3)})
        self.flash_scan = len(st)
        hold = 5
        for i in range(max(self.freeze_scan, 30), len(st) - hold + 1):
            base = float(np.median([x["motion"] for x in st[i - 30:i]]))
            fz = base >= 0.004 and all(x["motion"] < 0.25 * base and x["motion"] < 0.003 for x in st[i:i + hold])
            if fz and not self.frozen:
                out.append({"kind": "freeze", "f": gf(st[i]), "t": st[i]["t"], "motion": round(base, 4)})
            if fz:
                self.frozen = True
            elif st[i]["motion"] >= 0.004:
                self.frozen = False
        self.freeze_scan = max(self.freeze_scan, len(st) - hold + 1)
        return sorted(out, key=lambda x: x["f"])

    async def impacts(self, p: dict) -> dict:
        return {"impacts": self._impacts()}

    async def impact_onset(self, p: dict) -> dict:
        """When did an impact that a periodic look noticed late happen (game frames, at or after `since_f`)? Where the
        screen froze (walking back from now while change stays well below the earlier baseline), else the biggest
        spike of change, else unknown."""
        if not self.rec or not self.rec.stats:
            return {"f": None}
        st, fps = self.rec.stats, self.rec.fps
        gf = lambda s: int(round(s["t"] * fps))
        since = int(p.get("since_f", 0))
        i0 = next((i for i, x in enumerate(st) if gf(x) >= since), len(st))
        if i0 >= len(st):
            return {"f": None}
        base = float(np.median([x["motion"] for x in st[max(0, i0 - 30):i0]])) if i0 > 0 else 0.0
        if base >= 0.003:
            j = len(st) - 1
            while j >= i0 and st[j]["motion"] < 0.35 * base:
                j -= 1
            if j < i0:
                return {"f": None}  # already still at `since_f`: the impact is not in this window
            if len(st) - 1 - j >= 4:
                return {"f": gf(st[j + 1]), "how": "freeze"}
        best = max(range(i0, len(st)), key=lambda i: st[i]["motion"])
        local = float(np.median([x["motion"] for x in st[max(0, best - 15):best]])) if best > 0 else 0.0
        if st[best]["motion"] > 2.5 * max(local, 0.004):
            return {"f": gf(st[best]), "how": "spike"}
        return {"f": None}

    async def track_stop(self, p: dict) -> dict:
        self.tracker = None
        return {"ok": True}

    async def motion_probe(self, p: dict) -> dict:
        """Change between now and after `frames` more frames, without moving the observation baseline."""
        a = thumb_from_jpeg(await self._shot(quality=60, scale=0.25))
        await self.step({"frames": int(p.get("frames", 6)), "capture": bool(p.get("capture", True))})
        b = thumb_from_jpeg(await self._shot(quality=60, scale=0.25))
        return {"change": round(float(np.mean(np.abs(a - b)) / 255.0), 4), "changed_frac": round(float(np.mean(np.abs(a - b) > 18)), 4)}

    async def eval(self, p: dict) -> dict:
        return {"value": await self.page.evaluate(p["expr"])}

    # ------------------------------------------------------------------ audio
    async def export_audio(self) -> dict:
        adir = self.run_dir / "audio"
        adir.mkdir(exist_ok=True)
        try:
            webaudio = await self.render_webaudio(adir)
        except Exception as e:  # the media log is still worth having
            webaudio = {"error": str(e)[:300]}
        data = await self.page.evaluate("__sim.exportAudio([])")
        bufs = []
        for b in data["buffers"]:
            if b["kind"] == "encoded":
                (adir / f"buf_{b['id']}.bin").write_bytes(base64.b64decode(b["b64"]))
                bufs.append({"id": b["id"], "kind": "encoded", "file": f"buf_{b['id']}.bin", "duration": b.get("duration")})
            else:
                arr = np.asarray(b["pcm"], dtype=np.int16)
                np.save(adir / f"buf_{b['id']}.npy", arr)
                bufs.append({"id": b["id"], "kind": "pcm", "file": f"buf_{b['id']}.npy", "rate": b["rate"], "duration": b.get("duration")})
        media = []
        for m in data["media"]:
            src = m.get("src") or ""
            entry = {"id": m["id"], "src": src[:120]}
            if src.startswith("data:"):
                head, _, body = src.partition(",")
                (adir / f"media_{m['id']}.bin").write_bytes(base64.b64decode(body) if ";base64" in head else body.encode())
                entry["file"] = f"media_{m['id']}.bin"
            elif src.startswith("blob:"):
                try:
                    b64 = await self.page.evaluate("""async (u) => { const b = await (await fetch(u)).arrayBuffer(); let s=''; const a=new Uint8Array(b);
                        for (let i=0;i<a.length;i+=0x8000) s+=String.fromCharCode.apply(null,a.subarray(i,i+0x8000)); return btoa(s); }""", src)
                    (adir / f"media_{m['id']}.bin").write_bytes(base64.b64decode(b64))
                    entry["file"] = f"media_{m['id']}.bin"
                except Exception as e:
                    entry["error"] = str(e)[:200]
            media.append(entry)
        manifest = {"log": data["log"], "buffers": bufs, "media": media}
        if webaudio:
            manifest["webaudio"] = webaudio
        (adir / "audio_log.json").write_text(json.dumps(manifest))
        out = {"starts": sum(1 for e in data["log"] if e["op"] in ("start", "media_play", "osc")), "buffers": len(bufs), "media": len(media)}
        if webaudio:
            out["webaudio"] = {k: webaudio.get(k) for k in ("sources", "frames", "ms", "suspends", "truncated", "error") if webaudio.get(k)}
        return out

    async def render_webaudio(self, adir: Path) -> dict | None:
        """The game's Web Audio, rendered by the browser over the whole session (see shim.js, "render" audio):
        interleaved stereo float32 in audio/webaudio.f32, laid out in context time; `runs` maps it to game time."""
        info = await self.page.evaluate("__sim.renderAudio ? __sim.renderAudio() : null")
        if not info or info.get("error"):
            return info
        chunk = info["rate"] * 10
        with open(adir / "webaudio.f32", "wb") as f:
            for i0 in range(0, info["frames"], chunk):
                f.write(base64.b64decode(await self.page.evaluate("([a, n]) => __sim.audioChunk(a, n)", [i0, chunk])))
        return {**info, "file": "webaudio.f32", "channels": 2}


async def main():
    w = Worker()
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    out = sys.stdout
    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid, method, params = req.get("id"), req.get("method"), req.get("params") or {}
        try:
            fn = getattr(w, method)
            if method.startswith("_") or not callable(fn):
                raise AttributeError(method)
            result = await fn(params)
            out.write(json.dumps({"id": rid, "result": result}) + "\n")
        except Exception as e:
            log(traceback.format_exc())
            out.write(json.dumps({"id": rid, "error": f"{type(e).__name__}: {e}"}) + "\n")
        out.flush()
        if method == "close":
            break
    if w.page:
        try:
            await w.close({})
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
