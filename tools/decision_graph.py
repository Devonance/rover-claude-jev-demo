"""Draw the rover's decision graph as SVG in the TypeSafe-demo style:
state (left) -> jev typed questions with live answers (middle) -> code gates -> actions (right),
Claude's slow loop across the top. The highlighted path is a real cycle from the run:
a bright ripple field -> sand_ripples 1.00 / sinkage 0.74 -> 6 m keep-out -> ENav bends left.

  python tools/decision_graph.py           -> docs/decision-graph.svg
"""
import html
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "docs" / "decision-graph.svg"
W, H = 2000, 1200
BG, DIM, INK, GOLD, GREEN, BLUE, PURPLE, PINK, HOT = "#0b0d10", "#3a4450", "#c9d1d9", "#d9a441", "#4fd18b", "#5aa7e6", "#b48cff", "#ff8fb1", "#ea6a5a"

nodes = {}  # id -> dict(x,y,w,h,title,sub,kind,on)
edges = []  # (a,b,on,style)

def node(i, x, y, title, sub="", kind="jev", on=False, w=250, h=54):
    nodes[i] = dict(x=x, y=y, w=w, h=h, title=title, sub=sub, kind=kind, on=on)
def edge(a, b, on=False, style="solid"):
    edges.append((a, b, on, style))

# ---------------------------------------------------------------- columns
X_STATE, X_Q, X_GATE, X_ACT = 40, 590, 1100, 1630

# CLAUDE, across the top (slow loop)
node("c_plan", 560, 30, "CLAUDE · plan_sol", "criteria → jev; drive goal; budget", "claude", True, w=300)
node("c_interp", 900, 30, "CLAUDE · interpret", "lithology, next_action", "claude", w=260)
node("c_desc", 1200, 30, "CLAUDE · describe (vision)", "reads the Navcam frame", "claude", w=280)
node("c_anom", 1520, 30, "CLAUDE · anomaly", "diagnosis, constraints", "claude", w=240)

# STATE (left)
node("s_feat", X_STATE, 150, "navcam feature v7_0", "bright fine-grained patch ~8 m, low regular ripples · 6.5 m, well left", "state", True, w=470, h=64)
node("s_sun", X_STATE, 240, "sun", "low in the east, long shadows", "state", True, w=470)
node("s_feat2", X_STATE, 320, "navcam feature v7_1", "dark blocky rock 0.3 m · relief 0.19 m · 4.3 m, dead ahead", "state", w=470, h=64)
node("s_crit", X_STATE, 420, "criteria (from CLAUDE)", "“prioritise targets whose tone/texture differs from Máaz…”", "state", w=470, h=64)
node("s_cand", X_STATE, 520, "candidates in view", "Máaz + Navcam read · rock in view 1 · rock in view 2", "state", w=470)
node("s_arm", X_STATE, 600, "arm workspace", "gentle tilt · firm pavement · clear air", "state", w=470)
node("s_tele", X_STATE, 700, "telemetry stream · every sample, 1 Hz", "this sample: 46 % wheel slip over 2 m · VO converged · trends", "state", w=470, h=64)
node("s_obj", X_STATE, 800, "objective (USER)", "“Is this light-toned float a Séítah rock? LIBS + WATSON…”", "state", w=470, h=64)
node("s_plan", X_STATE, 900, "planned activity a0..a2", "Mastcam-Z → LIBS → WATSON · comes_after · uses_the_arm", "state", w=470, h=64)

# JEV questions (middle)
node("q_type", X_Q, 150, "feature_type · choice", "sand_ripples 1.00 · conf 1.00", on=True)
node("q_wheel", X_Q, 220, "wheel_hazard · noul", "0.05", on=True)
node("q_sink", X_Q, 290, "sinkage_risk · noul", "0.74", on=True)
node("q_sci", X_Q, 360, "science_interest · noul", "0.47", on=True)
node("q_match", X_Q, 450, "criteria match · score 0–3", "Máaz 2.97 · conf 0.97")
node("q_inst", X_Q, 520, "instrument · choice", "WATSON_closeup 78 % · LIBS 17 %")
node("q_armok", X_Q, 590, "arm_deploy_safe · noul", "0.96")
node("q_fault", X_Q, 680, "fault_class · choice", "wheel_slip_excess · conf 0.81")
node("q_stop", X_Q, 750, "stop_drive · noul", "0.71")
node("q_ground", X_Q, 820, "needs_ground · noul", "0.58")
node("q_serves", X_Q, 900, "serves_objective · noul ×3", "0.96 · 0.75 · 0.71")
node("q_prereq", X_Q, 970, "prerequisites_met · noul ×3", "0.90 · 0.88 · 0.84")
node("q_risk", X_Q, 1040, "risk_acceptable · noul ×3", "0.92 · 0.90 · 0.65")

# CODE gates
node("g_conf", X_GATE, 150, "conf < 0.55 ?", "no → act on the read", "code", True, w=300)
node("g_shadow", X_GATE, 220, "type == shadow_only ?", "no", "code", True, w=300)
node("g_sink", X_GATE, 290, "sinkage > 0.50 ?", "yes → keep-out r = 6 m", "code", True, w=300)
node("g_wheel", X_GATE, 360, "wheel_hazard > 0.50 || relief ≥ 0.20 ?", "→ perception map", "code", w=300)
node("g_sci", X_GATE, 430, "type == dust_devil && science > 0.60 ?", "→ MEDA movie", "code", w=300)
node("g_enav", X_GATE, 500, "ENav: 9 arcs · tracks + belly · tilt ≤ 20°", "8 of 9 blocked (keep-out) → κ = +0.15", "code", True, w=300, h=64)
node("g_sel", X_GATE, 590, "best match ≥ 1.5 && arm ≥ 0.60 ?", "yes → run planned + suggested", "code", w=300)
node("g_order", X_GATE, 660, "remote before contact; margin 15 %", "scheduler", "code", w=300)
node("g_halt", X_GATE, 740, "stop_drive > 0.50 → halt now", "no Earth round trip", "code", w=300)
node("g_esc", X_GATE, 810, "needs_ground > 0.50 || conf < 0.55 ?", "yes → escalate", "code", w=300)
node("g_verify", X_GATE, 930, "all three ≥ 0.50 ?", "a0 ✓ a1 ✓ a2 ✓ → commit", "code", w=300, h=64)

# ACTIONS (right)
node("a_steer", X_ACT, 150, "steer arc κ = +0.15", "route bends left · flag: jev keep-out", "act", True, w=330)
node("a_keep", X_ACT, 290, "add keep-out (6 m)", "swimlane unchanged", "act", True, w=330)
node("a_reimage", X_ACT, 220, "stop · raise mast · re-image · ask again", "confidence gate", "act", w=330)
node("a_meda", X_ACT, 430, "schedule MEDA + Navcam movie", "8 Wh · 15 min · 30 Mb", "act", w=330)
node("a_inst", X_ACT, 560, "run instruments → CLAUDE interpret", "Mastcam-Z → LIBS → WATSON → PIXL", "act", w=330, h=64)
node("a_halt", X_ACT, 740, "halt drive", "onboard, immediate", "act", w=330)
node("a_esc", X_ACT, 810, "wait for ground → CLAUDE anomaly", "resume with visodom / back up / stop", "act", w=330, h=64)
node("a_commit", X_ACT, 930, "commit to timeline · drive · execute", "then CLAUDE report", "act", w=330, h=64)
node("a_drop", X_ACT, 1030, "drop activity, report why", "jev: does not serve / prerequisite / risk", "act", w=330)

# ---------------------------------------------------------------- edges
for s in ("s_feat", "s_sun"):
    for q in ("q_type", "q_wheel", "q_sink", "q_sci"): edge(s, q, True)
for q in ("q_type", "q_wheel", "q_sink", "q_sci"): edge("s_feat2", q)
edge("q_type", "g_conf", True); edge("g_conf", "a_reimage"); edge("g_conf", "g_shadow", True)
edge("q_type", "g_shadow", True); edge("q_sink", "g_sink", True); edge("g_sink", "a_keep", True); edge("a_keep", "g_enav", True, "dashed")
edge("q_wheel", "g_wheel"); edge("g_wheel", "g_enav", False, "dashed"); edge("q_sci", "g_sci"); edge("g_sci", "a_meda")
edge("g_enav", "a_steer", True)
edge("c_plan", "s_crit", False, "dashed"); edge("s_crit", "q_match"); edge("s_cand", "q_match"); edge("s_cand", "q_inst"); edge("s_arm", "q_armok")
edge("c_desc", "s_cand", False, "dashed")
edge("q_match", "g_sel"); edge("q_inst", "g_sel"); edge("q_armok", "g_sel"); edge("g_sel", "g_order"); edge("g_order", "a_inst"); edge("a_inst", "c_interp", False, "dashed")
edge("s_tele", "q_fault"); edge("s_tele", "q_stop"); edge("s_tele", "q_ground")
edge("q_stop", "g_halt"); edge("g_halt", "a_halt"); edge("q_ground", "g_esc"); edge("q_fault", "g_esc"); edge("g_esc", "a_esc"); edge("a_esc", "c_anom", False, "dashed")
edge("s_obj", "q_serves"); edge("s_plan", "q_serves"); edge("s_plan", "q_prereq"); edge("s_arm", "q_risk")
edge("q_serves", "g_verify"); edge("q_prereq", "g_verify"); edge("q_risk", "g_verify"); edge("g_verify", "a_commit"); edge("g_verify", "a_drop")

# ---------------------------------------------------------------- render
def esc(s): return html.escape(s, quote=True)
def colour(kind):
    return {"jev": GOLD, "code": BLUE, "claude": PURPLE, "state": DIM, "act": GREEN}[kind]

out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="ui-monospace, Consolas, Menlo, monospace">',
       f'<rect width="{W}" height="{H}" fill="{BG}"/>',
       f'<text x="40" y="70" fill="{INK}" font-size="22" font-weight="700">JEZERO OPS · DECISION GRAPH</text>',
       f'<text x="40" y="96" fill="#7f8b98" font-size="13">state → jev typed questions (live answers) → code gates → actions · highlighted: one real NAVCAM planning cycle, sol 1, odometer 57 m — a ripple field becomes a keep-out and the route bends</text>',
       f'<text x="{X_STATE}" y="136" fill="#7f8b98" font-size="11" letter-spacing="2">STATE (words &amp; structured fields)</text>',
       f'<text x="{X_Q}" y="136" fill="{GOLD}" font-size="11" letter-spacing="2">JEV · SYSTEM ONE (≈250 ms, one request per column)</text>',
       f'<text x="{X_GATE}" y="136" fill="{BLUE}" font-size="11" letter-spacing="2">CODE · GATES &amp; GEOMETRY</text>',
       f'<text x="{X_ACT}" y="136" fill="{GREEN}" font-size="11" letter-spacing="2">ACTIONS</text>',
       f'<text x="{X_Q}" y="18" fill="{PURPLE}" font-size="11" letter-spacing="2">CLAUDE · SYSTEM TWO (15–80 s, a few times per sol)</text>']

def anchor(n, side):
    d = nodes[n]
    if side == "r": return d["x"] + d["w"], d["y"] + d["h"] / 2
    if side == "l": return d["x"], d["y"] + d["h"] / 2
    if side == "b": return d["x"] + d["w"] / 2, d["y"] + d["h"]
    return d["x"] + d["w"] / 2, d["y"]

# edges first (under nodes)
for a, b, on, style in sorted(edges, key=lambda e: e[2]):
    da, db = nodes[a], nodes[b]
    if db["y"] < 120 or da["y"] < 120:  # to/from the Claude row
        x1, y1 = anchor(a, "t") if da["y"] > db["y"] else anchor(a, "b")
        x2, y2 = anchor(b, "b") if da["y"] > db["y"] else anchor(b, "t")
        path = f"M{x1},{y1} C{x1},{(y1+y2)/2} {x2},{(y1+y2)/2} {x2},{y2}"
    elif db["x"] > da["x"]:
        x1, y1 = anchor(a, "r"); x2, y2 = anchor(b, "l")
        mx = (x1 + x2) / 2
        path = f"M{x1},{y1} C{mx},{y1} {mx},{y2} {x2},{y2}"
    else:
        x1, y1 = anchor(a, "l"); x2, y2 = anchor(b, "r")
        mx = (x1 + x2) / 2; my = max(y1, y2) + 34
        path = f"M{x1},{y1} C{mx},{y1} {mx},{my} {(x1+x2)/2},{my} S{x2},{my} {x2},{y2}"
    col = GREEN if on else DIM
    dash = ' stroke-dasharray="6 5"' if style == "dashed" else ""
    out.append(f'<path d="{path}" fill="none" stroke="{col}" stroke-width="{2.4 if on else 1.2}"{dash} opacity="{1 if on else 0.55}"/>')

for i, d in nodes.items():
    col = colour(d["kind"])
    on = d["on"]
    stroke = GREEN if on and d["kind"] != "claude" else col
    fill = "#12181f" if on else "#0f1317"
    out.append(f'<rect x="{d["x"]}" y="{d["y"]}" width="{d["w"]}" height="{d["h"]}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="{2 if on else 1.2}" opacity="{1 if on or d["kind"] in ("claude",) else 0.72}"/>')
    out.append(f'<text x="{d["x"]+12}" y="{d["y"]+21}" fill="{INK if on or d["kind"]!="state" else "#aab4bf"}" font-size="13" font-weight="600">{esc(d["title"])}</text>')
    if d["sub"]:
        out.append(f'<text x="{d["x"]+12}" y="{d["y"]+40}" fill="{stroke if on else "#7f8b98"}" font-size="11.5">{esc(d["sub"])}</text>')

# legend
lx, ly = 40, 1120
for k, label in (("state", "state (filtered, words)"), ("jev", "jev question · typed answer"), ("code", "code gate / geometry"), ("act", "action"), ("claude", "Claude (slow loop, dashed)")):
    out.append(f'<rect x="{lx}" y="{ly-12}" width="14" height="14" rx="3" fill="#0f1317" stroke="{colour(k)}" stroke-width="1.5"/><text x="{lx+22}" y="{ly}" fill="#aab4bf" font-size="12">{esc(label)}</text>')
    lx += 260
out.append(f'<rect x="{lx}" y="{ly-12}" width="14" height="14" rx="3" fill="#12181f" stroke="{GREEN}" stroke-width="2"/><text x="{lx+22}" y="{ly}" fill="#aab4bf" font-size="12">taken this cycle</text>')
# This graph is one Navcam planning cycle. It is not the whole drive loop: before any wheel
# is committed every camera pair is asked at once, and the arm has its own collision gates.
out.append(f'<text x="40" y="{ly+30}" fill="#7f8b98" font-size="12">One Navcam planning cycle. The near-field check before every wheel commit asks all four camera pairs in one request, and the arm has its own collision gates — see decision-graph-3 for all fourteen uses of jev.</text>')
out.append("</svg>")
OUT.write_text("\n".join(out), encoding="utf-8")
print("wrote", OUT, len(nodes), "nodes", len(edges), "edges")
