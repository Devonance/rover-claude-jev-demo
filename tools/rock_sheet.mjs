// Contact sheet: one close-up per rock scan variant, from the legacy page (no ROS graph involved).
import { chromium } from "playwright";
import fs from "node:fs";
const outDir = process.argv[2] ?? "shots/rocksheet";
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
const cdp = await p.context().newCDPSession(p); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await p.goto("http://localhost:4180/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);
await p.evaluate(() => { for (const id of ["navcam", "legend"]) document.getElementById(id)?.remove(); });
const vars = await p.evaluate(() => window.view.terrain.rockVariants.lo.map((v) => v.id));
for (let vi = 0; vi < vars.length; vi++) {
  const r = await p.evaluate((vi) => {
    const v = window.view; const st = v.rover.state;
    const c = v.terrain.rocksNear(st.x, st.y, 120).filter((n) => n.rock.variant === vi && n.rock.d > 0.9).sort((a, b) => b.rock.d - a.rock.d)[0];
    if (!c) return null; const r = c.rock; const h = v.terrain.h(r.x, r.y);
    v.camMode = "pinned"; v.camera.position.set(r.x + 2.2 + r.d, h + 1.0 + r.h, -r.y + 1.6 + r.d); v.camera.lookAt(r.x, h + r.h * 0.4, -r.y);
    return [r.i, r.d, r.h, r.tone, r.embed];
  }, vi);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${outDir}/${String(vi).padStart(2, "0")}_${vars[vi]}.png`, clip: { x: 300, y: 150, width: 560, height: 360 } });
  console.log(vi, vars[vi], JSON.stringify(r));
}
await b.close();
