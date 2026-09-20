# Rover engineering telemetry (what a real rover's housekeeping stream carries), 1 Hz from the simulator.
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
