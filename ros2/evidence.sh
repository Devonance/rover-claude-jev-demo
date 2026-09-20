#!/usr/bin/env bash
# Capture what the live graph looks like: nodes, topics, services, interfaces, rates, one decision.
source /opt/ros/jazzy/setup.bash
source /root/ws/install/setup.bash
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$REPO/docs/ros2/graph-evidence.txt}"
ros2 daemon stop >/dev/null 2>&1
{
  echo "# captured on the live graph, $(date -u +%Y-%m-%dT%H:%MZ)"
  echo; echo '$ ros2 node list'; ros2 node list --no-daemon --spin-time 4
  echo; echo '$ ros2 topic list'; ros2 topic list --no-daemon --spin-time 4
  echo; echo '$ ros2 service list | grep -E "jev|enav|claude" (parameter services omitted)'
  ros2 service list --no-daemon --spin-time 4 | grep -E "jev|enav|claude" | grep -v -E "parameter|type_description"
  echo; echo '$ ros2 interface list | grep jezero_msgs'; ros2 interface list | grep jezero_msgs
  echo; echo '$ ros2 topic hz /rover/state'; timeout 6 ros2 topic hz /rover/state 2>&1 | tail -2
  echo; echo '$ ros2 topic hz /navcam/points  (Navcam + Hazcam captures)'; timeout 12 ros2 topic hz /navcam/points 2>&1 | tail -2
  echo; echo '$ ros2 topic echo --once /ops/decisions'; timeout 20 ros2 topic echo --once /ops/decisions 2>&1 | head -10
} > "$out" 2>&1
echo "wrote $out ($(grep -c '' "$out") lines)"
sed -n 1,16p "$out"
