"""Decision graph III — jev everywhere a real rover would use a fast calibrated judge.
One row per use: the stream it reads (words code makes), the typed questions, the rate, the rule that
consumes the answer and the flight rule it enforces. Same visual language as graphs I and II.

  python tools/decision_graph3.py -> docs/decision-graph-3.svg
"""
import html
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "docs" / "decision-graph-3.svg"
W, H = 2000, 1310
BG, DIM, INK, GOLD, GREEN, BLUE, PURPLE, PINK = "#0b0d10", "#3a4450", "#c9d1d9", "#d9a441", "#4fd18b", "#5aa7e6", "#b48cff", "#ff8fb1"
esc = html.escape
X = [40, 520, 1000, 1500]  # stream | questions | cadence+rule | action
COLW = [440, 440, 460, 460]
ROWS = [
 ("Navcam pair (planning horizon)", "features: appearance, size, position, stereo note", "type (Choice ×6) · wheel hazard · sinkage · science (Noul)", "every 6 m · 1 request", "perception map · 6 m keep-out · opportunistic science · conf < 0.55 → re-image  [FR-04/05/08]", "code"),
 ("ground ahead", "corridor description: pavement, rocks, bright patches", "class (Choice ×4: bedrock · cobble · regolith · sand)", "with the Navcam frame", "predicted slip 5/12/20/45 % → energy & time per metre  [FR-14]", "code"),
 ("Navcam frame quality", "features counted, shadowed fraction, sun, exposure", "usable (Noul) · cause (Choice ×5)", "with the Navcam frame", "P(usable) < 0.5 → do not plan on it; mast pan, re-image  [FR-08]", "code"),
 ("front Hazcam pairs (near field)", "features 0.3–4 m beyond the wheel line", "same four, wheel-scale: about to roll onto it?", "before every 3 m segment + mid-arc", "veto → perception map / 3 m keep-out; ENav re-plans before a wheel moves  [FR-06]", "code"),
 ("rear Hazcam pair", "features behind the rover", "same, mirrored", "before any reverse", "reverse only on imaged, judged ground  [FR-07]", "code"),
 ("rover health (telemetry 1 Hz)", "SOC, battery temp, actuator currents, slip, VO, tilt, suspension, dust — in words", "fault class (Choice ×8) · stop drive · needs ground (Noul)", "on change, or every 10 s while driving", "stop > 0.5 → halt now; ground > 0.5 → Claude anomaly action; class change → cancel & re-issue  [FR-11]", "code"),
 ("sequence review before uplink", "every planned activity: instrument, measures, purpose, order, arm", "serves · prerequisites · risk (Noul each)", "once per sol, 1 request", "drop what fails, report to the planners; the rest is uplinked  [FR-10]", "code"),
 ("science stop (AEGIS-style)", "candidates in view + Claude's Navcam read + the criteria", "match (Score 0–3) · instrument (Choice ×5) · arm safe (Noul)", "each stop, 1 request", "selection rule; arm rule: 0.6 floor  [FR-09]", "code"),
 ("arm placement (each contact-science activity)", "candidate spots code derives from the rock geometry: attitude, reach, light, dust, roughness, height", "placement quality (Score 0–3) · collision risk (Noul), per spot", "each arm activity, 1 request", "best spot with quality ≥ 1.25, collision < 0.5, inside the workspace, else no contact science; code moves the arm  [FR-09]", "code"),
 ("pre-contact check (hover, 30 cm over the spot)", "workspace in words: placement-solution error, surface tilt, clearance, rendered-surface hit", "safe to contact · good data (Noul) · next (Choice ×3)", "each placement, 1 request", "safe ≥ 0.5 → lower to contact and measure; else the next spot once, or stow  [FR-09]", "code"),
 ("core decision", "target, evidence in hand, campaign goal", "defensible · coherent (Noul) · missing (Choice ×5)", "before any core", "core withheld with the missing step named, else committed  [FR-10]", "code"),
 ("relay pass", "data products: instrument, target, content, size; the hypotheses", "value if sent now (Score 0–3) per product", "each pass, 1 request", "order by score, fill the pass minus a 40 Mb engineering reserve  [FR-02]", "code"),
 ("user objective", "requester's text, the target, the draft activities", "serves · prerequisites · risk (Noul each)", "each objective", "commit survivors to the swimlane; drive; execute; Claude reports  [FR-12]", "code"),
 ("inside Claude's reasoning", "whatever the planner assembles: draft criteria, candidate order, evidence", "score · order check · tie-break · self-audit (as asked)", "~1 per Claude task, MCP tool", "evidence Claude weighs and cites; captured under its card; counted in the HUD", "claude"),
]
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="ui-monospace, Consolas, Menlo, monospace">',
       f'<rect width="{W}" height="{H}" fill="{BG}"/>',
       f'<text x="40" y="60" fill="{INK}" font-size="22" font-weight="700">JEZERO OPS · DECISION GRAPH III — WHERE A FAST CALIBRATED JUDGE IS USED ON THE ROVER</text>',
       f'<text x="40" y="86" fill="#7f8b98" font-size="13">fourteen uses of jev in the ROS 2 graph · every one is a closed question over words that code made from numbers · every answer is consumed by a rule that names its flight rule</text>',
       f'<text x="{X[0]}" y="126" fill="#7f8b98" font-size="11" letter-spacing="2">STREAM (what code turns into words)</text>',
       f'<text x="{X[1]}" y="126" fill="{GOLD}" font-size="11" letter-spacing="2">JEV · TYPED QUESTIONS</text>',
       f'<text x="{X[2]}" y="126" fill="{BLUE}" font-size="11" letter-spacing="2">CADENCE</text>',
       f'<text x="{X[3]}" y="126" fill="{GREEN}" font-size="11" letter-spacing="2">RULE THAT CONSUMES THE ANSWER</text>']
y = 150; RH = 74
def wrap(t, n):
    words, lines, cur = t.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > n: lines.append(cur); cur = w
        else: cur = (cur + " " + w).strip()
    if cur: lines.append(cur)
    return lines[:3]
for i, (stream, words, qs, rate, rule, kind) in enumerate(ROWS):
    col_stroke = PURPLE if kind == "claude" else DIM
    out.append(f'<rect x="{X[0]}" y="{y}" width="{COLW[0]}" height="{RH-8}" rx="8" fill="#0f1317" stroke="{col_stroke}" stroke-width="1.2"/>')
    out.append(f'<text x="{X[0]+12}" y="{y+22}" fill="{INK}" font-size="13" font-weight="600">{i+1}. {esc(stream)}</text>')
    for j, l in enumerate(wrap(words, 62)): out.append(f'<text x="{X[0]+12}" y="{y+40+j*14}" fill="#7f8b98" font-size="11">{esc(l)}</text>')
    out.append(f'<rect x="{X[1]}" y="{y}" width="{COLW[1]}" height="{RH-8}" rx="8" fill="#12181f" stroke="{GOLD}" stroke-width="1.5"/>')
    for j, l in enumerate(wrap(qs, 60)): out.append(f'<text x="{X[1]+12}" y="{y+24+j*15}" fill="{GOLD if j == 0 else "#c9b98a"}" font-size="12">{esc(l)}</text>')
    out.append(f'<rect x="{X[2]}" y="{y}" width="{COLW[2]}" height="{RH-8}" rx="8" fill="#0f1317" stroke="{BLUE}" stroke-width="1.2"/>')
    for j, l in enumerate(wrap(rate, 62)): out.append(f'<text x="{X[2]+12}" y="{y+24+j*15}" fill="{BLUE}" font-size="12">{esc(l)}</text>')
    out.append(f'<rect x="{X[3]}" y="{y}" width="{COLW[3]}" height="{RH-8}" rx="8" fill="#12181f" stroke="{GREEN}" stroke-width="1.5"/>')
    for j, l in enumerate(wrap(rule, 62)): out.append(f'<text x="{X[3]+12}" y="{y+22+j*14}" fill="{GREEN if j == 0 else "#9fd9b6"}" font-size="11.5">{esc(l)}</text>')
    for a, b in ((X[0]+COLW[0], X[1]), (X[1]+COLW[1], X[2]), (X[2]+COLW[2], X[3])):
        out.append(f'<path d="M{a},{y+33} L{b},{y+33}" stroke="{DIM}" stroke-width="1.2"/>')
    y += RH
out.append(f'<text x="40" y="{H-52}" fill="#aab4bf" font-size="12">Measured on the recorded run: see docs/ros2/stats-final.txt — onboard jev requests by use, Claude actions with feedback and one cancel/re-issue, zero node errors. Rows 1–13 are services (200–500 ms); row 14 is an MCP tool call inside a Claude action.</text>')
out.append(f'<text x="40" y="{H-30}" fill="#aab4bf" font-size="12">What jev is never asked: what to do next. That is a rule, and every rule cites the flight rule it enforces.</text>')
out.append("</svg>")
OUT.write_text("\n".join(out), encoding="utf-8")
print("wrote", OUT, len(ROWS), "rows")
