"""Download CC0 photogrammetry rock models from Poly Haven (glTF 1k + diffuse/normal textures).
  python tools/fetch_rocks.py  -> public/assets/rocks/raw/<id>/...
"""
import json, os, urllib.request, sys
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "assets", "rocks", "raw")
IDS = ["moon_rock_01", "moon_rock_02", "moon_rock_03", "moon_rock_04", "moon_rock_05", "moon_rock_06", "moon_rock_07",
       "namaqualand_boulder_02", "namaqualand_boulder_03", "namaqualand_boulder_05", "namaqualand_boulder_06",
       "namaqualand_stones_01", "sand_rocks_small_01", "rock_09", "stone_01"]
UA = {"User-Agent": "jezero-ops/1.0 (research sim; polyhaven CC0 assets)"}
def get(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0: return
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r, open(path, "wb") as f: f.write(r.read())
for aid in IDS:
    d = json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.polyhaven.com/files/{aid}", headers=UA)))
    g = d["gltf"]["1k"]["gltf"]
    out = os.path.join(ROOT, aid); os.makedirs(os.path.join(out, "textures"), exist_ok=True)
    get(g["url"], os.path.join(out, f"{aid}_1k.gltf"))
    for rel, info in g["include"].items():
        if any(k in rel for k in ("_arm_", "_rough_", "_disp_", "_ao_")): continue  # keep diffuse + normal + bin
        get(info["url"], os.path.join(out, rel))
    print("ok", aid, sorted(os.listdir(out)))
print("done", len(IDS))
