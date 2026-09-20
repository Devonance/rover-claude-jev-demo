// Record a full autoplay run to WebM with Playwright's built-in recorder.
//   node tools/record.mjs out/run.webm
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const outFile = path.resolve(process.argv[2] ?? "out/jezero-ops.webm");
const W = 1600, H = 900;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const tmpDir = path.join(path.dirname(outFile), "_rec");
fs.rmSync(tmpDir, { recursive: true, force: true });

const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: tmpDir, size: { width: W, height: H } } });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto("http://localhost:4180/?auto=1", { waitUntil: "networkidle" });
const t0 = Date.now();
while (Date.now() - t0 < 20 * 60 * 1000) {
  await p.waitForTimeout(5000);
  if (await p.evaluate(() => document.body.dataset.done === "1")) break;
  const stopped = await p.$$eval("#stream .ev-title", (els) => els.some((e) => e.textContent.includes("Run stopped")));
  if (stopped) { console.log("run stopped early"); break; }
}
await p.waitForTimeout(9000); // let the closing caption sit
const video = p.video();
await ctx.close();
const tmpPath = await video.path();
fs.renameSync(tmpPath, outFile);
fs.rmSync(tmpDir, { recursive: true, force: true });
await b.close();
console.log("recorded", outFile, (fs.statSync(outFile).size / 1e6).toFixed(1), "MB", ((Date.now() - t0) / 1000).toFixed(0), "s");
