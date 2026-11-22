// Turning an intended action into the touch stream of a person, in game time. Everything here is generic motor
// behaviour, not game knowledge: reaction and reading time, Fitts-law movement time, curved and slightly shaky drag
// paths with an ease-in-out speed profile, imprecise taps, a press that lasts a few frames, the occasional slip.
// The game is frozen while the model thinks, so these delays are the only "thinking" that shows up on video.
import type { Op } from "../browser/worker.ts";
import { Rng } from "../util/core.ts";

export type Persona = {
	name: string;
	reactionMedianMs: number; // a decision on a screen you already understand
	reactionSigma: number; // lognormal spread
	readMs: [number, number]; // extra time to read a screen that just changed a lot
	chainGapMs: [number, number]; // between two actions of the same plan
	tapJitter: number; // σ of tap position, as a fraction of the screen width
	pathJitter: number; // σ of drag path noise, px
	slipRate: number; // chance a tap lands visibly off target
	pauseRate: number; // chance of an extra hesitation before acting
};

export const PERSONAS: Record<string, Persona> = {
	casual_competent: { name: "casual_competent", reactionMedianMs: 430, reactionSigma: 0.32, readMs: [450, 1100], chainGapMs: [180, 420], tapJitter: 0.012, pathJitter: 1.6, slipRate: 0.05, pauseRate: 0.08 },
	first_timer: { name: "first_timer", reactionMedianMs: 650, reactionSigma: 0.38, readMs: [900, 1800], chainGapMs: [300, 650], tapJitter: 0.018, pathJitter: 2.4, slipRate: 0.1, pauseRate: 0.15 },
	expert: { name: "expert", reactionMedianMs: 300, reactionSigma: 0.25, readMs: [250, 600], chainGapMs: [120, 260], tapJitter: 0.008, pathJitter: 1.0, slipRate: 0.02, pauseRate: 0.03 },
};

export type Pt = { x: number; y: number };
export type GestureKind = "tap" | "drag" | "hold" | "swipe" | "wait";
/** A planned gesture in CSS pixels. */
export type Gesture = { kind: GestureKind; points: Pt[]; durationMs?: number; target?: { x: number; y: number; w: number; h: number } };
/** What was actually done, frame by frame (for the trace, the friction report and the touch overlay). */
export type Performed = { kind: GestureKind; frames: number; touches: { f: number; x: number; y: number; phase: "start" | "move" | "end" }[]; slipped: boolean; durationMs: number };

export class Humanizer {
	readonly p: Persona;
	private rng: Rng;
	readonly dtMs: number;
	readonly vw: number;
	readonly vh: number;
	constructor(persona: Persona, seed: string | number, fps: number, viewport: [number, number]) {
		this.p = persona;
		this.rng = new Rng(seed);
		this.dtMs = 1000 / fps;
		this.vw = viewport[0];
		this.vh = viewport[1];
	}

	private uniform(a: number, b: number) {
		return a + (b - a) * this.rng.next();
	}
	private clampPt(p: Pt): Pt {
		return { x: Math.min(this.vw - 1, Math.max(1, p.x)), y: Math.min(this.vh - 1, Math.max(1, p.y)) };
	}
	framesFor(ms: number): number {
		return Math.max(1, Math.round(ms / this.dtMs));
	}

	/** Delay before acting: reaction (lognormal) + reading time if the screen just changed + rare hesitation. */
	reactionMs(sceneChanged: boolean, firstLook = false): number {
		let ms = this.p.reactionMedianMs * Math.exp(this.p.reactionSigma * this.rng.normal());
		ms = Math.min(1500, Math.max(220, ms));
		if (sceneChanged || firstLook) ms += this.uniform(...this.p.readMs) * (firstLook ? 1.3 : 1);
		if (this.rng.next() < this.p.pauseRate) ms += this.uniform(300, 900);
		return ms;
	}
	chainGapMs(): number {
		return this.uniform(...this.p.chainGapMs);
	}

	/** A trained reflex (a stimulus you were waiting for): faster than a decision, still human — lognormal around
	 *  ~210 ms (scaled by the persona), clamped to 150-400 ms, and now and then noticeably late. */
	reflexMs(): { ms: number; late: boolean } {
		const median = 210 * (this.p.reactionMedianMs / 430);
		let ms = Math.min(400, Math.max(150, median * Math.exp(0.25 * this.rng.normal())));
		const late = this.rng.next() < this.p.slipRate;
		if (late) ms += this.uniform(80, 160);
		return { ms, late };
	}

	/** Fitts-law movement time for a drag of `dist` px towards a target `width` px wide. */
	movementMs(dist: number, width = 40): number {
		return 180 + 110 * Math.log2(1 + dist / Math.max(12, width));
	}

	private aim(pt: Pt, target?: Gesture["target"]): { pt: Pt; slipped: boolean } {
		const s = this.p.tapJitter * this.vw;
		let x = pt.x + this.rng.normal() * s, y = pt.y + this.rng.normal() * s;
		let slipped = false;
		if (target) {
			// Aim inside the element, biased to its centre, like a thumb would.
			x = Math.min(target.x + target.w * 0.85, Math.max(target.x + target.w * 0.15, x));
			y = Math.min(target.y + target.h * 0.85, Math.max(target.y + target.h * 0.15, y));
		}
		return { pt: this.clampPt({ x, y }), slipped };
	}

	/** Cubic Bézier through consecutive waypoints, sampled once per frame with an ease-in-out speed profile. */
	private path(points: Pt[], frames: number): Pt[] {
		if (points.length === 1) return Array.from({ length: frames + 1 }, () => points[0]!);
		const segs: { a: Pt; c1: Pt; c2: Pt; b: Pt; len: number }[] = [];
		for (let i = 0; i < points.length - 1; i++) {
			const a = points[i]!, b = points[i + 1]!;
			const dx = b.x - a.x, dy = b.y - a.y;
			const len = Math.hypot(dx, dy) || 1;
			const nx = -dy / len, ny = dx / len;
			const bend = points.length > 2 ? 0.04 : 0.12; // multi-point paths (word links) stay tight
			const k1 = this.rng.normal() * bend * len, k2 = this.rng.normal() * bend * len;
			segs.push({ a, b, len, c1: { x: a.x + dx * 0.3 + nx * k1, y: a.y + dy * 0.3 + ny * k1 }, c2: { x: a.x + dx * 0.7 + nx * k2, y: a.y + dy * 0.7 + ny * k2 } });
		}
		const total = segs.reduce((s, g) => s + g.len, 0);
		const out: Pt[] = [];
		for (let f = 0; f <= frames; f++) {
			const u = f / frames;
			const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // ease in-out
			let d = e * total;
			let si = 0;
			while (si < segs.length - 1 && d > segs[si]!.len) { d -= segs[si]!.len; si++; } // the last segment absorbs rounding
			const g = segs[si]!;
			const t = Math.min(1, d / g.len);
			const mt = 1 - t;
			const x = mt * mt * mt * g.a.x + 3 * mt * mt * t * g.c1.x + 3 * mt * t * t * g.c2.x + t * t * t * g.b.x;
			const y = mt * mt * mt * g.a.y + 3 * mt * mt * t * g.c1.y + 3 * mt * t * t * g.c2.y + t * t * t * g.b.y;
			const j = f === 0 || f === frames ? 0 : this.p.pathJitter;
			out.push(this.clampPt({ x: x + this.rng.normal() * j, y: y + this.rng.normal() * j }));
		}
		return out;
	}

	/** The worker ops for one gesture, starting now. `startFrame` is only used to stamp the performed touches. */
	compile(g: Gesture, startFrame: number, opts: { allowSlip?: boolean; mouse?: boolean } = {}): { ops: Op[]; performed: Performed } {
		const ops: Op[] = [];
		const touches: Performed["touches"] = [];
		let f = startFrame;
		const down = (p: Pt) => { ops.push(opts.mouse ? { op: "mouse", type: "down", x: p.x, y: p.y } : { op: "touch", type: "start", x: p.x, y: p.y }); touches.push({ f, x: p.x, y: p.y, phase: "start" }); };
		const move = (p: Pt) => { ops.push(opts.mouse ? { op: "mouse", type: "move", x: p.x, y: p.y } : { op: "touch", type: "move", x: p.x, y: p.y }); touches.push({ f, x: p.x, y: p.y, phase: "move" }); };
		const up = (p: Pt) => { ops.push(opts.mouse ? { op: "mouse", type: "up", x: p.x, y: p.y } : { op: "touch", type: "end" }); touches.push({ f, x: p.x, y: p.y, phase: "end" }); };
		const step = (n: number) => { if (n > 0) { ops.push({ op: "step", frames: n }); f += n; } };
		let slipped = false;

		if (g.kind === "wait") {
			const n = this.framesFor(g.durationMs ?? 800);
			step(n);
			return { ops, performed: { kind: "wait", frames: n, touches, slipped, durationMs: n * this.dtMs } };
		}
		if (g.kind === "tap" || g.kind === "hold") {
			let { pt } = this.aim(g.points[0]!, g.target);
			if (opts.allowSlip !== false && g.kind === "tap" && !g.target && this.rng.next() < this.p.slipRate) {
				const ang = this.rng.next() * Math.PI * 2, r = this.uniform(0.035, 0.06) * this.vw;
				pt = this.clampPt({ x: pt.x + Math.cos(ang) * r, y: pt.y + Math.sin(ang) * r });
				slipped = true;
			}
			const pressMs = g.kind === "hold" ? Math.max(250, g.durationMs ?? 700) : this.uniform(70, 140);
			const n = this.framesFor(pressMs);
			down(pt);
			// A held finger is never perfectly still.
			for (let i = 0; i < n; i++) {
				step(1);
				if (g.kind === "hold" && i % 3 === 2) move(this.clampPt({ x: pt.x + this.rng.normal() * 0.8, y: pt.y + this.rng.normal() * 0.8 }));
			}
			up(pt);
			step(1);
			return { ops, performed: { kind: g.kind, frames: f - startFrame, touches, slipped, durationMs: (f - startFrame) * this.dtMs } };
		}
		// drag / swipe: a polyline of waypoints, curved and timed
		const pts = g.points.map((p, i) => (i === 0 || i === g.points.length - 1 ? this.aim(p).pt : p));
		const dist = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);
		const ms = g.kind === "swipe" ? this.uniform(120, 220) : Math.min(4000, Math.max(220, g.durationMs ?? this.movementMs(dist) * Math.max(1, pts.length - 1) * 0.8));
		const n = this.framesFor(ms);
		const path = this.path(pts, n);
		down(path[0]!);
		step(1 + (g.kind === "drag" ? this.rng.int(2) : 0)); // settle the finger before moving
		for (let i = 1; i < path.length; i++) {
			move(path[i]!);
			step(1);
		}
		if (g.kind === "drag") step(this.rng.int(2)); // brief stop before lifting
		up(path[path.length - 1]!);
		step(1);
		return { ops, performed: { kind: g.kind, frames: f - startFrame, touches, slipped, durationMs: (f - startFrame) * this.dtMs } };
	}
}
