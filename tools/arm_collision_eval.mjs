// Does the arm ever end up inside a rock? Park the rover at a science stand-off from a
// series of real rocks, ask the solver for a placement on each candidate face, and measure
// how far the arm's own geometry penetrates the rock the instrument is working on.
//
//   node tools/arm_collision_eval.mjs [baseUrl]
//
// Passing means: for every placement the solver reports as acceptable, no part of the arm
// except the instrument face is inside the rock.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4180";
const STANDOFF = Number(process.argv[3] ?? 2.3);   // metres, rover centre to rock centre
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto(base + "/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);

const res = await p.evaluate(async (STANDOFF) => {
  const THREE = await import("three");
  const v = window.view, T = v.terrain, r = v.rover;
  const sleep = (ms) => new Promise((res2) => setTimeout(res2, ms));
  const st0 = { x: r.state.x, y: r.state.y, heading: r.state.heading };
  const rows = [];
  const big = T.rocksNear(st0.x, st0.y, 260).filter((o) => o.rock.h > 0.25 && o.rock.d > 0.5)
    .sort((a, c) => c.rock.h - a.rock.h).slice(0, 10).map((o) => o.rock);

  for (const rock of big) {
    const ang = Math.atan2(rock.y - st0.y, rock.x - st0.x);
    // science stand-off: the rock just inside the arm's reach
    const R = STANDOFF;
    r.pose(T, rock.x - Math.cos(ang) * R, rock.y - Math.sin(ang) * R, ang);
    await sleep(120);
    v.vision.capture();
    const feats = v.vision.detect({ low: false, shadowDir: "west" }).filter((f) => f.kind === "rock");
    // obstacles from PERCEPTION only; if the rover cannot see it, it cannot plan around it
    const obstacles = feats.map((f) => {
      const h = f.h ?? f.hEst ?? 0.25;
      const rad = Math.max(0.12, (f.footprint ? Math.max(f.footprint[0], f.footprint[1]) : (f.d ?? 0.4)) / 2);
      return { id: f.id, c: new THREE.Vector3(f.x, T.h(f.x, f.y) + h * 0.5, -f.y), rxz: rad, ry: Math.max(0.08, h * 0.5) };
    });
    if (!obstacles.length) { rows.push({ rock: +rock.d.toFixed(2), seen: false }); continue; }

    // candidate faces, as the executive proposes them: top, near face, two flanks
    const gh = T.h(rock.x, rock.y);
    const faces = [
      { id: "top", p: new THREE.Vector3(rock.x, gh + rock.h * 1.0, -rock.y), n: new THREE.Vector3(0, 1, 0) },
      { id: "near", p: new THREE.Vector3(rock.x - Math.cos(ang) * rock.d * 0.45, gh + rock.h * 0.55, -(rock.y - Math.sin(ang) * rock.d * 0.45)),
        n: new THREE.Vector3(-Math.cos(ang), 0.25, Math.sin(ang)).normalize() },
      { id: "flankL", p: new THREE.Vector3(rock.x + Math.sin(ang) * rock.d * 0.45, gh + rock.h * 0.55, -(rock.y - Math.cos(ang) * rock.d * 0.45)),
        n: new THREE.Vector3(Math.sin(ang), 0.25, Math.cos(ang)).normalize() },
    ];
    for (const f of faces) {
      const snap = r.armSnapshot();
      const sol = r.solveArmSafe(f.p, f.n, obstacles, "WATSON", 0.04);
      const c = r.armClearance(obstacles, "WATSON");
      rows.push({ rock: +rock.d.toFixed(2), h: +rock.h.toFixed(2), face: f.id,
                  err: +sol.err.toFixed(3), clearance: +c.clearance.toFixed(3),
                  offender: c.offender?.link ?? null, tipGap: +c.tipGap.toFixed(3),
                  accepted: c.clearance >= 0 && sol.err < 0.08, samples: c.samples });
      r.armApply(snap);
    }
  }
  r.pose(T, st0.x, st0.y, st0.heading);
  return rows;
}, STANDOFF);

const tried = res.filter((x) => x.face);
const accepted = tried.filter((x) => x.accepted);
const bad = accepted.filter((x) => x.clearance < 0);
console.log(JSON.stringify(tried, null, 0).replace(/\},/g, "},\n"));
console.log(`
stand-off                 ${STANDOFF} m
placements attempted      ${tried.length}
accepted by the model     ${accepted.length}
accepted but penetrating  ${bad.length}   <- must be 0
worst clearance accepted  ${accepted.length ? Math.min(...accepted.map((x) => x.clearance)).toFixed(3) : "n/a"} m
rejected (arm would hit)  ${tried.length - accepted.length}
`);
await b.close();
