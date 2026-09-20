// Full autoplay run with a simulated user: part-way through the sol-2 drive the
// "user" clicks a rock ahead of the rover and types a new science objective.
// Screenshots every 20 s; waits for completion.
//   node tools/autorun.mjs shots/run3 [--record out/run.webm]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "shots/run";
const recIdx = process.argv.indexOf("--record");
const recordTo = recIdx > 0 ? path.resolve(process.argv[recIdx + 1]) : null;
fs.mkdirSync(out, { recursive: true });
const W = 1920, H = 1080;

const objectiveFor = (rock) => rock.tone === "light-toned"
  ? "Is this light-toned float a carbonate-bearing Séítah rock? If it is, get LIBS chemistry and a WATSON close-up so we can tell whether the Séítah unit extends this far north — but don't blow the Rochette budget."
  : `That ${rock.shape} dark float ahead looks different from the Máaz pavement. Is it Máaz basalt or something transported from Séítah? Get LIBS chemistry first, and only add a WATSON close-up if the chemistry says it's not ordinary basalt. Keep the Rochette drive on budget.`;

const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const ctxOpts = { viewport: { width: W, height: H } };
let recDir = null;
if (recordTo) { recDir = path.join(path.dirname(recordTo), "_rec"); fs.rmSync(recDir, { recursive: true, force: true }); ctxOpts.recordVideo = { dir: recDir, size: { width: W, height: H } }; }
const ctx = await b.newContext(ctxOpts);
const vT0 = Date.now(); // Playwright starts recording when the context opens: this is video t=0
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => { errors.push(e.message); console.log("PAGE ERROR:", e.message); });
p.on("console", (m) => m.type() === "error" && console.log("CONSOLE ERROR:", m.text().slice(0, 300)));
const cdp = await ctx.newCDPSession(p); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await p.goto("http://localhost:4180/ros.html", { waitUntil: "networkidle" });

const t0 = Date.now();
let i = 0, lastN = 0, injected = false;
const titles = async () => p.$$eval("#stream .ev", (els) => els.map((e) => { const t = e.querySelector(".ev-title")?.textContent ?? ""; const body = /Drive ended|Approach ended|Run stopped|Drive cap/.test(t) ? " :: " + (e.querySelector(".body")?.textContent ?? "").slice(0, 160) : ""; return `${e.querySelector(".badge")?.textContent ?? "SOL"} | ${t}${body}`; }));

// Event log for the speed ramp: when each console entry appeared, measured against video
// t=0. tools/make_segments.mjs turns this into the per-segment playback speeds so the parts
// where a decision lands play at real time and the waiting in between is compressed.
const events = [];
let seenEv = 0;
const logEvents = (tl) => {
  const t = (Date.now() - vT0) / 1000;
  for (const line of tl.slice(seenEv)) {
    const [engine, ...rest] = line.split(" | ");
    events.push({ t: +t.toFixed(2), engine: engine.trim(), title: rest.join(" | ").trim() });
  }
  seenEv = tl.length;
};

while (Date.now() - t0 < 30 * 60 * 1000) {
  await p.waitForTimeout(1000);
  const tl = await titles();
  logEvents(tl);
  // Inject the objective once the sol-2 drive toward Rochette is under way (~25 m in).
  if (!injected && tl.some((t) => t.includes("Drive to Rochette"))) {
    const odo = await p.evaluate(() => window.game.odo);
    const driveStartOdo = await p.evaluate(() => (window.__odo0 ??= window.game.odo));
    if (odo - driveStartOdo > 22) {
      const idx = await p.evaluate(() => window.view.suggestRock());
      if (idx != null) {
        const { pos, rock } = await p.evaluate((k) => window.pickRockForDemo(k), idx);
        console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] USER clicks rock ${idx} (${rock.tone}, ${rock.d} m) at ${pos.sx.toFixed(0)},${pos.sy.toFixed(0)}`);
        await p.mouse.move(pos.sx - 40, pos.sy + 30);
        await p.waitForTimeout(400);
        await p.mouse.move(pos.sx, pos.sy, { steps: 12 });
        const ok = await p.evaluate((k) => window.demoPick(k), idx); // same code path as a click, in one frame
        if (!ok) { await p.mouse.click(pos.sx, pos.sy); }
        await p.waitForSelector("#objective.on", { timeout: 8000 });
        await p.waitForTimeout(800);
        await p.type("#obj-text", objectiveFor(rock), { delay: 18 });
        await p.waitForTimeout(700);
        await p.click("#obj-send");
        injected = true;
        console.log("USER objective sent");
      }
    }
  }
  if (Date.now() - t0 > i * 20000) {
    i++;
    await p.screenshot({ path: `${out}/${String(i).padStart(2, "0")}.png` });
    const now = await p.textContent("#now");
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${now.trim()} | entries ${tl.length}`);
    for (const t of tl.slice(lastN)) console.log("   ", t);
    lastN = tl.length;
  }
  if (await p.evaluate(() => document.body.dataset.done === "1")) { console.log("DONE"); break; }
  if (tl.some((t) => t.includes("Run stopped"))) { console.log("RUN STOPPED"); break; }
}
await p.waitForTimeout(recordTo ? 9000 : 1000);
await p.screenshot({ path: `${out}/final.png` });
logEvents(await titles());
const evPath = `${out}/events.json`;
fs.writeFileSync(evPath, JSON.stringify({ videoSeconds: (Date.now() - vT0) / 1000, events }, null, 1));
console.log("objective injected:", injected, "| errors:", errors.length, "| elapsed", ((Date.now() - t0) / 1000).toFixed(0), "s");
console.log("events ->", evPath, `(${events.length} entries)`);
if (recordTo) {
  const video = p.video();
  await ctx.close();
  const tmp = await video.path();
  fs.mkdirSync(path.dirname(recordTo), { recursive: true });
  fs.renameSync(tmp, recordTo);
  fs.rmSync(recDir, { recursive: true, force: true });
  console.log("recorded", recordTo, (fs.statSync(recordTo).size / 1e6).toFixed(1), "MB");
} else await ctx.close();
await b.close();
