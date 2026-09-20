// Close-up stills of the instanced rocks on the legacy page (does not touch the ROS graph).
import { chromium } from "playwright";
const out = process.argv[2] ?? "shots/rocks_close.png";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
p.on("console", (m) => m.type() === "error" && console.log("CONSOLE ERROR:", m.text().slice(0, 300)));
const cdp = await p.context().newCDPSession(p); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await p.goto("http://localhost:4180/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);
// science cam mode = low, close to the deck; then pin the camera near a cluster of rocks
const shots = await p.evaluate(() => {
  const v = window.view; const st = v.rover.state;
  const near = v.terrain.rocksNear(st.x, st.y, 40).filter((n) => n.rock.d > 0.8).sort((a, b) => b.rock.d - a.rock.d).slice(0, 3);
  return near.map((n) => n.rock);
});
console.log("rocks:", JSON.stringify(shots.map((r) => [r.i, r.d, r.h, r.tone, r.variant])));
for (let k = 0; k < shots.length; k++) {
  await p.evaluate((r) => {
    const v = window.view; const h = v.terrain.h(r.x, r.y);
    v.camMode = "pinned"; v.camera.position.set(r.x + 3.0 + r.d, h + 1.2 + r.h, -r.y + 2.2 + r.d); v.camera.lookAt(r.x, h + r.h * 0.4, -r.y);
  }, shots[k]);
  await p.waitForTimeout(500);
  await p.screenshot({ path: out.replace(".png", `_${k + 1}.png`), clip: { x: 0, y: 0, width: 1130, height: 600 } });
}
// and a low, wide view over the field in front of the rover
await p.evaluate(() => { const v = window.view; const st = v.rover.state; const h = v.terrain.h(st.x, st.y); const f = [Math.cos(st.heading), -Math.sin(st.heading)];
  v.camMode = "pinned"; v.camera.position.set(st.x - f[0] * 2 + 3, h + 2.0, -(st.y - f[1] * 2) + 3); v.camera.lookAt(st.x + f[0] * 14, h + 0.3, -(st.y + f[1] * 14)); });
await p.waitForTimeout(500);
await p.screenshot({ path: out.replace(".png", "_field.png"), clip: { x: 0, y: 0, width: 1130, height: 600 } });
await b.close();
