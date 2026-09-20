# One thing perception measured in a Navcam frame. Numbers from stereo; words from code.
string id
string kind          # rock | dark_patch | bright_patch | sand_field | shadow_ambiguity | dust_devil
float32 x            # world position of the blob centroid
float32 y
float32 dist
float32 rel          # bearing relative to heading, rad, +left
float32 d            # extent m across
float32 h            # max relief m (valid if h_known)
bool h_known
float32 h_est
string tone
string size_words
string appearance
string bearing_words
string stereo_note
int32[4] box         # x y w h in the frame (top-left origin)
int32 px
