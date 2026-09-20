"""Build the game terrain from the real USGS Jezero products.

Macro relief  : USGS Mars 2020 TRN CTX DTM mosaic, 20 m/px  (real)
Albedo        : USGS Mars 2020 TRN CTX orthomosaic, 6 m/px   (real)
Micro relief  : fractal noise at rover scale                 (synthetic, labelled)
Rock field    : Golombek rock size-frequency model, k=0.07   (synthetic, labelled)

Output goes to public/assets/terrain/.
"""
import json, math, sys
from pathlib import Path
import numpy as np
import tifffile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "assets" / "raw"
OUT = ROOT / "public" / "assets" / "terrain"
OUT.mkdir(parents=True, exist_ok=True)

# Georeferencing from the GeoTIFF tags (both products share the tiepoint).
R_MARS = 3396190.0
X0, Y0 = 4573663.250853, 1109693.140188
DTM_PX, ORTHO_PX = 20.0, 6.0

# Crop: 64 DTM px = 1280 m, centred a little south-west of the landing site,
# toward the Séítah / Artuby ridge area Perseverance worked in its first year.
CENTER_LONLAT = (77.4335, 18.4385)
HALF_DTM = 32                    # 64 x 64 DTM px
N = 1024                         # output grid -> 1.25 m/px
SIZE_M = HALF_DTM * 2 * DTM_PX   # 1280 m

rng = np.random.default_rng(2020)


def lonlat_to_xy(lon, lat):
    return R_MARS * math.radians(lon), R_MARS * math.radians(lat)


def xy_to_lonlat(x, y):
    return math.degrees(x / R_MARS), math.degrees(y / R_MARS)


cx, cy = lonlat_to_xy(*CENTER_LONLAT)
col = int(round((cx - X0) / DTM_PX))
row = int(round((Y0 - cy) / DTM_PX))
print(f"centre lon/lat {CENTER_LONLAT} -> DTM col {col} row {row}")

# ---------------------------------------------------------------- heights
dtm = tifffile.imread(RAW / "JEZ_ctx_DTM_20m.tif").astype(np.float64)
macro = dtm[row - HALF_DTM: row + HALF_DTM, col - HALF_DTM: col + HALF_DTM]
assert macro.shape == (2 * HALF_DTM, 2 * HALF_DTM), macro.shape
print(f"macro relief: {macro.min():.1f} .. {macro.max():.1f} m  ({macro.max()-macro.min():.1f} m)")

macro_img = Image.fromarray(macro.astype(np.float32), mode="F").resize((N, N), Image.BICUBIC)
height = np.asarray(macro_img, dtype=np.float64)


def smooth_noise(n, cells, amp):
    """Bicubic-upsampled white noise: a cheap band-limited bump field."""
    low = rng.standard_normal((cells, cells)).astype(np.float32)
    img = Image.fromarray(low, mode="F").resize((n, n), Image.BICUBIC)
    return np.asarray(img, dtype=np.float64) * amp


# Rover-scale texture. Amplitudes chosen to stay well inside ENav tilt limits
# on their own; the real hazards are the rocks and the sand, placed below.
micro = (
    smooth_noise(N, 32, 0.45)    # ~40 m undulation
    + smooth_noise(N, 128, 0.18)  # ~10 m
    + smooth_noise(N, 512, 0.06)  # ~2.5 m
)
height += micro

# ---------------------------------------------------------------- sand
# A few ripple fields (the Curiosity "Hidden Valley" lesson): ENav keep-out.
sand = []
for _ in range(7):
    sx, sy = rng.uniform(-500, 500, 2)
    a, b = rng.uniform(18, 55), rng.uniform(10, 30)
    th = rng.uniform(0, math.pi)
    sand.append({"x": float(sx), "y": float(sy), "a": float(a), "b": float(b), "theta": float(th)})

yy, xx = np.mgrid[0:N, 0:N]
gx = (xx / (N - 1) - 0.5) * SIZE_M
gy = (0.5 - yy / (N - 1)) * SIZE_M
sand_mask = np.zeros((N, N), dtype=bool)
for s in sand:
    dx, dy = gx - s["x"], gy - s["y"]
    c, sn = math.cos(s["theta"]), math.sin(s["theta"])
    u, v = dx * c + dy * sn, -dx * sn + dy * c
    inside = (u / s["a"]) ** 2 + (v / s["b"]) ** 2 < 1
    sand_mask |= inside
    # ripples: 2 m wavelength, 12 cm amplitude, aligned across the wind
    height += inside * 0.12 * np.sin(2 * math.pi * v / 2.0)

# ---------------------------------------------------------------- rocks
# Golombek et al. cumulative fractional area: F(D) = k * exp(-q(k) * D), q = 1.79 + 0.152/k
K = 0.07
q = 1.79 + 0.152 / K
F = lambda D: K * math.exp(-q * D)
ROCK_HALF = 400.0                      # rocks only where the rover can go
area = (2 * ROCK_HALF) ** 2
edges = np.arange(0.35, 3.0, 0.05)
rocks = []
for d0, d1 in zip(edges[:-1], edges[1:]):
    frac = F(d0) - F(d1)
    dm = (d0 + d1) / 2
    n = int(round(frac * area / (math.pi / 4 * dm * dm)))
    for _ in range(n):
        D = rng.uniform(d0, d1)
        x, y = rng.uniform(-ROCK_HALF, ROCK_HALF, 2)
        shape = rng.choice(["rounded", "angular", "slab", "pitted"], p=[0.35, 0.35, 0.15, 0.15])
        embed = rng.choice(["embedded", "half-buried", "perched"], p=[0.45, 0.4, 0.15])
        tone = rng.choice(["dark", "light-toned", "mottled"], p=[0.6, 0.2, 0.2])
        # Golombek height/diameter ~0.5, slabs lower, perched higher
        hd = {"rounded": 0.5, "angular": 0.55, "slab": 0.25, "pitted": 0.5}[shape]
        hd *= {"embedded": 0.6, "half-buried": 0.85, "perched": 1.1}[embed]
        rocks.append({
            "x": round(float(x), 2), "y": round(float(y), 2),
            "d": round(float(D), 2), "h": round(float(D * hd), 2),
            "shape": str(shape), "embed": str(embed), "tone": str(tone),
            "rot": round(float(rng.uniform(0, 2 * math.pi)), 3),
        })
print(f"rocks >= 0.35 m in {int(2*ROCK_HALF)} m box: {len(rocks)}  (CFA k={K})")

# ---------------------------------------------------------------- albedo
ortho = tifffile.imread(RAW / "JEZ_ctx_ortho_6m.tif")
oc = int(round((cx - X0) / ORTHO_PX))
orow = int(round((Y0 - cy) / ORTHO_PX))
oh = int(round(HALF_DTM * DTM_PX / ORTHO_PX))
ocrop = ortho[orow - oh: orow + oh, oc - oh: oc + oh].astype(np.float64)
print(f"ortho crop {ocrop.shape}, {ocrop.min():.0f}..{ocrop.max():.0f}")
alb = np.asarray(Image.fromarray(ocrop.astype(np.float32), mode="F").resize((N, N), Image.BICUBIC))
alb = (alb - alb.min()) / (alb.max() - alb.min() + 1e-9)
grain = smooth_noise(N, 512, 0.06) + smooth_noise(N, 1024, 0.04)
alb = np.clip(alb * 0.75 + 0.15 + grain, 0, 1)
alb_sand = np.clip(alb + 0.18, 0, 1)
alb = np.where(sand_mask, alb_sand, alb)
# Jezero floor colour, roughly: warm ochre. Tint the greyscale ortho.
rgb = np.stack([alb * 0.86 + 0.06, alb * 0.55 + 0.04, alb * 0.36 + 0.02], -1)
Image.fromarray((rgb * 255).astype(np.uint8), "RGB").save(OUT / "albedo.jpg", quality=88)

# ---------------------------------------------------------------- write
hmin, hmax = float(height.min()), float(height.max())
h16 = ((height - hmin) / (hmax - hmin) * 65535).astype(np.uint16)
Image.fromarray(h16, mode="I;16").save(OUT / "height.png")
np.save(OUT / "height.npy", height.astype(np.float32))
Image.fromarray((sand_mask * 255).astype(np.uint8)).save(OUT / "sand.png")

lon0, lat0 = xy_to_lonlat(cx - SIZE_M / 2, cy + SIZE_M / 2)
lon1, lat1 = xy_to_lonlat(cx + SIZE_M / 2, cy - SIZE_M / 2)
meta = {
    "grid": N, "size_m": SIZE_M, "m_per_px": SIZE_M / N,
    "height_min": hmin, "height_max": hmax,
    "centre_lonlat": CENTER_LONLAT,
    "bbox_lonlat": {"west": lon0, "north": lat0, "east": lon1, "south": lat1},
    "vertical_datum": "MOLA areoid (USGS DTM), metres",
    "sources": {
        "dtm": "USGS Astrogeology, Mars 2020 TRN CTX DTM Mosaic, 20 m/px, JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif (Fergason et al. 2020, doi:10.5066/P906QQT8)",
        "ortho": "USGS Astrogeology, Mars 2020 TRN CTX Orthomosaic, 6 m/px, JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif",
        "rover": "NASA/JPL-Caltech, Mars Perseverance Rover 3D model (25042_Perseverance.glb), science.nasa.gov",
    },
    "synthetic": {
        "micro_relief": "fractal noise, amplitudes 0.45/0.18/0.06 m at ~40/10/2.5 m wavelengths",
        "rocks": f"Golombek CFA model k={K}, D>=0.35 m, h/D~0.5, within +/-{int(ROCK_HALF)} m",
        "sand": "7 ripple fields, 2 m wavelength, 0.12 m amplitude",
    },
}
(OUT / "meta.json").write_text(json.dumps(meta, indent=2))
(OUT / "rocks.json").write_text(json.dumps(rocks, separators=(",", ":")))
(OUT / "sand.json").write_text(json.dumps(sand, indent=1))
print("wrote", sorted(p.name for p in OUT.iterdir()))
print(json.dumps({k: meta[k] for k in ("height_min", "height_max", "bbox_lonlat")}, indent=1))
