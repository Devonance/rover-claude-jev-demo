std_msgs/Header header
string group         # which camera pair measured these
uint32 request_id
uint32 seq
bool boost
float32 ground_tone
float32 stereo_coverage   # fraction of the near-field window with a stereo match (frame usability)
float32 shadow_fraction   # fraction of the near-field window in deep shadow
Feature[] features
