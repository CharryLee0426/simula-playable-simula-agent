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
        self.shot_ms: list[float] = []

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
        cfg = {"seed": int(p.get("seed", 1)), "fps": fps, "frozen": bool(p.get("frozen", True))}
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
            os.environ["DISPLAY"] = disp
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
            last = await self.page.evaluate("__sim.step(1)")
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
        await self.cdp.send("Input.dispatchTouchEvent", {"type": cdp_type, "touchPoints": points})
        self.touch_active = typ in ("start", "move")
        return {"ok": True}

    async def mouse(self, p: dict) -> dict:
        typ = p["type"]  # down | move | up
        x, y = float(p.get("x", 0)), float(p.get("y", 0))
        t = {"down": "mousePressed", "move": "mouseMoved", "up": "mouseReleased"}[typ]
        params = {"type": t, "x": x, "y": y, "button": "left" if typ != "move" else ("left" if self.touch_active else "none"), "clickCount": 1}
        if typ == "move" and self.touch_active:
            params["buttons"] = 1
        await self.cdp.send("Input.dispatchMouseEvent", params)
        self.touch_active = typ in ("down",) or (typ == "move" and self.touch_active)
        if typ == "up":
            self.touch_active = False
        return {"ok": True}

    async def key(self, p: dict) -> dict:
        await self.page.keyboard.press(p["key"])
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
        data = await self.page.evaluate("__sim.exportAudio([])")
        adir = self.run_dir / "audio"
        adir.mkdir(exist_ok=True)
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
        (adir / "audio_log.json").write_text(json.dumps(manifest))
        return {"starts": sum(1 for e in data["log"] if e["op"] in ("start", "media_play", "osc")), "buffers": len(bufs), "media": len(media)}


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
