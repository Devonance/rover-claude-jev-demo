#!/usr/bin/env bash
# Start (or restart) the Jezero Ops ROS 2 graph inside WSL, detached, logging to /root/launch.log.
#   wsl -d ros2 -u root -- bash /mnt/c/<path-to-repo>/ros2/start_graph.sh [stop]
source /opt/ros/jazzy/setup.bash
source /root/ws/install/setup.bash
for pat in "sol_executive" "health_monitor" "perception_node" "jev_judge_node" "enav_node" "claude_planner_node" "rosbridge_websocket" "rosapi_node" "ros2 launch"; do
  pkill -f "$pat" 2>/dev/null || true
done
sleep 1
if [ "${1:-}" = "stop" ]; then echo "stopped"; exit 0; fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# TYPESAFE_API_KEY from the environment, else from a .env in the repo or beside it.
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  for d in "$REPO" "$REPO/.."; do
    if [ -f "$d/.env" ]; then
      TYPESAFE_API_KEY=$(sed -n 's/^TYPESAFE_API_KEY=//p' "$d/.env" | head -1 | tr -d '"'"'"'')
      export TYPESAFE_API_KEY
      break
    fi
  done
fi
setsid nohup ros2 launch jezero_ops jezero_ops.launch.py "$@" > /root/launch.log 2>&1 < /dev/null &
sleep 10
ros2 node list
echo "--- log"
grep -E " up|ERROR|error|Traceback|listening" /root/launch.log | head -20
