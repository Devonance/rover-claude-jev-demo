// Close-range recall: park the rover at a fixed stand-off from each of the biggest rocks
// in the area and check the Navcam pipeline reports it at all. These are rocks no driver
// may miss, so this is the test that must stay at 100%.
//   node tools/recall_probe.mjs [baseUrl]
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:4180";
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle","--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
p.on("pageerror", e => console.log("PAGE ERROR:", e.message));
await p.goto(BASE + "/", { waitUntil: "networkidle" });
await p.waitForTimeout(6000);
console.log(JSON.stringify(await p.evaluate(async () => {
  const view=window.view,T=view.terrain,v=view.vision,rv=view.rover;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const st0={x:rv.state.x,y:rv.state.y,heading:rv.state.heading};
  const big=T.rocksNear(st0.x,st0.y,220).filter(o=>o.rock.h>0.30).sort((a,c)=>c.rock.h-a.rock.h).slice(0,8).map(o=>o.rock);
  const out=[];
  for (const R of [4,7,10]) {
    let hit=0,n=0;
    for (const rock of big) {
      const a=Math.atan2(rock.y-st0.y,rock.x-st0.x);
      rv.pose(T,rock.x-Math.cos(a)*R,rock.y-Math.sin(a)*R,a);
      await sleep(110); v.capture();
      const feats=v.detect({low:false,shadowDir:"west"}).filter(f=>f.kind==="rock");
      n++;
      if (feats.some(f=>Math.hypot(f.x-rock.x,f.y-rock.y)<Math.max(1.0,rock.d))) hit++;
    }
    out.push({standoff:R, detected:hit, of:n});
  }
  rv.pose(T,st0.x,st0.y,st0.heading);
  return out;
})));
await b.close();
