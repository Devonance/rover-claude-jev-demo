from setuptools import setup

package_name = "jezero_ops"
setup(
    name=package_name,
    version="0.2.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", ["launch/jezero_ops.launch.py"]),
        ("share/" + package_name + "/config", ["config/policy.yaml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Kevin Horton",
    maintainer_email="kevinleehorton@gmail.com",
    description="Jezero Ops decision graph: perception -> jev (System One) -> ENav (code) -> executive; Claude (System Two) as the ground segment.",
    license="MIT",
    entry_points={"console_scripts": [
        "perception_node = jezero_ops.perception_node:main",
        "jev_judge_node = jezero_ops.jev_judge_node:main",
        "enav_node = jezero_ops.enav_node:main",
        "claude_planner_node = jezero_ops.claude_planner_node:main",
        "sol_executive = jezero_ops.sol_executive:main",
        "health_monitor = jezero_ops.health_monitor:main",
    ]},
)
