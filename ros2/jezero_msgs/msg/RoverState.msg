# Published by the simulator (the rover's own pose/telemetry estimate).
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
