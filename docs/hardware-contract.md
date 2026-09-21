# Jezero Ops on real hardware — the contract

The browser is a simulator that implements a small set of ROS 2 interfaces. A real rover replaces it
by providing the same interfaces from drivers; nothing in the decision graph changes. This page lists
what the simulator provides today, what the standard ROS interface for it is, and what a flight-like
integration would use. Everything jev and Claude see is *derived* from these by code — the models
never touch hardware directly.

## What the simulator provides (and what replaces it)

| Simulator today | Standard ROS 2 interface on a real rover | Provided by |
|---|---|---|
| `/rover/state` (RoverState: x, y, heading, tilt, odometer, mast, arm, in_sand) | `nav_msgs/Odometry` + `tf2` (`map → base_link`), `sensor_msgs/JointState` for mast/arm, `sensor_msgs/Imu` for tilt | `robot_localization` (wheel odometry + IMU + visual odometry), `ros2_control` joint state broadcaster |
| `/rover/telemetry` (Telemetry: SOC, battery temp, actuator currents, slip, VO status, tilt, suspension, dust τ) | `sensor_msgs/BatteryState`, `sensor_msgs/Temperature`, `control_msgs/DynamicJointState` (currents), `diagnostic_msgs/DiagnosticArray` | power/thermal/motor-controller drivers; `diagnostic_aggregator`; VO status from the stereo odometry node |
| `/navcam/points` (organized PointCloud2 x,y,z,intensity per camera pair) | `sensor_msgs/PointCloud2` from `stereo_image_proc` (or `sensor_msgs/Image` disparity + `CameraInfo`) | camera drivers (`image_pipeline`), one stereo pipeline per pair (Navcam, front Hazcam A/B, rear Hazcam) |
| `/navcam/image/compressed` (PNG for the LLM) | `sensor_msgs/CompressedImage` | `image_transport` republisher |
| `/navcam/trigger` (CaptureRequest: id, group, boost) | a `std_srvs/Trigger`-style capture service per camera pair, or continuous streams the executive samples | camera drivers; "boost" = mast re-point + second pair (`MoveIt`/`ros2_control` mast joint goal) |
| `/sim/heightmap` (local DEM around the rover) | `grid_map_msgs/GridMap` or `nav2` elevation costmap layer built from stereo | `elevation_mapping` / `grid_map` from the fused point clouds |
| `/rover/cmd` (RoverCmd: follow path, turn, back_up, mast_sweep, arm_unstow / arm_preplace / arm_contact / arm_retract / arm_stow, speed) → `/rover/cmd_done` (moved, placement-solution error, surface tilt) | `nav2_msgs/action/FollowPath` (or the ENav arc as `geometry_msgs/Twist` to a `ros2_control` diff/skid controller), `control_msgs/action/FollowJointTrajectory` for mast and arm | Nav2 controller server, `ros2_control` (six wheel drives + four steer actuators for rocker-bogie), MoveIt 2 for the arm |
| `/sim/view`, `/ops/*` (console) | unchanged — these are the operator's tools, not the rover's | Foxglove / rqt panels driven by the same topics |

## What stays exactly the same

- **Perception node**: consumes `PointCloud2` + the local height map; publishes `FeatureArray`. Only
  the source of the cloud changes (stereo correlation instead of a depth buffer). Shadow dropout and
  holes come for free from real stereo.
- **jev services** (`/jev/classify`, `/jev/aegis`, `/jev/fault`, `/jev/verify`, `/jev/judge`) and the
  **health monitor** on `/rover/telemetry`: they read words that code makes from the streams above.
  On a rover jev's latency class (200–500 ms, a few hundred input tokens) is the onboard budget; the
  TypeSafe endpoint would be replaced by an onboard deployment behind the same service names.
- **ENav** (`/enav/evaluate`, `/nav/costmap`): the same nine-arc footprint check; on hardware the
  chosen arc goes to the drive controller instead of the simulator's follower.
- **The executive** (behaviour tree, flight rules, gates, ledger) and the **Claude actions**: the
  ground segment. On a mission the `/claude/*` action servers live on Earth and the relay delay is a
  real delay; the executive already treats them as long-running, cancellable goals.

## Timing and safety on hardware

- The immediate halt is in the drive loop, not the tree: a `stop_drive > 0.5` verdict stops the next
  segment before it is commanded (FR-11). On hardware this maps to cancelling the active
  `FollowPath`/`FollowJointTrajectory` goal and holding brakes.
- Near-field checks (front/rear Hazcam pairs) run before every segment and mid-arc (FR-06/07); with
  real cameras the cadence is bounded by stereo throughput (~1–2 Hz per pair), which is still well
  above the ~300 ms a jev request takes.
- The health monitor asks jev about every telemetry sample at 1 Hz, so
  the request rate stays low even with a 1 Hz telemetry stream.
- Everything the models decide is published on `/ops/decisions` with its engine; a `rosbag2` of a
  drive replays every judgment against every input.

## What is missing for a flight-like stack

Rocker-bogie URDF and `ros2_control` hardware interface for the six drives, a mast/arm MoveIt config,
`stereo_image_proc` pipelines per pair, `robot_localization` for VO + wheel + IMU fusion, `nav2`
integration of ENav as a controller plugin with jev keep-outs as a costmap layer, and a Space ROS
(Humble) build with static analysis and requirements traceability.
