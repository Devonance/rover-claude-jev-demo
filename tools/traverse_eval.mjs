// How many rocks does the rover actually roll over?
//
//   node tools/traverse_eval.mjs [baseUrl] [metres]
//
// Walks the rover along a straight line, running the real perception pipeline at each step
// and accumulating the perception map exactly as the executive does. Then counts the rocks
// above the step limit whose centre falls inside a wheel track, and splits them into the
// ones perception had found (ENav would have steered) and the ones it never saw (ENav could
// not have known). The world's rock list is ground truth here and nothing else.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4180";
const DIST = Number(process.argv[3] ?? 60);
const STEP_LIMIT = 0.20;     // FR-04: rocks above this are steered around, not driven over
const HALF_TRACK = 1.35;     // half the wheel-to-wheel track
const WHEEL_HALF = 0.25;     // half a wheel width

const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto(base + "/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);

const out = await p.evaluate(async ({ DIST, STEP_LIMIT, HALF_TRACK, WHEEL_HALF }) => {
  const v = window.view, T = v.terrain, r = v.rover, vis = v.vision;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const st0 = { x: r.state.x, y: r.state.y, heading: r.state.heading };
  const hd = st0.heading;
  const fx = Math.cos(hd), fy = Math.sin(hd);
  const px = -fy, py = fx;                       // lateral

  const perceived = [];                          // the map the executive would have built
  const remember = (f, h) => {
    const near = perceived.find((q) => Math.hypot(q.x - f.x, q.y - f.y) < 0.9);
    if (near) { near.h = Math.max(near.h, h); return; }
    perceived.push({ x: f.x, y: f.y, h, d: f.footprint ? Math.max(...f.footprint) : (f.d ?? 0.6) });
  };

  const rolled = [];
  let imaged = 0;
  for (let s = 0; s <= DIST; s += 0.5) {
    const cx = st0.x + fx * s, cy = st0.y + fy * s;
    r.pose(T, cx, cy, hd);
    // Image every 2 m the way the drive loop does, and use the whole rig: the mast Navcam
    // plans the route, the front Hazcam pair covers the 0.3-4 m the wheels are about to
    // enter. Testing the Navcam alone would understate what the deployed system sees.
    if (s % 2 < 0.25) {
      await sleep(70);
      imaged++;
      const cams = v.rig ? v.rig.cams.filter((c) => c.spec.primary) : [{ vision: vis }];
      for (const c of cams) {
        c.vision.capture();
        for (const f of c.vision.detect({ low: false, shadowDir: "west" })) {
          if (f.kind === "rock" && f.h != null) remember(f, f.h);
        }
      }
    }
    // rocks under a wheel at this step
    for (const { rock } of T.rocksNear(cx, cy, 2.2)) {
      if (rock.h < STEP_LIMIT) continue;
      const dx = rock.x - cx, dy = rock.y - cy;
      const lon = dx * fx + dy * fy, lat = dx * px + dy * py;
      if (Math.abs(lon) > 0.6) continue;                       // not at this step
      if (Math.abs(Math.abs(lat) - HALF_TRACK) > WHEEL_HALF + rock.d / 2) continue;  // not under a track
      if (rolled.some((q) => q.i === rock.i)) continue;
      const seen = perceived.some((q) => Math.hypot(q.x - rock.x, q.y - rock.y) < Math.max(0.9, rock.d));
      rolled.push({ i: rock.i, h: +rock.h.toFixed(2), d: +rock.d.toFixed(2), seen });
    }
  }
  // how much of the truth the map got, over the corridor actually walked
  let truthInCorridor = 0;
  for (let s = 0; s <= DIST; s += 1.0) {
    const cx = st0.x + fx * s, cy = st0.y + fy * s;
    for (const { rock } of T.rocksNear(cx, cy, 2.0)) {
      if (rock.h < STEP_LIMIT) continue;
      const dx = rock.x - cx, dy = rock.y - cy;
      if (Math.abs(dx * fx + dy * fy) > 0.5) continue;
      truthInCorridor++;
    }
  }
  r.pose(T, st0.x, st0.y, st0.heading);
  return { rolled, imaged, mapSize: perceived.length, truthInCorridor, distance: DIST };
}, { DIST, STEP_LIMIT, HALF_TRACK, WHEEL_HALF });

const missed = out.rolled.filter((x) => !x.seen);
const known = out.rolled.filter((x) => x.seen);
console.log(`
straight traverse         ${out.distance} m, ${out.imaged} imaging cycles
perception map built      ${out.mapSize} rocks
rocks >= ${STEP_LIMIT} m under a wheel  ${out.rolled.length}   (${(out.rolled.length / out.distance * 100).toFixed(1)} per 100 m)
  in the perception map   ${known.length}   ENav had these and would have steered
  never perceived         ${missed.length}   ENav could not have known: this is the real gap
tallest rolled over       ${out.rolled.length ? Math.max(...out.rolled.map((x) => x.h)).toFixed(2) : "n/a"} m
`);
console.log("NB: a forced straight line with ENav switched off. This measures what perception");
console.log("knows about the corridor, not how well ENav steers around what it is told about.");
await b.close();
