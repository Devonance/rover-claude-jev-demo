// NASA/JPL-Caltech Perseverance model, wheels split in Blender (tools/prep_rover.py).
// Model front (arm end) is +Z in the GLB, wheels rest on y=0; see the mount rotation below.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const WHEEL_R = 0.2625;
// Wheel contact offsets in rover frame: [lateral (+right), longitudinal (+forward)]
const CONTACTS = [[-1.2, 1.15], [-1.2, 0.09], [-1.2, -1.1], [1.2, 1.15], [1.2, 0.09], [1.2, -1.1]];

export async function loadRover() {
  const gltf = await new GLTFLoader().loadAsync("/assets/rover/perseverance.glb");
  const root = gltf.scene;
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  const wheels = ["LF", "LM", "LB", "RF", "RM", "RB"].map((n) => root.getObjectByName("wheel_" + n)).filter(Boolean);
  const head = root.getObjectByName("head");
  const arm1 = root.getObjectByName("arm_01_pivot");
  const arm2 = root.getObjectByName("arm_02_pivot");
  const turret = root.getObjectByName("turret_obj");
  const group = new THREE.Group();
  // The GLB's front (arm, turret) points along +Z; the group's forward is -Z,
  // so mount the model turned 180 degrees about the vertical axis.
  root.rotation.y = Math.PI;
  group.add(root);
  group.rotation.order = "YXZ";

  const state = { x: 0, y: 0, heading: Math.PI / 2, pitch: 0, roll: 0, spin: 0, mastPan: 0, armDeploy: 0 };
  const restArm = { a1: arm1 ? arm1.rotation.clone() : null, a2: arm2 ? arm2.rotation.clone() : null };

  function pose(terrain, x, y, heading) {
    state.x = x; state.y = y; state.heading = heading;
    const c = Math.cos(heading), s = Math.sin(heading);
    // forward = (c, s); right = (s, -c)
    const hs = CONTACTS.map(([lat, lon]) => terrain.h(x + lon * c + lat * s, y + lon * s - lat * c));
    const hF = (hs[0] + hs[3]) / 2, hB = (hs[2] + hs[5]) / 2;
    const hL = (hs[0] + hs[1] + hs[2]) / 3, hR = (hs[3] + hs[4] + hs[5]) / 3;
    const hC = hs.reduce((a, b) => a + b, 0) / 6;
    state.pitch = Math.atan2(hF - hB, 2.25);
    state.roll = Math.atan2(hR - hL, 2.4);
    group.position.set(x, hC, -y);
    group.rotation.set(state.pitch, heading - Math.PI / 2, state.roll);
    return state;
  }
  function advance(dist) {
    state.spin += dist / WHEEL_R;
    for (const w of wheels) w.rotation.x = state.spin; // model X is now opposite the group X
  }
  function tiltDeg() {
    return (Math.hypot(state.pitch, state.roll) * 180) / Math.PI;
  }
  function setMast(pan) {
    state.mastPan = pan;
    if (head) head.rotation.y = pan;
  }
  // ---------------------------------------------------------------- robotic arm
  // The model's arm is a real chain: arm.003 (shoulder mount, azimuth) -> arm.002 (shoulder elevation) -> arm (elbow)
  // -> arm.004 (wrist) -> turret_obj (turret pitch, carries WATSON / PIXL / the drill). Each hinge axis is found
  // numerically at load: the local direction that maps to the rover's lateral axis (or vertical for the azimuth).
  const byName = (...names) => names.map((n) => root.getObjectByName(n)).find(Boolean) ?? null; // GLTFLoader strips dots from node names
  const J = { az: byName("arm003", "arm.003"), sh: byName("arm002", "arm.002"), el: byName("arm"), wr: byName("arm004", "arm.004"), tu: byName("turret_obj") };
  const EFF = { WATSON: root.getObjectByName("WATSON"), PIXL: root.getObjectByName("PIXL"), drill: root.getObjectByName("corring_drill") };
  const ORDER = ["tu", "wr", "el", "sh", "az"];
  const LIMITS = { az: 1.4, sh: 2.1, el: 2.6, wr: 2.6, tu: 2.2 }; // rad, +/- from the model's rest pose
  const armOk = Object.values(J).every(Boolean) && Boolean(EFF.WATSON);
  const axisOf = {}; const rest = {}; const cur = {};
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
  function snapAxis(v) { const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)]; const i = a.indexOf(Math.max(...a)); const out = new THREE.Vector3(); out.setComponent(i, Math.sign(v.getComponent(i)) || 1); return out; }
  function initArm() {
    if (!armOk) return;
    group.updateMatrixWorld(true);
    const lateral = new THREE.Vector3(1, 0, 0).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion())); // rover right (heading pi/2 -> world +x)
    const up = new THREE.Vector3(0, 1, 0);
    for (const k of ORDER) {
      const j = J[k]; const wq = j.getWorldQuaternion(new THREE.Quaternion()).invert();
      axisOf[k] = snapAxis((k === "az" ? up : lateral).clone().applyQuaternion(wq));
      rest[k] = j.quaternion.clone(); cur[k] = 0;
    }
  }
  function armSnapshot() { const o = {}; for (const k of ORDER) o[k] = { q: J[k].quaternion.clone(), a: cur[k] }; return o; }
  function armApply(snap) { for (const k of ORDER) { J[k].quaternion.copy(snap[k].q); cur[k] = snap[k].a; } group.updateMatrixWorld(true); }
  // one CCD pass of `joints` bringing `eff` to `target` (world)
  function ccd(joints, eff, target, iters) {
    for (let it = 0; it < iters; it++) {
      for (const k of joints) {
        const j = J[k]; j.updateMatrixWorld(true);
        const jp = j.getWorldPosition(new THREE.Vector3()); const ep = eff.getWorldPosition(new THREE.Vector3());
        const axisW = axisOf[k].clone().applyQuaternion(j.getWorldQuaternion(_q)).normalize();
        const e = ep.sub(jp); const t = target.clone().sub(jp);
        e.addScaledVector(axisW, -e.dot(axisW)); t.addScaledVector(axisW, -t.dot(axisW));
        if (e.length() < 1e-4 || t.length() < 1e-4) continue;
        let ang = Math.atan2(_v.crossVectors(e, t).dot(axisW), e.dot(t));
        ang = Math.max(-LIMITS[k] - cur[k], Math.min(LIMITS[k] - cur[k], ang * 0.9));
        j.rotateOnAxis(axisOf[k], ang); cur[k] += ang;
      }
    }
  }
  // Solve for the instrument on `target` (world point) approached along `normal` (world unit vector, out of the surface).
  function solveArm(target, normal, instrument = "WATSON") {
    const eff = EFF[instrument] ?? EFF.WATSON;
    const hover = target.clone().addScaledVector(normal, 0.42);
    ccd(["wr", "el", "sh", "az"], J.tu, hover, 24);   // bring the turret above the spot first (approach from the normal)
    ccd(["tu"], eff, target, 12);                      // then pitch the turret so the instrument meets the surface
    ccd(["tu", "wr", "el", "sh", "az"], eff, target, 16);
    group.updateMatrixWorld(true);
    return eff.getWorldPosition(new THREE.Vector3()).distanceTo(target);
  }
  // Animate to a solved pose. `frame` yields dt (seconds) per frame (the sim's nextFrame).
  async function armTo(target, normal, { instrument = "WATSON", seconds = 2.2, frame } = {}) {
    if (!armOk) return 0;
    const start = armSnapshot();
    const err = solveArm(target, normal, instrument);
    const end = armSnapshot(); armApply(start);
    await tween(start, end, seconds, frame);
    state.armDeploy = 1;
    return err;
  }
  async function armStow({ seconds = 2.4, frame } = {}) {
    if (!armOk) return;
    const end = {}; for (const k of ORDER) end[k] = { q: rest[k].clone(), a: 0 };
    await tween(armSnapshot(), end, seconds, frame); state.armDeploy = 0;
  }
  async function tween(a, b, seconds, frame) {
    for (let t = 0; t < 1;) {
      const dt = frame ? await frame() : 1 / 60; t = Math.min(1, t + dt / seconds);
      const s = 0.5 - 0.5 * Math.cos(t * Math.PI);
      for (const k of ORDER) { J[k].quaternion.slerpQuaternions(a[k].q, b[k].q, s); cur[k] = a[k].a + (b[k].a - a[k].a) * s; }
      if (!frame) await new Promise((r) => requestAnimationFrame(r));
    }
    group.updateMatrixWorld(true);
  }
  // ---------------------------------------------------------------- arm collision model
  //
  // Measured, not guessed (tools/arm_metrics.mjs): the turret is 0.83 x 0.34 x 0.84 m and the
  // instrument face sits 0.37 m from the turret joint, i.e. out on the rim of that disc. An
  // earlier version modelled the turret as a capsule of radius 0.12 m, a seven-fold
  // under-estimate, which is why the turret could be buried in a boulder while the model
  // reported clearance. So the turret is not approximated at all: points are sampled off its
  // real meshes and transformed by the live pose. The long links stay capsules, which they
  // genuinely are.
  //
  // Only the instrument face may touch. Everything within TIP_EXEMPT of the face is allowed
  // inside a rock; every other sampled point and every link capsule must stay outside.
  const LINK_R = { shoulder: 0.11, upper: 0.10, forearm: 0.085, wrist: 0.10 };
  const TIP_EXEMPT = 0.10;
  const TURRET_SAMPLES = 48;
  let turretPts = null;   // local-space sample points on the turret, built once

  function buildTurretSamples() {
    if (!armOk) return [];
    const pts = [];
    const inv = new THREE.Matrix4();
    J.tu.updateWorldMatrix(true, false);
    inv.copy(J.tu.matrixWorld).invert();
    const v = new THREE.Vector3();
    const meshes = [];
    J.tu.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
    const total = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0) || 1;
    for (const mesh of meshes) {
      const pos = mesh.geometry.attributes.position;
      const want = Math.max(4, Math.round((pos.count / total) * TURRET_SAMPLES));
      const step = Math.max(1, Math.floor(pos.count / want));
      mesh.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
        pts.push(v.clone());
      }
    }
    return pts;
  }

  // Sampled turret points in world space for the current pose, minus the instrument face.
  function armTurretPoints(instrument = "WATSON") {
    if (!armOk) return [];
    if (!turretPts) turretPts = buildTurretSamples();
    const eff = instrumentWorld(instrument);
    J.tu.updateWorldMatrix(true, false);
    const out = [];
    const v = new THREE.Vector3();
    for (const p of turretPts) {
      v.copy(p).applyMatrix4(J.tu.matrixWorld);
      if (v.distanceTo(eff) <= TIP_EXEMPT) continue;   // the bit that is meant to touch
      out.push(v.clone());
    }
    return out;
  }

  function armLinks() {
    if (!armOk) return [];
    const wp = (j) => J[j].getWorldPosition(new THREE.Vector3());
    const az = wp("az"), sh = wp("sh"), el = wp("el"), wr = wp("wr"), tu = wp("tu");
    return [
      { a: az, b: sh, r: LINK_R.shoulder, name: "shoulder" },
      { a: sh, b: el, r: LINK_R.upper, name: "upper arm" },
      { a: el, b: wr, r: LINK_R.forearm, name: "forearm" },
      { a: wr, b: tu, r: LINK_R.wrist, name: "wrist" },
    ];
  }
  const segDist = (p, a, b) => {
    const ab = b.clone().sub(a), t = ab.lengthSq() ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())) : 0;
    return p.distanceTo(a.clone().addScaledVector(ab, t));
  };
  // Rocks are ELLIPSOIDS, not spheres: perception measures a footprint and a height, and for
  // the wide flat slabs that make up most of this terrain a sphere sized to the footprint
  // stands a metre taller than the rock does. That phantom height was rejecting exactly the
  // placement a rover actually wants - the instrument flat on the top facet.
  // Signed distance to an ellipsoid has no closed form; this is the standard scaled-space
  // approximation, which under-estimates the true distance and so errs toward refusing.
  const _e = new THREE.Vector3();
  const ellipDist = (p, o) => {
    const rxz = o.rxz ?? o.r ?? 0.3, ry = o.ry ?? o.r ?? 0.3;
    _e.set((p.x - o.c.x) / rxz, (p.y - o.c.y) / ry, (p.z - o.c.z) / rxz);
    const q = _e.length();
    if (q < 1e-6) return -Math.min(rxz, ry);
    return (q - 1) * Math.min(rxz, ry);
  };
  // obstacles: [{ c: Vector3, rxz, ry, id }] (or { c, r } for a sphere) in three.js world coords
  function armClearance(obstacles = [], instrument = "WATSON") {
    const links = armLinks();
    const tpts = armTurretPoints(instrument);
    const eff = instrumentWorld(instrument);
    let clearance = Infinity, offender = null;
    const mid = new THREE.Vector3();
    for (const o of obstacles) {
      for (const L of links) {
        // sample along the capsule; an ellipsoid has no single closest-point shortcut
        for (let t = 0; t <= 1.0001; t += 0.125) {
          mid.copy(L.a).lerp(L.b, t);
          const d = ellipDist(mid, o) - L.r;
          if (d < clearance) { clearance = d; offender = { link: L.name, obstacle: o.id ?? "rock", d: +d.toFixed(3) }; }
        }
      }
      for (const p of tpts) {
        const d = ellipDist(p, o);
        if (d < clearance) { clearance = d; offender = { link: "turret", obstacle: o.id ?? "rock", d: +d.toFixed(3) }; }
      }
    }
    let tipGap = Infinity;
    for (const o of obstacles) tipGap = Math.min(tipGap, ellipDist(eff, o));
    return { clearance: Number.isFinite(clearance) ? clearance : 9.9, offender,
             tipGap: Number.isFinite(tipGap) ? tipGap : 9.9, samples: tpts.length };
  }
  // Solve for the spot, and if any part of the arm other than the instrument face would be
  // inside a rock, try approaching along a cone of directions around the surface normal and
  // keep the best clearance. Returns { err, clearance, tipGap, offender, tries, normal }.
  function solveArmSafe(target, normal, obstacles = [], instrument = "WATSON", margin = 0.04) {
    const cands = [normal.clone()];
    const up = new THREE.Vector3(0, 1, 0);
    const ref = Math.abs(normal.dot(up)) > 0.94 ? new THREE.Vector3(1, 0, 0) : up;
    const t1 = new THREE.Vector3().crossVectors(normal, ref).normalize();
    const t2 = new THREE.Vector3().crossVectors(normal, t1).normalize();
    // bias the search toward "more from above": the turret is a wide disc and a top-down
    // approach is the only one that reliably keeps it out of a rock
    cands.push(normal.clone().lerp(up, 0.35).normalize(), normal.clone().lerp(up, 0.7).normalize(), up.clone());
    for (const ang of [0.25, 0.5]) for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      cands.push(normal.clone().addScaledVector(t1, Math.sin(ang) * Math.cos(a))
                       .addScaledVector(t2, Math.sin(ang) * Math.sin(a)).normalize());
    }
    let best = null;
    for (let i = 0; i < cands.length; i++) {
      const err = solveArm(target, cands[i], instrument);
      const c = armClearance(obstacles, instrument);
      const score = Math.min(c.clearance, margin) - err * 0.5;
      if (!best || score > best.score) best = { score, err, ...c, normal: cands[i], tries: i + 1 };
      if (c.clearance >= margin && err < 0.02) break;
    }
    if (best) solveArm(target, best.normal, instrument);
    return best ?? { err: 9.9, clearance: 9.9, tipGap: 9.9, offender: null, tries: 0, normal };
  }

  // Measured envelope, for the rules and for the words jev is given.
  const ARM = {
    reachFromShoulder: 2.05,   // m, furthest the instrument solves to (tools/arm_metrics.mjs)
    turretSize: [0.83, 0.34, 0.84],
    instrumentStandoff: 0.37,  // m from turret joint to the instrument face
    tipExempt: TIP_EXEMPT,
  };
  function instrumentWorld(instrument = "WATSON") { return (EFF[instrument] ?? EFF.WATSON).getWorldPosition(new THREE.Vector3()); }
  function shoulderWorld() { return (J.sh ?? root).getWorldPosition(new THREE.Vector3()); }
  initArm();
  // Legacy: 0 = stowed, 1 = deployed (kept for the browser-only page; it now drives the real chain)
  function setArm(t) { state.armDeploy = t; }
  // World position of the mast head (for the Navcam POV).
  function mastWorld() {
    const v = new THREE.Vector3();
    (head ?? root).getWorldPosition(v);
    return v;
  }
  return { group, root, wheels, head, arm1, arm2, turret, state, pose, advance, tiltDeg, setMast, setArm, mastWorld, armOk, armTo, armStow, solveArm, solveArmSafe, armLinks, armClearance, armTurretPoints, ARM, armSnapshot, armApply, instrumentWorld, shoulderWorld, joints: J };
}
