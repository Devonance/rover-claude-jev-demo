// Scene shell: three.js world, cameras, lighting, markers. The sol logic is in game.js.
import * as THREE from "three";
import { loadTerrain, rockFromHit } from "./terrain.js";
import { loadRover } from "./rover.js";
import { ops } from "./ops.js";
import { Game } from "./game.js";
import { Vision } from "./vision.js";
import { CameraRig } from "./cameras.js";
import { Coverage } from "./coverage.js";

const canvas = document.getElementById("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9a27a);
scene.fog = new THREE.Fog(0xc9a27a, 180, 900);

const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 3000);
camera.layers.enable(1); // UI overlays (markers, rings, lines, flags) live on layer 1; the Navcam never sees them
const overlay = (o) => { o.traverse ? o.traverse((c) => c.layers.set(1)) : o.layers.set(1); return o; };
const sun = new THREE.DirectionalLight(0xffe2c4, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 400;
sun.shadow.camera.left = sun.shadow.camera.bottom = -45;
sun.shadow.camera.right = sun.shadow.camera.top = 45;
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xd9b48e, 0x5a3a26, 0.9));

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const W = (x, y, h) => new THREE.Vector3(x, h, -y); // game -> three

// ------------------------------------------------------------------ markers
function labelSprite(text, color = "#ffffff", fixed = false) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d");
  g.font = "600 44px ui-sans-serif, system-ui";
  g.fillStyle = "rgba(8,10,13,.72)";
  const wpx = g.measureText(text).width + 40;
  g.beginPath(); g.roundRect((512 - wpx) / 2, 24, wpx, 80, 14); g.fill();
  g.fillStyle = color; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: !fixed }));
  if (fixed) sp.scale.set(0.19, 0.0475, 1); else sp.scale.set(12, 3, 1);
  return sp;
}

const view = {
  scene, camera, renderer, sun, W,
  terrain: null, rover: null, targets: [], marks: [], dynamic: [],
  camMode: "chase", camT: 0, orbit: 0, navcamLook: null,

  addTarget(t) {
    const h = this.terrain.h(t.x, t.y);
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.6, 48), new THREE.MeshBasicMaterial({ color: 0xe6b45a, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6, 6), new THREE.MeshBasicMaterial({ color: 0xe6b45a }));
    pole.position.y = 3;
    const lab = labelSprite(t.name, "#ffd68a"); lab.position.y = 7.5;
    // the target itself: a distinct rock so there is something to drive up to and image
    const size = /(\d+(?:\.\d+)?)\s*m across/.exec(t.description)?.[1] ? Number(/(\d+(?:\.\d+)?)\s*m across/.exec(t.description)[1]) : 1.4;
    const light = /light-toned/i.test(t.description);
    const lv = this.terrain.rockVariants?.lo ?? [];
    let rock;
    if (lv.length) {
      const v = lv[Math.abs([...t.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % lv.length];
      const tint = (vv) => new THREE.Color(light ? 0xa8907a : 0x3b3230).multiplyScalar(Math.min(3.5, 1.0 / Math.max(0.12, vv.lum)));
      rock = new THREE.Mesh(v.geo, new THREE.MeshStandardMaterial({ map: v.map ?? null, roughness: 0.9, color: tint(v) }));
      rock.scale.set(size, size * 0.7, size * 0.85);
      this.terrain.rockVariants.hi(v.id).then((hv) => { if (!hv) return; rock.geometry = hv.geo; rock.material.map = hv.map; rock.material.color = tint(hv); rock.material.needsUpdate = true; });
    } else {
      const rockGeo = new THREE.IcosahedronGeometry(size / 2, 2);
      rock = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({ color: light ? 0xa8907a : 0x3b3230, roughness: 0.9 }));
    }
    rock.position.y = size * 0.22; rock.castShadow = true; rock.receiveShadow = true;
    g.add(ring, pole, lab, rock);
    overlay(ring); overlay(pole); overlay(lab);
    g.position.copy(W(t.x, t.y, h));
    scene.add(g);
    this.targets.push({ ...t, group: g, ring });
  },
  highlightGoal(id) {
    for (const t of this.targets) t.ring.material.color.setHex(t.id === id ? 0x5aa7e6 : 0xe6b45a);
  },
  mark(x, y, color, size = 1.2, ttl = 5000) {
    const h = this.terrain.h(x, y);
    const m = overlay(new THREE.Mesh(new THREE.BoxGeometry(size, size * 1.6, size), new THREE.MeshBasicMaterial({ color, wireframe: true })));
    m.position.copy(W(x, y, h + size * 0.8));
    scene.add(m);
    setTimeout(() => scene.remove(m), ttl);
    return m;
  },
  ring(x, y, r, color, ttl = 0) {
    const h = this.terrain.h(x, y);
    const m = overlay(new THREE.Mesh(new THREE.RingGeometry(r - 0.25, r, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8 })));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(W(x, y, h + 0.15));
    scene.add(m);
    if (ttl) setTimeout(() => scene.remove(m), ttl);
    return m;
  },
  sandPatch(x, y, r) {
    const geo = new THREE.CircleGeometry(r, 40);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const gx = x + p.getX(i), gy = y + p.getY(i);
      p.setZ(i, this.terrain.h(gx, gy) - this.terrain.h(x, y) + 0.12);
    }
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9b68a, roughness: 1 }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(W(x, y, this.terrain.h(x, y)));
    scene.add(m);
    return m;
  },
  dustDevil(x, y) {
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = Math.random(), a = Math.random() * Math.PI * 2, r = (1.5 + t * 6) * Math.sqrt(Math.random());
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = t * 45; pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = overlay(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xe0c2a0, size: 1.4, transparent: true, opacity: 0.55, depthWrite: false })));
    pts.position.copy(W(x, y, this.terrain.h(x, y)));
    scene.add(pts);
    const obj = { mesh: pts, vx: 1.6, vy: 0.6, life: 60 };
    this.dynamic.push(obj);
    return obj;
  },
  track: null, trackPts: [],
  addTrack(x, y) {
    this.trackPts.push(W(x, y, this.terrain.h(x, y) + 0.12));
    if (this.track) scene.remove(this.track);
    if (this.trackPts.length > 1) {
      this.track = overlay(new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.trackPts), new THREE.LineBasicMaterial({ color: 0xe6b45a })));
      scene.add(this.track);
    }
  },
  plannedLine: null,
  planned(from, to) {
    if (this.plannedLine) scene.remove(this.plannedLine);
    if (!to) { this.plannedLine = null; return; }
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const x = from.x + (to.x - from.x) * (i / 40), y = from.y + (to.y - from.y) * (i / 40);
      pts.push(W(x, y, this.terrain.h(x, y) + 0.4));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.plannedLine = overlay(new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x5aa7e6, dashSize: 2, gapSize: 1.5 })));
    this.plannedLine.computeLineDistances();
    scene.add(this.plannedLine);
  },
  // ---- paths: travelled (gold), intended (cyan dashed), current ENav arc (blue)
  futureLine: null, arcLine: null, waypoints: [],
  future(pts) {
    if (this.futureLine) scene.remove(this.futureLine);
    this.futureLine = null;
    if (!pts || pts.length < 2) return;
    const v = pts.map(([x, y]) => W(x, y, this.terrain.h(x, y) + 0.35));
    const geo = new THREE.BufferGeometry().setFromPoints(v);
    this.futureLine = overlay(new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x4fe3e0, dashSize: 1.2, gapSize: 0.8, linewidth: 2 })));
    this.futureLine.computeLineDistances();
    scene.add(this.futureLine);
  },
  arc(pts) {
    if (this.arcLine) scene.remove(this.arcLine);
    this.arcLine = null;
    if (!pts || pts.length < 2) return;
    const v = [W(this.rover.state.x, this.rover.state.y, this.terrain.h(this.rover.state.x, this.rover.state.y) + 0.3), ...pts.map(([x, y]) => W(x, y, this.terrain.h(x, y) + 0.3))];
    this.arcLine = overlay(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color: 0x5aa7e6 })));
    scene.add(this.arcLine);
  },
  waypoint(x, y, text, engine) {
    const color = { jev: "#4fd18b", code: "#5aa7e6", claude: "#b48cff", user: "#ff8fb1", rover: "#e6b45a" }[engine] ?? "#ffffff";
    const h = this.terrain.h(x, y);
    const g = new THREE.Group();
    const ph = 2.4 + (this.waypoints.length % 3) * 0.7;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, ph, 5), new THREE.MeshBasicMaterial({ color }));
    pole.position.y = ph / 2;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color }));
    dot.position.y = 0.2;
    const short = text.length > 30 ? text.slice(0, 29) + "…" : text;
    const lab = labelSprite(short, color, true); lab.position.y = 2.7 + (this.waypoints.length % 3) * 0.7;
    g.add(pole, dot, lab);
    overlay(g);
    g.position.copy(W(x, y, h));
    scene.add(g);
    this.waypoints.push(g);
    return g;
  },
  // ---- picking: click a rock -> a user objective target
  project(x, y, h) {
    const v = W(x, y, h ?? this.terrain.h(x, y)).project(camera);
    return { sx: ((v.x + 1) / 2) * canvas.clientWidth, sy: ((1 - v.y) / 2) * canvas.clientHeight, visible: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
  },
  screenPosOfRock(i) { const r = this.terrain.rocks[i]; return this.project(r.x, r.y, this.terrain.h(r.x, r.y) + r.h); },
  // a rock ahead of the rover that is on-screen, biggish and light-toned if possible
  suggestRock() {
    const st = this.rover.state;
    let best = null;
    for (const { rock, dist } of this.terrain.rocksNear(st.x, st.y, 34)) {
      if (dist < 12 || rock.d < 0.8) continue;
      const rel = Math.atan2(Math.sin(Math.atan2(rock.y - st.y, rock.x - st.x) - st.heading), Math.cos(Math.atan2(rock.y - st.y, rock.x - st.x) - st.heading));
      if (Math.abs(rel) > 0.6) continue;
      const p = this.screenPosOfRock(rock.i);
      if (!p.visible) continue;
      const score = (rock.tone === "light-toned" ? 3 : 0) + rock.d - dist / 40;
      if (!best || score > best.score) best = { i: rock.i, score };
    }
    return best ? best.i : null;
  },
  // Words for a clicked rock come from perception, never from the world's rock record:
  // the click supplies a position, the Navcam supplies the description.
  perceivedDesc(x, y) {
    const f = (this.vision?.lastFrame?.feats ?? [])
      .map((ff) => ({ ff, d: Math.hypot(ff.x - x, ff.y - y) }))
      .filter((o) => o.d < Math.max(1.2, (o.ff.footprint?.[0] ?? o.ff.d ?? 0.6)))
      .sort((a, b) => a.d - b.d)[0]?.ff;
    if (f) return `${f.appearance}; ${f.stereo_note}`;
    const st = this.rover.state;
    const range = Math.hypot(x - st.x, y - st.y);
    return `an unresolved feature about ${range.toFixed(0)} m out; the Navcam has not measured it yet, so its size and tone are unknown until the rover images it`;
  },
  pickAt(sx, sy) {
    const ndc = new THREE.Vector2((sx / canvas.clientWidth) * 2 - 1, -(sy / canvas.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const r0 = rockFromHit(this.terrain, ray.intersectObject(this.terrain.rockMesh, true));
    if (r0) { const r = r0; return { id: `pick_${r.i}`, rockIndex: r.i, x: r.x, y: r.y, description: view.perceivedDesc(r.x, r.y) }; }
    for (const t of this.targets) {
      const th = ray.intersectObject(t.group, true);
      if (th.length) return { id: t.id, name: t.name, x: t.x, y: t.y, description: t.description };
    }
    // fallback: nearest on-screen rock within 40 px (the scene moves while you aim)
    const st = this.rover.state;
    let best = null;
    for (const { rock } of this.terrain.rocksNear(st.x, st.y, 45)) {
      if (rock.d < 0.5) continue;
      const q = this.screenPosOfRock(rock.i);
      if (!q.visible) continue;
      const d = Math.hypot(q.sx - sx, q.sy - sy);
      if (d < 40 && (!best || d < best.d)) best = { d, r: rock };
    }
    if (best) { const r = best.r; return { id: `pick_${r.i}`, rockIndex: r.i, x: r.x, y: r.y, description: view.perceivedDesc(r.x, r.y) }; }
    return null;
  },
  setCamera(mode) {
    this.camMode = mode; this.camT = 0;
    ops.view({ chase: "CHASE CAM", navcam: "NAVCAM POV (rover eyes)", overview: "PLANNING OVERVIEW", map: "MAP VIEW · CAMERA COVERAGE", science: "ARM WORKSPACE CAM" }[mode] ?? mode);
    // The coverage map is a map: it belongs in the views you read as a map. In a chase or
    // arm-workspace shot it is just a colour wash over the ground, so fade it down there.
    this.coverage?.setMix({ map: 1.0, overview: 1.0, chase: 0.45, navcam: 0.25, science: 0.0, pinned: 1.0 }[mode] ?? 0.6);
  },
  setSun(lmstMin) {
    const hour = lmstMin / 60;
    const el = Math.max(6, 78 * Math.sin(((hour - 6) / 12) * Math.PI)) * (Math.PI / 180);
    const az = ((hour - 12) / 12) * Math.PI; // 0 at noon (south), negative = east
    const r = 150;
    const p = this.rover.group.position;
    sun.position.set(p.x + Math.sin(az) * Math.cos(el) * r, p.y + Math.sin(el) * r, p.z + Math.cos(el) * Math.cos(az) * r * 0.6);
    sun.target.position.copy(p);
    const warm = Math.min(1, Math.max(0, 1 - el / 0.8));
    sun.color.setRGB(1, 0.86 - 0.18 * warm, 0.72 - 0.3 * warm);
  },
};

// ------------------------------------------------------------------ camera
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const tmp = new THREE.Vector3();
function updateCamera(dt) {
  const r = view.rover;
  if (!r) return;
  if (view.camMode === "pinned") return; // probe / stills
  const p = r.group.position;
  const th = r.state.heading;
  const f = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th));
  let target, look, k = 2.2;
  if (view.camMode === "chase") {
    target = p.clone().addScaledVector(f, -11).add(new THREE.Vector3(-f.z * 4, 5.5, f.x * 4));
    look = p.clone().addScaledVector(f, 6).add(new THREE.Vector3(0, 1.2, 0));
  } else if (view.camMode === "navcam") {
    target = r.mastWorld().add(new THREE.Vector3(0, 0.3, 0));
    look = target.clone().addScaledVector(f, 10).add(new THREE.Vector3(0, -1.6, 0));
    if (view.navcamLook) look = view.navcamLook.clone();
    k = 5;
  } else if (view.camMode === "map") {
    // the default travelling view: high and near-vertical so the coverage the cameras
    // paint on the ground is the thing you read, with enough tilt to keep the rover solid
    const hh = view.mapHeight ?? 52;
    target = p.clone().addScaledVector(f, -hh * 0.34).add(new THREE.Vector3(0, hh, 0));
    look = p.clone().addScaledVector(f, 7);
    k = 1.8;
  } else if (view.camMode === "overview") {
    view.orbit += dt * 0.08;
    target = p.clone().add(new THREE.Vector3(Math.cos(view.orbit) * 95, 70, Math.sin(view.orbit) * 95));
    look = p.clone().addScaledVector(f, 40);
    k = 1.2;
  } else {
    // arm workspace: off the rover's front-right shoulder, looking across the arm at the target
    const right = new THREE.Vector3(-f.z, 0, f.x);
    target = p.clone().addScaledVector(f, 3.2).addScaledVector(right, 7.5).add(new THREE.Vector3(0, 3.0, 0));
    look = p.clone().addScaledVector(f, 2.4).add(new THREE.Vector3(0, 0.5, 0));
  }
  const a = 1 - Math.exp(-k * dt);
  camPos.lerp(target, a); camLook.lerp(look, a);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ------------------------------------------------------------------ boot
ops.now("CODE", "loading USGS terrain and NASA rover model…");
const world = await fetch("/api/world", { method: "POST" }).then((r) => r.json());
const [terrain, rover] = await Promise.all([loadTerrain(), loadRover()]);
view.terrain = terrain; view.rover = rover;
scene.add(terrain.mesh, terrain.rockMesh, rover.group);
for (const t of world.targets) view.addTarget(t);
rover.pose(terrain, world.rover_start.x, world.rover_start.y, (world.rover_start.heading_deg * Math.PI) / 180);
camPos.copy(rover.group.position).add(new THREE.Vector3(-20, 12, 20));
camLook.copy(rover.group.position);
view.setSun(8 * 60);

ops.log("CODE", "Assets loaded", `Terrain: <b>${terrain.N}×${terrain.N}</b> grid, ${terrain.size} m, ${terrain.rocks.length.toLocaleString()} rocks (${terrain.rockSource}) · ${terrain.meta.sources.dtm.split(",")[1]}, ${terrain.meta.sources.ortho.split(",")[1]}. Rover: ${terrain.meta.sources.rover.split(",")[0]}, ${rover.wheels.length} wheels articulated.<div class="kv"><span>centre <b>${terrain.meta.centre_lonlat[1].toFixed(4)}°N ${terrain.meta.centre_lonlat[0].toFixed(4)}°E</b></span><span>jev <b>${world.models.jev}</b></span><span>llm <b>claude ${world.models.llm}</b></span></div><div style="font-size:11px;color:var(--ink3);margin-top:4px">Synthetic: ${terrain.meta.synthetic.rocks}; ${terrain.meta.synthetic.micro_relief}.</div>`);

view.vision = new Vision(renderer, scene, terrain, rover);
// The full nine-camera rig is used here only to drive the ground-coverage overlay: the
// browser-only page still plans on the mast Navcam, but the ground shows every camera's reach.
const rig = new CameraRig(renderer, scene, terrain, rover);
view.rig = rig;
view.coverage = new Coverage(renderer, terrain);
view.coverage.attach(terrain.mesh);
const game = new Game(view, world);
ops.now("CODE", "ready — press Autoplay");

let last = performance.now();
let tCov = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  tCov += dt;
  if (tCov >= 0.25) {
    tCov = 0;
    for (const c of rig.cams) c.vision.captureDepth();
    view.coverage.update(rig.cams, rover.state);
    view.coverage.sync();
  }
  for (const d of view.dynamic) {
    d.mesh.position.x += d.vx * dt; d.mesh.position.z -= d.vy * dt; d.mesh.rotation.y += dt * 2;
    d.life -= dt;
    if (d.life <= 0) { scene.remove(d.mesh); view.dynamic.splice(view.dynamic.indexOf(d), 1); }
  }
  updateCamera(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.getElementById("btn-start").addEventListener("click", () => game.start());
document.getElementById("btn-step").addEventListener("click", () => game.step());
if (new URLSearchParams(location.search).get("auto") === "1") setTimeout(() => game.start(), 800);
window.game = game; window.view = view;

// ------------------------------------------------------------------ user objectives (click a rock)
const objPanel = document.getElementById("objective");
let currentPick = null;
function openObjective(pick) {
  currentPick = pick;
  view.ring(pick.x, pick.y, 2.0, 0xff8fb1, 20000);
  document.getElementById("obj-pick").innerHTML = `Pointed at: <b>${pick.name ?? "float rock"}</b> — ${pick.description} <span style="font-family:var(--mono);color:var(--ink3)">(${pick.x.toFixed(0)} E, ${pick.y.toFixed(0)} N)</span>`;
  objPanel.classList.add("on");
  document.getElementById("obj-text").focus();
}
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const pick = view.pickAt(e.clientX - rect.left, e.clientY - rect.top);
  if (pick) openObjective(pick);
});
// demo hook: pick a rock by index through the same path a click takes
window.demoPick = (i) => { const p = view.screenPosOfRock(i); const pick = view.pickAt(p.sx, p.sy); if (pick) openObjective(pick); return Boolean(pick); };
document.getElementById("obj-send").addEventListener("click", () => {
  const text = document.getElementById("obj-text").value.trim();
  if (!text || !currentPick) return;
  game.injectObjective(currentPick, text);
  objPanel.classList.remove("on");
  document.getElementById("obj-text").value = "";
});
document.getElementById("obj-cancel").addEventListener("click", () => objPanel.classList.remove("on"));
document.getElementById("btn-swim").addEventListener("click", (e) => {
  const w = document.getElementById("swimlane-wrap");
  w.classList.toggle("hidden");
  e.currentTarget.classList.toggle("on", !w.classList.contains("hidden"));
});
document.getElementById("btn-obj").addEventListener("click", () => {
  document.getElementById("pick-hint").classList.toggle("on");
});
window.pickRockForDemo = (i) => { const r = view.terrain.rocks[i]; return { pos: view.screenPosOfRock(i), rock: r }; };
