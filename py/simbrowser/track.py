"""Following the object the player controls, frame to frame, so a reflex policy's attention zone moves with it.

Generic on purpose: the planner (a VLM) says once where the player-controlled object is on the screen; from then on
this tracker finds it again in every new frame by normalized cross-correlation of a small grayscale template within a
search window around its last position. No game knowledge, ~5-30 ms per frame on a 180-px-wide image.

- The template adapts slowly while matches are confident (cars tilt while changing lanes, ships bank).
- A weak match (explosion, particles, the object hidden) keeps the last position instead of jumping to a look-alike.
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

SMALL_W = 180  # tracking resolution (width); height follows the aspect ratio


class Tracker:
    def __init__(self, gray: np.ndarray, center_xy: tuple[float, float], size_wh: tuple[float, float]):
        """gray: float32 image (H, W); center/size in pixels of that image."""
        self.h, self.w = gray.shape
        tw = int(max(8, min(self.w * 0.6, size_wh[0])))
        th = int(max(8, min(self.h * 0.4, size_wh[1])))
        self.tw, self.th = tw, th
        cx, cy = center_xy  # (snapping to the most contrasted patch nearby was tried: it lost the car from 3 of 5 starts)
        x0 = int(round(min(max(0, cx - tw / 2), self.w - tw)))
        y0 = int(round(min(max(0, cy - th / 2), self.h - th)))
        self.tpl = gray[y0:y0 + th, x0:x0 + tw].astype(np.float32).copy()
        self.pos = (x0 + tw / 2, y0 + th / 2)
        self.start = self.pos
        self.conf = 1.0
        self.lost = 0

    def update(self, gray: np.ndarray, search_x: float = 0.4, search_y: float = 0.1) -> tuple[float, float, float]:
        """Find the template near its last position. Returns (cx, cy, confidence in [-1, 1])."""
        th, tw = self.tpl.shape
        px, py = self.pos
        sx0 = int(max(0, px - tw / 2 - search_x * self.w))
        sx1 = int(min(self.w, px + tw / 2 + search_x * self.w))
        sy0 = int(max(0, py - th / 2 - search_y * self.h))
        sy1 = int(min(self.h, py + th / 2 + search_y * self.h))
        win = gray[sy0:sy1, sx0:sx1].astype(np.float32)
        if win.shape[0] < th or win.shape[1] < tw:
            return px, py, 0.0
        v = sliding_window_view(win, (th, tw))
        t = self.tpl - self.tpl.mean()
        tn = float(np.sqrt((t * t).sum())) + 1e-6
        vm = v.mean(axis=(2, 3), keepdims=True)
        vc = v - vm
        num = np.einsum("ijkl,kl->ij", vc, t)
        den = np.sqrt(np.einsum("ijkl,ijkl->ij", vc, vc)) * tn + 1e-6
        ncc = num / den
        # A mild preference for staying close: among near-equal matches, the nearer one wins (no teleporting to a
        # look-alike on the other side of the screen).
        yy, xx = np.mgrid[0:ncc.shape[0], 0:ncc.shape[1]]
        dist = np.hypot(sx0 + xx + tw / 2 - px, sy0 + yy + th / 2 - py) / max(self.w, self.h)
        score = ncc - 0.15 * dist
        iy, ix = np.unravel_index(int(np.argmax(score)), score.shape)
        conf = float(ncc[iy, ix])
        self.conf = conf
        if conf < 0.45:
            self.lost += 1
            return px, py, conf
        self.lost = 0
        cx, cy = sx0 + ix + tw / 2, sy0 + iy + th / 2
        self.pos = (cx, cy)
        if conf > 0.8:  # adapt slowly to appearance changes
            patch = win[iy:iy + th, ix:ix + tw]
            self.tpl = 0.85 * self.tpl + 0.15 * patch
        return cx, cy, conf

    def displacement(self) -> tuple[float, float]:
        """Movement since the start, as fractions of the image (dx, dy)."""
        return (self.pos[0] - self.start[0]) / self.w, (self.pos[1] - self.start[1]) / self.h


def to_small_gray(rgb: np.ndarray) -> np.ndarray:
    """RGB uint8 (H, W, 3) -> float32 gray at SMALL_W width (box-averaged)."""
    h, w = rgb.shape[:2]
    f = max(1, w // SMALL_W)
    g = rgb[: (h // f) * f, : (w // f) * f].astype(np.float32).mean(axis=2)
    return g.reshape(h // f, f, w // f, f).mean(axis=(1, 3))


def shift_zone(zone: list[float], dx: float, dy: float) -> list[float]:
    """zone [y0, x0, y1, x1] in 0-1000 shifted by (dx, dy) fractions, kept inside the screen with its size."""
    y0, x0, y1, x1 = zone
    hgt, wid = y1 - y0, x1 - x0
    nx0 = min(max(0.0, x0 + dx * 1000), 1000 - wid)
    ny0 = min(max(0.0, y0 + dy * 1000), 1000 - hgt)
    return [ny0, nx0, ny0 + hgt, nx0 + wid]
