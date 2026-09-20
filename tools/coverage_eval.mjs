// Is the coverage map actually occluded by rocks? For each rock the Navcam can see,
// sample the live coverage just BEHIND it (along the rover->rock ray) and BESIDE it
// (same range, offset laterally). Occlusion is working if behind << beside.
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://localhost:4180";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
await p.goto(base + "/", { waitUntil: "networkidle" });
await p.waitForTimeout(7000);
const out = await p.evaluate(async () => {
  const view = window.view, cov = view.coverage, T = view.terrain, r = cov.renderer;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const rows = [];
  // Park the rover a fixed stand-off from a big rock and look straight at it, so the
  // geometry is unambiguous and the shadow is long enough to resolve.
  const st0 = { x: view.rover.state.x, y: view.rover.state.y, heading: view.rover.state.heading };
  const big = T.rocksNear(st0.x, st0.y, 220).filter((o) => o.rock.h > 0.35)
    .sort((a, c) => c.rock.h - a.rock.h).slice(0, 10).map((o) => o.rock);
  for (const rock of big) {
    const approach = Math.atan2(rock.y - st0.y, rock.x - st0.x);
    const R = 7.0;
    view.rover.pose(T, rock.x - Math.cos(approach) * R, rock.y - Math.sin(approach) * R, approach);
    cov.reset();
    await sleep(140);
    for (const c of view.rig.cams) c.vision.captureDepth();
    cov.update(view.rig.cams, view.rover.state); cov.sync();
    await sleep(60);

    const RES = 1024, win = cov.liveWindow();
    const buf = new Uint8Array(RES * RES * 4);
    const prev = r.getRenderTarget();
    r.setRenderTarget(cov.live); r.readRenderTargetPixels(cov.live, 0, 0, RES, RES, buf); r.setRenderTarget(prev);
    const at = (x, y) => {
      const u = Math.round(((x - win.minX) / win.span) * RES), v = Math.round(((y - win.minY) / win.span) * RES);
      if (u < 0 || v < 0 || u >= RES || v >= RES) return null;
      return buf[(v * RES + u) * 4 + 3] / 255;
    };
    const st = view.rover.state;
    const mast = view.rover.mastWorld();
    const Hc = mast.y - T.h(st.x, st.y) + 0.25;
    const dist = Math.hypot(rock.x - st.x, rock.y - st.y);
    const hr = rock.h * 0.7;
    if (hr >= Hc) continue;
    const rEnd = (dist * Hc) / (Hc - hr);
    const shadowLen = rEnd - dist - rock.d * 0.5;
    if (shadowLen < 0.3) continue;
    const rMid = dist + rock.d * 0.5 + shadowLen * 0.5;
    const ux = Math.cos(approach), uy = Math.sin(approach), px = -uy, py = ux;
    const behind = at(st.x + ux * rMid, st.y + uy * rMid);
    const off = rock.d * 1.5 + 0.7;
    const beside = [at(st.x + ux * rMid + px * off, st.y + uy * rMid + py * off),
                    at(st.x + ux * rMid - px * off, st.y + uy * rMid - py * off)].filter((v2) => v2 != null);
    if (behind == null || !beside.length) continue;
    rows.push({ d: +rock.d.toFixed(2), h: +rock.h.toFixed(2), range: +dist.toFixed(1),
                shadowLen: +shadowLen.toFixed(2), behind: +behind.toFixed(2),
                beside: +(beside.reduce((a, c) => a + c, 0) / beside.length).toFixed(2) });
  }
  view.rover.pose(T, st0.x, st0.y, st0.heading);
  return rows;
});
const n = out.length;
const mb = out.reduce((s, r) => s + r.behind, 0) / Math.max(1, n);
const ms = out.reduce((s, r) => s + r.beside, 0) / Math.max(1, n);
const shadowed = out.filter((r) => r.behind < r.beside * 0.6).length;
console.log(JSON.stringify(out.slice(0, 14), null, 0).replace(/\},/g, "},\n"));
console.log(`\nrocks tested            ${n}`);
console.log(`mean coverage behind    ${mb.toFixed(2)}`);
console.log(`mean coverage beside    ${ms.toFixed(2)}`);
console.log(`rocks casting a shadow  ${shadowed}/${n}  (behind < 60% of beside)`);
await b.close();
