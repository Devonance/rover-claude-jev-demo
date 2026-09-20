// Load ros.html against the live graph and screenshot at a few points (planning, driving, first science stop)
// to check that the overlays leave the rover visible. Usage: node tools/layout_probe.mjs shots/layout 40 150 230
import { chromium } from "playwright";
import fs from "node:fs";
const out = process.argv[2] ?? "shots/layout"; const times = process.argv.slice(3).map(Number);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
const cdp = await p.context().newCDPSession(p); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await p.goto("http://localhost:4180/ros.html", { waitUntil: "networkidle" });
const t0 = Date.now();
for (const t of times) {
  const wait = t * 1000 - (Date.now() - t0); if (wait > 0) await p.waitForTimeout(wait);
  await p.screenshot({ path: `${out}/${t}.png` }); console.log("shot", t);
}
await b.close();
