"""Write the two data-driven figure sources from the deliverables:
     eval-separation.html  chosen cut vs the two naive baseline cuts, per playable
     edl-timeline.html     how one session (Castle Toss) becomes a 20 s cut
   python3 docs/figures/src/build_data_figures.py   (then: node docs/figures/src/render.cjs)
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DELIV = HERE.parents[2] / "deliverables"

GROUPS = [
    ("Samples from the brief", [("boom-castle", "Boom Castle", "2D tower defense, drag to aim"), ("word-hunt", "Word Hunt", "DOM word puzzle, swipe letters"),
                                ("raid-shard-market", "Raid: Shard Market", "3D resource game, joystick"), ("west-game-ii", "West Game II", "3D town defense, joystick")]),
    ("Generated for this project", [("castle-toss", "Castle Toss", "2D physics slingshot"), ("bakery-rush", "Bakery Rush", "DOM idle clicker"),
                                    ("neon-lanes", "Neon Lanes", "raw-WebGL 3D runner, reflexes"), ("orb-merge", "Orb Merge", "2D merge puzzle")]),
    ("Hold-out, never used during development", [("gem-swap", "Gem Swap", "match-3"), ("sky-stack", "Sky Stack", "raw-WebGL 3D timing stacker"),
                                                 ("comet-dodge", "Comet Dodge", "2D dodger, hold to steer")]),
]
CALIB = ("word-hunt-random-player", "Word Hunt, random player", "random taps, machine timing, no model")

HEAD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title><link rel="stylesheet" href="base.css">
<style>{css}</style></head><body><div class="fig">
"""
TAIL = "</div></body></html>\n"


def load_eval(game):
    ev = json.loads((DELIV / game / "eval.json").read_text())
    c = {x["id"]: x for x in ev["candidates"]}
    best = c[ev["best"]]
    vs = ev.get("vs_baseline") or {}
    return {"score": ev["score"], "first": c["base_first"]["score"], "random": c["base_random"]["score"], "sep": ev["separation"],
            "J": best["judge"]["J"], "H": best["heuristics"]["H"], "wins": vs.get("chosen_wins"), "of": vs.get("of"), "orders": vs.get("orders")}


def eval_figure():
    X0, X1, LO, HI = 400, 1050, 20, 100
    x = lambda v: X0 + (v - LO) / (HI - LO) * (X1 - X0)
    rows, y = [], 64
    svg = []
    for title, games in GROUPS + [("Calibration: bad play instead of bad editing", [CALIB])]:
        svg.append(f'<text x="0" y="{y}" class="grp">{title}</text>')
        y += 2
        for gid, name, kind in games:
            y += 38
            e = load_eval(gid)
            rows.append((y, e))
            lo = min(e["first"], e["random"], e["score"])
            svg.append(f'<text x="0" y="{y + 1}" class="name">{name}</text><text x="0" y="{y + 17}" class="kind">{kind}</text>')
            svg.append(f'<line x1="{x(lo):.1f}" y1="{y}" x2="{x(e["score"]):.1f}" y2="{y}" class="conn"/>')
            fx, rx, sx = x(e["first"]), x(e["random"]), x(e["score"])
            svg.append(f'<circle cx="{fx:.1f}" cy="{y}" r="6" class="first"/>')
            svg.append(f'<rect x="{rx - 5.5:.1f}" y="{y - 5.5}" width="11" height="11" transform="rotate(45 {rx:.1f} {y})" class="rand"/>')
            svg.append(f'<circle cx="{sx:.1f}" cy="{y}" r="8" class="chosen"/>')
            svg.append(f'<text x="{sx + 14:.1f}" y="{y + 4.5}" class="val">{e["score"]:.1f}</text>')
            h2h = "tie, tie" if e["wins"] == 0 and e["orders"] == ["tie", "tie"] else f'{e["wins"]} of {e["of"]}'
            if gid == CALIB[0]:
                h2h = "tie, tie"
            sep = f'+{e["sep"]:.1f}' if e["sep"] >= 0 else f'{e["sep"]:.1f}'
            svg.append(f'<text x="1112" y="{y + 4.5}" class="col">{sep}</text><text x="1198" y="{y + 4.5}" class="col">{h2h}</text>')
            svg.append(f'<text x="1400" y="{y + 4.5}" class="col" text-anchor="end">{e["J"]:.1f} · {e["H"]:.1f}</text>')
        y += 44
    top, bottom = 34, y - 30
    grid = "".join(f'<line x1="{x(v):.1f}" y1="{top}" x2="{x(v):.1f}" y2="{bottom}" class="grid"/><text x="{x(v):.1f}" y="{bottom + 18}" class="tick">{v}</text>' for v in range(LO, HI + 1, 10))
    passl = f'<line x1="{x(70):.1f}" y1="{top - 8}" x2="{x(70):.1f}" y2="{bottom}" class="pass"/><text x="{x(70) + 6:.1f}" y="{top - 2}" class="tick" text-anchor="start">pass score 70</text>'
    hdr = f'<text x="1112" y="{top - 2}" class="colh">separation</text><text x="1198" y="{top - 2}" class="colh">head to head</text><text x="1400" y="{top - 2}" class="colh" text-anchor="end">judge · heuristics</text>'
    css = """
      svg text { font-family: Inter, system-ui, sans-serif; }
      .grp { font-size: 13px; font-weight: 650; fill: var(--ink); }
      .name { font-size: 14px; font-weight: 600; fill: var(--ink); } .kind { font-size: 11.5px; fill: var(--muted); }
      .grid { stroke: var(--hair); stroke-width: 1; } .tick { font-size: 11.5px; fill: var(--muted); text-anchor: middle; font-variant-numeric: tabular-nums; }
      .pass { stroke: var(--axis); stroke-width: 1.5; }
      .conn { stroke: var(--axis); stroke-width: 2; }
      .first { fill: var(--surface); stroke: #7d7b75; stroke-width: 2; } .rand { fill: #a9a8a1; stroke: var(--surface); stroke-width: 2; }
      .chosen { fill: var(--blue); stroke: var(--surface); stroke-width: 2; }
      .val { font-size: 13px; font-weight: 650; fill: var(--ink); font-variant-numeric: tabular-nums; }
      .col { font-size: 12.5px; fill: var(--ink2); font-variant-numeric: tabular-nums; } .colh { font-size: 11.5px; fill: var(--muted); font-weight: 600; }
      .legend { display: flex; gap: 22px; font-size: 13px; color: var(--ink2); margin: 0 0 6px; align-items: center; }
      .legend svg { vertical-align: -3px; margin-right: 6px; }
    """
    legend = ('<div class="legend">'
              '<span><svg width="18" height="18"><circle cx="9" cy="9" r="7" class="chosen"/></svg>chosen cut (the delivered highlight)</span>'
              '<span><svg width="18" height="18"><circle cx="9" cy="9" r="5.5" class="first"/></svg>naive baseline: the first 20 s, uncut</span>'
              '<span><svg width="18" height="18"><rect x="4" y="4" width="10" height="10" transform="rotate(45 9 9)" class="rand"/></svg>naive baseline: five random 4 s clips</span>'
              '</div>')
    body = ('<h1>Does the evaluator tell a real edit from a lazy one?</h1>'
            '<p class="sub">Score = gate × (0.55 × judge + 0.45 × heuristics), 0–100. Two naive cuts of the same session go through the same evaluator as a control group. '
            'Head to head is the judge comparing the chosen cut with the stronger baseline, in both orders.</p>' + legend +
            f'<svg width="1400" height="{y - 8}" viewBox="0 0 1400 {y - 8}">{grid}{passl}{hdr}{"".join(svg)}</svg>'
            '<p class="note">Word Hunt lasts 26 s in total, so its first 20 s already are the whole story: the evaluator calls that a tie. '
            'The random player scores 54.4 because the judge gives it 28.3 (“no coherent play”); motion-based heuristics alone would have passed it at 86.4, which is why the judge carries the larger weight.</p>')
    (HERE / "eval-separation.html").write_text(HEAD.format(title="Evaluator separation", css=css) + body + TAIL)


ROLE = {"hook": ("var(--orange)", "#fff"), "core_loop": ("var(--blue)", "#fff"), "feature": ("var(--violet)", "#fff"), "progression": ("var(--aqua)", "#fff"),
        "climax": ("var(--magenta)", "#fff"), "end_card": ("var(--yellow)", "#0b0b0b")}
KIND_ROLE = {"hook": "hook", "core_loop": "core_loop", "feature": "feature", "upgrade": "feature", "progression": "progression", "reward": "progression",
             "climax": "climax", "end_card": "end_card"}
ROLE_NAME = {"hook": "hook", "core_loop": "core loop", "feature": "feature", "progression": "progression", "climax": "climax", "end_card": "end card"}


def anchor(t, total):
    """Keep the first and last axis labels inside the drawing."""
    return ' style="text-anchor:start"' if t == 0 else ' style="text-anchor:end"' if t >= total - 0.5 else ""


def edl_figure(game="castle-toss", title="Castle Toss"):
    ev = json.loads((DELIV / game / "eval.json").read_text())
    edl = json.loads((DELIV / game / f"edl_{ev['best']}.json").read_text())
    ix = json.loads((DELIV / game / "moments.json").read_text())
    acts = [json.loads(l) for l in (DELIV / game / "actions.jsonl").read_text().splitlines() if l.strip()]
    D, W = ix["duration"], 1400
    sx = lambda t: t / D * W
    out_len = sum((c["end"] - c["start"]) / c["speed"] for c in edl["clips"])
    ox = lambda t: t / out_len * W
    TOP, LANE_H, GAP = 28, 92, 150
    s = []
    # session lane: moments as bars, height = intensity
    base = TOP + LANE_H
    for m in ix["moments"]:
        role = KIND_ROLE.get(m["kind"])
        fill = ROLE[role][0] if role else "#d7d6cf"
        h = 14 + m["intensity"] * 15
        s.append(f'<rect x="{sx(m["start"]) + 1:.1f}" y="{base - h:.1f}" width="{max(2, sx(m["end"] - m["start"]) - 2):.1f}" height="{h:.1f}" rx="3" fill="{fill}" opacity="{0.38 if role else 0.7}"/>')
    # finger gestures as ticks under the lane
    for a in acts:
        if a["kind"] != "wait":
            s.append(f'<rect x="{sx(a["t0"]):.1f}" y="{base + 5}" width="{max(2, sx(a["t1"] - a["t0"])):.1f}" height="5" rx="2" fill="var(--ink2)" opacity="0.55"/>')
    s.append(f'<line x1="0" y1="{base}" x2="{W}" y2="{base}" stroke="var(--axis)"/>')
    for t in range(0, int(D) + 1, 5):
        s.append(f'<text x="{sx(t):.1f}" y="{base + 28}" class="tick"{anchor(t, D)}>{t} s</text>')
    # output lane and connectors
    oy = base + GAP
    t_out = 0.0
    for i, c in enumerate(edl["clips"]):
        col, ink = ROLE[c["role"]]
        ln = (c["end"] - c["start"]) / c["speed"]
        a0, a1, b0, b1 = sx(c["start"]), sx(c["end"]), ox(t_out), ox(t_out + ln)
        s.append(f'<path d="M{a0:.1f},{base + 14} L{a1:.1f},{base + 14} L{b1 - 1:.1f},{oy} L{b0 + 1:.1f},{oy} Z" fill="{col}" opacity="0.16"/>')
        s.append(f'<rect x="{a0:.1f}" y="{TOP - 4}" width="{a1 - a0:.1f}" height="{LANE_H + 4}" rx="4" fill="none" stroke="{col}" stroke-width="2.5"/>')
        s.append(f'<circle cx="{(a0 + a1) / 2:.1f}" cy="{TOP - 4}" r="10" fill="{col}" stroke="var(--surface)" stroke-width="2"/><text x="{(a0 + a1) / 2:.1f}" y="{TOP}" class="badge" fill="{ink}">{i + 1}</text>')
        s.append(f'<rect x="{b0 + 1:.1f}" y="{oy}" width="{b1 - b0 - 2:.1f}" height="64" rx="6" fill="{col}"/>')
        speed = f' · {c["speed"]:g}×' if c["speed"] > 1 else ""
        s.append(f'<text x="{b0 + 9:.1f}" y="{oy + 22}" class="role" fill="{ink}">{i + 1} · {ROLE_NAME[c["role"]]}</text>')
        s.append(f'<text x="{b0 + 9:.1f}" y="{oy + 40}" class="src" fill="{ink}">{c["start"]:.1f}–{c["end"]:.1f} s{speed}</text>')
        s.append(f'<text x="{b0 + 9:.1f}" y="{oy + 55}" class="src" fill="{ink}">{ln:.1f} s on screen</text>')
        t_out += ln
    for t in range(0, int(round(out_len)) + 1, 2):
        s.append(f'<text x="{ox(t):.1f}" y="{oy + 84}" class="tick"{anchor(t, out_len)}>{t} s</text>')
    H = oy + 96
    css = """
      svg text { font-family: Inter, system-ui, sans-serif; }
      .tick { font-size: 11.5px; fill: var(--muted); text-anchor: middle; font-variant-numeric: tabular-nums; }
      .badge { font-size: 11.5px; font-weight: 700; text-anchor: middle; }
      .role { font-size: 13px; font-weight: 650; } .src { font-size: 11.5px; opacity: 0.92; font-variant-numeric: tabular-nums; }
      .lab { font-size: 12.5px; font-weight: 600; color: var(--ink2); margin: 14px 0 6px; }
      .legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12.5px; color: var(--ink2); margin: 0 0 4px; }
      .legend i { display: inline-block; width: 13px; height: 13px; border-radius: 3px; vertical-align: -2px; margin-right: 6px; }
      .rules { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
      .rules span { font-size: 12.5px; padding: 5px 11px; border-radius: 999px; background: var(--gray-t); color: var(--ink2); }
      .rules b { color: var(--ink); font-weight: 600; }
    """
    legend = '<div class="legend">' + "".join(f'<span><i style="background:{ROLE[r][0]}"></i>{ROLE_NAME[r]}</span>' for r in ROLE) + \
        '<span><i style="background:#d7d6cf"></i>tutorial, idle</span><span><i style="background:var(--ink2);height:5px;vertical-align:3px;opacity:.55"></i>finger on the screen</span></div>'
    body = (f'<h1>From a {D:.0f}-second session to a 20-second cut ({title}, strategy “{edl["strategy"]}”)</h1>'
            '<p class="sub">The director labels every moment of the session and rates its intensity from 1 to 5 (bar height). The editor picks and orders clips; '
            'here the best moment of the session opens the ad and the rest runs in order. Code then makes the numbers exact.</p>' + legend +
            f'<div class="lab">The session as played, with the moments the director logged</div>'
            f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">{"".join(s)}'
            f'<text x="0" y="{oy - 12}" style="font-size:12.5px;font-weight:600;fill:var(--ink2)">The highlight, in edit order</text></svg>'
            '<div class="rules"><span><b>exactly 20.0 s</b> (600 frames)</span><span>speed <b>1.0–1.5×</b></span><span><b>≤ 30 s</b> of source</span>'
            '<span><b>no cut</b> while a finger is on the screen</span><span>dead air ≥ 1.5 s trimmed to <b>~1 s</b> of pause</span>'
            '<span>end card <b>last</b>, at most 3 s</span></div>')
    (HERE / "edl-timeline.html").write_text(HEAD.format(title="EDL timeline", css=css) + body + TAIL)


if __name__ == "__main__":
    eval_figure()
    edl_figure()
    print("wrote eval-separation.html, edl-timeline.html")
