"""Blender 5.x VSE: transcode the Playwright WebM to an H.264 MP4 with a title card.

  blender -b --python tools/encode_blender.py -- in.webm out.mp4 [width height]
"""
import bpy, sys
from pathlib import Path

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = Path(argv[0]).resolve(), Path(argv[1]).resolve()
W = int(argv[2]) if len(argv) > 2 else 1600
H = int(argv[3]) if len(argv) > 3 else 900

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# Blender 5 defaults to AgX, which tone-maps the video (whites land at ~233/255). Screen recordings are already display-referred.
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.sequence_editor_create()
se = scene.sequence_editor
strips = se.strips if hasattr(se, "strips") else se.sequences  # Blender 5 renamed the collection (empty collections are falsy)

clip = strips.new_movie(name="run", filepath=str(src), channel=2, frame_start=1)
fps = getattr(clip, "fps", 0) or 25.0
scene.render.fps = int(round(fps)) or 25
scene.render.fps_base = 1.0
scene.render.resolution_x = W
scene.render.resolution_y = H
scene.render.resolution_percentage = 100
scene.frame_start = 1
scene.frame_end = clip.frame_final_duration
title_len = int(round(fps * 3.5))

bg = strips.new_effect(name="bg", type="COLOR", channel=1, frame_start=1, length=title_len)
bg.color = (0.03, 0.04, 0.05)
title = strips.new_effect(name="title", type="TEXT", channel=3, frame_start=1, length=title_len)
title.text = "Jezero Ops — Perseverance in-situ sim\nClaude plans & interprets · jev decides & verifies · code owns the rules"
title.font_size = 52
title.use_shadow = True
title.location = (0.5, 0.5)
title.alignment_x = "CENTER"
title.anchor_x = "CENTER"
title.anchor_y = "CENTER"

# Fade the run in over the title card.
clip.blend_type = "ALPHA_OVER"
clip.blend_alpha = 0.0
clip.keyframe_insert("blend_alpha", frame=1)
clip.blend_alpha = 0.0
clip.keyframe_insert("blend_alpha", frame=int(fps * 2.0))
clip.blend_alpha = 1.0
clip.keyframe_insert("blend_alpha", frame=title_len)

r = scene.render
if hasattr(r.image_settings, "media_type"): r.image_settings.media_type = "VIDEO"
r.image_settings.file_format = "FFMPEG"
r.ffmpeg.format = "MPEG4"
r.ffmpeg.codec = "H264"
r.ffmpeg.constant_rate_factor = "HIGH"
r.ffmpeg.ffmpeg_preset = "BEST"
r.ffmpeg.audio_codec = "NONE"
r.filepath = str(dst)
dst.parent.mkdir(parents=True, exist_ok=True)
print(f"encoding {scene.frame_end} frames @ {scene.render.fps} fps at {W}x{H} -> {dst}")
bpy.ops.render.render(animation=True)
print("done", dst, dst.stat().st_size if dst.exists() else "missing")
