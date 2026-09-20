#!/usr/bin/env bash
# Provision ROS 2 Jazzy inside the WSL distro used for Jezero Ops (Ubuntu 24.04).
#   wsl -d ros2 -u root -- bash /mnt/c/<path-to-repo>/ros2/setup_wsl.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q locales curl gnupg lsb-release software-properties-common
locale-gen en_US en_US.UTF-8 >/dev/null
update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
add-apt-repository -y universe >/dev/null
ROS_APT=$(curl -s https://api.github.com/repos/ros-infrastructure/ros-apt-source/releases/latest | grep -F "tag_name" | awk -F\" '{print $4}')
curl -L -o /root/ros2-apt-source.deb "https://github.com/ros-infrastructure/ros-apt-source/releases/download/${ROS_APT}/ros2-apt-source_${ROS_APT}.$(. /etc/os-release && echo "$VERSION_CODENAME")_all.deb"
dpkg -i /root/ros2-apt-source.deb
apt-get update -q
apt-get install -y -q ros-jazzy-ros-base ros-dev-tools python3-colcon-common-extensions \
  ros-jazzy-rosbridge-suite ros-jazzy-rqt-graph ros-jazzy-rosbag2 \
  python3-numpy python3-scipy python3-requests python3-pil
echo "source /opt/ros/jazzy/setup.bash" >> /root/.bashrc
echo "ROS2_SETUP_DONE"
