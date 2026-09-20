import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle"] });
const p = await b.newPage({ viewport: { width: 1200, height: 700 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto("http://localhost:4180/", { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
const out = await p.evaluate(async () => {
  const enav = await import("/enav.js");
  const T = window.view.terrain;
  // parked 2.6 m short of Máaz, facing it; Rochette is the goal
  const maaz = { x: -52, y: -132 }, rochette = { x: 70, y: 10 };
  const heading = Math.atan2(maaz.y - (-54), maaz.x - (-54));
  const pos = { x: -54, y: -134 };
  const perceived = [{ x: maaz.x, y: maaz.y, d: 1.2, h: 0.55, label: "seen" }];
  const base = { ...pos, heading, goal: rochette, terrain: T, obstacles: [], keepouts: [], tiltLimit: 20, stepLimit: 0.2 };
  const fwd = enav.evaluateArcs({ ...base, rocks: perceived });
  const rev = enav.evaluateArcs({ ...base, reverse: true, rocks: null });
  const near = T.rocksNear(pos.x, pos.y, 8).filter(({ rock }) => rock.h >= 0.2).map(({ rock, dist }) => ({ x: +rock.x.toFixed(1), y: +rock.y.toFixed(1), h: rock.h, d: rock.d, dist: +dist.toFixed(1) }));
  return { heading: +(heading * 180 / Math.PI).toFixed(0), fwd: fwd.arcs.map((a) => a.blocked ?? "ok"), rev: rev.arcs.map((a) => a.blocked ?? `ok ${a.maxTilt.toFixed(1)}`), truthNear: near };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
