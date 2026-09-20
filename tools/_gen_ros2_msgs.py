"""Generate ros2/jezero_msgs (interfaces for the Jezero Ops ROS 2 graph)."""
import io, os, shutil
R = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ros2", "jezero_msgs")
shutil.rmtree(R, ignore_errors=True)
F = {}

# ---------------------------------------------------------------- messages
F["msg/RoverState.msg"] = """# Published by the simulator (the rover's own pose/telemetry estimate).
std_msgs/Header header
float32 x            # m east of site origin
float32 y            # m north
float32 heading      # rad, CCW from east
float32 tilt_deg
float32 slope_deg    # local ground slope
float32 odometer     # m, cumulative
float32 mast_pan
float32 arm_deploy
bool in_sand
bool dust_nearby
"""
F["msg/HeightMap.msg"] = """# Local terrain model around the rover (what stereo/DEM fusion would give ENav).
std_msgs/Header header
float32 origin_x     # world x of column 0
float32 origin_y     # world y of row 0
float32 resolution   # m per cell
uint32 width
uint32 height
uint8[] heights      # float32 little-endian, row-major (row = y increasing north)
uint8[] sand         # 1 = loose drift material
"""
F["msg/Rock.msg"] = """float32 x
float32 y
float32 d            # m across
float32 h            # m relief
string label
"""
F["msg/RockArray.msg"] = "std_msgs/Header header\nRock[] rocks\n"
F["msg/PerceptionMap.msg"] = "std_msgs/Header header\nRock[] rocks\n"
F["msg/KeepOut.msg"] = "float32 x\nfloat32 y\nfloat32 r\nstring label\nstring engine\n"
F["msg/KeepOutArray.msg"] = "std_msgs/Header header\nKeepOut[] keepouts\n"
F["msg/CaptureRequest.msg"] = """# Executive -> simulator (and perception): take a Navcam stereo pair now.
uint32 id
string group         # navcam | front_hazcam | rear_hazcam
bool boost           # mast raised / second pair: no shadow dropout
"""
F["msg/Feature.msg"] = """# One thing perception measured in a Navcam frame. Numbers from stereo; words from code.
string id
string kind          # rock | dark_patch | bright_patch | sand_field | shadow_ambiguity | dust_devil
float32 x            # world position of the blob centroid
float32 y
float32 dist
float32 rel          # bearing relative to heading, rad, +left
float32 d            # extent m across
float32 h            # max relief m (valid if h_known)
bool h_known
float32 h_est
string tone
string size_words
string appearance
string bearing_words
string stereo_note
int32[4] box         # x y w h in the frame (top-left origin)
int32 px
"""
F["msg/FeatureArray.msg"] = """std_msgs/Header header
string group         # which camera pair measured these
uint32 request_id
uint32 seq
bool boost
float32 ground_tone
float32 stereo_coverage   # fraction of the near-field window with a stereo match (frame usability)
float32 shadow_fraction   # fraction of the near-field window in deep shadow
Feature[] features
"""
F["msg/Arc.msg"] = """float32 k
string blocked
float32 cost
float32 max_tilt
float32 head_err
float32 progress
float32[] path       # x0 y0 x1 y1 ...
"""
F["msg/ArcEval.msg"] = """Arc[] arcs
int8 chosen          # index into arcs, -1 if none
bool reverse
float32[] lookahead  # intended route x0 y0 x1 y1 ...
"""
F["msg/RoverCmd.msg"] = """# Executive -> simulator motion controller.
uint32 id
string kind          # follow | turn | back_up | mast_sweep | arm | speed | look_at | look_clear
float32[] path       # follow: x0 y0 x1 y1 ...
bool reverse
float32 value        # turn: rad; back_up: m; arm: 0..1; speed: factor
float32 x
float32 y
"""
F["msg/CmdDone.msg"] = "uint32 id\nfloat32 moved_m\nfloat32 err_m      # arm: placement solution error\nfloat32 tilt_deg   # arm: surface tilt at the spot\nstring note\n"
F["msg/Decision.msg"] = """# Every attributed decision. The console renders it; a bag replays it.
builtin_interfaces/Time stamp
string engine        # CLAUDE | JEV | CODE | USER | ROVER | SOL
string kind          # log | claude_plan | jev_hazards | enav | ... (see sol_executive)
string title
string meta
string payload_json
"""
F["msg/Hud.msg"] = """int32 sol
float32 lmst         # minutes
float32 energy
float32 energy_max
float32 data
float32 data_max
float32 odometer
float32 tilt
string mode
float32 slip_pct       # predicted wheel slip for the ground ahead (terrain class -> table)
string ground_class
int32 jev_calls        # jev requests so far (all)
int32 jev_in_claude    # of which made by Claude while reasoning (MCP)
int32 claude_calls
"""
F["msg/TimelineBlock.msg"] = """string id
string lane
string key
string target
string label
string short_label
float32 start
float32 dur
float32 end
bool has_end
float32 wh
float32 mb
string status
string tag
string reason
bool has_verify
float32[3] verify
"""
F["msg/Timeline.msg"] = "int32 sol\nTimelineBlock[] blocks\n"
F["msg/CostMap.msg"] = """# ENav traversability around the rover: tilt + rocks in the perception map + keep-outs.
std_msgs/Header header
float32 origin_x
float32 origin_y
float32 resolution
uint32 width
uint32 height
uint8[] cost         # 0 free .. 100 lethal, row-major, row = y increasing north
"""
F["msg/ViewCmd.msg"] = """# Executive -> simulator visual layer (markers, rings, camera, Navcam PiP).
string kind          # camera|mark|ring|sand|dust_devil|waypoint|planned|future|arc|highlight|navcam_active|navcam_draw|navcam_foot|caption|now|view
float32 x
float32 y
float32 r
float32 ttl_ms
string text
string color
string engine
float32[] points     # x0 y0 x1 y1 ...
bool flag
string json          # extra (verdicts for navcam_draw, etc.)
"""
F["msg/UserObjective.msg"] = "string id\nstring name\nstring description\nfloat32 x\nfloat32 y\nstring text\n"
F["msg/Verdict.msg"] = """string id
string feature_type
float32 type_confidence
float32 wheel_hazard
float32 sinkage_risk
float32 science_interest
"""
F["msg/VerdictArray.msg"] = "std_msgs/Header header\nfloat32 latency_ms\nint32 input_tokens\nstring answers_json\nVerdict[] verdicts\n"

F["msg/Telemetry.msg"] = """# Rover engineering telemetry (what a real rover's housekeeping stream carries), 1 Hz from the simulator.
std_msgs/Header header
float32 battery_soc_pct
float32 battery_temp_c
float32 motor_current_max_a    # highest of the six drive actuators
string motor_current_actuator
float32 wheel_slip_pct         # commanded vs visual-odometry distance over the last 2 m
bool vo_converged
float32 tilt_deg
float32 suspension_diff_deg
float32 dust_opacity_tau
string phase                   # driving | parked | science | comm
"""
F["msg/HealthVerdict.msg"] = """# jev's continuous read of the telemetry (health_monitor node).
std_msgs/Header header
string fault_class
float32 confidence
float32 stop_drive
float32 needs_ground
float32 latency_ms
string summary_words           # the words jev was shown
string answers_json
"""
F["msg/DataProduct.msg"] = """string id
string instrument
string target
float32 mb
float32 science_score          # jev score 0..3 vs the sol's hypotheses
string rationale
uint8 priority                 # 1 first .. n last (code, from the score and the budget)
bool sent
"""
F["msg/DownlinkQueue.msg"] = "int32 sol\nfloat32 budget_mb\nfloat32 queued_mb\nDataProduct[] products\n"
F["msg/TreeState.msg"] = """# Behaviour-tree snapshot for the console (py_trees executive).
string ascii
string active_path             # e.g. Sol / Execute / Drive
string status                  # RUNNING | SUCCESS | FAILURE
bool safety_halt
string halt_reason
"""

# ---------------------------------------------------------------- services
F["srv/Classify.srv"] = "FeatureArray features\nstring sun_words\nstring ground_words\n---\nVerdictArray verdicts\n"
F["srv/Aegis.srv"] = "string candidates_json\nstring criteria\nstring arm_json\n---\nstring answers_json\nfloat32 latency_ms\n"
F["srv/Fault.srv"] = "string phase\nstring description\nstring terrain_words\n---\nstring answers_json\nfloat32 latency_ms\n"
F["srv/Verify.srv"] = "string plan_json\n---\nstring answers_json\nfloat32 latency_ms\n"
F["srv/Judge.srv"] = "# generic typed judgment: kind = frame | downlink | sample | health; args_json per kind\nstring kind\nstring args_json\n---\nstring answers_json\nfloat32 latency_ms\n"
F["srv/EvaluateArcs.srv"] = """float32 x
float32 y
float32 heading
float32 goal_x
float32 goal_y
bool reverse
int32 lookahead_steps
---
ArcEval eval
"""
F["srv/Ask.srv"] = """# System Two: one schema-constrained call to the LLM (plan | interpret | anomaly | objective | report).
string kind
string ctx_json
---
bool ok
string error
string output_json
string prompt
string model
float32 latency_ms
float32 cost_usd
int32 tokens_out
int32 turns
string consults_json   # jev consultations Claude made while reasoning (MCP tool calls)
"""
F["srv/DescribeFrame.srv"] = """sensor_msgs/CompressedImage frame
string target_name
int32 sol
---
bool ok
string error
string output_json
string prompt
string model
float32 latency_ms
float32 cost_usd
string consults_json
"""

# ---------------------------------------------------------------- actions (System Two: long, cancellable, with feedback)
F["action/Ask.action"] = """# One schema-constrained Claude call: plan | interpret | anomaly | objective | report.
string kind
string ctx_json
---
bool ok
string error
string output_json
string prompt
string model
float32 latency_ms
float32 cost_usd
int32 tokens_out
int32 turns
string consults_json
---
string phase                   # starting | thinking | consulting jev | structuring | done | cancelled
int32 turns
int32 consults
float32 elapsed_s
string last_note               # the note on the latest jev consultation
"""
F["action/Describe.action"] = """sensor_msgs/CompressedImage frame
string target_name
int32 sol
---
bool ok
string error
string output_json
string prompt
string model
float32 latency_ms
float32 cost_usd
---
string phase
float32 elapsed_s
"""
msgs = sorted(k for k in F if k.startswith("msg/")); srvs = sorted(k for k in F if k.startswith("srv/")); actions = sorted(k for k in F if k.startswith("action/"))
F["package.xml"] = """<?xml version="1.0"?>
<package format="3">
  <name>jezero_msgs</name>
  <version>0.2.0</version>
  <description>Interfaces for the Jezero Ops rover-decision graph (Claude + jev + code).</description>
  <maintainer email="kevinleehorton@gmail.com">Kevin Horton</maintainer>
  <license>MIT</license>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <buildtool_depend>rosidl_default_generators</buildtool_depend>
  <depend>std_msgs</depend>
  <depend>sensor_msgs</depend>
  <depend>builtin_interfaces</depend>
  <depend>action_msgs</depend>
  <exec_depend>rosidl_default_runtime</exec_depend>
  <member_of_group>rosidl_interface_packages</member_of_group>
  <export><build_type>ament_cmake</build_type></export>
</package>
"""
F["CMakeLists.txt"] = "cmake_minimum_required(VERSION 3.8)\nproject(jezero_msgs)\nfind_package(ament_cmake REQUIRED)\nfind_package(rosidl_default_generators REQUIRED)\nfind_package(std_msgs REQUIRED)\nfind_package(sensor_msgs REQUIRED)\nfind_package(builtin_interfaces REQUIRED)\nfind_package(action_msgs REQUIRED)\nrosidl_generate_interfaces(${PROJECT_NAME}\n" + "".join(f'  "{k}"\n' for k in msgs + srvs + actions) + "  DEPENDENCIES std_msgs sensor_msgs builtin_interfaces action_msgs)\nament_export_dependencies(rosidl_default_runtime)\nament_package()\n"

for name, content in F.items():
    p = os.path.join(R, name); os.makedirs(os.path.dirname(p), exist_ok=True)
    io.open(p, "w", encoding="utf-8", newline="\n").write(content)
print(len(msgs), "msgs", len(srvs), "srvs", len(actions), "actions written to", R)
