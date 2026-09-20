// Measure perception against the world's rock list. The rover never gets to see this
// list — it is ground truth, used here only to score what the camera pipeline found.
//
//   node tools/perception_eval.mjs [baseUrl] [poses]
//
// Reports, over a set of rover poses:
//   recall      true rocks inside the Navcam cone that produced a feature
//   size error  |measured diameter - true diameter| / true diameter
//   centre err  metres between the feature centroid and the true rock centre
//   box slack   how much bigger the pixel box is than the rock's own pixels
//   merges      features whose pixels span more than one true rock
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4180";
const POSES = Number(process.argv[3] ?? 12);

const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
p.on("console", (m) => m.type() === "error" && console.log("CONSOLE ERROR:", m.text().slice(0, 240)));
await p.goto(base + "/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);

const result = await p.evaluate(async (nPoses) => {
  const view = window.view, T = view.terrain, rover = view.rover, v = view.vision;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  // deterministic sweep of poses around the start, so runs are comparable
  const st0 = { x: rover.state.x, y: rover.state.y, heading: rover.state.heading };
  for (let i = 0; i < nPoses; i++) {
    const ang = (i / nPoses) * Math.PI * 2;
    const x = st0.x + Math.cos(ang) * (8 + (i % 4) * 9);
    const y = st0.y + Math.sin(ang) * (8 + (i % 4) * 9);
    rover.pose(T, x, y, ang + 0.4);
    await sleep(90);
    v.capture();
    const feats = v.detect({ low: i % 2 === 0, shadowDir: "west" });
    const st = rover.state;

    // true rocks the Navcam could in principle resolve from here
    const truth = [];
    for (const { rock, dist } of T.rocksNear(st.x, st.y, 13.5)) {
      if (dist < 2.0 || dist > 13) continue;
      if (rock.d < 0.35) continue;                       // below the modelled size floor
      const bearing = Math.atan2(rock.y - st.y, rock.x - st.x) - st.heading;
      const rel = Math.atan2(Math.sin(bearing), Math.cos(bearing));
      if (Math.abs(rel) > 1.02) continue;                // outside the ~120 deg horizontal FOV
      truth.push({ rock, dist });
    }

    const rocks = feats.filter((f) => f.kind === "rock");
    const claimed = new Set();
    const matched = [];
    for (const f of rocks) {
      let best = null;
      for (const t of truth) {
        const off = Math.hypot(t.rock.x - f.x, t.rock.y - f.y);
        if (off < Math.max(1.0, t.rock.d) && (!best || off < best.off)) best = { off, t };
      }
      if (best) {
        claimed.add(best.t.rock.i);
        const trueD = best.t.rock.d;
        const measD = f.footprint ? Math.max(f.footprint[0], f.footprint[1]) : f.d;
        matched.push({ off: best.off, sizeErr: Math.abs(measD - trueD) / trueD, trueD, measD,
                       boxPx: f.box ? f.box[2] * f.box[3] : null, px: f.px });
      }
    }
    // a feature that covers two or more true rock centres has merged them
    let merges = 0;
    for (const f of rocks) {
      let n = 0;
      for (const t of truth) if (Math.hypot(t.rock.x - f.x, t.rock.y - f.y) < Math.max(0.8, (f.footprint?.[0] ?? f.d) * 0.6)) n++;
      if (n > 1) merges++;
    }
    const bucket = (d) => (d < 0.5 ? "0.35-0.5" : d < 0.8 ? "0.5-0.8" : d < 1.2 ? "0.8-1.2" : "1.2+");
    const bySize = {};
    for (const t of truth) {
      const k = bucket(t.rock.d);
      bySize[k] = bySize[k] || { n: 0, hit: 0 };
      bySize[k].n++; if (claimed.has(t.rock.i)) bySize[k].hit++;
    }
    rows.push({ truth: truth.length, found: rocks.length, hit: claimed.size, merges, matched, bySize });
  }
  rover.pose(T, st0.x, st0.y, st0.heading);

  const all = rows.flatMap((r) => r.matched);
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  return {
    poses: rows.length,
    trueRocksInCone: rows.reduce((s, r) => s + r.truth, 0),
    featuresReported: rows.reduce((s, r) => s + r.found, 0),
    trueRocksDetected: rows.reduce((s, r) => s + r.hit, 0),
    mergedFeatures: rows.reduce((s, r) => s + r.merges, 0),
    medianCentreErrM: med(all.map((m) => m.off)),
    medianSizeErrPct: med(all.map((m) => m.sizeErr * 100)),
    medianBoxFillPct: med(all.filter((m) => m.boxPx).map((m) => (m.px / m.boxPx) * 100)),
    recallBySize: rows.reduce((acc, r) => {
      for (const [k, v2] of Object.entries(r.bySize)) { acc[k] = acc[k] || { n: 0, hit: 0 }; acc[k].n += v2.n; acc[k].hit += v2.hit; }
      return acc;
    }, {}),
  };
}, POSES);

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
console.log(JSON.stringify(result, null, 1));
console.log(`\nrecall            ${result.trueRocksDetected}/${result.trueRocksInCone}  ${pct(result.trueRocksDetected, result.trueRocksInCone)}`);
console.log(`merged features   ${result.mergedFeatures}/${result.featuresReported}  ${pct(result.mergedFeatures, result.featuresReported)}`);
console.log(`centre error      ${result.medianCentreErrM?.toFixed(2)} m (median)`);
console.log(`size error        ${result.medianSizeErrPct?.toFixed(0)}% (median)`);
console.log(`box fill          ${result.medianBoxFillPct?.toFixed(0)}% of the box is rock pixels (median)`);
console.log("recall by diameter:");
for (const k of ["0.35-0.5", "0.5-0.8", "0.8-1.2", "1.2+"]) {
  const v2 = result.recallBySize[k]; if (!v2) continue;
  console.log(`  ${k.padEnd(9)} m  ${String(v2.hit).padStart(3)}/${String(v2.n).padEnd(4)} ${pct(v2.hit, v2.n)}`);
}
await b.close();
