"""Blender 5.x VSE: transcode a run recording to MP4 with a variable speed ramp.

The run itself cannot be made shorter. Roughly two thirds of its wall clock is Claude
actually reasoning, and the drives are at rover pace on purpose. So the recording is
re-timed instead: the parts where a decision is visibly being made play at 1x, and the
waiting between them is compressed, with the multiplier burned into the corner so nobody
has to guess whether they are watching real time.

  blender -b --python tools/encode_ramp.py -- in.webm out.mp4 segments.json [W H]

segments.json:
  {"segments": [{"t0": 0.0, "t1": 14.0, "speed": 1.0, "label": "sol 1 planning"}, ...]}
t0/t1 are seconds into the source. Gaps between segments are dropped; overlaps are not
allowed. `speed` is the playback multiplier (4 means four times faster).
"""
import bpy, json, os, sys
from pathlib import Path

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = Path(argv[0]).resolve(), Path(argv[1]).resolve()
segs = json.loads(Path(argv[2]).read_text(encoding="utf-8"))["segments"]
W = int(argv[3]) if len(argv) > 3 else 1920
H = int(argv[4]) if len(argv) > 4 else 1080

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# Blender 5 defaults to AgX, which tone-maps a screen recording (whites land at ~233/255).
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.sequence_editor_create()
strips = scene.sequence_editor.strips

# probe the source once for fps and length
probe = strips.new_movie(name="probe", filepath=str(src), channel=1, frame_start=1)
fps = getattr(probe, "fps", 0) or 25.0
src_len = probe.frame_final_duration
strips.remove(probe)

scene.render.fps = int(round(fps)) or 25
scene.render.fps_base = 1.0
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100

TITLE_S = 3.0
title_len = int(round(fps * TITLE_S))
cursor = 1 + title_len          # first frame of run content on the output timeline
MOVIE_CH, SPEED_CH, BADGE_CH = 2, 3, 6

placed = []
for i, sg in enumerate(segs):
    speed = float(sg.get("speed", 1.0)) or 1.0
    f0 = max(0, int(round(float(sg["t0"]) * fps)))
    f1 = min(src_len, int(round(float(sg["t1"]) * fps)))
    n = f1 - f0
    if n <= 1:
        continue
    out_n = max(1, int(round(n / speed)))

    s = strips.new_movie(name=f"seg{i}", filepath=str(src), channel=MOVIE_CH, frame_start=cursor - f0)
    s.frame_offset_start = f0
    s.frame_final_duration = n
    if abs(speed - 1.0) > 1e-3:
        sp = strips.new_effect(name=f"spd{i}", type="SPEED", channel=SPEED_CH,
                               frame_start=cursor, length=n, input1=s)
        sp.speed_control = "MULTIPLY"
        sp.speed_factor = speed
        sp.use_frame_interpolate = False
        # After retiming, the input occupies out_n frames. The effect strip follows its
        # input automatically (its own duration is read-only).
        s.frame_final_duration = out_n
    placed.append({"out_start": cursor, "out_len": out_n, "speed": speed, "label": sg.get("label", "")})
    cursor += out_n

scene.frame_start = 1
scene.frame_end = max(cursor - 1, title_len + 1)

# ---------------------------------------------------------------- title card
bg = strips.new_effect(name="bg", type="COLOR", channel=1, frame_start=1, length=title_len)
bg.color = (0.03, 0.04, 0.05)
title = strips.new_effect(name="title", type="TEXT", channel=4, frame_start=1, length=title_len)
title.text = ("Jezero Ops — Perseverance in-situ sim\n"
              "Claude plans & interprets · jev decides & verifies · code owns the rules")
title.font_size = 48
title.use_shadow = True
title.location = (0.5, 0.5)
title.alignment_x = "CENTER"
title.anchor_x = "CENTER"
title.anchor_y = "CENTER"

# ---------------------------------------------------------------- speed badge
# One text strip per segment, bottom-right. Real time says so; compressed time says by
# how much and what is being skipped past.
for p in placed:
    tag = "REAL TIME" if abs(p["speed"] - 1.0) < 1e-3 else f"×{p['speed']:g}"
    label = p["label"]
    t = strips.new_effect(name=f"badge{p['out_start']}", type="TEXT", channel=BADGE_CH,
                          frame_start=p["out_start"], length=p["out_len"])
    t.text = tag if not label else f"{tag}  ·  {label}"
    t.font_size = 13
    t.use_shadow = True
    t.use_box = True
    t.box_color = (0.03, 0.04, 0.05, 0.72)
    t.box_margin = 0.006
    t.location = (0.993, 0.008)
    t.alignment_x = "RIGHT"
    t.anchor_x = "RIGHT"
    t.anchor_y = "BOTTOM"

r = scene.render
if hasattr(r.image_settings, "media_type"):
    r.image_settings.media_type = "VIDEO"
r.image_settings.file_format = "FFMPEG"
r.ffmpeg.format = "MPEG4"
r.ffmpeg.codec = "H264"
r.ffmpeg.constant_rate_factor = os.environ.get("RAMP_CRF", "HIGH")
r.ffmpeg.ffmpeg_preset = "BEST"
r.ffmpeg.audio_codec = "NONE"
r.filepath = str(dst)
dst.parent.mkdir(parents=True, exist_ok=True)

src_s = src_len / fps
out_s = (scene.frame_end - scene.frame_start + 1) / fps
print(f"[ramp] source {src_s:.1f} s ({src_len} f @ {fps:g} fps) -> output {out_s:.1f} s "
      f"({scene.frame_end} f), {len(placed)} segments, mean {src_s / max(out_s - TITLE_S, 1):.1f}x")
for p in placed:
    print(f"       @{(p['out_start'] - 1) / fps:6.1f}s  x{p['speed']:<5g} {p['out_len']:5d} f  {p['label']}")
bpy.ops.render.render(animation=True)
print("done", dst, dst.stat().st_size if dst.exists() else "missing")
