"""Game audio in game time: Web Audio rendered by the browser ("render" audio, shim.js) and mixed by audio.py.

One small page schedules sounds at known game times; the test steps the virtual clock through it, closes the worker
(which renders the audio) and checks the mix sample by sample against what the page asked for.
"""
import asyncio
import json
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from simbrowser.audio import SR, mix_session
from simbrowser.server import Worker

PAGE = """<!doctype html><html><body><script>
window.R = {};
let ctx;
const at = (ms, fn) => setTimeout(fn, ms);
// 0.5 s: the context; a 440 Hz tone at gain 0.2, wired through a gain node that is disconnected at 1.5 s.
at(500, () => {
  ctx = new AudioContext();
  R.same = new AudioContext() === ctx; R.isAC = ctx instanceof AudioContext; R.state = ctx.state;
  const o = ctx.createOscillator(), g = ctx.createGain();
  g.gain.value = 0.2; R.gv = g.gain.value;
  o.connect(g).connect(ctx.destination); o.start();
  at(1000, () => { g.disconnect(); R.tDisc = ctx.currentTime; });
});
// 1.0 s: a game's own OfflineAudioContext (pre-rendering a sound) keeps its native clock and is not heard.
at(1000, async () => {
  const oc = new OfflineAudioContext(1, 4800, 48000); R.ocTime = oc.currentTime;
  const o = oc.createOscillator(); o.connect(oc.destination); o.start();
  const b = await oc.startRendering(); R.ocLen = b.length; R.ocPeak = Math.max(...b.getChannelData(0).slice(0, 1000));
});
// 2.0 s: an envelope like a word game's tile sound: 12 ms attack to 0.025, exponential decay, stop at 200 ms.
at(2000, () => {
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
  o.frequency.value = 660; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.025, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.2);
  R.auto = []; [6, 12, 100].forEach((ms) => at(ms, () => R.auto.push(g.gain.value)));
  o.onended = () => { (R.oscEnded = R.oscEnded || []).push(performance.now()); };
});
// 2.5 s: a 0.3 s buffer (square wave at 0.1); its `ended` comes from a listener.
at(2500, () => {
  const b = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = i % 2 ? 0.1 : -0.1;
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination);
  s.addEventListener("ended", () => { (R.bufEnded = R.bufEnded || []).push(performance.now()); }); s.start();
});
// 2.9 s: a 220 Hz tone for 0.4 s of context time; the context is suspended from 3.0 to 4.0 s, so it is heard
// 2.9-3.0 s and 4.0-4.3 s.
at(2900, () => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 220; g.gain.value = 0.1;
  o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4); });
at(3000, () => { R.cBefore = ctx.currentTime; ctx.onstatechange = () => { (R.states = R.states || []).push(ctx.state); }; ctx.suspend(); });
at(3500, () => { R.cDuring = ctx.currentTime; R.stateDuring = ctx.state; });
at(4000, () => { ctx.resume(); R.cAfter = ctx.currentTime; });
</script></body></html>"""

END_S = 5.0


async def play(run_dir: Path, page: Path, audio: str) -> tuple[dict, dict]:
    w = Worker()
    await w.open({"run_dir": str(run_dir), "playable": str(page), "viewport": [360, 640], "dpr": 1, "fps": 30, "seed": 1,
                  "display": "headless", "record": False, "audio": audio, "audio_max_s": 20})
    await w.step({"frames": int(END_S * 30), "capture": False})
    r = (await w.eval({"expr": "window.R"}))["value"]
    out = await w.close({})
    return r, out


def rms(x: np.ndarray, a: float, b: float) -> float:
    s = x[int(a * SR): int(b * SR)]
    return float(np.sqrt(np.mean(s ** 2)))


def peak(x: np.ndarray, a: float, b: float) -> tuple[float, float]:
    s = np.abs(x[int(a * SR): int(b * SR)])
    return float(s.max()), a + int(s.argmax()) / SR


class RenderedAudio(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        page = root / "page.html"
        page.write_text(PAGE)
        cls.run_dir = root / "run"
        cls.r, cls.out = asyncio.run(play(cls.run_dir, page, "render"))
        cls.stats = mix_session(cls.run_dir, END_S)
        with wave.open(str(cls.run_dir / "audio.wav")) as f:
            cls.mix = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).reshape(-1, 2)[:, 0] / 32767.0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_page_sees_a_live_audio_context(self):
        r = self.r
        self.assertTrue(r["same"] and r["isAC"])
        self.assertEqual(r["state"], "running")
        self.assertAlmostEqual(r["gv"], 0.2, places=6)
        self.assertAlmostEqual(r["tDisc"], 1.0, places=6)  # context time starts at 0 when it is made (0.5 s)

    def test_value_reads_the_automation(self):
        a = self.r["auto"]  # 6 ms (mid attack), 12 ms (top), 100 ms (decay)
        self.assertAlmostEqual(a[0], 0.0125, delta=1e-4)
        self.assertAlmostEqual(a[1], 0.025, delta=1e-4)
        self.assertAlmostEqual(a[2], 0.025 * 0.04 ** ((0.1 - 0.012) / 0.168), delta=1e-4)

    def test_ended_fires_once_in_game_time(self):
        self.assertEqual(len(self.r["oscEnded"]), 1)
        self.assertAlmostEqual(self.r["oscEnded"][0], 2200, delta=1)
        self.assertEqual(len(self.r["bufEnded"]), 1)
        self.assertAlmostEqual(self.r["bufEnded"][0], 2800, delta=1)

    def test_suspend_freezes_the_clock(self):
        r = self.r
        self.assertAlmostEqual(r["cBefore"], 2.5, places=6)
        self.assertAlmostEqual(r["cDuring"], 2.5, places=6)
        self.assertAlmostEqual(r["cAfter"], 2.5, places=6)
        self.assertEqual(r["stateDuring"], "suspended")
        self.assertEqual(r["states"], ["suspended", "running"])

    def test_games_own_offline_context_is_untouched(self):
        self.assertEqual(self.r["ocTime"], 0)
        self.assertEqual(self.r["ocLen"], 4800)
        self.assertGreater(self.r["ocPeak"], 0.5)

    def test_render_reported(self):
        wa = self.out["audio"]["webaudio"]
        self.assertEqual(wa["sources"], 4)  # 440, 660, the buffer, 220 (not the offline pre-render)
        self.assertEqual(self.stats["webaudio_sources"], 4)
        self.assertNotIn("errors", self.stats)

    def test_mix_matches_the_schedule(self):
        x = self.mix
        self.assertLess(rms(x, 0.0, 0.48), 1e-4)                         # nothing before the context
        self.assertAlmostEqual(rms(x, 0.6, 1.4), 0.2 / np.sqrt(2), delta=0.005)  # 440 Hz at 0.2
        self.assertLess(rms(x, 1.52, 1.98), 1e-4)                        # disconnected at 1.5 s, not before
        p, t = peak(x, 1.99, 2.3)                                        # the envelope, not a flat beep
        self.assertAlmostEqual(p, 0.025, delta=0.001)
        self.assertAlmostEqual(t, 2.012, delta=0.002)
        self.assertLess(peak(x, 2.15, 2.3)[0], 0.0025)
        self.assertAlmostEqual(peak(x, 2.52, 2.78)[0], 0.1, delta=0.002)  # the buffer
        self.assertLess(rms(x, 2.81, 2.89), 1e-4)
        self.assertAlmostEqual(rms(x, 2.91, 2.99), 0.1 / np.sqrt(2), delta=0.004)
        self.assertLess(rms(x, 3.02, 3.98), 1e-4)                        # suspended
        self.assertAlmostEqual(rms(x, 4.02, 4.28), 0.1 / np.sqrt(2), delta=0.004)
        self.assertLess(rms(x, 4.32, 5.0), 1e-4)


class LogFallback(unittest.TestCase):
    def test_log_mode_still_logs_starts(self):
        with tempfile.TemporaryDirectory() as d:
            page = Path(d) / "page.html"
            page.write_text(PAGE)
            asyncio.run(play(Path(d) / "run", page, "log"))
            log = json.loads((Path(d) / "run" / "audio" / "audio_log.json").read_text())
            self.assertNotIn("webaudio", log)
            self.assertEqual(sum(1 for e in log["log"] if e["op"] == "osc"), 3)
            self.assertEqual(sum(1 for e in log["log"] if e["op"] == "start"), 1)  # the game's own offline render is not logged


if __name__ == "__main__":
    unittest.main()
