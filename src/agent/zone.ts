// Learning a reflex zone's depth from hits. Pure functions (unit-tested); play.ts calls them.
//
// The zone is how far ahead of the player the reflexes look. Too shallow and hazards are seen too late to react;
// too deep and reactions come early (a jump that lands before the barrier). A hit tells which, through the lead time:
// how long before the hit the danger was first flagged and the reflex fired.

export type CheckLog = { f: number; c?: string };
export type Fire = { f: number; name: string; pickup?: boolean };
export type Lesson = { delta: -1 | 0 | 1; reason: string; lead?: number };

export const LATE_S = 0.5; // a reaction fired less than this before the hit was too late to help
export const EARLY_S = 1.2; // a reaction fired more than this before the hit came too early

/** What a confirmed hit at frame `hitF` says about the zone depth: +1 deeper, -1 shallower, 0 not a depth problem.
 *  `startF` is the frame the policy started: a hit in its first second says nothing about what the zone could see. */
export function depthLesson(log: CheckLog[], fires: Fire[], hitF: number, fps: number, startF = -Infinity, windowS = 2.5): Lesson {
	if ((hitF - startF) / fps < 1) return { delta: 0, reason: `the policy had only been watching for ${((hitF - startF) / fps).toFixed(2)} s` };
	const from = Math.max(startF, hitF - windowS * fps);
	const recent = fires.filter((x) => x.f <= hitF && x.f >= from);
	const lastPickup = [...recent].reverse().find((x) => x.pickup);
	const lastReaction = [...recent].reverse().find((x) => !x.pickup);
	if (lastPickup && (!lastReaction || lastPickup.f > lastReaction.f) && (hitF - lastPickup.f) / fps < 0.8) {
		return { delta: 0, reason: "moved into danger while going for a pickup (a judgement error, not depth)", lead: (hitF - lastPickup.f) / fps };
	}
	if (lastReaction) {
		const lead = (hitF - lastReaction.f) / fps;
		if (lead < LATE_S) return { delta: 1, reason: `the reflex fired only ${lead.toFixed(2)} s before the hit: seen too late`, lead };
		if (lead > EARLY_S) return { delta: -1, reason: `the reflex fired ${lead.toFixed(2)} s before the hit: too early`, lead };
		return { delta: 0, reason: `the reflex fired ${lead.toFixed(2)} s before the hit, in time: the reaction itself was wrong`, lead };
	}
	// No reaction at all: was the danger even flagged?
	const flagged = log.filter((x) => x.f <= hitF && x.f >= from && x.c && x.c !== "none");
	if (!flagged.length) return { delta: 1, reason: "the danger was never flagged inside the zone before the hit: seen too late" };
	const lead = (hitF - flagged[0]!.f) / fps;
	if (lead < LATE_S) return { delta: 1, reason: `the danger was first flagged ${lead.toFixed(2)} s before the hit: seen too late`, lead };
	return { delta: 0, reason: `the danger was flagged ${lead.toFixed(2)} s before the hit but never confidently enough to fire`, lead };
}

/** Where hazards come from: the planner draws the zone with the player off-centre on the hazard axis (low in the
 *  zone for runners and falling hazards, at the left for side-scrollers), so the far edge is the opposite side of the
 *  player on the axis where it sits most off-centre. Centred player: top (the common case). */
export function farEdge(zone: number[], player?: number[]): "top" | "bottom" | "left" | "right" {
	const [y0, x0, y1, x1] = zone as [number, number, number, number];
	if (!player) return "top";
	const [py, px] = player as [number, number];
	const vOff = (py - (y0 + y1) / 2) / Math.max(1, y1 - y0);
	const hOff = (px - (x0 + x1) / 2) / Math.max(1, x1 - x0);
	if (Math.abs(vOff) < 0.05 && Math.abs(hOff) < 0.05) return "top";
	if (Math.abs(vOff) >= Math.abs(hOff)) return vOff > 0 ? "top" : "bottom";
	return hOff > 0 ? "left" : "right";
}

/** Move the far edge outward (positive `depth`, 0-1000 units) or inward (negative), keeping >= 120 of depth. */
export function applyDepth(zone: number[], depth: number, player?: number[]): [number, number, number, number] {
	let [y0, x0, y1, x1] = zone as [number, number, number, number];
	const e = farEdge(zone, player);
	if (e === "top") y0 = Math.min(y1 - 120, Math.max(0, y0 - depth));
	if (e === "bottom") y1 = Math.max(y0 + 120, Math.min(1000, y1 + depth));
	if (e === "left") x0 = Math.min(x1 - 120, Math.max(0, x0 - depth));
	if (e === "right") x1 = Math.max(x0 + 120, Math.min(1000, x1 + depth));
	return [y0, x0, y1, x1];
}

/** Step size for one lesson: 15% of the zone's depth along the hazard axis, at least 40/1000. */
export function depthStep(zone: number[], player?: number[]): number {
	const [y0, x0, y1, x1] = zone as [number, number, number, number];
	const e = farEdge(zone, player);
	const span = e === "top" || e === "bottom" ? y1 - y0 : x1 - x0;
	return Math.max(40, Math.round(span * 0.15));
}
