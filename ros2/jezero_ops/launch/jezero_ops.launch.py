"""Bring up the Jezero Ops graph: rosbridge for the browser simulator, then the five nodes."""
import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, DeclareLaunchArgument
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    policy = os.path.join(get_package_share_directory("jezero_ops"), "config", "policy.yaml")
    return LaunchDescription([
        DeclareLaunchArgument("autostart", default_value="true", description="start the sol loop as soon as the simulator connects"),
        DeclareLaunchArgument("llm_model", default_value="sonnet"),
        IncludeLaunchDescription(AnyLaunchDescriptionSource(os.path.join(get_package_share_directory("rosbridge_server"), "launch", "rosbridge_websocket_launch.xml")),
                                 launch_arguments={"port": "9090", "max_message_size": "10000000"}.items()),
        Node(package="jezero_ops", executable="perception_node", name="perception", output="screen", parameters=[policy]),
        Node(package="jezero_ops", executable="jev_judge_node", name="jev_judge", output="screen", parameters=[policy]),
        Node(package="jezero_ops", executable="enav_node", name="enav", output="screen", parameters=[policy]),
        Node(package="jezero_ops", executable="claude_planner_node", name="claude_planner", output="screen", parameters=[policy, {"llm_model": LaunchConfiguration("llm_model")}]),
        Node(package="jezero_ops", executable="health_monitor", name="health_monitor", output="screen", parameters=[policy]),
        Node(package="jezero_ops", executable="sol_executive", name="sol_executive", output="screen", parameters=[policy, {"autostart": LaunchConfiguration("autostart")}]),
    ])
