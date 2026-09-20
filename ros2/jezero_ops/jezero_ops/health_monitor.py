"""Continuous rover-health monitor: jev on the engineering telemetry stream.

On a real rover the housekeeping stream (battery, thermal, actuator currents, visual odometry, slip,
tilt, dust) is watched by flight rules and by the ground. Here code turns each telemetry sample into
words, and jev is asked three typed questions whenever something changes (or every `period_s` while
driving): what does this most likely indicate, should the drive stop now, does it need the ground.
The verdict is published on /health/verdict; the executive's safety branch acts on it (halt, cancel the
running Claude action, escalate). Nothing here moves the rover."""
import json, os, time
import requests
import rclpy
from rclpy.node import Node
from jezero_msgs.msg import Telemetry, HealthVerdict
from .questions import health_questions

ENDPOINT = "https://api.typesafe.ai/v1/systemone"


def load_key():
    k = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if k: return k
    # TYPESAFE_API_KEY in the environment is the normal path. Failing that, look for a
    # .env in this repo, its parent, or wherever JEZERO_ENV_DIR points. No absolute paths.
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", "..", ".."))
    for d in [x for x in (os.environ.get("JEZERO_ENV_DIR"), repo, os.path.dirname(repo)) if x]:
        f = os.path.join(d, ".env")
        if os.path.exists(f):
            for line in open(f, encoding="utf-8"):
                if line.strip().startswith("TYPESAFE_API_KEY"): return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def words(t, hist=None):
    """Numbers -> words. This is the whole discipline: jev never sees the raw telemetry.

    The bands are deliberately fine and the trend terms are included because System One is
    cheap enough to ask about every sample: at roughly 180 input tokens a question, watching
    the housekeeping stream at 1 Hz for a whole sol costs a few cents. A coarser summary
    would be cheaper to ask about but would hide the thing worth catching, which is a channel
    drifting before it trips a limit."""
    soc = ("battery comfortably charged" if t.battery_soc_pct > 60 else "battery below two thirds" if t.battery_soc_pct > 35
           else "battery low, approaching the survival reserve" if t.battery_soc_pct > 20 else "battery into the survival reserve")
    temp = ("battery at a normal temperature" if -10 < t.battery_temp_c < 30 else "battery cold" if t.battery_temp_c <= -10
            else "battery warm, above its normal band" if t.battery_temp_c < 40 else "battery hot, well above its normal band")
    cur = ("drive actuator currents nominal" if t.motor_current_max_a < 2.5
           else f"the {t.motor_current_actuator} drive actuator drawing a little more current than the others" if t.motor_current_max_a < 3.5
           else f"the {t.motor_current_actuator} drive actuator drawing clearly more current than the others" if t.motor_current_max_a < 4.5
           else f"the {t.motor_current_actuator} drive actuator at a current that would trip a limit")
    slip = ("no measurable wheel slip" if t.wheel_slip_pct < 8 else "mild wheel slip" if t.wheel_slip_pct < 18
            else f"wheel slip around {int(round(t.wheel_slip_pct / 5) * 5)} percent over the last two metres")
    vo = "visual odometry converged" if t.vo_converged else "visual odometry did not converge on the last step"
    tilt = ("gentle tilt" if t.tilt_deg < 8 else "moderate tilt" if t.tilt_deg < 12 else "pronounced tilt" if t.tilt_deg < 15
            else "steep tilt near the limit")
    susp = ("suspension level" if abs(t.suspension_diff_deg) < 4 else "rocker-bogie differential deflected"
            if abs(t.suspension_diff_deg) < 8 else "rocker-bogie differential strongly deflected, a wheel is riding something")
    dust = "clear air" if t.dust_opacity_tau < 0.8 else "dusty air, optical depth elevated" if t.dust_opacity_tau < 1.4 else "heavy dust in the air"
    parts = [t.phase, soc, temp, cur, slip, vo, tilt, susp, dust]
    # Trend terms: a channel on its way somewhere is the thing a monitor exists to catch.
    if hist:
        def trend(get, rising, falling, dead):
            first, last = get(hist[0]), get(hist[-1])
            if last - first > dead: return rising
            if first - last > dead: return falling
            return None
        for term in (trend(lambda m: m.motor_current_a, "actuator current rising over the last few samples", "actuator current falling back", 0.6),
                     trend(lambda m: m.slip, "wheel slip increasing", "wheel slip easing", 8.0),
                     trend(lambda m: m.temp, "battery warming", "battery cooling", 6.0),
                     trend(lambda m: m.tilt, "tilt increasing", "tilt easing", 3.0)):
            if term: parts.append(term)
    return "; ".join(parts)


class HealthMonitor(Node):
    def __init__(self):
        super().__init__("health_monitor")
        # jev is cheap enough to ask about every sample: watch the whole stream, not a sample of it
        self.declare_parameter("period_s", 1.0)
        self.declare_parameter("model", "jev-latest")
        self.key = load_key(); self.last_words = None; self.last_t = 0.0; self.tel = None; self.n = 0
        self.hist = []  # short ring of recent samples, for the trend terms
        self.pub = self.create_publisher(HealthVerdict, "/health/verdict", 10)
        self.create_subscription(Telemetry, "/rover/telemetry", self.on_tel, 10)
        self.create_timer(1.0, self.tick)
        self.get_logger().info("health_monitor up: /rover/telemetry -> jev -> /health/verdict")

    def on_tel(self, m):
        self.tel = m
        self.hist.append(type("S", (), {"motor_current_a": m.motor_current_max_a, "slip": m.wheel_slip_pct,
                                        "temp": m.battery_temp_c, "tilt": m.tilt_deg})())
        if len(self.hist) > 6: self.hist.pop(0)

    def tick(self):
        if self.tel is None: return
        w = words(self.tel, self.hist); now = time.time()
        changed = w != self.last_words
        # every sample while the rover is moving, and any change at all when it is not
        due = (now - self.last_t) >= float(self.get_parameter("period_s").value) and self.tel.phase in ("driving", "science")
        if not (changed or due): return
        self.last_words = w; self.last_t = now
        state, q = health_questions(w)
        t0 = time.time()
        try:
            r = requests.post(ENDPOINT, json={"state": state, "model": self.get_parameter("model").value, "questions": q},
                              headers={"Authorization": f"Bearer {self.key}"}, timeout=20)
            r.raise_for_status(); ans = r.json()["answers"]
        except Exception as e:
            self.get_logger().warn(f"jev health call failed: {e}"); return
        ms = (time.time() - t0) * 1000; self.n += 1
        v = HealthVerdict(); v.header.stamp = self.get_clock().now().to_msg()
        v.fault_class = ans["fault_class"]["choice"]; v.confidence = float(ans["fault_class"]["confidence"])
        v.stop_drive = float(ans["stop_drive"]["noul"]); v.needs_ground = float(ans["needs_ground"]["noul"])
        v.latency_ms = float(ms); v.summary_words = w; v.answers_json = json.dumps({"answers": ans, "state": state, "questions": q})
        self.pub.publish(v)
        self.get_logger().info(f"health #{self.n}: {v.fault_class} ({v.confidence:.2f}) stop {v.stop_drive:.2f} ground {v.needs_ground:.2f} · {ms:.0f} ms · {w[:70]}")


def main():
    rclpy.init(); n = HealthMonitor()
    try: rclpy.spin(n)
    except KeyboardInterrupt: pass
    rclpy.shutdown()
