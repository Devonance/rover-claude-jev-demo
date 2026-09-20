// Upload a file to Google Drive through the user's own, already-logged-in Chrome.
// Chrome must be running with remote debugging enabled, e.g.
//   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
// Then:  node tools/upload_drive.mjs out/jezero-ops.mp4 [folderName]
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const files = process.argv.slice(2).map((f) => path.resolve(f)).filter((f) => fs.existsSync(f));
if (!files.length) { console.error("no files"); process.exit(1); }

const b = await chromium.connectOverCDP("http://localhost:9222");
const ctx = b.contexts()[0];
const p = await ctx.newPage();
await p.goto("https://drive.google.com/drive/my-drive", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);
if (/accounts\.google\.com/.test(p.url())) { console.error("Drive is not logged in in this Chrome profile:", p.url()); process.exit(2); }
console.log("Drive open:", await p.title());

// Upload into the "Jezero Ops" folder created earlier.
await p.goto("https://drive.google.com/drive/folders/1wPn-6qFPWSQbdugrCB8zLrincXlMbBya", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);
for (const file of files) {
  const sizeMb = (fs.statSync(file).size / 1e6).toFixed(1);
  const [chooser] = await Promise.all([
    p.waitForEvent("filechooser", { timeout: 30000 }),
    (async () => {
      await p.click('button[aria-label="New"], div[aria-label="New"], [guidedhelpid="new_menu_button"]', { timeout: 20000 });
      await p.waitForTimeout(900);
      await p.getByText("File upload", { exact: true }).first().click({ timeout: 15000 });
    })(),
  ]);
  await chooser.setFiles(file);
  console.log(`uploading ${path.basename(file)} (${sizeMb} MB)…`);
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 40 * 60 * 1000) {
    await p.waitForTimeout(5000);
    const txt = await p.evaluate(() => document.body.innerText);
    if (/uploads? complete|Upload complete/i.test(txt)) { done = true; break; }
    if (/Upload failed/i.test(txt)) { console.log("Drive reports upload failed"); break; }
  }
  console.log(done ? `complete: ${path.basename(file)} in ${((Date.now() - t0) / 1000).toFixed(0)} s` : `no completion toast for ${path.basename(file)} (check Drive)`);
  await p.waitForTimeout(2500);
}
await p.goto("https://drive.google.com/drive/folders/1wPn-6qFPWSQbdugrCB8zLrincXlMbBya", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(5000);
const items = await p.evaluate(() => [...document.querySelectorAll("[data-id]")].map((e) => ({ id: e.getAttribute("data-id"), text: (e.innerText || "").split(/\r?\n/)[0].slice(0, 60) })).filter((x) => x.text));
for (const it of items) console.log(`${it.text} -> https://drive.google.com/file/d/${it.id}/view`);
await p.screenshot({ path: "shots/drive_upload.png" });
await p.close();
