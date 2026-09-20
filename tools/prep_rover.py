"""Blender: split the NASA Perseverance GLB's single wheel mesh into six wheels,
name them by position, and re-export for the game. Run with:

  blender -b --python tools/prep_rover.py
"""
import bpy, bmesh, sys
from mathutils import Vector
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "raw" / "25042_Perseverance.glb"
DST = ROOT / "public" / "assets" / "rover" / "perseverance.glb"
DST.parent.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SRC))

wheels = bpy.data.objects.get("Wheels_objs")
if wheels is None:
    sys.exit("no Wheels_objs in GLB")

bpy.ops.object.select_all(action="DESELECT")
wheels.select_set(True)
bpy.context.view_layer.objects.active = wheels
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.separate(type="LOOSE")
bpy.ops.object.mode_set(mode="OBJECT")

parts = [o for o in bpy.context.selected_objects if o.type == "MESH"]
print("loose parts:", len(parts))

# Cluster parts by their world-space centre into 6 wheel groups.
def centre(o):
    return sum((o.matrix_world @ Vector(c) for c in o.bound_box), Vector()) / 8

groups = []
for o in parts:
    c = centre(o)
    for g in groups:
        if (g["c"] - c).length < 0.45:
            g["objs"].append(o)
            break
    else:
        groups.append({"c": c, "objs": [o]})
groups.sort(key=lambda g: len(g["objs"]), reverse=True)
print("clusters:", [(len(g["objs"]), tuple(round(v, 2) for v in g["c"])) for g in groups])
groups = groups[:6]

# Join each cluster into one wheel object, origin at its own centre so it can spin.
names = {}
for g in groups:
    bpy.ops.object.select_all(action="DESELECT")
    for o in g["objs"]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = g["objs"][0]
    bpy.ops.object.join()
    w = bpy.context.view_layer.objects.active
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    c = w.matrix_world.translation
    side = "L" if c.x < 0 else "R"
    names.setdefault(side, []).append((c.y, w))

for side, lst in names.items():
    lst.sort(key=lambda t: t[0], reverse=True)  # +Y is forward in the GLB (arm end)
    for tag, (_, w) in zip(["F", "M", "B"], lst):
        w.name = f"wheel_{side}{tag}"
        print("named", w.name, [round(v, 2) for v in w.matrix_world.translation])

# Leftover fragments (if any) go back to a static object so nothing is lost.
bpy.ops.object.select_all(action="DESELECT")
left = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Wheels_objs")]
if left:
    for o in left:
        o.select_set(True)
    bpy.context.view_layer.objects.active = left[0]
    if len(left) > 1:
        bpy.ops.object.join()
    bpy.context.view_layer.objects.active.name = "wheel_fragments"

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=str(DST),
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_jpeg_quality=85,
)
print("exported", DST, DST.stat().st_size, "bytes")
