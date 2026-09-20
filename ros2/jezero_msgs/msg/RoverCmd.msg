# Executive -> simulator motion controller.
uint32 id
string kind          # follow | turn | back_up | mast_sweep | arm | speed | look_at | look_clear
float32[] path       # follow: x0 y0 x1 y1 ...
bool reverse
float32 value        # turn: rad; back_up: m; arm: 0..1; speed: factor
float32 x
float32 y
