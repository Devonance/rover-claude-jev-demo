# ros2/ — Jezero Ops as a ROS 2 graph (skeleton)

Two packages: `jezero_msgs` (interfaces) and `jezero_ops` (Python nodes). Not built or run
here (no ROS 2 on this machine); written against Humble/Jazzy APIs and the Space ROS
toolchain. See `docs/ros2-migration.md` for the mapping and effort estimate.

```
cd ~/ros2_ws/src && ln -s /path/to/mars-rover-game/ros2/* .
cd ~/ros2_ws && rosdep install --from-paths src -y && colcon build --symlink-install
source install/setup.bash && ros2 launch jezero_ops jezero_ops.launch.py
```
