cmake_minimum_required(VERSION 3.8)
project(jezero_msgs)
find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(std_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(builtin_interfaces REQUIRED)
find_package(action_msgs REQUIRED)
rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/Arc.msg"
  "msg/ArcEval.msg"
  "msg/CaptureRequest.msg"
  "msg/CmdDone.msg"
  "msg/CostMap.msg"
  "msg/DataProduct.msg"
  "msg/Decision.msg"
  "msg/DownlinkQueue.msg"
  "msg/Feature.msg"
  "msg/FeatureArray.msg"
  "msg/HealthVerdict.msg"
  "msg/HeightMap.msg"
  "msg/Hud.msg"
  "msg/KeepOut.msg"
  "msg/KeepOutArray.msg"
  "msg/PerceptionMap.msg"
  "msg/Rock.msg"
  "msg/RockArray.msg"
  "msg/RoverCmd.msg"
  "msg/RoverState.msg"
  "msg/Telemetry.msg"
  "msg/Timeline.msg"
  "msg/TimelineBlock.msg"
  "msg/TreeState.msg"
  "msg/UserObjective.msg"
  "msg/Verdict.msg"
  "msg/VerdictArray.msg"
  "msg/ViewCmd.msg"
  "srv/Aegis.srv"
  "srv/Ask.srv"
  "srv/Classify.srv"
  "srv/DescribeFrame.srv"
  "srv/EvaluateArcs.srv"
  "srv/Fault.srv"
  "srv/Judge.srv"
  "srv/Verify.srv"
  "action/Ask.action"
  "action/Describe.action"
  DEPENDENCIES std_msgs sensor_msgs builtin_interfaces action_msgs)
ament_export_dependencies(rosidl_default_runtime)
ament_package()
