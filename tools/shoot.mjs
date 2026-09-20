// Open the sim in Chrome, report console errors, take a screenshot.
import { chromium } from "playwright";
const url = process.argv[2] ?? "http://localhost:4180/";
const out = process.argv[3] ?? "shots/boot.png";
const waitMs = Number(process.argv[4] ?? 6000);
const b = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
p.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log("CONSOLE", m.type().toUpperCase() + ":", m.text().slice(0, 300)));
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(waitMs);
await p.screenshot({ path: out });
console.log("now:", await p.textContent("#now"));
console.log("stream entries:", await p.locator("#stream .ev").count());
await b.close();
