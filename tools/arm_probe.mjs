// Park the rover 2.6 m from Máaz on the legacy page and drive the arm through unstow / preplace / contact / stow,
// screenshotting each stage from a pinned workspace camera. Prints the joint axes and the IK error.
import { chromium } from "playwright";
const out = process.argv[2] ?? "shots/arm";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
p.on("console", (m) => (m.type() === "error") && console.log("CONSOLE ERROR:", m.text().slice(0, 300)));
const cdp = await p.context().newCDPSession(p); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await p.goto("http://localhost:4180/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);
const info = await p.evaluate(async () => {
  const v = window.view, r = v.rover, T = await import("three");
  const t = v.targets[0];
  const h = v.terrain.h(t.x, t.y);
  // park 2.6 m short of the target, facing it
  const dx = t.x - r.state.x, dy = t.y - r.state.y; const hd = Math.atan2(dy, dx);
  r.pose(v.terrain, t.x - 2.6 * Math.cos(hd), t.y - 2.6 * Math.sin(hd), hd);
  // pinned workspace camera: right side, low
  const p0 = r.group.position, f = new T.Vector3(Math.cos(hd), 0, -Math.sin(hd)), right = new T.Vector3(-f.z, 0, f.x);
  v.camMode = "pinned"; v.camera.position.copy(p0.clone().addScaledVector(f, 1.8).addScaledVector(right, 4.2).add(new T.Vector3(0, 1.6, 0)));
  v.camera.lookAt(p0.clone().addScaledVector(f, 2.2).add(new T.Vector3(0, 0.3, 0)));
  window.__t = t; window.__h = h;
  return { armOk: r.armOk, target: [t.x, t.y, h], joints: Object.fromEntries(Object.entries(r.joints).map(([k, j]) => [k, j ? j.name : null])) };
});
console.log(JSON.stringify(info));
await p.waitForTimeout(400); await p.screenshot({ path: `${out}_0_stowed.png`, clip: { x: 0, y: 0, width: 1130, height: 600 } });
const stages = [
  ["1_unstow", "r.armTo(p0.clone().addScaledVector(f, 1.9).add(new T.Vector3(0, 0.9 - 0, 0)), new T.Vector3(0, 1, 0), { seconds: 0.2 })"],
  ["2_preplace", "r.armTo(spot.clone().add(new T.Vector3(0, 0.3, 0)), new T.Vector3(0, 1, 0), { seconds: 0.2 })"],
  ["3_contact", "r.armTo(spot, new T.Vector3(0, 1, 0), { seconds: 0.2 })"],
  ["4_stow", "r.armStow({ seconds: 0.2 })"],
];
for (const [name, expr] of stages) {
  const err = await p.evaluate(async (expr) => {
    const v = window.view, r = v.rover, T = await import("three"); const t = window.__t;
    const p0 = r.group.position, f = new T.Vector3(Math.cos(r.state.heading), 0, -Math.sin(r.state.heading));
    // spot = top of the target rock via raycast against the target group
    const ray = new T.Raycaster(new T.Vector3(t.x, window.__h + 6, -t.y), new T.Vector3(0, -1, 0));
    const hits = ray.intersectObject(t.group, true).filter((h) => h.object.geometry?.type !== "RingGeometry" && h.object.type !== "Sprite");
    const spot = hits.length ? hits[0].point.clone() : new T.Vector3(t.x, window.__h + 0.5, -t.y);
    const e = await eval(expr);
    return { err: e, spot: spot.toArray().map((x) => +x.toFixed(2)), eff: r.instrumentWorld().toArray().map((x) => +x.toFixed(2)), shoulder: r.shoulderWorld().toArray().map((x) => +x.toFixed(2)) };
  }, expr);
  console.log(name, JSON.stringify(err));
  await p.waitForTimeout(200); await p.screenshot({ path: `${out}_${name}.png`, clip: { x: 0, y: 0, width: 1130, height: 600 } });
}
await b.close();
