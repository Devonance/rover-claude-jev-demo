"""ENav in code, as a service. Arcs plan on the perception map (rocks the Navcam and Hazcam
pairs have measured, plus what jev vetoed) and jev's keep-outs. Terrain tilt comes from the
local height map the simulator publishes. Nothing here reads the world's rock list.

Also publishes a traversability cost map around the rover (/nav/costmap) each evaluation --
the kind of hazard map ENav/ACE builds onboard -- so the console can show *why* arcs are blocked."""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from jezero_msgs.srv import EvaluateArcs
from jezero_msgs.msg import HeightMap, PerceptionMap, KeepOutArray, ArcEval, Arc, CostMap
from .geometry import HeightMap as HM, evaluate_arcs, lookahead, TRACK_OUT, BELLY

CM_HALF, CM_RES = 14.0, 1.0


class ENav(Node):
    def __init__(self):
        super().__init__("enav")
        self.declare_parameter("tilt_limit_deg", 20.0)
        self.declare_parameter("rock_step_limit_m", 0.20)
        self.hmap = HM(None); self.rocks = []; self.keepouts = []
        self.create_subscription(HeightMap, "/sim/heightmap", lambda m: setattr(self, "hmap", HM(m)), 5)
        self.create_subscription(PerceptionMap, "/perception/map", lambda m: setattr(self, "rocks", [{"x": r.x, "y": r.y, "d": r.d, "h": r.h} for r in m.rocks]), 5)
        self.create_subscription(KeepOutArray, "/nav/keepouts", lambda m: setattr(self, "keepouts", [{"x": k.x, "y": k.y, "r": k.r, "label": k.label} for k in m.keepouts]), 5)
        self.pub_cm = self.create_publisher(CostMap, "/nav/costmap", 5)
        self.create_service(EvaluateArcs, "/enav/evaluate", self.evaluate)
        self.get_logger().info("enav up: /enav/evaluate (9 arcs x 6 m; tracks + belly; tilt) + /nav/costmap")

    def costmap(self, x, y, tilt_limit, step_limit):
        """Cell cost 0..100: tilt fraction, rocks above the step limit (lethal near, graded around), keep-outs, sand."""
        n = int(2 * CM_HALF / CM_RES) + 1
        ox, oy = math.floor(x) - CM_HALF, math.floor(y) - CM_HALF
        cost = np.zeros((n, n), dtype=np.float32)
        rocks = [r for r in self.rocks if r["h"] >= step_limit and abs(r["x"] - x) < CM_HALF + 2 and abs(r["y"] - y) < CM_HALF + 2]
        for r in range(n):
            for c in range(n):
                cx, cy = ox + c * CM_RES, oy + r * CM_RES
                if self.hmap.ok:
                    hs = [self.hmap.height(cx + dx, cy + dy) for dx, dy in ((-1.2, 1.15), (1.2, 1.15), (-1.2, -1.1), (1.2, -1.1))]
                    pitch = math.atan2((hs[0] + hs[1]) / 2 - (hs[2] + hs[3]) / 2, 2.25); roll = math.atan2((hs[1] + hs[3]) / 2 - (hs[0] + hs[2]) / 2, 2.4)
                    tilt = math.degrees(math.hypot(pitch, roll))
                    v = 100.0 if tilt > tilt_limit else 60.0 * tilt / tilt_limit
                    if self.hmap.in_sand(cx, cy): v = max(v, 70.0)
                else:
                    v = 0.0
                for k in self.rocks and rocks:
                    d = math.hypot(k["x"] - cx, k["y"] - cy)
                    if d < 0.9 + k["d"] / 2: v = 100.0
                    elif d < TRACK_OUT + k["d"] / 2 + 0.6: v = max(v, 75.0 if k["h"] >= BELLY else 55.0)
                for ko in self.keepouts:
                    if math.hypot(ko["x"] - cx, ko["y"] - cy) < ko["r"]: v = 100.0
                cost[r, c] = v
        m = CostMap(); m.header.frame_id = "map"; m.origin_x = float(ox); m.origin_y = float(oy); m.resolution = CM_RES; m.width = n; m.height = n
        m.cost = np.clip(cost, 0, 100).astype(np.uint8).tobytes()
        return m

    def evaluate(self, req, res):
        tilt = float(self.get_parameter("tilt_limit_deg").value); step = float(self.get_parameter("rock_step_limit_m").value)
        goal = (req.goal_x, req.goal_y)
        rocks = self.rocks
        arcs, best = evaluate_arcs(req.x, req.y, req.heading, goal, self.hmap, self.keepouts, tilt, step, rocks, reverse=req.reverse)
        ev = ArcEval(); ev.reverse = req.reverse; ev.chosen = best
        for a in arcs:
            m = Arc(k=float(a["k"]), blocked=a["blocked"] or "", cost=float(a["cost"]) if a["cost"] != float("inf") else 1e9,
                    max_tilt=float(a["max_tilt"]), head_err=float(a["head_err"]), progress=float(a["progress"]))
            m.path = [float(v) for p in a["path"] for v in p]
            ev.arcs.append(m)
        if best >= 0 and req.lookahead_steps > 0 and not req.reverse:
            pts = lookahead(req.x, req.y, req.heading, goal, self.hmap, self.keepouts, tilt, step, rocks, arcs[best], req.lookahead_steps)
            ev.lookahead = [float(v) for p in pts for v in p]
        res.eval = ev
        if not req.reverse:
            try: self.pub_cm.publish(self.costmap(req.x, req.y, tilt, step))
            except Exception as e: self.get_logger().warn(f"costmap failed: {e}")
        blocked = sum(1 for a in arcs if a["blocked"])
        self.get_logger().info(f"{'reverse' if req.reverse else 'forward'}: {blocked}/9 blocked, chosen " + (f"k={arcs[best]['k']:+.2f} cost {arcs[best]['cost']:.2f}" if best >= 0 else "none") + f" (map {len(rocks)} rocks, {len(self.keepouts)} keep-outs, hmap {'ok' if self.hmap.ok else 'MISSING'})")
        return res


def main():
    rclpy.init(); n = ENav()
    try: rclpy.spin(n)
    except KeyboardInterrupt: pass
    rclpy.shutdown()
