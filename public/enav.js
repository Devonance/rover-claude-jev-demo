// ENav-style local planner, in code. Geometry only: arcs, tilt, clearance.
// What it cannot know from geometry (is that dark patch a rock or a shadow?
// will that bright patch swallow a wheel?) is what jev is asked. Those
// verdicts arrive here as obstacles and keep-outs.

export const CURVATURES = [-0.25, -0.15, -0.08, -0.03, 0, 0.03, 0.08, 0.15, 0.25];
export const ARC_LEN = 6;
export const STEP = 0.5;
const FOOT_R = 1.5;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function evaluateArcs({ x, y, heading, goal, terrain, obstacles, keepouts, tiltLimit, stepLimit, reverse = false, rocks: rockList = null }) {
  // Obstacles the rover is already inside of (it drove up to them, or jev flagged
  // them beside the rover) must not deadlock the planner: an arc is blocked only
  // if it gets CLOSER to such an obstacle than it already is.
  // ACE-style rock check: a rock only matters if it lies under a wheel track
  // (step limit) or under the belly (clearance). Rocks between the tracks that
  // fit under the belly are driven over, as the real rover does.
  // Forward: only rocks the Navcam has actually seen and measured (perception map).
  // Reverse: the rear Hazcams see the ground behind, so use the local truth there.
  const rocks = (rockList ?? terrain.rocksNear(x, y, ARC_LEN + 4).map(({ rock }) => rock)).filter((r) => r.h >= stepLimit && Math.hypot(r.x - x, r.y - y) < ARC_LEN + 4);
  const all = [...obstacles.map((o) => ({ ...o, r: o.r })), ...keepouts.map((o) => ({ ...o, r: o.r - FOOT_R, keep: true }))];
  for (const o of all) o.d0 = Math.hypot(o.x - x, o.y - y);
  const TRACK_IN = 0.8, TRACK_OUT = 1.65, HALF_LEN = 1.7, BELLY = 0.48;
  const rockHit = (px, py, c, sn, list) => {
    for (const r of list) {
      const dx = r.x - px, dy = r.y - py;
      const lon = dx * c + dy * sn, lat = -dx * sn + dy * c;
      if (Math.abs(lon) > HALF_LEN + r.d / 2) continue;
      const a = Math.abs(lat), rr = r.d / 2;
      const underTrack = a + rr > TRACK_IN && a - rr < TRACK_OUT;
      const underBelly = a - rr < TRACK_IN;
      if (underTrack) return `rock ${r.h.toFixed(2)} m`;
      if (underBelly && r.h >= BELLY) return `belly ${r.h.toFixed(2)} m`;
    }
    return null;
  };
  // A rock already inside the footprint (the rover parked on or beside it, or it was
  // below the stereo threshold on approach) cannot be allowed to veto every move:
  // the only way off it is to move. Drop such rocks for this evaluation.
  const c0 = Math.cos(heading), s0 = Math.sin(heading);
  const inFootprintNow = (r) => {
    const dx = r.x - x, dy = r.y - y;
    const lon = dx * c0 + dy * s0, lat = -dx * s0 + dy * c0;
    return Math.abs(lon) <= HALF_LEN + r.d / 2 && Math.abs(lat) - r.d / 2 < TRACK_OUT;
  };
  const rocksActive = rocks.filter((r) => !inFootprintNow(r));
  const dir = reverse ? -1 : 1;

  const arcs = CURVATURES.map((k) => {
    let px = x, py = y, th = heading, blocked = null, maxTilt = 0;
    const path = [];
    for (let s = STEP; s <= ARC_LEN + 1e-6; s += STEP) {
      th = heading + k * s * dir;
      px += Math.cos(th) * STEP * dir; py += Math.sin(th) * STEP * dir;
      path.push([px, py]);
      const c = Math.cos(th), sn = Math.sin(th);
      const hs = [[-1.2, 1.15], [1.2, 1.15], [-1.2, -1.1], [1.2, -1.1]].map(([lat, lon]) => terrain.h(px + lon * c + lat * sn, py + lon * sn - lat * c));
      const pitch = Math.atan2((hs[0] + hs[1]) / 2 - (hs[2] + hs[3]) / 2, 2.25);
      const roll = Math.atan2((hs[1] + hs[3]) / 2 - (hs[0] + hs[2]) / 2, 2.4);
      const tilt = (Math.hypot(pitch, roll) * 180) / Math.PI;
      maxTilt = Math.max(maxTilt, tilt);
      if (tilt > tiltLimit) { blocked = `tilt ${tilt.toFixed(0)}°`; break; }
      if (s > STEP) { blocked = rockHit(px, py, c, sn, rocksActive); if (blocked) break; }
      for (const o of all) {
        const d = Math.hypot(o.x - px, o.y - py);
        const safe = o.r + FOOT_R;
        if (d < safe && !(o.d0 < safe && d >= o.d0 - 0.15)) { blocked = o.label; break; }
      }
      if (blocked) break;
    }
    const end = path[path.length - 1] ?? [x, y];
    const goalBearing = Math.atan2(goal.y - end[1], goal.x - end[0]);
    const headErr = Math.abs(wrap(goalBearing - th));
    const d0 = Math.hypot(goal.x - x, goal.y - y), d1 = Math.hypot(goal.x - end[0], goal.y - end[1]);
    const progress = (d0 - d1) / ARC_LEN;
    const cost = blocked ? Infinity : 1.6 * (headErr / Math.PI) + 0.5 * (maxTilt / tiltLimit) + 0.12 * (Math.abs(k) / 0.25) + 0.9 * (1 - progress) + (reverse ? 1.5 : 0);
    return { k, path, blocked, maxTilt, headErr, progress, cost, reverse };
  });
  let best = null;
  for (const a of arcs) if (a.cost < Infinity && (!best || a.cost < best.cost)) best = a;
  return { arcs, chosen: best };
}

// ------------------------------------------------------------------ perception
// What the "image-based detector" hands to jev: words, not numbers.
const bearingWords = (rel) => {
  const d = (rel * 180) / Math.PI;
  if (Math.abs(d) < 8) return "dead ahead";
  if (Math.abs(d) < 25) return d > 0 ? "slightly left of centre" : "slightly right of centre";
  return d > 0 ? "well to the left" : "well to the right";
};

export function describeRock(r, sun) {
  const shadow = sun.low ? ` with a long shadow stretching ${sun.shadowDir}` : "";
  const shape = { rounded: "rounded", angular: "angular, sharp-edged", slab: "flat slab-like", pitted: "pitted, vesicular" }[r.shape];
  return `${r.tone}, ${shape} rock, ${r.embed}${shadow}`;
}

export function detectFeatures({ x, y, heading, terrain, sun, radius = 9, max = 3, minH = 0.16 }) {
  const out = [];
  for (const { rock, dist } of terrain.rocksNear(x, y, radius)) {
    if (rock.h < minH || dist < 1.5) continue;
    const rel = wrap(Math.atan2(rock.y - y, rock.x - x) - heading);
    if (Math.abs(rel) > (50 * Math.PI) / 180) continue;
    out.push({ rock, dist, rel });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, max).map(({ rock, dist, rel }, i) => ({
    id: `r${rock.i}`,
    kind: "rock", rock, dist, rel,
    x: rock.x, y: rock.y,
    appearance: describeRock(rock, sun),
    h: rock.h,
    bearing_words: bearingWords(rel),
    stereo_note: "stereo shows clear relief above the surrounding surface",
  }));
}

// Scripted, semantically ambiguous features. Geometry cannot resolve these.
export function scriptedFeature(kind, { x, y, heading, sun }) {
  const ahead = (d, rel) => ({ x: x + Math.cos(heading + rel) * d, y: y + Math.sin(heading + rel) * d });
  switch (kind) {
    case "sand_field": {
      const p = ahead(7, 0.15);
      return { id: "ev_sand", kind, ...p, dist: 7, rel: 0.15, h: 0.12,
        appearance: "bright, fine-grained patch with regular parallel ripples about a stride apart, filling the gap between two dark rocks",
        bearing_words: bearingWords(0.15), stereo_note: "stereo shows only low, regular ripple relief; no rocks inside the patch" };
    }
    case "shadow_ambiguity": {
      const p = ahead(5.5, -0.05);
      return { id: "ev_shadow", kind, ...p, dist: 5.5, rel: -0.05, h: null, size_words: "possibly knee-height",
        appearance: `dark, elongated shape at the edge of a large rock's shadow on its ${sun.shadowDir} side; its outline is sharper than the rest of the shadow and one edge may be catching light`,
        bearing_words: bearingWords(-0.05), stereo_note: "mostly inside deep shadow; stereo returned only a handful of matches, relief could be anything from flat to knee-height" };
    }
    case "dust_devil": {
      const p = ahead(40, 0.6);
      return { id: "ev_dd", kind, ...p, dist: 9, rel: 0.6, h: null, size_words: "tens of metres tall",
        appearance: "tall, faint column of lifted dust moving across the far ground, in a different place in each Navcam frame",
        bearing_words: "well to the left, on the horizon", stereo_note: "no stable stereo match between frames" };
    }
  }
  return null;
}

export function sunState(lmstMin) {
  const hour = lmstMin / 60;
  const el = Math.max(4, 80 * Math.sin(((hour - 6) / 12) * Math.PI));
  const az = hour < 12 ? "west" : "east";
  return { elevationDeg: el, low: el < 30, shadowDir: az, words: el < 30 ? `low in the ${hour < 12 ? "east" : "west"}, long shadows` : "high, short shadows" };
}

// Where ENav currently thinks it is going: chain arc choices forward from the
// chosen arc's endpoint, against the same obstacles and keep-outs. Recomputed
// every cycle, so the drawn route bends the moment jev adds a keep-out.
export function lookahead(base, first, steps = 7) {
  const pts = first.path.map(([x, y]) => [x, y]);
  let x = pts[pts.length - 1][0], y = pts[pts.length - 1][1];
  let heading = base.heading + first.k * ARC_LEN;
  for (let i = 0; i < steps; i++) {
    if (Math.hypot(base.goal.x - x, base.goal.y - y) < 4) break;
    const res = evaluateArcs({ ...base, x, y, heading });
    if (!res.chosen) break;
    for (const p of res.chosen.path) pts.push(p);
    x = res.chosen.path[res.chosen.path.length - 1][0]; y = res.chosen.path[res.chosen.path.length - 1][1];
    heading += res.chosen.k * ARC_LEN;
  }
  return pts;
}
