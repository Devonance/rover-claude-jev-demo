// Perception: what the rover actually sees, not the world's rock list.
//
// A small camera rides the mast (Navcam). Each imaging cycle we render two
// frames from it: colour, and a packed depth buffer standing in for the stereo
// range map. Depth is unprojected to world points, relief above the local
// ground is measured, and connected blobs become "features" with numbers a
// stereo pipeline would produce: distance, bearing, extent, max relief, tone,
// outline. Those numbers are turned into words, and the words go to jev.
// Stereo in deep shadow is sparse, so shadowed pixels are sampled thinly —
// the same failure mode the real Navcams have.
import * as THREE from "three";

// Perception resolution. The real Navcams are 1280x960; this is the trade between what
// the pipeline can resolve and how long a frame takes to pull back to the CPU. At 192x108
// a 0.4 m rock at 8 m was two or three pixels and was usually thrown away as noise.
const W = 384, H = 216;
const gam = new Uint8Array(256); for (let i = 0; i < 256; i++) gam[i] = Math.round(255 * Math.pow(i / 255, 1 / 2.2));

export class Vision {
  // How big a range step between neighbouring pixels means "different object" rather than
  // "same rock, curving away". Too tight and one boulder shatters into a dozen fragments;
  // too loose and a near rock merges with the one behind it. Scales with range because
  // stereo range noise does.
  static splitStep(dist) { return Math.max(0.30, dist * 0.075); }

  constructor(renderer, scene, terrain, rover, spec = null) {
    this.renderer = renderer; this.scene = scene; this.terrain = terrain; this.rover = rover;
    this.spec = spec; // null = the classic mast Navcam; otherwise a rig entry (see cameras.js)
    this.cam = new THREE.PerspectiveCamera(spec?.fov ?? 88, W / H, 0.25, 45);
    this.cam.layers.set(0); // scene geometry only: no markers, rings, lines or flags
    this.rtColor = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtDepth = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.color = new Uint8Array(W * H * 4);
    this.depth = new Uint8Array(W * H * 4);
    this.lastFrame = null;
    this.seq = 0;
    this.width = W; this.height = H;   // consumers that re-grid the point cloud need these
  }

  // Place the Navcam on the mast, looking ahead and a little down.
  aim() {
    const st = this.rover.state, sp = this.spec;
    const f = new THREE.Vector3(Math.cos(st.heading), 0, -Math.sin(st.heading));
    const left = new THREE.Vector3(-Math.sin(st.heading), 0, -Math.cos(st.heading));
    let p;
    if (!sp || sp.mast) { p = this.rover.mastWorld(); p.y += 0.25; if (sp?.lat) p.addScaledVector(left, sp.lat); }
    else { p = this.rover.group.position.clone().addScaledVector(f, sp.lon ?? 0).addScaledVector(left, sp.lat ?? 0); p.y += sp.h ?? 0.6; }
    this.cam.position.copy(p);
    const yaw = st.heading + (sp?.yaw ?? 0), pitch = sp?.pitch ?? -0.2;
    const dir = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch));
    this.cam.lookAt(p.clone().add(dir));
    this.cam.updateMatrixWorld();
    this.cam.updateProjectionMatrix();
  }

  capture() {
    this.aim();
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevOverride = this.scene.overrideMaterial;
    const roverVisible = this.rover.group.visible;
    this.rover.group.visible = false; // the rover does not image its own deck
    r.setRenderTarget(this.rtColor); r.render(this.scene, this.cam);
    r.readRenderTargetPixels(this.rtColor, 0, 0, W, H, this.color);
    // depth pass: no sky colour, clear to white so empty pixels unpack past the far plane
    const bg = this.scene.background;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    this.scene.background = null;
    r.setClearColor(0xffffff, 1);
    this.scene.overrideMaterial = this.depthMat;
    r.setRenderTarget(this.rtDepth); r.render(this.scene, this.cam);
    r.readRenderTargetPixels(this.rtDepth, 0, 0, W, H, this.depth);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = bg;
    r.setClearColor(prevClear, prevAlpha);
    this.rover.group.visible = roverVisible;
    r.setRenderTarget(prevTarget);
    this.seq++;
  }

  // Depth pass only, no pixel readback. The coverage overlay shadow-tests the ground
  // against this texture on the GPU, so it can run at a much higher cadence than a full
  // capture(), which stalls the pipeline pulling both frames back to the CPU.
  captureDepth() {
    this.aim();
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevOverride = this.scene.overrideMaterial;
    const roverVisible = this.rover.group.visible;
    const bg = this.scene.background;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    this.rover.group.visible = false;
    this.scene.background = null;
    r.setClearColor(0xffffff, 1);
    this.scene.overrideMaterial = this.depthMat;
    r.setRenderTarget(this.rtDepth); r.render(this.scene, this.cam);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = bg;
    r.setClearColor(prevClear, prevAlpha);
    this.rover.group.visible = roverVisible;
    r.setRenderTarget(prevTarget);
  }

  // ---------------------------------------------------------- pixel -> world
  unpackDepth(i) {
    const d = this.depth;
    return d[i] / 255 + d[i + 1] / 65025 + d[i + 2] / 16581375 + d[i + 3] / 4228250625;
  }
  points() {
    const st = this.rover.state;
    const c = Math.cos(st.heading), s = Math.sin(st.heading);
    const out = new Array(W * H).fill(null);
    const v = new THREE.Vector3();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const idx = (j * W + i) * 4; // rows read bottom-up from the render target
      const z = this.unpackDepth(idx);
      if (z >= 0.9999 || z <= 0.0002) continue; // far plane, or cleared (sky) pixels
      v.set(((i + 0.5) / W) * 2 - 1, ((j + 0.5) / H) * 2 - 1, z * 2 - 1).unproject(this.cam);
      const gx = v.x, gy = -v.z;
      const dx = gx - st.x, dy = gy - st.y;
      const lon = dx * c + dy * s, lat = -dx * s + dy * c;
      const dist = Math.hypot(dx, dy);
      const relief = v.y - this.terrain.h(gx, gy);
      const lin = (0.30 * this.color[idx] + 0.59 * this.color[idx + 1] + 0.11 * this.color[idx + 2]) / 255;
      const lum = Math.pow(lin, 1 / 2.2); // the off-screen render is linear light
      out[j * W + i] = { gx, gy, lon, lat, dist, relief, lum, rel: Math.atan2(lat, lon) };
    }
    return out;
  }

  // ---------------------------------------------------------- features
  detect(sun, { boost = false } = {}) {
    const pts = this.points();
    // ground tone: median luminance of near-flat pixels
    const flat = [];
    for (const p of pts) if (p && p.relief < 0.05 && p.dist < 14) flat.push(p.lum);
    flat.sort((a, b) => a - b);
    const ground = flat.length ? flat[flat.length >> 1] : 0.45;

    const label = new Int32Array(W * H).fill(0);
    const kindOf = new Uint8Array(W * H); // 1 rock, 2 dark patch, 3 bright patch
    const strong = new Uint8Array(W * H); // rock pixels above the seed threshold
    const hash = (i) => ((i * 2654435761) >>> 0) / 4294967296;
    // Stereo dropout in deep shadow is real, but it fails in PATCHES — a correlation
    // window either finds a match or it does not, and neighbouring windows fail together.
    // Dropping independent pixels instead was destroying connectivity: a shadowed boulder
    // came apart into single-pixel fragments, every one below the blob floor, and the only
    // thing left that still joined up was its flat dark skirt. The rock was then reported
    // as a shadow, which is the worst possible error for a driver.
    const BLK = 4;
    const blocksW = Math.ceil(W / BLK);
    const dropped = (x, y) => hash(((y / BLK) | 0) * blocksW + ((x / BLK) | 0) + 977) > 0.55;
    // Window by camera group, the same split the ROS perception node uses. This was missing
    // here: every camera was given the mast Navcam's 1.9-13 m window, so the Hazcam pairs -
    // whose entire job is the 0.3-4 m the wheels are about to enter - threw away everything
    // they measured. The arm's obstacle set reads these features too, which is part of why
    // the turret could be driven into a rock nobody had recorded.
    const group = this.spec?.group ?? "navcam";
    const front = group === "front_hazcam" || group === "front_hazcam_b";
    const rear = group === "rear_hazcam";
    for (let i = 0; i < W * H; i++) {
      const p = pts[i]; if (!p) continue;
      if (front || rear) {
        const beyondWheel = (front ? p.lon - 1.15 : -p.lon - 1.1);
        if (beyondWheel < 0.3 || beyondWheel > 4.0 || Math.abs(p.lat) > 2.4) continue;
      } else {
        if (p.dist < 1.9 || p.dist > 13) continue;
        if (p.lon < 1.2 && Math.abs(p.lat) < 1.6) continue; // under the rover
      }
      const shadowed = p.lum < ground * 0.5;
      // Two thresholds, joined up afterwards. A single cut has to choose between finding
      // the rock (low) and drawing a tight box round it (high); seeding on strong relief
      // and growing into weak relief does both, so the box is the rock's real footprint
      // and not just its crown.
      if (p.relief > 0.075) { if (shadowed && !boost && dropped(i % W, (i / W) | 0)) continue; kindOf[i] = 1; strong[i] = 1; }
      else if (p.relief > 0.028) { if (shadowed && !boost && dropped(i % W, (i / W) | 0)) continue; kindOf[i] = 1; }
      else if (p.lum < ground * 0.55 && p.relief < 0.06 && p.dist < 9) kindOf[i] = 2;
      else if (p.lum > ground + 0.13 && p.relief < 0.16) kindOf[i] = 3;
    }
    // connected components, 4-neighbour, same kind
    const blobs = [];
    let n = 0;
    const stack = [];
    for (let i = 0; i < W * H; i++) {
      if (!kindOf[i] || label[i]) continue;
      n++;
      const kind = kindOf[i];
      const px = [];
      let seeds = 0;
      stack.push(i); label[i] = n;
      while (stack.length) {
        const k = stack.pop(); px.push(k); if (strong[k]) seeds++;
        const x = k % W, y = (k / W) | 0;
        const pk = pts[k];
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
                                [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const m = ny * W + nx;
          if (label[m] || kindOf[m] !== kind) continue;
          // Two rocks that overlap in the image are still two rocks: refuse to grow a
          // blob across a range step bigger than a stereo pipeline's own depth noise.
          // Without this, a near rock and the one behind it merge into one huge box.
          const pm = pts[m];
          if (pk && pm && Math.abs(pm.dist - pk.dist) > Vision.splitStep(pk.dist)) continue;
          label[m] = n; stack.push(m);
        }
      }
      blobs.push({ kind, px, seeds });
    }

    const feats = [];
    for (const b of blobs) {
      const minPx = b.kind === 1 ? 6 : b.kind === 2 ? 30 : 60;
      if (b.px.length < minPx) continue;
      if (b.kind === 1 && b.seeds < 3) continue; // weak relief with no core: ground texture, not a rock
      let sx = 0, sy = 0, maxH = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, lum = 0, lum2 = 0, dark = 0;
      let bx0 = W, bx1 = 0, by0 = H, by1 = 0;
      for (const k of b.px) {
        const p = pts[k];
        sx += p.gx; sy += p.gy; maxH = Math.max(maxH, p.relief);
        minX = Math.min(minX, p.gx); maxX = Math.max(maxX, p.gx); minY = Math.min(minY, p.gy); maxY = Math.max(maxY, p.gy);
        lum += p.lum; lum2 += p.lum * p.lum; if (p.lum < ground * 0.5) dark++;
        const x = k % W, y = (k / W) | 0;
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      }
      const m = b.px.length;
      // The raw pixel bounding box is inflated by the few stray pixels every blob picks up
      // at its shadow skirt. Take the 2nd..98th percentile in each axis instead, so the box
      // is around the rock rather than around the rock plus its fringe.
      {
        const xs = b.px.map((k) => k % W).sort((a, c) => a - c);
        const ys = b.px.map((k) => (k / W) | 0).sort((a, c) => a - c);
        const lo = Math.floor(m * 0.02), hi = Math.min(m - 1, Math.ceil(m * 0.98));
        bx0 = xs[lo]; bx1 = xs[hi]; by0 = ys[lo]; by1 = ys[hi];
      }
      const cx = sx / m, cy = sy / m;
      const st = this.rover.state;
      let dist = Math.hypot(cx - st.x, cy - st.y);
      let rel = Math.atan2(Math.sin(Math.atan2(cy - st.y, cx - st.x) - st.heading), Math.cos(Math.atan2(cy - st.y, cx - st.x) - st.heading));
      if (front || rear) {
        // a Hazcam reports how far beyond the wheel line a thing is, not how far from the
        // rover's centre: that is the number the "about to roll onto it" question is about
        const lonC = (cx - st.x) * Math.cos(st.heading) + (cy - st.y) * Math.sin(st.heading);
        dist = Math.max(0, front ? lonC - 1.15 : -lonC - 1.1);
        if (rear) rel = Math.atan2(Math.sin(rel - Math.PI), Math.cos(rel - Math.PI));
      }
      const extent = Math.max(maxX - minX, maxY - minY, 0.2);
      const fill = m / Math.max(1, (bx1 - bx0 + 1) * (by1 - by0 + 1));
      const meanLum = lum / m, varLum = lum2 / m - meanLum * meanLum;
      const shadowFrac = dark / m;
      const toneRel = meanLum - ground;
      const tone = toneRel < -0.08 ? "dark" : toneRel > 0.10 ? "light-toned" : varLum > 0.02 ? "mottled" : "medium-toned";
      // world-space footprint (metres), so obstacle inflation can use the measured size
      // rather than a single "extent" number applied in every direction
      const wx = Math.max(0.12, maxX - minX), wy = Math.max(0.12, maxY - minY);
      const prefix = front ? (group === "front_hazcam_b" ? "fhb" : "fh") : rear ? "rh" : "v";
      const f = { id: `${prefix}${this.seq}_${feats.length}`, x: cx, y: cy, dist, rel, box: [bx0, H - 1 - by1, bx1 - bx0 + 1, by1 - by0 + 1],
                  footprint: [wx, wy], px: m, source: group };
      if (b.kind === 1) {
        const outline = fill < 0.5 ? "angular, irregular outline" : fill < 0.68 ? "blocky" : "rounded";
        const slab = maxH / extent < 0.28 ? ", low and slab-like" : "";
        f.kind = "rock"; f.h = maxH; f.d = extent; f.tone = tone;
        f.appearance = `${tone}, ${outline} rock about ${extent.toFixed(1)} m across${slab}${shadowFrac > 0.5 ? ", mostly inside a shadow" : sun.low ? ", casting a long shadow" : ""}`;
        if (shadowFrac > 0.5) {
          f.h = null; f.hEst = maxH;
          f.size_words = maxH > 0.3 ? "possibly knee-height" : "possibly shin-height";
          f.stereo_note = "mostly inside deep shadow; stereo returned only a handful of matches, relief could be anything from flat to knee-height";
        } else {
          f.stereo_note = `stereo shows clear relief, ${maxH.toFixed(2)} m above the surrounding surface`;
        }
      } else if (b.kind === 2) {
        f.kind = "dark_patch"; f.h = null; f.d = extent;
        f.size_words = "would be knee-height if it were a rock";
        f.appearance = `dark, elongated patch on the ground about ${extent.toFixed(1)} m long, same tone as the shadows of nearby rocks`;
        f.stereo_note = "stereo shows no relief; the patch is flush with the ground";
      } else {
        f.kind = "bright_patch"; f.h = 0.12; f.d = extent;
        f.appearance = `bright, fine-grained patch about ${extent.toFixed(0)} m across with low regular ripple texture`;
        f.stereo_note = "stereo shows only low, regular ripple relief; no rocks inside the patch";
      }
      f.bearing_words = bearingWords(rel);
      feats.push(f);
    }
    // nearest first; cap what we hand to jev per cycle
    feats.sort((a, b) => a.dist - b.dist);
    const rocks = feats.filter((f) => f.kind === "rock").slice(0, 8);
    const patches = feats.filter((f) => f.kind !== "rock").slice(0, 2);
    this.lastFrame = { ground, feats: [...rocks, ...patches] };
    return this.lastFrame.feats;
  }

  // ---------------------------------------------------------- picture-in-picture
  draw(canvas, feats, verdicts, rect = null) {
    const g = canvas.getContext("2d");
    const cw = rect ? rect.w : canvas.width, ch = rect ? rect.h : canvas.height;
    const ox = rect ? rect.x : 0, oy = rect ? rect.y : 0;
    g.save(); g.translate(ox, oy);
    const img = g.createImageData(W, H);
    // flip vertically: render targets are bottom-up
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const s = ((H - 1 - j) * W + i) * 4, d = (j * W + i) * 4;
      img.data[d] = gam[this.color[s]]; img.data[d + 1] = gam[this.color[s + 1]]; img.data[d + 2] = gam[this.color[s + 2]]; img.data[d + 3] = 255;
    }
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    off.getContext("2d").putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(off, 0, 0, cw, ch);
    g.beginPath(); g.rect(0, 0, cw, ch); g.clip();
    const sx = cw / W, sy = ch / H;
    g.lineWidth = 2; g.font = "11px ui-monospace, monospace"; g.textBaseline = "top";
    for (const f of feats ?? []) {
      if (!f.box) continue; // scripted/injected descriptors have no image box
      const v = verdicts?.[f.id];
      const color = !v ? "#4fd18b" : v.cls === "warn" ? "#ea6a5a" : v.cls === "unsure" ? "#b48cff" : "#9aa5b1";
      const [x, y, w, h] = f.box;
      g.strokeStyle = color; g.strokeRect(x * sx, y * sy, w * sx, h * sy);
      const txt = `${f.kind === "rock" ? (f.h != null ? f.h.toFixed(2) + " m" : "?") : f.kind.replace("_", " ")} · ${f.dist.toFixed(1)} m${v ? " · " + v.text : ""}`;
      g.fillStyle = "rgba(8,10,13,.75)";
      const tw = g.measureText(txt).width + 6;
      g.fillRect(x * sx, Math.max(0, y * sy - 14), tw, 13);
      g.fillStyle = color; g.fillText(txt, x * sx + 3, Math.max(0, y * sy - 13));
    }
    g.restore();
  }
  png() {
    const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2;
    this.draw(c, [], {});
    return c.toDataURL("image/png");
  }
}

const bearingWords = (rel) => {
  const d = (rel * 180) / Math.PI;
  if (Math.abs(d) < 8) return "dead ahead";
  if (Math.abs(d) < 25) return d > 0 ? "slightly left of centre" : "slightly right of centre";
  return d > 0 ? "well to the left" : "well to the right";
};
