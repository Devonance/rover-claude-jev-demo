// Upload files to Google Drive by driving Chrome on the user's own profile via
// Playwright's internal pipe (no remote-debugging port is opened, nothing is
// copied). Chrome must not be running when this starts.
//   node tools/upload_drive_profile.mjs file1 [file2 ...]
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const files = process.argv.slice(2).map((f) => path.resolve(f)).filter((f) => fs.existsSync(f));
if (!files.length) { console.error("no files"); process.exit(1); }
// Chrome refuses automation on its default data directory, so drive a copy of it.
const userDataDir = process.env.CHROME_PROFILE_DIR || path.join(os.homedir(), "AppData", "Local", "Temp", "chrome-automation");

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
  args: ["--no-first-run", "--no-default-browser-check", "--restore-last-session", "--start-maximized"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const p = await ctx.newPage();
await p.goto("https://drive.google.com/drive/my-drive", { waitUntil: "domcontentloaded", timeout: 90000 });
await p.waitForTimeout(6000);
if (/accounts\.google\.com/.test(p.url())) { console.error("Drive not logged in:", p.url()); await ctx.close(); process.exit(2); }
console.log("Drive open:", (await p.title()).slice(0, 60));

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
    if (/upload failed|Upload failed/i.test(txt)) { console.log("upload failed per Drive UI"); break; }
  }
  console.log(done ? `complete: ${path.basename(file)} in ${((Date.now() - t0) / 1000).toFixed(0)} s` : `timed out waiting for completion of ${path.basename(file)}`);
  await p.waitForTimeout(2000);
}
// share links
for (const file of files) {
  await p.goto(`https://drive.google.com/drive/search?q=${encodeURIComponent(path.basename(file))}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(5000);
  const id = await p.evaluate((name) => { const els = [...document.querySelectorAll("[data-id]")]; const el = els.find((e) => e.innerText && e.innerText.includes(name)) ?? els[0]; return el ? el.getAttribute("data-id") : null; }, path.basename(file));
  console.log(`${path.basename(file)} -> ${id ? "https://drive.google.com/file/d/" + id + "/view" : "(search Drive by name)"}`);
}
await p.screenshot({ path: "shots/drive_upload.png" });
await p.close();
// leave the user's Chrome open with their session; detach by exiting without closing the context
setTimeout(() => process.exit(0), 500);
