// Terrain from the USGS Jezero products (see tools/build_terrain.py).
// Game coords: x east, y north, metres from centre. three.js: (x, up, -y).
// Rocks are 14 CC0 photogrammetry scans from Poly Haven (moon_rock_01-07, namaqualand_boulder/stones,
// rock_09, stone_01), decimated and normalised to a unit box by tools/prep_rocks.py, instanced per
// variant and tinted per rock to the Máaz / Séítah tones. Named targets use the hi-res versions.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const ROCK_VARIANTS = ["moon_rock_01", "moon_rock_02", "moon_rock_03", "moon_rock_04", "moon_rock_05", "moon_rock_06", "moon_rock_07",
  "namaqualand_boulder_02", "namaqualand_boulder_03", "namaqualand_boulder_05", "namaqualand_boulder_06", "namaqualand_stones_01", "rock_09", "stone_01"]; // sand_rocks_small_01 is a cluster on a sand base: excluded

function parseNpy(buf) {
  const u8 = new Uint8Array(buf);
  const major = u8[6];
  const hlen = major === 1 ? u8[8] | (u8[9] << 8) : u8[8] | (u8[9] << 8) | (u8[10] << 16) | (u8[11] << 24);
  const start = (major === 1 ? 10 : 12) + hlen;
  const header = new TextDecoder().decode(u8.slice(major === 1 ? 10 : 12, start));
  const shape = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/).slice(1).map(Number);
  if (!header.includes("<f4")) throw new Error("expected <f4 npy");
  return { data: new Float32Array(buf, start, shape[0] * shape[1]), rows: shape[0], cols: shape[1] };
}

const loadImageData = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      resolve(g.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = reject;
    img.src = url;
  });

// mean luminance of a texture image (so tints normalise a grey moon scan and a tan desert scan alike)
function meanLum(tex) {
  try {
    const img = tex.image; const c = document.createElement("canvas"); c.width = 64; c.height = 64;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data; let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;
    return s / (d.length / 4);
  } catch { return 0.5; }
}

async function loadRockVariants() {
  const loader = new GLTFLoader();
  const one = async (id, tag) => {
    try {
      const g = await loader.loadAsync(`/assets/rocks/${id}_${tag}.glb`);
      let mesh = null; g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      if (!mesh) return null;
      const geo = mesh.geometry; geo.computeVertexNormals();
      const map = mesh.material?.map ?? null; if (map) map.colorSpace = THREE.SRGBColorSpace;
      return { id, geo, map, lum: map ? meanLum(map) : 0.5 };
    } catch { return null; }
  };
  const lo = (await Promise.all(ROCK_VARIANTS.map((id) => one(id, "lo")))).filter(Boolean);
  // hi-res versions (1k textures) are only needed for the handful of named targets: load them lazily
  const hiCache = new Map();
  const hi = (id) => { if (!hiCache.has(id)) hiCache.set(id, one(id, "hi")); return hiCache.get(id); };
  return { lo, hi };
}

export async function loadTerrain() {
  const [meta, npyBuf, sandImg, rocksRaw, sandEll, variants] = await Promise.all([
    fetch("/assets/terrain/meta.json").then((r) => r.json()),
    fetch("/assets/terrain/height.npy").then((r) => r.arrayBuffer()),
    loadImageData("/assets/terrain/sand.png"),
    fetch("/assets/terrain/rocks.json").then((r) => r.json()),
    fetch("/assets/terrain/sand.json").then((r) => r.json()),
    loadRockVariants(),
  ]);
  const { data, rows: N } = parseNpy(npyBuf);
  const size = meta.size_m;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const h0 = sum / data.length;

  const sandMask = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) sandMask[i] = sandImg.data[i * 4] > 127 ? 1 : 0;
  const toGrid = (x, y) => [((x / size) + 0.5) * (N - 1), (0.5 - (y / size)) * (N - 1)];

  function h(x, y) {
    let [c, r] = toGrid(x, y);
    c = Math.min(Math.max(c, 0), N - 1.001); r = Math.min(Math.max(r, 0), N - 1.001);
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0;
    const i = r0 * N + c0;
    const a = data[i], b = data[i + 1], cc = data[i + N], d = data[i + N + 1];
    return (a * (1 - fc) + b * fc) * (1 - fr) + (cc * (1 - fc) + d * fc) * fr - h0;
  }
  function inSand(x, y) {
    const [c, r] = toGrid(x, y);
    const ci = Math.round(c), ri = Math.round(r);
    if (ci < 0 || ri < 0 || ci >= N || ri >= N) return false;
    return sandMask[ri * N + ci] === 1;
  }
  function slopeDeg(x, y) {
    const e = 1.0;
    const dx = (h(x + e, y) - h(x - e, y)) / (2 * e);
    const dy = (h(x, y + e) - h(x, y - e)) / (2 * e);
    return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  }

  // ---------------------------------------------------------------- mesh
  const SEG = 511;
  const geo = new THREE.PlaneGeometry(size, size, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); pos.setY(i, h(x, -z)); }
  geo.computeVertexNormals();
  const tex = await new THREE.TextureLoader().loadAsync("/assets/terrain/albedo.jpg");
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0 }));
  mesh.receiveShadow = true;

  // ---------------------------------------------------------------- rocks
  const rocks = rocksRaw.map((r, i) => ({ ...r, i }));
  const cell = 10;
  const grid = new Map();
  for (const r of rocks) {
    const k = `${Math.floor(r.x / cell)},${Math.floor(r.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  function rocksNear(x, y, radius) {
    const out = [];
    const c0 = Math.floor((x - radius) / cell), c1 = Math.floor((x + radius) / cell);
    const r0 = Math.floor((y - radius) / cell), r1 = Math.floor((y + radius) / cell);
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
      const lst = grid.get(`${cx},${cy}`);
      if (!lst) continue;
      for (const r of lst) { const d = Math.hypot(r.x - x, r.y - y); if (d <= radius) out.push({ rock: r, dist: d }); }
    }
    return out;
  }

  // one InstancedMesh per scan variant; a rock's variant is a hash of its index (stable across loads)
  const tones = { dark: 0x6b584a, "light-toned": 0xb6987a, mottled: 0x8a7059 };
  const group = new THREE.Group();
  const rockMeshes = [];
  let vars = variants.lo;
  if (!vars.length) {
    // fallback: the old procedural rock
    const g0 = new THREE.IcosahedronGeometry(0.5, 1);
    vars = [{ id: "procedural", geo: g0, map: null, lum: 0.5 }];
  }
  const hash = (i) => ((i * 2654435761) >>> 0) % vars.length;
  const buckets = vars.map(() => []);
  for (const r of rocks) { r.variant = hash(r.i); buckets[r.variant].push(r); }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const col = new THREE.Color();
  vars.forEach((v, vi) => {
    const list = buckets[vi]; if (!list.length) return;
    const mat = new THREE.MeshStandardMaterial({ map: v.map ?? null, roughness: 0.94, metalness: 0.0 });
    const inst = new THREE.InstancedMesh(v.geo, mat, list.length);
    inst.castShadow = true; inst.receiveShadow = true;
    const idx = new Int32Array(list.length);
    const gain = Math.min(3.5, 1.0 / Math.max(0.12, v.lum)); // normalise the scan's own brightness so the tint reads the same on every variant
    list.forEach((r, k) => {
      const sink = r.embed === "embedded" ? 0.45 : r.embed === "half-buried" ? 0.3 : 0.12;
      t.set(r.x, h(r.x, r.y) + r.h * (0.5 - sink), -r.y);
      q.setFromEuler(new THREE.Euler(0, r.rot, 0));
      s.set(r.d, r.h * 2, r.d * 0.85);
      m.compose(t, q, s);
      inst.setMatrixAt(k, m);
      col.setHex(tones[r.tone] ?? tones.dark).offsetHSL(0, 0, (r.i % 7) * 0.012 - 0.03).multiplyScalar(gain);
      inst.setColorAt(k, col);
      idx[k] = r.i;
    });
    inst.instanceMatrix.needsUpdate = true; inst.instanceColor.needsUpdate = true;
    inst.userData.rockIndex = idx; inst.userData.variant = v.id;
    group.add(inst); rockMeshes.push(inst);
  });

  return { meta, size, N, h, h0, heightData: data, inSand, slopeDeg, rocks, rocksNear, sandEllipses: sandEll, mesh, rockMesh: group, rockMeshes, rockVariants: variants,
    rockSource: variants.lo.length ? `${variants.lo.length} Poly Haven CC0 photogrammetry scans` : "procedural" };
}

// Pick a rock from a raycast against the rock group: returns the rock record or null.
export function rockFromHit(terrain, hits) {
  for (const hit of hits) {
    const o = hit.object;
    if (o?.isInstancedMesh && o.userData.rockIndex && hit.instanceId != null) return terrain.rocks[o.userData.rockIndex[hit.instanceId]];
  }
  return null;
}
