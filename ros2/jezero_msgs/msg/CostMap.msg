# ENav traversability around the rover: tilt + rocks in the perception map + keep-outs.
std_msgs/Header header
float32 origin_x
float32 origin_y
float32 resolution
uint32 width
uint32 height
uint8[] cost         # 0 free .. 100 lethal, row-major, row = y increasing north
