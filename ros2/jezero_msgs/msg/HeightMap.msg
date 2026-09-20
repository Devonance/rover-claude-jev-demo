# Local terrain model around the rover (what stereo/DEM fusion would give ENav).
std_msgs/Header header
float32 origin_x     # world x of column 0
float32 origin_y     # world y of row 0
float32 resolution   # m per cell
uint32 width
uint32 height
uint8[] heights      # float32 little-endian, row-major (row = y increasing north)
uint8[] sand         # 1 = loose drift material
