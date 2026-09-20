"""Perception: organized Navcam point cloud (x, y, z, intensity; NaN = no stereo match)
plus the local terrain model -> FeatureArray. Same stages as public/vision.js: relief above
the ground, connected blobs, measured numbers, then words. Shadow dropout (sparse stereo in
deep shadow) is modelled here unless the capture was a 'boost' (mast raised, second pair)."""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import PointCloud2
from jezero_msgs.msg import FeatureArray, HeightMap, RoverState, CaptureRequest, Hud
from .geometry import HeightMap as HM, detect, sun_state
from .common import feature_to_msg


class Perception(Node):
    def __init__(self):
        super().__init__("perception")
        self.hmap = HM(None); self.state = None; self.req = None; self.seq = 0; self.lmst = 8 * 60
        self.pub = self.create_publisher(FeatureArray, "/perception/features", 10)
        self.create_subscription(HeightMap, "/sim/heightmap", self.on_hmap, 5)
        self.create_subscription(RoverState, "/rover/state", self.on_state, 10)
        self.create_subscription(Hud, "/ops/hud", lambda m: setattr(self, "lmst", m.lmst), 10)
        self.create_subscription(CaptureRequest, "/navcam/trigger", self.on_trigger, 10)
        self.create_subscription(PointCloud2, "/navcam/points", self.on_cloud, 5)
        self.get_logger().info("perception up: /navcam/points -> /perception/features")

    def on_hmap(self, m): self.hmap = HM(m)
    def on_state(self, m): self.state = m
    def on_trigger(self, m): self.req = m

    def on_cloud(self, msg):
        if self.state is None:
            return
        H, W = msg.height, msg.width
        if msg.point_step != 16 or H * W == 0:
            self.get_logger().warn(f"unexpected cloud layout {W}x{H} step {msg.point_step}"); return
        a = np.frombuffer(bytes(msg.data), dtype="<f4").reshape(H, W, 4)
        xyz = a[..., :3]; lum = a[..., 3].copy()
        lum[~np.isfinite(lum)] = 0.0
        st = self.state
        self.seq += 1
        boost = bool(self.req.boost) if self.req is not None else False
        rid = int(self.req.id) if self.req is not None else 0
        group = (self.req.group if self.req is not None and self.req.group else (msg.header.frame_id or "navcam").split(":")[0]) or "navcam"
        sun_low = sun_state(self.lmst)["low"]
        try:
            ground, feats = detect(xyz, lum, st.x, st.y, st.heading, self.hmap, sun_low, self.seq, boost=boost, W=W, H=H, group=group)
        except Exception as e:  # never let a bad frame kill perception
            self.get_logger().error(f"detect failed: {e}"); ground, feats = 0.45, []
        # frame quality numbers for the usability gate: stereo coverage and deep-shadow fraction in the near-field window
        try:
            valid = np.isfinite(xyz[..., 2]); near = valid & (np.hypot(xyz[..., 0] - st.x, xyz[..., 1] - st.y) < 9.0)
            rows = slice(H // 3, H)  # lower two thirds of the frame: the ground
            window = np.zeros((H, W), dtype=bool); window[rows, :] = True
            cov = float((valid & window).mean() / max(1e-6, window.mean()))
            shadow = float(((lum < 0.5 * max(ground, 0.05)) & window).mean() / max(1e-6, window.mean()))
        except Exception:
            cov, shadow = 1.0, 0.0
        out = FeatureArray(); out.header = msg.header; out.group = group; out.request_id = rid; out.seq = self.seq; out.boost = boost; out.ground_tone = float(ground)
        out.stereo_coverage = cov; out.shadow_fraction = shadow
        out.features = [feature_to_msg(f) for f in feats]
        self.pub.publish(out)
        self.get_logger().info(f"[{group}] frame {self.seq} (req {rid}{', boost' if boost else ''}): {len(feats)} features")


def main():
    rclpy.init(); n = Perception()
    try: rclpy.spin(n)
    except KeyboardInterrupt: pass
    rclpy.shutdown()
