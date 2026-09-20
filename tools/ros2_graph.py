"""Draw the Jezero Ops ROS 2 graph (nodes, topics, services) as an SVG, rqt_graph style but
legible: engines coloured like the console (purple Claude, green jev, blue code, gold sim).
  python tools/ros2_graph.py  -> docs/ros2/graph.svg (+ PNG via tools/_svg2png.mjs if present)"""
import io, os
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "ros2", "graph.svg")
W, H = 1780, 1000
C = {"sim": "#e6b45a", "code": "#5aa7e6", "jev": "#4fd18b", "claude": "#b48cff", "bridge": "#9aa5b1", "ink": "#e8edf2", "ink2": "#aab4bf", "bg": "#0b0e12", "panel": "#12161c", "line": "#2a323c"}

NODES = [  # id, label, sub, engine, x, y
    ("sim", "browser simulator", "three.js · terrain, rover motion, 9-camera rig, HUD (roslibjs)", "sim", 60, 380),
    ("bridge", "/rosbridge_websocket", "ws://localhost:9090 · JSON ⇄ DDS", "bridge", 400, 380),
    ("perc", "/perception", "cloud → relief → blobs → words", "code", 760, 120),
    ("enav", "/enav", "9 arcs × 6 m · tracks + belly · tilt · cost map", "code", 760, 640),
    ("exec", "/sol_executive", "py_trees executive · safety branch · gates · ledger", "code", 1130, 380),
    ("jev", "/jev_judge", "TypeSafe jev · questions → probabilities", "jev", 1440, 200),
    ("claude", "/claude_planner", "ACTION servers · claude CLI + jev MCP tool", "claude", 1440, 560),
    ("health", "/health_monitor", "jev on the telemetry stream · continuous", "jev", 60, 760),
]
EDGES = [  # from, to, label, kind(topic|srv), engine colour
    ("sim", "bridge", "", "topic", "bridge"),
    ("bridge", "perc", "/navcam/points  PointCloud2 (per camera pair)\n/sim/heightmap  HeightMap", "topic", "sim"),
    ("bridge", "exec", "/rover/state 10 Hz · /rover/cmd_done · /sim/ready\n/ops/user_objective · /navcam/image/compressed", "topic", "sim"),
    ("exec", "bridge", "/rover/cmd · /navcam/trigger (group, boost) · /sim/view\n/ops/hud · /ops/timeline · /ops/decisions · /ops/tree · /ops/downlink", "topic", "code"),
    ("perc", "exec", "/perception/features  FeatureArray", "topic", "code"),
    ("exec", "enav", "/enav/evaluate (srv): pose, goal, reverse → 9 arcs + lookahead", "srv", "code"),
    ("exec", "enav", "/perception/map · /nav/keepouts", "topic", "code"),
    ("bridge", "enav", "/sim/heightmap", "topic", "sim"),
    ("exec", "jev", "/jev/classify (Navcam + Hazcam) · /jev/aegis · /jev/verify (objectives + sequence review)\n/jev/judge: frame usability · downlink priority · sample defensibility   (srv, 200-500 ms)", "srv", "jev"),
    ("exec", "claude", "/claude/ask · /claude/describe  (ACTIONS: feedback = phase/turns/consults, cancel)\nplan | interpret | objective | report | anomaly · 15-105 s", "srv", "claude"),
    ("bridge", "health", "/rover/telemetry 1 Hz", "topic", "sim"),
    ("health", "exec", "/health/verdict (fault class, stop, needs ground)", "topic", "jev"),
]


def node_xy(n):
    for id_, *_r in NODES:
        if id_ == n:
            return _r[3], _r[4]


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="ui-monospace, Consolas, monospace">',
     f'<rect width="{W}" height="{H}" fill="{C["bg"]}"/>',
     f'<text x="40" y="52" font-size="26" font-weight="700" fill="{C["ink"]}">JEZERO OPS · ROS 2 JAZZY GRAPH</text>',
     f'<text x="40" y="80" font-size="13" fill="{C["ink2"]}">browser = simulator (sensors, motion, rendering) · nodes = the decisions · every edge is a typed jezero_msgs interface · services for judgments, topics for sensors and state</text>',
     '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="#6b7783"/></marker></defs>']
BW, BH = 300, 74
for id_, label, sub, eng, x, y in NODES:
    col = C[eng]
    o.append(f'<rect x="{x}" y="{y}" width="{BW}" height="{BH}" rx="8" fill="{C["panel"]}" stroke="{col}" stroke-width="2"/>')
    o.append(f'<text x="{x + 14}" y="{y + 30}" font-size="16" font-weight="700" fill="{C["ink"]}">{esc(label)}</text>')
    o.append(f'<text x="{x + 14}" y="{y + 54}" font-size="11.5" fill="{col}">{esc(sub)}</text>')
for i, (a, b, label, kind, eng) in enumerate(EDGES):
    ax, ay = node_xy(a); bx, by = node_xy(b)
    # anchor on box edges
    if bx > ax + BW: x1, y1, x2, y2 = ax + BW, ay + BH / 2, bx, by + BH / 2
    elif ax > bx + BW: x1, y1, x2, y2 = ax, ay + BH / 2, bx + BW, by + BH / 2
    else: x1, y1, x2, y2 = ax + BW / 2, ay + (BH if by > ay else 0), bx + BW / 2, by + (0 if by > ay else BH)
    # spread parallel edges
    same = [j for j, e in enumerate(EDGES) if {e[0], e[1]} == {a, b}]
    k = same.index(i) - (len(same) - 1) / 2
    off = 22 * k; loff = 40 * k
    if abs(y2 - y1) < abs(x2 - x1): y1 += off; y2 += off
    else: x1 += off; x2 += off
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    dash = ' stroke-dasharray="7 5"' if kind == "srv" else ""
    o.append(f'<path d="M{x1} {y1} C {mx} {y1}, {mx} {y2}, {x2} {y2}" fill="none" stroke="{C[eng]}" stroke-width="1.8" opacity="0.9"{dash} marker-end="url(#a)"/>')
    if label:
        lines = label.split("\n")
        lw = max(len(l) for l in lines) * 6.6 + 12; lh = 15 * len(lines) + 8
        lx, ly = mx - lw / 2, my - lh / 2 - (10 if abs(y2 - y1) < 40 else 0) + loff
        o.append(f'<rect x="{lx}" y="{ly}" width="{lw}" height="{lh}" rx="4" fill="{C["bg"]}" stroke="{C["line"]}"/>')
        for j, l in enumerate(lines):
            o.append(f'<text x="{lx + 6}" y="{ly + 15 + 15 * j}" font-size="11" fill="{C["ink2"]}">{esc(l)}</text>')
# legend
ly = H - 60
for j, (k, t) in enumerate([("sim", "simulator (browser)"), ("code", "code nodes (rules, geometry, executive)"), ("jev", "System One — jev"), ("claude", "System Two — Claude"), ("bridge", "rosbridge")]):
    x = 40 + j * 300
    o.append(f'<rect x="{x}" y="{ly}" width="14" height="14" rx="3" fill="none" stroke="{C[k]}" stroke-width="2"/><text x="{x + 22}" y="{ly + 12}" font-size="12" fill="{C["ink2"]}">{t}</text>')
o.append(f'<text x="40" y="{H - 22}" font-size="11" fill="{C["ink2"]}">solid = topic · dashed = service/action · measured on the live graph: /rover/state 9-10 Hz, telemetry 1 Hz, jev 200-500 ms (onboard, continuous, and inside Claude), ENav &lt; 30 ms, Claude 15-105 s</text>')
o.append("</svg>")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(o))
print("wrote", OUT)
