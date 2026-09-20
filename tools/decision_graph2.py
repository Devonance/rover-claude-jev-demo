"""The other half of the decision graph: System One *inside* System Two.

Claude's five reasoning tasks (columns on the left) and the typed questions each one puts to jev
while it thinks (middle), with jev's real answers from the ROS 2 run, and what Claude did with
them (right). Same visual language as decision-graph.svg.

  python tools/decision_graph2.py   -> docs/decision-graph-2.svg
"""
import html
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "docs" / "decision-graph-2.svg"
W, H = 2000, 1180
BG, DIM, INK, GOLD, GREEN, BLUE, PURPLE, PINK = "#0b0d10", "#3a4450", "#c9d1d9", "#d9a441", "#4fd18b", "#5aa7e6", "#b48cff", "#ff8fb1"
esc = html.escape
nodes, edges = {}, []
def node(i, x, y, title, sub="", kind="jev", on=False, w=250, h=54): nodes[i] = dict(x=x, y=y, w=w, h=h, title=title, sub=sub, kind=kind, on=on)
def edge(a, b, on=False, style="solid"): edges.append((a, b, on, style))
X_C, X_Q, X_A, X_U = 40, 520, 1040, 1560

# ---- CLAUDE tasks (left)
node("c_plan", X_C, 160, "CLAUDE · plan_sol", "downlink · targets · hypotheses · jev ledger", "claude", True, w=440, h=64)
node("c_interp", X_C, 330, "CLAUDE · interpret", "instrument result vs. hypotheses", "claude", True, w=440, h=64)
node("c_obj", X_C, 500, "CLAUDE · objective", "a human's request vs. the envelope", "claude", True, w=440, h=64)
node("c_report", X_C, 640, "CLAUDE · report", "results vs. expected evidence", "claude", True, w=440, h=64)
node("c_plan3", X_C, 730, "CLAUDE · plan_sol 3 (Rochette)", "abrade → PIXL → core?", "claude", True, w=440, h=64)
node("c_anom", X_C, 810, "CLAUDE · anomaly", "onboard triage + telemetry", "claude", w=440, h=64)
node("c_desc", X_C, 890, "CLAUDE · describe (vision)", "reads the Navcam frame · no jev: perception is the LLM's", "claude", w=440, h=64)

# ---- jev questions Claude asked (middle) — real consultations, sol 1-2 of the ROS 2 run
node("q_score", X_Q, 140, "score · target vs draft criteria ×4", "Máaz 2.98 · Bastide 0.16 · Rochette 0.41 · Yeehgo 0.12  (of 3)", "jev", True, w=480, h=64)
node("q_order", X_Q, 220, "noul · activity order respects the rules", "Máaz 0.74 · drive budget check 0.74", "jev", True, w=480, h=64)
node("q_next", X_Q, 330, "choice · next step at Máaz", "supercam_now 1.00  vs  drive_for_contact", "jev", True, w=480, h=64)
node("q_serves", X_Q, 480, "noul · activity bears on the objective ×2", "LIBS 0.92 · WATSON 0.76", "jev", True, w=480, h=64)
node("q_target", X_Q, 560, "noul · target is what the requester thinks", "dark float = transported Séítah clast? 0.62", "jev", True, w=480, h=64)
node("q_report", X_Q, 640, "noul · report self-check ×3", "= Máaz 0.96 · WATSON justified by rule 0.05 · Séítah clast 0.47", "jev", True, w=480, h=64)
node("q_why", X_Q, 730, "noul · why was the order only 37 %? (follow-up)", "Claude split the check: PIXL before core 0.91 · cleared to core now 0.88", "jev", True, w=480, h=64)
node("q_safe", X_Q, 810, "noul · candidate action safe to command ×4", "resume_visodom · back_up · stop · reimage", "jev", w=480, h=64)
node("q_ms", X_Q, 890, "one request per consultation", "222–361 ms · 1–6 questions", "state", True, w=480, h=54)

# ---- what Claude did with the answer (right)
node("a_plan", X_A, 140, "plan commits Máaz first", "Bastide/Rochette deferred: low scores against *this sol's* criteria", "act", True, w=480, h=64)
node("a_order", X_A, 220, "order kept: Mastcam-Z → LIBS → WATSON", "0.74 ≥ 0.5 — sequencing rule holds", "act", True, w=480, h=64)
node("a_next", X_A, 330, "rationale cites jev", "“jev's choice check confirms supercam_now … confidence 1.0”", "act", True, w=480, h=64)
node("a_obj", X_A, 480, "objective plan: LIBS then WATSON", "both ≥ 0.5 — nothing dropped; approach required", "act", True, w=480, h=64)
node("a_hedge", X_A, 560, "assessment hedged", "0.62 → ‘partial’: worth LIBS first, WATSON only if chemistry says so", "act", True, w=480, h=64)
node("a_report", X_A, 640, "report says so", "“refuted — basalt; WATSON ran on a rule the data did not meet”", "act", True, w=480, h=64)
node("a_why", X_A, 730, "core committed, PIXL first", "a low score became two narrower questions, then a decision", "act", True, w=480, h=64)
node("a_anom", X_A, 810, "action picked from the safe set", "diagnosis + constraints_for_onboard", "act", w=480, h=64)

# ---- then the onboard side takes over (far right)
node("u_verify", X_U, 480, "JEV · verify each step (onboard)", "serves / prerequisites / risk ≥ 0.5 → swimlane", "jev", True, w=400, h=64)
node("u_aegis", X_U, 330, "JEV · AEGIS target selection (onboard)", "score vs. the criteria Claude wrote", "jev", True, w=400, h=64)
node("u_drive", X_U, 140, "CODE · execute the plan", "ENav · Navcam/Hazcam checks · vetoes · ledger → next plan", "code", True, w=400, h=64)

for a, b in (("c_plan", "q_score"), ("c_plan", "q_order"), ("c_interp", "q_next"), ("c_obj", "q_serves"), ("c_obj", "q_target"), ("c_report", "q_report"), ("c_plan3", "q_why")):
    edge(a, b, True, "dashed")
edge("c_anom", "q_safe", False, "dashed")
for a, b in (("q_score", "a_plan"), ("q_order", "a_order"), ("q_next", "a_next"), ("q_serves", "a_obj"), ("q_target", "a_hedge"), ("q_report", "a_report"), ("q_why", "a_why")):
    edge(a, b, True)
edge("q_safe", "a_anom")
edge("a_plan", "u_drive", True); edge("a_order", "u_drive", True); edge("a_next", "u_aegis", True); edge("a_obj", "u_verify", True); edge("a_hedge", "u_verify", True)
edge("u_drive", "c_plan", True, "dashed")  # the ledger closes the loop

def colour(kind): return {"jev": GOLD, "code": BLUE, "claude": PURPLE, "state": DIM, "act": GREEN}[kind]
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="ui-monospace, Consolas, Menlo, monospace">',
       f'<rect width="{W}" height="{H}" fill="{BG}"/>',
       f'<text x="40" y="60" fill="{INK}" font-size="22" font-weight="700">JEZERO OPS · DECISION GRAPH II — SYSTEM ONE INSIDE SYSTEM TWO</text>',
       f'<text x="40" y="86" fill="#7f8b98" font-size="13">what Claude asks jev while it reasons (as an MCP tool), jev\'s real answers from the ROS 2 run, and what Claude did with them · then the onboard side takes over with the criteria Claude wrote</text>',
       f'<text x="{X_C}" y="126" fill="{PURPLE}" font-size="11" letter-spacing="2">CLAUDE · SYSTEM TWO (15–95 s per task)</text>',
       f'<text x="{X_Q}" y="126" fill="{GOLD}" font-size="11" letter-spacing="2">JEV · CONSULTED MID-REASONING (≈300 ms)</text>',
       f'<text x="{X_A}" y="126" fill="{GREEN}" font-size="11" letter-spacing="2">WHAT CLAUDE DID WITH THE ANSWER</text>',
       f'<text x="{X_U}" y="126" fill="{BLUE}" font-size="11" letter-spacing="2">ONBOARD (the other graph)</text>']
def anchor(n, side):
    d = nodes[n]
    return {"r": (d["x"] + d["w"], d["y"] + d["h"] / 2), "l": (d["x"], d["y"] + d["h"] / 2), "b": (d["x"] + d["w"] / 2, d["y"] + d["h"]), "t": (d["x"] + d["w"] / 2, d["y"])}[side]
for a, b, on, style in sorted(edges, key=lambda e: e[2]):
    da, db = nodes[a], nodes[b]
    if db["x"] > da["x"]:
        x1, y1 = anchor(a, "r"); x2, y2 = anchor(b, "l"); mx = (x1 + x2) / 2
        path = f"M{x1},{y1} C{mx},{y1} {mx},{y2} {x2},{y2}"
    else:  # the ledger loop: from the far right back to plan_sol, over the top
        x1, y1 = anchor(a, "t"); x2, y2 = anchor(b, "t")
        path = f"M{x1},{y1} C{x1},{y1-70} {x2},{y2-70} {x2},{y2}"
    col = GREEN if on else DIM
    dash = ' stroke-dasharray="6 5"' if style == "dashed" else ""
    out.append(f'<path d="{path}" fill="none" stroke="{col}" stroke-width="{2.4 if on else 1.2}"{dash} opacity="{1 if on else 0.55}"/>')
for i, d in nodes.items():
    col = colour(d["kind"]); on = d["on"]
    stroke = GREEN if on and d["kind"] not in ("claude", "jev", "code") else col
    fill = "#12181f" if on else "#0f1317"
    out.append(f'<rect x="{d["x"]}" y="{d["y"]}" width="{d["w"]}" height="{d["h"]}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="{2 if on else 1.2}" opacity="{1 if on else 0.72}"/>')
    out.append(f'<text x="{d["x"]+12}" y="{d["y"]+21}" fill="{INK}" font-size="13" font-weight="600">{esc(d["title"])}</text>')
    if d["sub"]: out.append(f'<text x="{d["x"]+12}" y="{d["y"]+41}" fill="{stroke if on else "#7f8b98"}" font-size="11.5">{esc(d["sub"])}</text>')
out.append(f'<text x="40" y="{H-88}" fill="#aab4bf" font-size="12">Measured on the ROS 2 run: 18 Claude calls, 13 of them consulted jev — 13 consultations, 33 questions, 222–361 ms each; the rover itself made 96 jev requests while driving.</text>')
out.append(f'<text x="40" y="{H-68}" fill="#aab4bf" font-size="12">A consultation costs Claude nothing extra: jev answers in the time a token takes. The dashed loop is the onboard ledger fed back into the next plan.</text>')
lx, ly = 40, H - 30
for k, label in (("claude", "Claude task"), ("jev", "jev question · typed answer"), ("act", "Claude's use of the answer"), ("code", "onboard code"), ("state", "cost of the consultation")):
    out.append(f'<rect x="{lx}" y="{ly-12}" width="14" height="14" rx="3" fill="#0f1317" stroke="{colour(k)}" stroke-width="1.5"/><text x="{lx+22}" y="{ly}" fill="#aab4bf" font-size="12">{esc(label)}</text>'); lx += 300
out.append("</svg>")
OUT.write_text("\n".join(out), encoding="utf-8")
print("wrote", OUT, len(nodes), "nodes", len(edges), "edges")
