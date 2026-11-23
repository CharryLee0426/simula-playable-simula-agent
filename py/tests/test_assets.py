"""Asset work in game time (shim.js section 1b): pictures, blobs, data:/blob: fetches, fonts and scripts finish on the
real clock but are delivered at a fixed frame, so a replay is the same game however fast the machine is.

One page requests each kind of work at known game times and logs, with the frame, when each result reaches it. The
page is played twice: as fast as possible, and with real-time pauses before the first steps (as a slow or busy
machine would). Both runs must see every result in the same frame.
"""
import asyncio
import tempfile
import time
import unittest
from pathlib import Path

from simbrowser.server import Worker

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

PAGE = """<!doctype html><html><body><script>
window.L = [];
const log = (m) => L.push([__sim.frame, m]);
const PNG = "%s";
// Before the first frame (page load).
const img = new Image(); img.onload = () => log("img.onload"); img.addEventListener("load", () => log("img.once"), { once: true }); img.src = PNG;
fetch(PNG).then((r) => { log("fetch"); return r.blob(); }).then((b) => { log("blob"); return createImageBitmap(b); }).then((bm) => log("bitmap " + bm.width));
fetch("data:application/octet-stream;base64," + "AAAA".repeat(2e6)).then((r) => r.arrayBuffer()).then((b) => log("8 MB " + b.byteLength));
const s = document.createElement("script"); s.onload = () => log("script.onload");
s.src = URL.createObjectURL(new Blob(['log("script ran")'], { type: "text/javascript" })); document.head.appendChild(s);
document.fonts.load("12px sans-serif").then(() => log("fonts.load"));
requestIdleCallback(() => log("idle"));
// 100 ms: decode(), a src replaced before it loaded, a src removed, a broken picture.
setTimeout(() => {
  log("t100");
  const a = new Image(); a.src = PNG; a.decode().then(() => log("decode"));
  const b = new Image(); b.onload = () => log("replaced " + b.src.length); b.src = "data:image/png;base64,AAAA"; b.src = PNG;
  const c = new Image(); c.onload = c.onerror = () => log("removed src fired"); c.src = PNG; c.removeAttribute("src");
  const d = new Image(); d.onerror = () => log("broken.onerror"); d.src = "data:image/png;base64,AAAA";
}, 100);
// 100 ms: a CSS transition (0 -> 300 px in 1 s) made by a style change while slow asset work is in flight (a real
// rendering frame may come while the frame waits for it): it starts at the end of the frame that made it, 100 ms.
const bar = document.createElement("div"); bar.style.cssText = "height:4px;width:0;background:red;transition:width 1s linear";
document.body.appendChild(bar);
setTimeout(() => {
  const c = document.createElement("canvas"); c.width = c.height = 2048; c.getContext("2d").fillRect(0, 0, 2048, 2048);
  createImageBitmap(c).then(() => log("big bitmap"));
  bar.style.width = "300px";
}, 100);
setTimeout(() => log("bar " + getComputedStyle(bar).width), 400);
// 200 ms: a shader's parallel-compile status.
setTimeout(() => {
  const gl = document.createElement("canvas").getContext("webgl");
  if (!gl) return log("no webgl");
  const sh = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(sh, "void main(){gl_Position=vec4(0.);}"); gl.compileShader(sh);
  log("khr " + gl.getShaderParameter(sh, 0x91B1) + " " + gl.getShaderParameter(sh, gl.COMPILE_STATUS));
}, 200);
</script></body></html>""" % PNG

# A body the game feeds from one of its own timers: the clock cannot wait for it (it would never finish), so after the
# stall timeout it is no longer waited for, and it is delivered once it finishes.
STALL_PAGE = """<!doctype html><html><body><script>
window.L = [];
setTimeout(() => {
  new Response(new ReadableStream({ start(c) { setTimeout(() => { c.enqueue(new Uint8Array(3)); c.close(); }, 100); } }))
    .arrayBuffer().then((b) => L.push([__sim.frame, "fed " + b.byteLength]));
}, 100);
</script></body></html>"""

INPUT_PAGE = """<!doctype html><html><body style="margin:0"><canvas id=c width=360 height=640 style="touch-action:none"></canvas><script>
window.L = [];
for (const t of ["pointerdown", "pointermove", "pointerup"]) c.addEventListener(t, (e) => { if (e.pointerType === "touch") L.push([__sim.frame, t, Math.round(e.clientX)]); });
</script></body></html>"""

FRAMES = 20


async def play(page: Path, run_dir: Path, pause_s: float = 0.0, stall_ms: float = 10000) -> tuple[list, dict, float]:
    w = Worker()
    await w.open({"run_dir": str(run_dir), "playable": str(page), "viewport": [360, 640], "dpr": 1, "fps": 30, "seed": 1,
                  "display": "headless", "record": False, "asset_stall_ms": stall_ms})
    t0 = time.time()
    try:
        for f in range(FRAMES):
            if pause_s and f < 10:
                await asyncio.sleep(pause_s)
            await w.step({"frames": 1, "capture": False})
        log = (await w.eval({"expr": "window.L"}))["value"]
        stats = (await w.eval({"expr": "__sim.assetStats()"}))["value"]
    finally:
        await w.close({})
    return log, stats, time.time() - t0


def frame_of(log: list, msg: str) -> int:
    hits = [f for f, m in log if m == msg]
    assert len(hits) == 1, (msg, log)
    return hits[0]


class AssetsInGameTime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        page = root / "page.html"
        page.write_text(PAGE)
        cls.fast, cls.stats, _ = asyncio.run(play(page, root / "fast"))
        cls.slow, _, _ = asyncio.run(play(page, root / "slow", pause_s=0.15))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_same_frames_however_fast_the_machine(self):
        self.assertEqual(self.fast, self.slow)

    def test_page_load_requests_land_in_the_first_frame(self):
        for msg in ["img.onload", "img.once", "fetch", "script.onload", "fonts.load", "idle"]:
            self.assertEqual(frame_of(self.fast, msg), 0, msg)
        self.assertEqual(frame_of(self.fast, "script ran"), 0)  # executed before the first frame, its load event in it

    def test_a_chain_takes_one_frame_per_link(self):
        self.assertEqual(frame_of(self.fast, "blob"), 1)
        self.assertEqual(frame_of(self.fast, "bitmap 1"), 2)
        self.assertEqual(frame_of(self.fast, "8 MB 6000000"), 1)

    def test_pictures(self):
        t = frame_of(self.fast, "t100")
        self.assertEqual(frame_of(self.fast, "decode"), t + 1)
        self.assertEqual(frame_of(self.fast, "replaced %d" % len(PNG)), t + 1)  # one load, for the last src
        self.assertEqual(frame_of(self.fast, "broken.onerror"), t + 1)
        self.assertNotIn("removed src fired", [m for _, m in self.fast])

    def test_css_transition_starts_in_game_time(self):
        # read in frame f: seeked at the end of frame f - 1 (f * 1/30 s), so f/30 s - 100 ms into a 1 s transition
        bar = [(f, m) for f, m in self.fast if m.startswith("bar ")]
        self.assertEqual(len(bar), 1)
        f, m = bar[0]
        self.assertAlmostEqual(float(m[4:-2]), 300 * (f * 1000 / 30 - 100) / 1000, delta=0.5)

    def test_shader_compile_reports_done(self):
        msgs = [m for _, m in self.fast if m.startswith("khr") or m == "no webgl"]
        self.assertEqual(len(msgs), 1)
        if msgs[0] != "no webgl":
            self.assertEqual(msgs[0], "khr true true")

    def test_nothing_waited_on_late(self):
        self.assertEqual(self.stats["late"], 0)
        self.assertEqual(self.stats["open"], 0)
        self.assertGreaterEqual(self.stats["requested"], 12)


class InputBeforeTheFrame(unittest.TestCase):
    """Touches sent before a step are handled before its frame: the step waits until the page has them."""

    def test_every_touch_lands_before_its_frame(self):
        async def run(d: Path):
            page = d / "page.html"
            page.write_text(INPUT_PAGE)
            w = Worker()
            await w.open({"run_dir": str(d / "run"), "playable": str(page), "dpr": 1, "display": "headless", "record": False})
            sent = []
            try:
                await w.step({"frames": 2, "capture": False})
                for typ, x in [("start", 100), ("move", 100), ("move", 120), ("move", 120), ("move", 150), ("end", 150)]:
                    r = await w.touch({"type": typ, "x": x, "y": 300})
                    if not r.get("same_point"):
                        sent.append((await w.eval({"expr": "__sim.frame"}))["value"])
                    await w.step({"frames": 1, "capture": False})
                log = (await w.eval({"expr": "window.L"}))["value"]
                stats = (await w.eval({"expr": "__sim.inputStats()"}))["value"]
                return sent, log, stats, w.input_sent
            finally:
                await w.close({})

        with tempfile.TemporaryDirectory() as d:
            sent, log, stats, counted = asyncio.run(run(Path(d)))
        self.assertEqual([t for _, t, _ in log], ["pointerdown", "pointermove", "pointermove", "pointerup"])  # same-point moves are not sent
        self.assertEqual([f for f, _, _ in log], sent)  # each handled in the frame it was sent before
        self.assertEqual(stats["timeouts"], 0)
        self.assertEqual(stats["touch"], counted["touch"])


class StalledWork(unittest.TestCase):
    def test_work_the_game_holds_up_is_not_waited_for_forever(self):
        with tempfile.TemporaryDirectory() as d:
            page = Path(d) / "page.html"
            page.write_text(STALL_PAGE)
            log, stats, wall = asyncio.run(play(page, Path(d) / "run", stall_ms=300))
        self.assertEqual([m for _, m in log], ["fed 3"])
        self.assertEqual(stats["late"], 1)
        self.assertLess(wall, 5)


if __name__ == "__main__":
    unittest.main()
