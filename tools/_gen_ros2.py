"""Generate the ROS 2 package skeleton under ros2/ (see docs/ros2-migration.md)."""
import io, os
R = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ros2")
files = {}

files["README.md"] = """# ros2/ — Jezero Ops as a ROS 2 graph (skeleton)

Two packages: `jezero_msgs` (interfaces) and `jezero_ops` (Python nodes). Not built or run
here (no ROS 2 on this machine); written against Humble/Jazzy APIs and the Space ROS
toolchain. See `docs/ros2-migration.md` for the mapping and effort estimate.

```
cd ~/ros2_ws/src && ln -s /path/to/mars-rover-game/ros2/* .
cd ~/ros2_ws && rosdep install --from-paths src -y && colcon build --symlink-install
source install/setup.bash && ros2 launch jezero_ops jezero_ops.launch.py
```
"""

files["jezero_msgs/package.xml"] = """<?xml version="1.0"?>
<package format="3">
  <name>jezero_msgs</name>
  <version>0.1.0</version>
  <description>Messages for the Jezero Ops rover-decision graph.</description>
  <maintainer email="kevinleehorton@gmail.com">Kevin Horton</maintainer>
  <license>MIT</license>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <buildtool_depend>rosidl_default_generators</buildtool_depend>
  <depend>std_msgs</depend>
  <depend>geometry_msgs</depend>
  <depend>sensor_msgs</depend>
  <depend>builtin_interfaces</depend>
  <exec_depend>rosidl_default_runtime</exec_depend>
  <member_of_group>rosidl_interface_packages</member_of_group>
  <export><build_type>ament_cmake</build_type></export>
</package>
"""
files["jezero_msgs/CMakeLists.txt"] = """cmake_minimum_required(VERSION 3.8)
project(jezero_msgs)
find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(std_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(builtin_interfaces REQUIRED)
rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/Feature.msg" "msg/FeatureArray.msg" "msg/Verdict.msg" "msg/VerdictArray.msg"
  "msg/Rock.msg" "msg/PerceptionMap.msg" "msg/KeepOut.msg" "msg/KeepOutArray.msg"
  "msg/ArcEval.msg" "msg/Decision.msg" "msg/TimelineBlock.msg"
  "srv/Classify.srv" "srv/Aegis.srv" "srv/Fault.srv" "srv/Verify.srv" "srv/DescribeFrame.srv"
  "action/PlanSol.action" "action/InterpretData.action" "action/AssessObjective.action" "action/WriteReport.action" "action/Anomaly.action"
  DEPENDENCIES std_msgs geometry_msgs sensor_msgs builtin_interfaces)
ament_export_dependencies(rosidl_default_runtime)
ament_package()
"""
files["jezero_msgs/msg/Feature.msg"] = """# One thing the Navcam measured. Numbers from stereo; words from code.
string id
float32 distance       # m from rover centre
float32 bearing        # rad, +left
float32 extent         # m across
float32 relief         # m above local ground (valid if relief_known)
bool relief_known
string tone            # dark | light-toned | mottled | medium-toned
string outline         # rounded | blocky | angular, irregular outline
float32 shadow_frac
string kind            # rock | dark_patch | bright_patch | column
string appearance      # the sentence jev will read
string bearing_words
string stereo_note
int32[4] box           # x y w h in the annotated frame
"""
files["jezero_msgs/msg/FeatureArray.msg"] = "std_msgs/Header header\nstring sun_words\nFeature[] features\n"
files["jezero_msgs/msg/Verdict.msg"] = "string id\nstring feature_type\nfloat32 type_confidence\nstring[] type_labels\nfloat32[] type_probs\nfloat32 wheel_hazard\nfloat32 sinkage_risk\nfloat32 science_interest\n"
files["jezero_msgs/msg/VerdictArray.msg"] = "std_msgs/Header header\nfloat32 latency_ms\nVerdict[] verdicts\n"
files["jezero_msgs/msg/Rock.msg"] = "float32 x\nfloat32 y\nfloat32 d\nfloat32 h\nstring label\n"
files["jezero_msgs/msg/PerceptionMap.msg"] = "std_msgs/Header header\nRock[] rocks\n"
files["jezero_msgs/msg/KeepOut.msg"] = "float32 x\nfloat32 y\nfloat32 r\nstring label\nstring engine\n"
files["jezero_msgs/msg/KeepOutArray.msg"] = "std_msgs/Header header\nKeepOut[] keepouts\n"
files["jezero_msgs/msg/ArcEval.msg"] = "std_msgs/Header header\nfloat32[9] curvature\nstring[9] blocked\nfloat32[9] cost\nfloat32[9] max_tilt_deg\nint8 chosen\nbool reverse\n"
files["jezero_msgs/msg/Decision.msg"] = "# Every attributed decision, replayable from a bag.\nbuiltin_interfaces/Time stamp\nstring engine          # CLAUDE | JEV | CODE | USER | ROVER\nstring title\nstring body_json\nfloat32 latency_ms\n"
files["jezero_msgs/msg/TimelineBlock.msg"] = "string lane\nstring key\nstring target\nfloat32 start_min\nfloat32 dur_min\nfloat32 wh\nfloat32 mb\nstring status\nstring tag\nfloat32[3] verify\n"
files["jezero_msgs/srv/Classify.srv"] = "FeatureArray features\n---\nVerdictArray verdicts\n"
files["jezero_msgs/srv/Aegis.srv"] = "string criteria\nstring[] candidate_ids\nstring[] candidate_descriptions\nstring[] candidate_distance_words\nstring arm_workspace_json\n---\nfloat32[] match_score\nfloat32[] match_confidence\nstring[] instrument\nfloat32 arm_deploy_safe\nfloat32 latency_ms\n"
files["jezero_msgs/srv/Fault.srv"] = "string phase\nstring description\nstring terrain_words\n---\nstring fault_class\nfloat32 confidence\nfloat32 stop_drive\nfloat32 needs_ground\n"
files["jezero_msgs/srv/Verify.srv"] = "string objective\nstring target\nstring rover_words\nstring[] activity_names\nstring[] activity_measures\nstring[] activity_purposes\nbool[] uses_arm\n---\nfloat32[] serves_objective\nfloat32[] prerequisites_met\nfloat32[] risk_acceptable\n"
files["jezero_msgs/srv/DescribeFrame.srv"] = "sensor_msgs/Image frame\nstring target_name\nint32 sol\n---\nstring description_json\nfloat32 latency_ms\n"
for a, fields in {"PlanSol": ("string downlink_json", "string plan_json\nfloat32 latency_ms"), "InterpretData": ("string context_json", "string interpretation_json"),
                  "AssessObjective": ("string context_json", "string assessment_json"), "WriteReport": ("string context_json", "string report_json"),
                  "Anomaly": ("string context_json", "string response_json")}.items():
    files[f"jezero_msgs/action/{a}.action"] = f"{fields[0]}\n---\n{fields[1]}\n---\nstring phase\n"

files["jezero_ops/package.xml"] = """<?xml version="1.0"?>
<package format="3">
  <name>jezero_ops</name>
  <version>0.1.0</version>
  <description>Jezero Ops decision graph: perception -> jev (System One) -> ENav (code) -> executive; Claude (System Two) as the ground segment.</description>
  <maintainer email="kevinleehorton@gmail.com">Kevin Horton</maintainer>
  <license>MIT</license>
  <depend>rclpy</depend>
  <depend>jezero_msgs</depend>
  <depend>sensor_msgs</depend>
  <depend>nav_msgs</depend>
  <depend>geometry_msgs</depend>
  <depend>sensor_msgs_py</depend>
  <exec_depend>python3-requests</exec_depend>
  <exec_depend>python3-numpy</exec_depend>
  <exec_depend>python3-scipy</exec_depend>
  <export><build_type>ament_python</build_type></export>
</package>
"""
files["jezero_ops/setup.py"] = """from setuptools import setup
package_name = "jezero_ops"
setup(
    name=package_name, version="0.1.0", packages=[package_name],
    data_files=[("share/ament_index/resource_index/packages", ["resource/" + package_name]),
                ("share/" + package_name, ["package.xml"]),
                ("share/" + package_name + "/launch", ["launch/jezero_ops.launch.py"]),
                ("share/" + package_name + "/config", ["config/policy.yaml"])],
    install_requires=["setuptools"], zip_safe=True,
    maintainer="Kevin Horton", maintainer_email="kevinleehorton@gmail.com",
    description="Jezero Ops decision graph", license="MIT",
    entry_points={"console_scripts": [
        "perception_node = jezero_ops.perception_node:main",
        "jev_judge_node = jezero_ops.jev_judge_node:main",
        "enav_node = jezero_ops.enav_node:main",
        "claude_planner_node = jezero_ops.claude_planner_node:main",
        "sol_executive = jezero_ops.sol_executive:main",
    ]},
)
"""
files["jezero_ops/setup.cfg"] = "[develop]\nscript_dir=$base/lib/jezero_ops\n[install]\ninstall_scripts=$base/lib/jezero_ops\n"
files["jezero_ops/resource/jezero_ops"] = ""
files["jezero_ops/jezero_ops/__init__.py"] = ""
files["jezero_ops/config/policy.yaml"] = """# Thresholds are policy, and policy is data the executive reads — never model output.
enav:
  tilt_limit_deg: 20.0
  rock_step_limit_m: 0.20
  belly_clearance_m: 0.48
  track_in_m: 0.80
  track_out_m: 1.65
  half_len_m: 1.70
  arc_len_m: 6.0
  curvatures: [-0.25, -0.15, -0.08, -0.03, 0.0, 0.03, 0.08, 0.15, 0.25]
gates:
  feature_type_confidence_floor: 0.55
  wheel_hazard: 0.5
  sinkage: 0.5
  science_interest: 0.6
  stop_drive: 0.5
  needs_ground: 0.5
  verify_floor: 0.5
  arm_deploy_safe: 0.6
budget:
  energy_wh: 900
  data_mb: 300
  sol_minutes: 420
  max_drive_m: 200
  margin: 0.15
"""
files["jezero_ops/launch/jezero_ops.launch.py"] = """from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
    return LaunchDescription([
        Node(package="jezero_ops", executable="perception_node", name="perception"),
        Node(package="jezero_ops", executable="jev_judge_node", name="jev_judge", parameters=[{"typesafe_api_key": "", "model": "jev-latest"}]),
        Node(package="jezero_ops", executable="enav_node", name="enav"),
        Node(package="jezero_ops", executable="claude_planner_node", name="claude_planner", parameters=[{"llm_model": "sonnet"}]),
        Node(package="jezero_ops", executable="sol_executive", name="sol_executive"),
    ])
"""
files["jezero_ops/jezero_ops/jev_judge_node.py"] = '''"""System One judgment as ROS 2 services. Same question sets as server/jev.mjs; same
discipline: state is words and structured fields, never raw numbers to reason over."""
import os, time
import rclpy
from rclpy.node import Node
import requests
from jezero_msgs.srv import Classify, Fault, Verify
from jezero_msgs.msg import Verdict, VerdictArray

ENDPOINT = "https://api.typesafe.ai/v1/systemone"


def bucket_size(h):
    return ("ankle-height" if h < 0.15 else "shin-height" if h < 0.3 else "knee-height" if h < 0.5
            else "waist-height" if h < 0.8 else "taller than a wheel")


def bucket_dist(d):
    return "right in front of the rover" if d < 3 else "a few metres ahead" if d < 6 else "at the edge of Navcam range"


class JevJudge(Node):
    def __init__(self):
        super().__init__("jev_judge")
        self.declare_parameter("typesafe_api_key", "")
        self.declare_parameter("model", "jev-latest")
        self.key = self.get_parameter("typesafe_api_key").value or os.environ.get("TYPESAFE_API_KEY", "")
        self.model = self.get_parameter("model").value
        self.create_service(Classify, "~/classify", self.classify)
        self.create_service(Fault, "~/fault", self.fault)
        self.create_service(Verify, "~/verify", self.verify)

    def call(self, state, questions):
        t0 = time.time()
        r = requests.post(ENDPOINT, json={"state": state, "model": self.model, "questions": questions},
                          headers={"Authorization": f"Bearer {self.key}"}, timeout=20)
        r.raise_for_status()
        return r.json()["answers"], (time.time() - t0) * 1000

    def classify(self, req, res):
        feats = req.features.features
        state = {"rover": {"drive_mode": "AutoNav with ENav", "wheel_diameter": "about half a metre",
                           "belly_clearance": "about half a metre", "sun": req.features.sun_words},
                 "navcam_features": {f.id: {"appearance": f.appearance,
                                             "apparent_size": bucket_size(f.relief) if f.relief_known else "relief unknown",
                                             "position": f"{bucket_dist(f.distance)}, {f.bearing_words}",
                                             "stereo_range_note": f.stereo_note} for f in feats}}
        q = {}
        for f in feats:
            q[f"{f.id}__type"] = {"type": "choice",
                "instructions": {"question": f"What is the feature at `navcam_features.{f.id}`?",
                                 "focus": "Use the appearance and the stereo note together. Shadows have no stereo relief."},
                "criteria": {"embedded_rock": {"what": "A rock set into the ground; stereo shows relief."},
                             "loose_rock": {"what": "A rock resting on the surface, perched or half-buried; stereo shows relief."},
                             "bedrock_slab": {"what": "A flat, coherent slab of pavement; low relief, broad."},
                             "sand_ripples": {"what": "Fine-grained bright material with regular ripples; no rock relief."},
                             "shadow_only": {"what": "A dark patch with no stereo relief.", "not_for": "Anything with measured relief."},
                             "dust_devil": {"what": "A moving column of lifted dust; changes between frames."}}}
            q[f"{f.id}__wheel_hazard"] = {"type": "noul",
                "instructions": {"question": f"Would driving a wheel over `navcam_features.{f.id}` risk damaging the wheel or high-centring the rover?",
                                 "focus": "Relief taller than shin-height matters. Shadows and dust do not."}}
            q[f"{f.id}__sinkage"] = {"type": "noul",
                "instructions": {"question": f"Could `navcam_features.{f.id}` cause wheel sinkage or excessive slip?"}}
            q[f"{f.id}__science"] = {"type": "noul",
                "instructions": {"question": f"Is `navcam_features.{f.id}` worth an opportunistic observation during the drive?"}}
        ans, ms = self.call(state, q)
        out = VerdictArray(); out.header = req.features.header; out.latency_ms = ms
        for f in feats:
            t = ans[f"{f.id}__type"]
            out.verdicts.append(Verdict(id=f.id, feature_type=t["choice"], type_confidence=t["confidence"],
                                        type_labels=list(t["probabilities"].keys()), type_probs=list(t["probabilities"].values()),
                                        wheel_hazard=ans[f"{f.id}__wheel_hazard"]["noul"], sinkage_risk=ans[f"{f.id}__sinkage"]["noul"],
                                        science_interest=ans[f"{f.id}__science"]["noul"]))
        res.verdicts = out
        return res

    def fault(self, req, res):
        state = {"drive_phase": req.phase, "telemetry_event": req.description, "recent_terrain": req.terrain_words}
        q = {"fault_class": {"type": "choice", "instructions": {"question": "What does `telemetry_event` most likely indicate?"},
                             "criteria": {"nominal": None, "wheel_slip_excess": None, "motor_current_high": None, "tilt_exceeded": None, "visual_odometry_failure": None, "thermal": None}},
             "stop_drive": {"type": "noul", "instructions": {"question": "Should the rover stop driving now rather than continue?"}},
             "needs_ground": {"type": "noul", "instructions": {"question": "Does this need the ground team (Earth) to decide, rather than an onboard rule?"}}}
        ans, _ = self.call(state, q)
        res.fault_class = ans["fault_class"]["choice"]; res.confidence = ans["fault_class"]["confidence"]
        res.stop_drive = ans["stop_drive"]["noul"]; res.needs_ground = ans["needs_ground"]["noul"]
        return res

    def verify(self, req, res):
        acts = {f"a{i}": {"instrument": n, "what_it_measures": m, "purpose": p, "comes_after": list(req.activity_names[:i]), "uses_the_arm": "yes" if a else "no"}
                for i, (n, m, p, a) in enumerate(zip(req.activity_names, req.activity_measures, req.activity_purposes, req.uses_arm))}
        state = {"objective": req.objective, "target": req.target, "rover_state": req.rover_words, "activities": acts}
        q = {}
        for k in acts:
            q[f"{k}__serves_objective"] = {"type": "noul", "instructions": {"question": f"Does `activities.{k}` produce evidence that bears directly on `objective` for `target`?"}}
            q[f"{k}__prerequisites_met"] = {"type": "noul", "instructions": {"question": f"Given `activities.{k}.comes_after`, is `activities.{k}` in an acceptable position in the sequence?",
                                                                            "focus": "Remote sensing before arm work; abrasion before PIXL on a coring candidate; a core is last."}}
            q[f"{k}__risk_acceptable"] = {"type": "noul", "instructions": {"question": f"Given `rover_state`, is it acceptable to run `activities.{k}` now?"}}
        ans, _ = self.call(state, q)
        res.serves_objective = [ans[f"{k}__serves_objective"]["noul"] for k in acts]
        res.prerequisites_met = [ans[f"{k}__prerequisites_met"]["noul"] for k in acts]
        res.risk_acceptable = [ans[f"{k}__risk_acceptable"]["noul"] for k in acts]
        return res


def main():
    rclpy.init(); n = JevJudge(); rclpy.spin(n); rclpy.shutdown()
'''
files["jezero_ops/jezero_ops/claude_planner_node.py"] = '''"""System Two as ROS 2 actions: the ground segment. Long-running, schema-constrained.
The CLI is spawned with the prompt on stdin and a JSON schema, as in the browser sim."""
import json, subprocess, os, time, tempfile
import rclpy
from rclpy.node import Node
from rclpy.action import ActionServer
from jezero_msgs.action import PlanSol, InterpretData, AssessObjective, WriteReport, Anomaly
from jezero_msgs.srv import DescribeFrame

SCHEMAS = {}  # export PLAN_SCHEMA etc. from server/prompts.mjs as JSON and load here
SYSTEM_PROMPT = os.environ.get("JEZERO_SYSTEM_PROMPT", "You are the Mars 2020 science and tactical planning team.")


def ask_claude(prompt, schema, model="sonnet", allow_read=False):
    args = ["claude", "-p", "--model", model, "--no-session-persistence", "--output-format", "json",
            "--json-schema", json.dumps(schema), "--system-prompt", SYSTEM_PROMPT]
    if allow_read:
        args += ["--allowedTools", "Read"]
    t0 = time.time()
    out = subprocess.run(args, input=prompt, capture_output=True, text=True, timeout=240).stdout
    return json.loads(out).get("structured_output"), (time.time() - t0) * 1000


class ClaudePlanner(Node):
    def __init__(self):
        super().__init__("claude_planner")
        self.declare_parameter("llm_model", "sonnet")
        self.model = self.get_parameter("llm_model").value
        self._servers = [
            ActionServer(self, PlanSol, "plan_sol", lambda g: self.run(g, "plan", PlanSol.Result, "downlink_json", "plan_json")),
            ActionServer(self, InterpretData, "interpret_data", lambda g: self.run(g, "interpret", InterpretData.Result, "context_json", "interpretation_json")),
            ActionServer(self, AssessObjective, "assess_objective", lambda g: self.run(g, "objective", AssessObjective.Result, "context_json", "assessment_json")),
            ActionServer(self, WriteReport, "write_report", lambda g: self.run(g, "report", WriteReport.Result, "context_json", "report_json")),
            ActionServer(self, Anomaly, "anomaly", lambda g: self.run(g, "anomaly", Anomaly.Result, "context_json", "response_json")),
        ]
        self.create_service(DescribeFrame, "~/describe_frame", self.describe)

    def run(self, goal_handle, kind, ResultT, in_field, out_field):
        ctx = json.loads(getattr(goal_handle.request, in_field))
        prompt = ctx.get("prompt") or json.dumps(ctx)   # the executive renders prompts (port of server/prompts.mjs)
        out, ms = ask_claude(prompt, SCHEMAS.get(kind, {"type": "object"}), self.model)
        goal_handle.succeed()
        r = ResultT(); setattr(r, out_field, json.dumps(out))
        if hasattr(r, "latency_ms"): r.latency_ms = ms
        return r

    def describe(self, req, res):
        import numpy as np
        from PIL import Image
        img = np.frombuffer(bytes(req.frame.data), dtype=np.uint8).reshape(req.frame.height, req.frame.width, -1)
        path = os.path.join(tempfile.gettempdir(), f"navcam-sol{req.sol}-{int(time.time())}.png")
        Image.fromarray(img[..., :3]).save(path)
        prompt = (f"NAVCAM FRAME REVIEW, SOL {req.sol}\\n\\nRead the image file {path} with the Read tool. Describe the rock nearest the frame centre "
                  f"({req.target_name}) as a field geologist would; note other rocks and any hazard a rover planner should know about.")
        out, ms = ask_claude(prompt, SCHEMAS.get("describe", {"type": "object"}), self.model, allow_read=True)
        res.description_json = json.dumps(out); res.latency_ms = ms
        return res


def main():
    rclpy.init(); n = ClaudePlanner(); rclpy.spin(n); rclpy.shutdown()
'''
files["jezero_ops/jezero_ops/perception_node.py"] = '''"""Perception: PointCloud2 (from stereo_image_proc) + colour Image -> FeatureArray.
Same stages as public/vision.js: relief above local ground, connected blobs, measured
numbers, then words. Ground is a plane fit on the near field (a real rover has only its own stereo)."""
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2, Image
from sensor_msgs_py import point_cloud2
from scipy import ndimage
from jezero_msgs.msg import Feature, FeatureArray


def bearing_words(rel):
    d = np.degrees(rel)
    if abs(d) < 8: return "dead ahead"
    if abs(d) < 25: return "slightly left of centre" if d > 0 else "slightly right of centre"
    return "well to the left" if d > 0 else "well to the right"


class Perception(Node):
    def __init__(self):
        super().__init__("perception")
        self.declare_parameter("min_relief", 0.10)
        self.declare_parameter("max_range", 13.0)
        self.pub = self.create_publisher(FeatureArray, "/perception/features", 10)
        self.create_subscription(PointCloud2, "/navcam/points", self.on_cloud, 5)
        self.create_subscription(Image, "/navcam/left/image_rect_color", self.on_image, 5)
        self.last_gray = None
        self.seq = 0

    def on_image(self, msg):
        a = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(msg.height, msg.width, -1)[..., :3]
        self.last_gray = (0.30 * a[..., 0] + 0.59 * a[..., 1] + 0.11 * a[..., 2]) / 255.0

    def on_cloud(self, msg):
        H, W = msg.height, msg.width
        P = point_cloud2.read_points_numpy(msg, field_names=("x", "y", "z"), skip_nans=False).reshape(H, W, 3)  # x fwd, y left, z up
        valid = np.isfinite(P).all(-1) & (np.hypot(P[..., 0], P[..., 1]) < self.get_parameter("max_range").value)
        near = P[valid & (P[..., 0] < 6)]
        if len(near) < 50: return
        A = np.c_[near[:, 0], near[:, 1], np.ones(len(near))]
        coef, *_ = np.linalg.lstsq(A, near[:, 2], rcond=None)
        relief = P[..., 2] - (coef[0] * P[..., 0] + coef[1] * P[..., 1] + coef[2])
        gray = self.last_gray if self.last_gray is not None and self.last_gray.shape == (H, W) else np.full((H, W), 0.5)
        gmed = float(np.median(gray[valid & (relief < 0.05)])) if valid.any() else 0.5
        rock = valid & (relief > self.get_parameter("min_relief").value)
        lab, n = ndimage.label(rock)
        out = FeatureArray(); out.header = msg.header
        self.seq += 1
        for k in range(1, n + 1):
            m = lab == k
            if m.sum() < 4: continue
            xs, ys, zs = P[m, 0], P[m, 1], relief[m]
            cx, cy = float(xs.mean()), float(ys.mean())
            ys_, xs_ = np.where(m)
            fill = m.sum() / max(1, (xs_.ptp() + 1) * (ys_.ptp() + 1))
            f = Feature(id=f"v{self.seq}_{k}", kind="rock", distance=float(np.hypot(cx, cy)), bearing=float(np.arctan2(cy, cx)),
                        extent=float(max(xs.ptp(), ys.ptp(), 0.2)), relief=float(zs.max()), relief_known=True)
            f.outline = "angular, irregular outline" if fill < 0.5 else "blocky" if fill < 0.68 else "rounded"
            tone_rel = float(gray[m].mean()) - gmed
            f.tone = "dark" if tone_rel < -0.08 else "light-toned" if tone_rel > 0.10 else "medium-toned"
            f.shadow_frac = float((gray[m] < gmed * 0.5).mean())
            f.bearing_words = bearing_words(f.bearing)
            f.appearance = f"{f.tone}, {f.outline} rock about {f.extent:.1f} m across"
            f.stereo_note = f"stereo shows clear relief, {f.relief:.2f} m above the surrounding surface"
            f.box = [int(xs_.min()), int(ys_.min()), int(xs_.ptp() + 1), int(ys_.ptp() + 1)]
            out.features.append(f)
        self.pub.publish(out)


def main():
    rclpy.init(); n = Perception(); rclpy.spin(n); rclpy.shutdown()
'''
files["jezero_ops/jezero_ops/enav_node.py"] = '''"""ENav in code: nine arcs, wheel-track + belly footprint against the perception map, jev
keep-outs. Port of public/enav.js; numbers come from config/policy.yaml via parameters."""
import math
import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry, Path
from geometry_msgs.msg import PoseStamped
from jezero_msgs.msg import PerceptionMap, KeepOutArray, ArcEval


class ENav(Node):
    def __init__(self):
        super().__init__("enav")
        for k, v in dict(rock_step_limit_m=0.20, belly_clearance_m=0.48, track_in_m=0.8, track_out_m=1.65, half_len_m=1.7, arc_len_m=6.0, step_m=0.5).items():
            self.declare_parameter(k, v)
        self.curv = [-0.25, -0.15, -0.08, -0.03, 0.0, 0.03, 0.08, 0.15, 0.25]
        self.rocks, self.keepouts, self.pose, self.goal = [], [], None, None
        self.create_subscription(PerceptionMap, "/perception/map", lambda m: setattr(self, "rocks", m.rocks), 5)
        self.create_subscription(KeepOutArray, "/nav/keepouts", lambda m: setattr(self, "keepouts", m.keepouts), 5)
        self.create_subscription(Odometry, "/odom", self.on_odom, 10)
        self.create_subscription(PoseStamped, "/nav/goal", lambda m: setattr(self, "goal", (m.pose.position.x, m.pose.position.y)), 5)
        self.pub_eval = self.create_publisher(ArcEval, "/nav/arc_eval", 5)
        self.pub_path = self.create_publisher(Path, "/nav/intended_path", 5)
        self.create_timer(0.5, self.plan)

    def p(self, k): return self.get_parameter(k).value

    def on_odom(self, m):
        q = m.pose.pose.orientation
        yaw = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
        self.pose = (m.pose.pose.position.x, m.pose.pose.position.y, yaw)

    def rock_hit(self, px, py, c, s, rocks):
        for r in rocks:
            dx, dy = r.x - px, r.y - py
            lon, lat = dx * c + dy * s, -dx * s + dy * c
            if abs(lon) > self.p("half_len_m") + r.d / 2: continue
            a, rr = abs(lat), r.d / 2
            if a + rr > self.p("track_in_m") and a - rr < self.p("track_out_m"): return f"rock {r.h:.2f} m"
            if a - rr < self.p("track_in_m") and r.h >= self.p("belly_clearance_m"): return f"belly {r.h:.2f} m"
        return None

    def plan(self):
        if not self.pose or not self.goal: return
        x, y, th0 = self.pose
        step, L = self.p("step_m"), self.p("arc_len_m")
        c0, s0 = math.cos(th0), math.sin(th0)
        rocks = [r for r in self.rocks if r.h >= self.p("rock_step_limit_m")]

        def in_fp(r):  # a rock already inside the footprint cannot veto the move that gets us off it
            dx, dy = r.x - x, r.y - y
            lon, lat = dx * c0 + dy * s0, -dx * s0 + dy * c0
            return abs(lon) <= self.p("half_len_m") + r.d / 2 and abs(lat) - r.d / 2 < self.p("track_out_m")
        active = [r for r in rocks if not in_fp(r)]
        ev = ArcEval(); ev.curvature = self.curv; ev.blocked = [""] * 9; ev.cost = [1e9] * 9; ev.max_tilt_deg = [0.0] * 9
        best, best_cost, best_path = -1, float("inf"), []
        for i, k in enumerate(self.curv):
            px, py, th, blocked, path, s = x, y, th0, "", [], step
            while s <= L + 1e-6:
                th = th0 + k * s; px += math.cos(th) * step; py += math.sin(th) * step; path.append((px, py))
                if s > step:
                    blocked = self.rock_hit(px, py, math.cos(th), math.sin(th), active) or ""
                    if blocked: break
                for ko in self.keepouts:
                    if math.hypot(ko.x - px, ko.y - py) < ko.r: blocked = ko.label; break
                if blocked: break
                s += step
            ex, ey = path[-1] if path else (x, y)
            gb = math.atan2(self.goal[1] - ey, self.goal[0] - ex)
            head_err = abs(math.atan2(math.sin(gb - th), math.cos(gb - th)))
            d0 = math.hypot(self.goal[0] - x, self.goal[1] - y); d1 = math.hypot(self.goal[0] - ex, self.goal[1] - ey)
            cost = float("inf") if blocked else 1.6 * head_err / math.pi + 0.12 * abs(k) / 0.25 + 0.9 * (1 - (d0 - d1) / L)
            ev.blocked[i] = blocked
            if cost < float("inf"): ev.cost[i] = cost
            if cost < best_cost: best, best_cost, best_path = i, cost, path
        ev.chosen = best
        self.pub_eval.publish(ev)
        if best >= 0:
            path = Path(); path.header.frame_id = "map"
            for (qx, qy) in best_path:
                ps = PoseStamped(); ps.pose.position.x, ps.pose.position.y = qx, qy; path.poses.append(ps)
            self.pub_path.publish(path)


def main():
    rclpy.init(); n = ENav(); rclpy.spin(n); rclpy.shutdown()
'''
files["jezero_ops/jezero_ops/sol_executive.py"] = '''"""The sol executive (skeleton). The rules from public/game.js — confidence gate, verdict ->
keep-out / perception map, ordering, scheduler margin, halt-then-escalate — belong here,
ideally as a behaviour tree (py_trees). Every decision is published as jezero_msgs/Decision
with its engine, so a bag replays the attribution stream."""
import json
import rclpy
from rclpy.node import Node
from jezero_msgs.msg import Decision, KeepOut, KeepOutArray, PerceptionMap, Rock, FeatureArray
from jezero_msgs.srv import Classify

GATES = dict(feature_type_confidence_floor=0.55, wheel_hazard=0.5, sinkage=0.5, science_interest=0.6)


class SolExecutive(Node):
    def __init__(self):
        super().__init__("sol_executive")
        self.decisions = self.create_publisher(Decision, "/ops/decisions", 50)
        self.keepouts_pub = self.create_publisher(KeepOutArray, "/nav/keepouts", 5)
        self.map_pub = self.create_publisher(PerceptionMap, "/perception/map", 5)
        self.classify = self.create_client(Classify, "/jev_judge/classify")
        self.create_subscription(FeatureArray, "/perception/features", self.on_features, 5)
        self.keepouts, self.rocks, self.judged = [], [], set()

    def log(self, engine, title, body):
        d = Decision(); d.stamp = self.get_clock().now().to_msg(); d.engine = engine; d.title = title; d.body_json = json.dumps(body)
        self.decisions.publish(d)

    def on_features(self, msg):
        # geometry first: measured rocks go straight to the perception map (TODO: transform to the map frame via tf2)
        for f in msg.features:
            if f.kind == "rock" and f.relief_known:
                self.rocks.append(Rock(x=f.distance, y=0.0, d=f.extent, h=f.relief, label="seen"))
        pm = PerceptionMap(); pm.header = msg.header; pm.rocks = self.rocks; self.map_pub.publish(pm)
        new = [f for f in msg.features if f.id not in self.judged]
        if not new or not self.classify.wait_for_service(timeout_sec=0.5): return
        req = Classify.Request(); req.features = msg; req.features.features = new
        fut = self.classify.call_async(req); fut.add_done_callback(lambda fu: self.on_verdicts(fu.result().verdicts, new))

    def on_verdicts(self, verdicts, feats):
        by_id = {f.id: f for f in feats}
        for v in verdicts.verdicts:
            f = by_id[v.id]; self.judged.add(v.id)
            if v.type_confidence < GATES["feature_type_confidence_floor"]:
                self.log("CODE", "Confidence gate", {"id": v.id, "confidence": v.type_confidence, "action": "halt, re-image, ask again"}); continue
            if v.feature_type == "shadow_only":
                self.log("JEV", "Ignored (shadow)", {"id": v.id}); continue
            if v.sinkage_risk > GATES["sinkage"]:
                self.keepouts.append(KeepOut(x=f.distance, y=0.0, r=6.0, label="jev: sinkage keep-out", engine="JEV"))
                self.log("JEV", "Keep-out (sinkage)", {"id": v.id, "p": v.sinkage_risk})
            elif v.wheel_hazard > GATES["wheel_hazard"]:
                self.log("JEV", "Obstacle (wheel hazard)", {"id": v.id, "p": v.wheel_hazard})
        ka = KeepOutArray(); ka.keepouts = self.keepouts; self.keepouts_pub.publish(ka)


def main():
    rclpy.init(); n = SolExecutive(); rclpy.spin(n); rclpy.shutdown()
'''

for name, content in files.items():
    path = os.path.join(R, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8", newline="\n").write(content)
print(len(files), "files written under ros2/")
