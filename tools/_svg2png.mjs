// Render an SVG file to PNG with headless Chrome:  node tools/_svg2png.mjs in.svg out.png [scale]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const [inp, out, scale = "2"] = process.argv.slice(2);
const svg = fs.readFileSync(inp, "utf8");
const m = /width="(\d+)" height="(\d+)"/.exec(svg);
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: Number(m[1]), height: Number(m[2]) }, deviceScaleFactor: Number(scale) });
await p.setContent(`<html><body style="margin:0;background:#0b0e12">${svg}</body></html>`);
await p.screenshot({ path: path.resolve(out), fullPage: true });
await b.close();
console.log("png", out);
