# Executive -> simulator visual layer (markers, rings, camera, Navcam PiP).
string kind          # camera|mark|ring|sand|dust_devil|waypoint|planned|future|arc|highlight|navcam_active|navcam_draw|navcam_foot|caption|now|view
float32 x
float32 y
float32 r
float32 ttl_ms
string text
string color
string engine
float32[] points     # x0 y0 x1 y1 ...
bool flag
string json          # extra (verdicts for navcam_draw, etc.)
