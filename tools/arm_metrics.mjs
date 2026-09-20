// Measure the arm. Everything the collision model and the placement rules need should come
// from the model itself, not from numbers someone guessed: link lengths, the turret's real
// size, how far the instrument can actually reach from the shoulder, and how close the
// turret body sits behind the instrument face when it is on a surface.
//
//   node tools/arm_metrics.mjs [baseUrl]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4180";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto(base + "/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);

const m = await p.evaluate(async () => {
  const THREE = await import("three");
  const v = window.view, r = v.rover;
  const J = r.joints;
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  r.group.updateMatrixWorld(true);

  // bounding box of a node's own meshes, in world units
  const boxOf = (node) => {
    const bb = new THREE.Box3();
    let any = false;
    node.traverse((o) => { if (o.isMesh) { o.updateWorldMatrix(true, false); bb.expandByObject(o); any = true; } });
    if (!any) return null;
    const s = bb.getSize(new THREE.Vector3());
    return { size: [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)], radius: +(Math.max(s.x, s.y, s.z) / 2).toFixed(3) };
  };

  const out = { stowed: {}, links: {}, turret: boxOf(J.tu) };
  const order = ["az", "sh", "el", "wr", "tu"];
  for (const k of order) out.stowed[k] = wp(J[k]).toArray().map((n) => +n.toFixed(3));
  const inst = {};
  for (const name of ["WATSON", "PIXL", "drill"]) {
    try { inst[name] = +wp(r.instrumentWorld ? { getWorldPosition: (t) => t.copy(r.instrumentWorld(name)) } : J.tu).distanceTo(wp(J.tu)).toFixed(3); } catch { }
  }
  out.instrumentOffsetFromTurret = inst;

  // link lengths, stowed (a revolute chain's link lengths do not change)
  for (let i = 0; i < order.length - 1; i++) {
    out.links[`${order[i]}->${order[i + 1]}`] = +wp(J[order[i]]).distanceTo(wp(J[order[i + 1]])).toFixed(3);
  }
  out.links["tu->WATSON"] = +wp(J.tu).distanceTo(r.instrumentWorld("WATSON")).toFixed(3);

  // Reach envelope: drive the solver at targets on a ray out from the shoulder and find the
  // furthest one it can actually reach, plus the shoulder height above the ground.
  const sh = wp(J.sh);
  const st = r.state;
  const fwd = new THREE.Vector3(Math.cos(st.heading), 0, -Math.sin(st.heading));
  const snap = r.armSnapshot();
  let maxReach = 0, reachAt = null;
  for (let d = 0.4; d <= 3.2; d += 0.05) {
    for (const drop of [0.0, -0.3, -0.6]) {
      const t = sh.clone().addScaledVector(fwd, d); t.y += drop;
      const err = r.solveArm(t, new THREE.Vector3(0, 1, 0), "WATSON");
      if (err < 0.03 && d > maxReach) { maxReach = d; reachAt = { d: +d.toFixed(2), drop, err: +err.toFixed(4) }; }
    }
  }
  r.armApply(snap);
  out.shoulder = { world: sh.toArray().map((n) => +n.toFixed(3)), heightAboveGround: +(sh.y - v.terrain.h(st.x, st.y)).toFixed(3) };
  out.maxReachFromShoulder = +maxReach.toFixed(2);
  out.maxReachDetail = reachAt;

  // Fully extended: solve at max reach and report the chain spread + link capsule ends.
  const t = sh.clone().addScaledVector(fwd, maxReach);
  r.solveArm(t, new THREE.Vector3(0, 1, 0), "WATSON");
  out.extended = {};
  for (const k of order) out.extended[k] = wp(J[k]).toArray().map((n) => +n.toFixed(3));
  out.extended.WATSON = r.instrumentWorld("WATSON").toArray().map((n) => +n.toFixed(3));
  // how far the turret joint sits behind the instrument face when extended
  out.turretStandoff = +wp(J.tu).distanceTo(r.instrumentWorld("WATSON")).toFixed(3);
  const links = r.armLinks("WATSON");
  out.linkCapsules = links.map((L) => ({ name: L.name, r: L.r, len: +L.a.distanceTo(L.b).toFixed(3) }));
  r.armApply(snap);
  return out;
});

console.log(JSON.stringify(m, null, 1));
console.log(`
arm summary
  shoulder height above ground   ${m.shoulder.heightAboveGround} m
  max instrument reach           ${m.maxReachFromShoulder} m from the shoulder
  turret joint -> instrument face ${m.links["tu->WATSON"]} m
  turret body half-size          ${m.turret ? m.turret.radius : "?"} m
`);
await b.close();
