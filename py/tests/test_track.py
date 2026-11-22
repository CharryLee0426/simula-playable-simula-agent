"""Tracker unit tests on synthetic frames: lane changes, a look-alike distractor, a hidden frame."""
import unittest

import numpy as np

from simbrowser.track import Tracker, shift_zone


def frame(car_x: float, car_y: float = 230, distractor_x: float | None = None, hide: bool = False, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    g = rng.normal(60, 12, (320, 180)).astype(np.float32)          # noisy road texture
    g[:, 59:61] = 200
    g[:, 119:121] = 200                                             # lane lines
    def car(x, y, v=220):
        g[int(y) - 10:int(y) + 10, int(x) - 9:int(x) + 9] = 30     # body
        g[int(y) - 6:int(y) + 2, int(x) - 6:int(x) + 6] = v        # windscreen
    if not hide:
        car(car_x, car_y)
    if distractor_x is not None:
        car(distractor_x, 120, v=160)                               # similar shape, further up, different brightness
    return g


class TrackerTest(unittest.TestCase):
    def test_follows_lane_changes(self):
        t = Tracker(frame(90), (90, 230), (24, 26))
        for x in [90, 100, 115, 130, 145, 150, 150, 140, 120, 95, 70, 40, 30, 30]:  # right lane, then left lane
            cx, cy, conf = t.update(frame(x, seed=int(x)))
            self.assertLess(abs(cx - x), 4, f"lost the car at x={x}: got {cx:.1f} (conf {conf:.2f})")
            self.assertLess(abs(cy - 230), 4)
        dx, _ = t.displacement()
        self.assertAlmostEqual(dx, (30 - 90) / 180, delta=0.03)

    def test_ignores_distractor_and_survives_occlusion(self):
        t = Tracker(frame(90), (90, 230), (24, 26))
        t.update(frame(100, distractor_x=40, seed=1))
        cx, _, conf = t.update(frame(100, distractor_x=40, hide=True, seed=2))   # car hidden (explosion, particles)
        self.assertLess(abs(cx - 100), 4, "should keep the last position, not jump to the look-alike")
        cx, _, _ = t.update(frame(110, distractor_x=40, seed=3))
        self.assertLess(abs(cx - 110), 4)

    def test_shift_zone_stays_on_screen(self):
        self.assertEqual(shift_zone([400, 300, 800, 700], -0.5, 0), [400, 0.0, 800, 400.0])
        self.assertEqual(shift_zone([400, 300, 800, 700], 0.1, 0), [400, 400.0, 800, 800.0])


if __name__ == "__main__":
    unittest.main()
