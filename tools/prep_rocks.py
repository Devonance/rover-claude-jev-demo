"""Blender 5: turn the Poly Haven scans into Mars-rock variants for the sim.
For each model: import glTF, join, recentre, normalise to a unit box (x/z extent 1, y extent 1, centred),
decimate to a low-poly instancing version (~320 tris) and a hi-res version for the named targets
(~2500 tris), keep the diffuse (and normal) texture, export GLB.
  blender -b --python tools/prep_rocks.py -- public/assets/rocks/raw public/assets/rocks
"""
import bpy, sys, os, glob, math
argv = sys.argv[sys.argv.index("--") + 1:]
RAW, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
os.makedirs(OUT, exist_ok=True)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def process(aid, tris_lo=320, tris_hi=2500):
    reset()
    gltf = glob.glob(os.path.join(RAW, aid, "*.gltf"))[0]
    bpy.ops.import_scene.gltf(filepath=gltf)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # some scans are groups of stones: split into loose parts and keep the biggest single rock
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT"); bpy.ops.mesh.remove_doubles(threshold=1e-5); bpy.ops.mesh.separate(type="LOOSE"); bpy.ops.object.mode_set(mode="OBJECT")
    parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    parts.sort(key=lambda o: -len(o.data.vertices))
    ob = parts[0]
    for o in parts[1:]: bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    print(f"ROCK {aid}: {len(parts)} loose parts, kept {len(ob.data.vertices)} verts")
    # recentre on the bounding box and normalise: unit footprint, unit height (Blender Z up -> glTF Y up on export)
    xs = [v.co.x for v in ob.data.vertices]; ys = [v.co.y for v in ob.data.vertices]; zs = [v.co.z for v in ob.data.vertices]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    sx, sy, sz = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
    foot = max(sx, sy)
    for v in ob.data.vertices:
        v.co.x = (v.co.x - cx) / foot; v.co.y = (v.co.y - cy) / foot; v.co.z = (v.co.z - cz) / sz
    n0 = len(ob.data.polygons)
    for tag, tris, texpx in (("hi", tris_hi, 1024), ("lo", tris_lo, 384)):
        # shrink the textures for the instancing version (hi first so it keeps the full 1k)
        for img in bpy.data.images:
            if img.size[0] > texpx: img.scale(texpx, texpx)
        bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True); bpy.context.view_layer.objects.active = ob
        bpy.ops.object.duplicate()
        d = bpy.context.view_layer.objects.active
        mod = d.modifiers.new("dec", "DECIMATE"); mod.ratio = min(1.0, tris / max(1, n0 * 2)); mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier="dec")
        bpy.ops.object.select_all(action="DESELECT"); d.select_set(True)
        d.name = f"{aid}_{tag}"
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f"{aid}_{tag}.glb"), use_selection=True, export_format="GLB",
                                  export_image_format="JPEG", export_jpeg_quality=72, export_apply=True, export_normals=True,
                                  export_texcoords=True, export_materials="EXPORT")
        print(f"ROCK {aid}_{tag}: {len(d.data.polygons)} faces from {n0}")
        bpy.data.objects.remove(d, do_unlink=True)

ids = sorted(os.listdir(RAW))
for aid in ids:
    try: process(aid)
    except Exception as e: print("ROCK FAILED", aid, repr(e))
print("ROCKS DONE")
