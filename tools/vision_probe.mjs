// Load the sim (no autoplay), run one Navcam capture+detect, draw the PiP, screenshot.
import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto("http://localhost:4180/", { waitUntil: "networkidle" });
await p.waitForTimeout(5000);
const out = await p.evaluate(async () => {
  const v = window.view.vision;
  const t0 = performance.now();
  v.capture();
  const feats = v.detect({ low: true, shadowDir: "west" });
  const ms = performance.now() - t0;
  v.draw(document.getElementById("navcam"), feats, {});
  document.getElementById("navcam-foot").textContent = `probe: ${feats.length} features in ${ms.toFixed(0)} ms`;
  // truth check: nearest real rock to each detected rock
  const T = window.view.terrain;
  return { ms, ground: v.lastFrame.ground, feats: feats.map((f) => {
    const near = T.rocksNear(f.x, f.y, 1.5).sort((a, b) => a.dist - b.dist)[0];
    return { id: f.id, kind: f.kind, dist: +f.dist.toFixed(1), h: f.h == null ? null : +f.h.toFixed(2), d: +f.d.toFixed(2), px: f.px, appearance: f.appearance, truth: near ? { h: near.rock.h, d: near.rock.d, off: +near.dist.toFixed(2) } : null };
  }) };
});
console.log(JSON.stringify(out, null, 1));
await p.screenshot({ path: "shots/vision_probe.png" });
await b.close();
