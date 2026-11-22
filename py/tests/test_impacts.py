"""Hit-candidate detection on synthetic per-frame stats: a flash, a freeze, a pickup-like dim spike, a slow scene."""
import asyncio
import types
import unittest

import numpy as np

from simbrowser.server import Worker


def worker(motion: list[float], luma: list[float] | None = None, fps: int = 30) -> Worker:
    w = Worker.__new__(Worker)  # no browser: only the recorder stats matter here
    w.flash_scan = w.freeze_scan = 0
    w.frozen = False
    luma = luma or [0.2] * len(motion)
    stats = [{"f": i, "t": round((i + 1) / fps, 4), "motion": m, "luma": l} for i, (m, l) in enumerate(zip(motion, luma))]
    w.rec = types.SimpleNamespace(stats=[], fps=fps)
    w._all = stats
    return w


def feed(w: Worker, step: int = 3) -> list[dict]:
    """Replay the stats a few frames at a time, scanning after each step like the reflex checks do."""
    out = []
    for i in range(0, len(w._all), step):
        w.rec.stats.extend(w._all[i:i + step])
        out += w._impacts()
    return out


class ImpactTests(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(0)

    def running(self, n: int, level: float = 0.012) -> list[float]:
        return list(np.clip(self.rng.normal(level, level * 0.3, n), 0.001, None))

    def test_freeze_found_once_at_its_onset(self):
        m = self.running(60) + [0.0004] * 40 + self.running(30)
        ev = feed(worker(m))
        fz = [e for e in ev if e["kind"] == "freeze"]
        self.assertEqual(len(fz), 1)
        self.assertEqual(fz[0]["f"], 61)  # game frame = recorder index + 1

    def test_bright_flash_found_dim_spike_ignored(self):
        m = self.running(40) + [0.08] + self.running(20) + [0.08] + self.running(20)
        l = [0.2] * 40 + [0.3] + [0.2] * 20 + [0.12] + [0.2] * 20
        ev = feed(worker(m, l))
        self.assertEqual([e["f"] for e in ev if e["kind"] == "flash"], [41])

    def test_still_scene_is_not_a_freeze(self):
        ev = feed(worker([0.0015] * 120))  # a puzzle screen that barely moves
        self.assertEqual(ev, [])

    def test_onset_of_a_freeze_noticed_late(self):
        w = worker(self.running(60) + [0.0005] * 20)
        w.rec.stats = w._all
        r = asyncio.run(w.impact_onset({"since_f": 45}))  # the last look that saw normal play was at frame 45
        self.assertEqual((r["f"], r["how"]), (61, "freeze"))
        r = asyncio.run(w.impact_onset({"since_f": 70}))  # already frozen before that look: nothing to time
        self.assertIsNone(r["f"])


if __name__ == "__main__":
    unittest.main()
