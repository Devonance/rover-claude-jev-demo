"""ENav-style local planner and the perception helpers (port of public/enav.js and the
feature stage of public/vision.js). Pure functions; the nodes wrap them."""
import math
import numpy as np

CURVATURES = [-0.25, -0.15, -0.08, -0.03, 0.0, 0.03, 0.08, 0.15, 0.25]
ARC_LEN = 6.0
STEP = 0.5
FOOT_R = 1.5
TRACK_IN, TRACK_OUT, HALF_LEN, BELLY = 0.8, 1.65, 1.7, 0.48


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


class HeightMap:
    """Bilinear lookup on the local terrain model the simulator publishes."""
    def __init__(self, msg=None):
        self.ok = False
        if msg is None or msg.width == 0:
            return
        self.ox, self.oy, self.res = msg.origin_x, msg.origin_y, msg.resolution
        self.w, self.h = msg.width, msg.height
        self.z = np.frombuffer(bytes(msg.heights), dtype="<f4").reshape(self.h, self.w)
        self.sand = np.frombuffer(bytes(msg.sand), dtype=np.uint8).reshape(self.h, self.w) if len(msg.sand) == self.w * self.h else None
        self.ok = True

    def height(self, x, y):
        if not self.ok:
            return 0.0
        c = (x - self.ox) / self.res; r = (y - self.oy) / self.res
        c = min(max(c, 0.0), self.w - 1.001); r = min(max(r, 0.0), self.h - 1.001)
        c0, r0 = int(c), int(r); fc, fr = c - c0, r - r0
        z = self.z
        return float((z[r0, c0] * (1 - fc) + z[r0, c0 + 1] * fc) * (1 - fr) + (z[r0 + 1, c0] * (1 - fc) + z[r0 + 1, c0 + 1] * fc) * fr)

    def in_sand(self, x, y):
        if not self.ok or self.sand is None:
            return False
        c = int(round((x - self.ox) / self.res)); r = int(round((y - self.oy) / self.res))
        if c < 0 or r < 0 or c >= self.w or r >= self.h:
            return False
        return bool(self.sand[r, c])


def evaluate_arcs(x, y, heading, goal, hmap, keepouts, tilt_limit, step_limit, rocks, reverse=False):
    """rocks: list of dicts {x,y,d,h}. keepouts: list of dicts {x,y,r,label}. Returns (arcs, chosen_index)."""
    rocks = [r for r in rocks if r["h"] >= step_limit and math.hypot(r["x"] - x, r["y"] - y) < ARC_LEN + 4]
    allo = [{**o, "r": o["r"] - FOOT_R, "d0": math.hypot(o["x"] - x, o["y"] - y)} for o in keepouts]
    c0, s0 = math.cos(heading), math.sin(heading)

    def in_fp(r):
        dx, dy = r["x"] - x, r["y"] - y
        lon, lat = dx * c0 + dy * s0, -dx * s0 + dy * c0
        return abs(lon) <= HALF_LEN + r["d"] / 2 and abs(lat) - r["d"] / 2 < TRACK_OUT
    active = [r for r in rocks if not in_fp(r)]

    def rock_hit(px, py, c, sn):
        for r in active:
            dx, dy = r["x"] - px, r["y"] - py
            lon, lat = dx * c + dy * sn, -dx * sn + dy * c
            if abs(lon) > HALF_LEN + r["d"] / 2:
                continue
            a, rr = abs(lat), r["d"] / 2
            if a + rr > TRACK_IN and a - rr < TRACK_OUT:
                return f"rock {r['h']:.2f} m"
            if a - rr < TRACK_IN and r["h"] >= BELLY:
                return f"belly {r['h']:.2f} m"
        return None

    d = -1 if reverse else 1
    arcs = []
    for k in CURVATURES:
        px, py, th, blocked, max_tilt, path = x, y, heading, None, 0.0, []
        s = STEP
        while s <= ARC_LEN + 1e-6:
            th = heading + k * s * d
            px += math.cos(th) * STEP * d; py += math.sin(th) * STEP * d
            path.append((px, py))
            c, sn = math.cos(th), math.sin(th)
            hs = [hmap.height(px + lon * c + lat * sn, py + lon * sn - lat * c) for lat, lon in ((-1.2, 1.15), (1.2, 1.15), (-1.2, -1.1), (1.2, -1.1))]
            pitch = math.atan2((hs[0] + hs[1]) / 2 - (hs[2] + hs[3]) / 2, 2.25)
            roll = math.atan2((hs[1] + hs[3]) / 2 - (hs[0] + hs[2]) / 2, 2.4)
            tilt = math.degrees(math.hypot(pitch, roll))
            max_tilt = max(max_tilt, tilt)
            if tilt > tilt_limit:
                blocked = f"tilt {tilt:.0f}°"; break
            if s > STEP:
                blocked = rock_hit(px, py, c, sn)
                if blocked: break
            for o in allo:
                dd = math.hypot(o["x"] - px, o["y"] - py); safe = o["r"] + FOOT_R
                if dd < safe and not (o["d0"] < safe and dd >= o["d0"] - 0.15):
                    blocked = o["label"]; break
            if blocked: break
            s += STEP
        ex, ey = path[-1] if path else (x, y)
        gb = math.atan2(goal[1] - ey, goal[0] - ex)
        head_err = abs(wrap(gb - th))
        d0 = math.hypot(goal[0] - x, goal[1] - y); d1 = math.hypot(goal[0] - ex, goal[1] - ey)
        progress = (d0 - d1) / ARC_LEN
        cost = math.inf if blocked else 1.6 * (head_err / math.pi) + 0.5 * (max_tilt / tilt_limit) + 0.12 * (abs(k) / 0.25) + 0.9 * (1 - progress) + (1.5 if reverse else 0)
        arcs.append({"k": k, "path": path, "blocked": blocked, "max_tilt": max_tilt, "head_err": head_err, "progress": progress, "cost": cost})
    best = -1
    for i, a in enumerate(arcs):
        if a["cost"] < math.inf and (best < 0 or a["cost"] < arcs[best]["cost"]):
            best = i
    return arcs, best


def lookahead(x, y, heading, goal, hmap, keepouts, tilt_limit, step_limit, rocks, first, steps=7):
    pts = list(first["path"])
    if not pts:
        return pts
    px, py = pts[-1]; h = heading + first["k"] * ARC_LEN
    for _ in range(steps):
        if math.hypot(goal[0] - px, goal[1] - py) < 4:
            break
        arcs, b = evaluate_arcs(px, py, h, goal, hmap, keepouts, tilt_limit, step_limit, rocks)
        if b < 0:
            break
        pts.extend(arcs[b]["path"]); px, py = arcs[b]["path"][-1]; h += arcs[b]["k"] * ARC_LEN
    return pts


# ------------------------------------------------------------------ perception words
def bearing_words(rel):
    d = math.degrees(rel)
    if abs(d) < 8: return "dead ahead"
    if abs(d) < 25: return "slightly left of centre" if d > 0 else "slightly right of centre"
    return "well to the left" if d > 0 else "well to the right"


def scripted_feature(kind, x, y, heading, sun):
    """Scripted, semantically ambiguous features. Geometry cannot resolve these."""
    def ahead(dd, rel):
        return x + math.cos(heading + rel) * dd, y + math.sin(heading + rel) * dd
    if kind == "sand_field":
        px, py = ahead(7, 0.15)
        return {"id": "ev_sand", "kind": kind, "x": px, "y": py, "dist": 7, "rel": 0.15, "h": 0.12, "d": 5.5,
                "appearance": "bright, fine-grained patch with regular parallel ripples about a stride apart, filling the gap between two dark rocks",
                "bearing_words": bearing_words(0.15), "stereo_note": "stereo shows only low, regular ripple relief; no rocks inside the patch"}
    if kind == "shadow_ambiguity":
        px, py = ahead(5.5, -0.05)
        return {"id": "ev_shadow", "kind": kind, "x": px, "y": py, "dist": 5.5, "rel": -0.05, "h": None, "d": 0.6, "size_words": "possibly knee-height",
                "appearance": f"dark, elongated shape at the edge of a large rock's shadow on its {sun['shadow_dir']} side; its outline is sharper than the rest of the shadow and one edge may be catching light",
                "bearing_words": bearing_words(-0.05), "stereo_note": "mostly inside deep shadow; stereo returned only a handful of matches, relief could be anything from flat to knee-height"}
    if kind == "dust_devil":
        px, py = ahead(40, 0.6)
        return {"id": "ev_dd", "kind": kind, "x": px, "y": py, "dist": 9, "rel": 0.6, "h": None, "d": 8, "size_words": "tens of metres tall",
                "appearance": "tall, faint column of lifted dust moving across the far ground, in a different place in each Navcam frame",
                "bearing_words": "well to the left, on the horizon", "stereo_note": "no stable stereo match between frames"}
    return None


def sun_state(lmst_min):
    hour = lmst_min / 60
    el = max(4, 80 * math.sin(((hour - 6) / 12) * math.pi))
    az = "west" if hour < 12 else "east"
    return {"elevation_deg": el, "low": el < 30, "shadow_dir": az, "words": f"low in the {'east' if hour < 12 else 'west'}, long shadows" if el < 30 else "high, short shadows"}


# ------------------------------------------------------------------ feature detection
def detect(xyz, lum, rx, ry, heading, hmap, sun_low, seq, boost=False, W=192, H=108, group="navcam"):
    """xyz: (H,W,3) world points (x east, y north, z up) with NaN for no stereo match;
    lum: (H,W) display luminance 0..1. Row 0 is the top of the image.
    Port of Vision.detect(): relief above the local ground, connected blobs, words.
    group selects the window: the Navcam pair plans (1.9-13 m ahead); the Hazcam pairs check the
    ground just beyond the wheel line (0.3-4 m), where 'dist' is measured from that wheel line."""
    # front_hazcam_b is the redundant front pair: same geometry as front_hazcam, so it gets
    # the near-field window too. Treating it as a Navcam gave it the 1.9-13 m window, and
    # those far-field features then arrived in the sweep framed as "under the next wheel".
    front = group in ("front_hazcam", "front_hazcam_b")
    rear = group == "rear_hazcam"
    prefix = "fhb" if group == "front_hazcam_b" else "fh" if front else "rh" if rear else "v"
    gx, gy, gz = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    valid = np.isfinite(gz)
    c, s = math.cos(heading), math.sin(heading)
    dx, dy = gx - rx, gy - ry
    lon, lat = dx * c + dy * s, -dx * s + dy * c
    dist = np.hypot(dx, dy)
    ground_h = np.zeros_like(gz)
    if hmap.ok:
        ii, jj = np.where(valid)
        for i, j in zip(ii, jj):
            ground_h[i, j] = hmap.height(float(gx[i, j]), float(gy[i, j]))
    relief = gz - ground_h
    flat = lum[valid & (relief < 0.05) & (dist < 14)]
    ground = float(np.median(flat)) if flat.size else 0.45

    kind = np.zeros((H, W), dtype=np.uint8)
    idx = np.arange(H * W).reshape(H, W).astype(np.uint64)
    hash_ = ((idx * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)).astype(np.float64) / 4294967296.0
    if front:
        wheel = lon - 1.15; consider = valid & (wheel >= 0.3) & (wheel <= 4.0) & (np.abs(lat) < 2.4)
    elif rear:
        wheel = -lon - 1.1; consider = valid & (wheel >= 0.3) & (wheel <= 4.0) & (np.abs(lat) < 2.4)
    else:
        consider = valid & (dist >= 1.9) & (dist <= 13) & ~((lon < 1.2) & (np.abs(lat) < 1.6))
    shadowed = lum < ground * 0.5
    # Stereo dropout in deep shadow fails in PATCHES, not per pixel: a correlation window
    # either matches or it does not, and neighbouring windows fail together. Dropping
    # independent pixels tore shadowed boulders into single-pixel fragments that all fell
    # under the blob floor, leaving only the flat dark skirt connected - so the rock was
    # reported as a shadow, which is the worst error a driver can be handed.
    BLK = 4
    by_, bx_ = np.meshgrid(np.arange(H) // BLK, np.arange(W) // BLK, indexing="ij")
    blk_idx = (by_ * (W // BLK + 1) + bx_ + 977).astype(np.uint64)
    blk_hash = ((blk_idx * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)).astype(np.float64) / 4294967296.0
    dropped = blk_hash > 0.55
    # Two thresholds joined up afterwards: seed on strong relief so noise is rejected, grow
    # into weak relief so the blob is the rock's whole footprint and not just its crown.
    strong = consider & (relief > 0.075)
    weak = consider & (relief > 0.028)
    if not boost:
        strong &= ~(shadowed & dropped)
        weak &= ~(shadowed & dropped)
    rock = weak
    kind[rock] = 1
    dark = consider & ~rock & (lum < ground * 0.55) & (relief < 0.06) & ((dist < 9) if not (front or rear) else True)
    kind[dark & (kind == 0)] = 2
    bright = consider & ~rock & ~dark & (lum > ground + 0.13) & (relief < 0.16)
    kind[bright & (kind == 0)] = 3

    from scipy import ndimage
    CONN8 = np.ones((3, 3), dtype=bool)   # a rock touching diagonally is still one rock
    feats = []
    for kv, min_px in ((1, 6), (2, 30), (3, 60)):
        lab, n = ndimage.label(kind == kv, structure=CONN8)
        # a weak-relief blob with no strong core is ground texture, not a rock
        if kv == 1 and n:
            seeds = np.bincount(lab[strong].ravel(), minlength=n + 1)
        for b in range(1, n + 1):
            m = lab == b
            npx = int(m.sum())
            if npx < min_px:
                continue
            if kv == 1 and seeds[b] < 3:
                continue
            bx = gx[m]; by = gy[m]; rl = relief[m]; lm = lum[m]
            ys, xs = np.where(m)
            cx, cy = float(bx.mean()), float(by.mean())
            d = math.hypot(cx - rx, cy - ry)
            rel = wrap(math.atan2(cy - ry, cx - rx) - heading)
            if front or rear:  # distance beyond the wheel line, not from the rover centre
                lon_c = (cx - rx) * c + (cy - ry) * s
                d = max(0.0, (lon_c - 1.15) if front else (-lon_c - 1.1))
                if rear: rel = wrap(rel - math.pi)
            extent = float(max(bx.max() - bx.min(), by.max() - by.min(), 0.2))
            # Trim the shadow-skirt stragglers: the 2nd..98th percentile in each axis is the
            # rock, the last 2% is fringe, and a box drawn round the fringe is a box that
            # tells ENav to steer round something bigger than what is there.
            x_lo, x_hi = (int(v) for v in np.percentile(xs, [2, 98]))
            y_lo, y_hi = (int(v) for v in np.percentile(ys, [2, 98]))
            fill = npx / max(1, (x_hi - x_lo + 1) * (y_hi - y_lo + 1))
            mean_lum = float(lm.mean()); var_lum = float((lm * lm).mean() - mean_lum * mean_lum)
            shadow_frac = float((lm < ground * 0.5).mean())
            tone_rel = mean_lum - ground
            tone = "dark" if tone_rel < -0.08 else "light-toned" if tone_rel > 0.10 else "mottled" if var_lum > 0.02 else "medium-toned"
            max_h = float(rl.max())
            f = {"id": f"{prefix}{seq}_{len(feats)}", "x": cx, "y": cy, "dist": d, "rel": rel, "d": extent, "px": npx, "tone": tone,
                 "box": [x_lo, y_lo, x_hi - x_lo + 1, y_hi - y_lo + 1], "h": None, "h_est": max_h, "size_words": ""}
            if kv == 1:
                outline = "angular, irregular outline" if fill < 0.5 else "blocky" if fill < 0.68 else "rounded"
                slab = ", low and slab-like" if max_h / extent < 0.28 else ""
                f["kind"] = "rock"; f["h"] = max_h
                f["appearance"] = f"{tone}, {outline} rock about {extent:.1f} m across{slab}" + (", mostly inside a shadow" if shadow_frac > 0.5 else ", casting a long shadow" if sun_low else "")
                if shadow_frac > 0.5:
                    f["h"] = None
                    f["size_words"] = "possibly knee-height" if max_h > 0.3 else "possibly shin-height"
                    f["stereo_note"] = "mostly inside deep shadow; stereo returned only a handful of matches, relief could be anything from flat to knee-height"
                else:
                    f["stereo_note"] = f"stereo shows clear relief, {max_h:.2f} m above the surrounding surface"
            elif kv == 2:
                f["kind"] = "dark_patch"; f["size_words"] = "would be knee-height if it were a rock"
                f["appearance"] = f"dark, elongated patch on the ground about {extent:.1f} m long, same tone as the shadows of nearby rocks"
                f["stereo_note"] = "stereo shows no relief; the patch is flush with the ground"
            else:
                f["kind"] = "bright_patch"; f["h"] = 0.12
                f["appearance"] = f"bright, fine-grained patch about {extent:.0f} m across with low regular ripple texture"
                f["stereo_note"] = "stereo shows only low, regular ripple relief; no rocks inside the patch"
            f["bearing_words"] = bearing_words(rel)
            feats.append(f)
    feats.sort(key=lambda f: f["dist"])
    rocks = [f for f in feats if f["kind"] == "rock"][:8]
    patches = [f for f in feats if f["kind"] != "rock"][:2]
    return ground, rocks + patches
