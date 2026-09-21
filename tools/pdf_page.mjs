// Screenshot a page of a PDF using Chrome's built-in viewer, so typeset output can be
// checked without poppler installed.
//   node tools/_pdfshot.mjs <abs-pdf-path> <out.png> [page]
import { chromium } from "playwright";
const [pdf, out, page] = process.argv.slice(2);
const url = "file:///" + pdf.split("\\").join("/") + "#page=" + (page || 1) + "&zoom=page-fit";
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1200, height: 1550 } });
await p.goto(url, { waitUntil: "load" });
await p.waitForTimeout(7000);
await p.screenshot({ path: out });
await b.close();
console.log("shot", out);
