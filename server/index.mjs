// Jezero ops sim. The browser runs the rover, terrain, ENav geometry and the
// sol state machine. This server owns the two kinds of intelligence:
//   /api/claude/*  System Two  — Claude, planning and interpretation
//   /api/jev/*     System One  — jev, fast typed judgments
// and serves the assets.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadApiKey, systemOne, MODEL as JEV_MODEL } from "./typesafe.mjs";
import { askClaude, LLM_MODEL } from "./claude.mjs";
import { hazardQuestions, aegisQuestions, faultQuestions, verifyQuestions } from "./jev.mjs";
import { SYSTEM, PLAN_SCHEMA, INTERPRET_SCHEMA, ANOMALY_SCHEMA, OBJECTIVE_SCHEMA, REPORT_SCHEMA, DESCRIBE_SCHEMA, planPrompt, interpretPrompt, anomalyPrompt, objectivePrompt, reportPrompt, describePrompt } from "./prompts.mjs";
import os from "node:os";
import { CAMPAIGN, CONSTRAINTS, INSTRUMENTS, TARGETS, ROVER_START, EVENTS } from "./world.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4180);
const API_KEY = loadApiKey(ROOT);
if (!API_KEY) {
  console.error("No TYPESAFE_API_KEY. Copy .env.example to .env and put your TypeSafe key in it.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary",
  ".npy": "application/octet-stream", ".svg": "image/svg+xml",
};

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8e6) reject(new Error("body too large")); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });

// Public view of targets: everything except the truth table.
const publicTargets = TARGETS.map(({ truth, ...t }) => t);

async function jevCall(builder, ...args) {
  const { state, questions } = builder(...args);
  const r = await systemOne({ apiKey: API_KEY, state, questions });
  return { engine: "JEV", model: r.model, latencyMs: r.latencyMs, usage: r.usage, state, questions, answers: r.answers };
}

async function claudeCall(kind, schema, prompt) {
  const r = await askClaude({ system: SYSTEM, prompt, schema });
  return { engine: "CLAUDE", kind, model: r.model, latencyMs: r.latencyMs, apiMs: r.apiMs, costUsd: r.costUsd, tokens: r.tokens, prompt, output: r.output };
}

// Synthetic instrument result: looked up from the target's truth table, worded
// like a pipeline summary. Real data products are not simulated here.
function instrumentResult(targetId, instrument, pick) {
  if (instrument === "MEDA_dust") return "Dust-devil movie captured: vortex diameter ~15 m, transit 40 s; MEDA pressure drop 0.8 Pa; wind 12 m/s.";
  if (instrument === "RIMFAX") return "Radar profile along drive: layered reflectors dipping gently toward the delta; consistent with stacked flows or cumulate layering.";
  let t = TARGETS.find((x) => x.id === targetId);
  if (!t && pick) t = syntheticTarget(pick);
  if (!t) return "no data";
  const k = instrument.startsWith("SuperCam") ? "libs" : instrument.startsWith("WATSON") ? "watson" : instrument.startsWith("PIXL") ? "pixl" : null;
  if (instrument.startsWith("MastcamZ")) {
    return `Multispectral (11 bands): ${t.truth.lithology.includes("olivine") ? "strong 1 um olivine absorption, weak 2.3 um carbonate feature" : "flat basaltic spectrum with ferric dust slope; no 1 um olivine band"}; texture ${t.truth.watson.split(";")[0].toLowerCase()}.`;
  }
  if (instrument === "abrade") return `Abrasion patch 5 cm complete; gDRT cleared dust. Fresh surface: ${t.truth.watson}`;
  if (instrument === "core") return `Core acquired and sealed (tube ${Math.floor(Math.random() * 20) + 1}). Volume nominal. Lithology per prior analyses: ${t.truth.lithology}.`;
  if (instrument === "RIMFAX") return "Radar profile along drive: layered reflectors dipping gently toward the delta; consistent with stacked flows or cumulate layering.";
  if (instrument === "MEDA_dust") return "Dust-devil movie captured: vortex diameter ~15 m, transit 40 s; MEDA pressure drop 0.8 Pa; wind 12 m/s.";
  return k ? t.truth[k] : "no data";
}

// A user-picked float rock gets a truth table from its appearance: light-toned
// rocks in this area are Séítah-derived olivine/carbonate float, dark ones are Máaz basalt.
function syntheticTarget(pick) {
  const light = /light-toned/i.test(pick.description ?? "");
  return light
    ? { truth: { lithology: "olivine-carbonate float (Séítah-derived)", libs: "High Mg/Si; olivine signature; carbonate features; hydration band.", watson: "Coarse mm-scale olivine grains, carbonate-filled fractures, light-toned weathering rind.", pixl: "Olivine + carbonate + minor pyroxene; matches the Séítah assemblage.", abradable: true } }
    : { truth: { lithology: "basalt float (Máaz fm)", libs: "Fe-rich pyroxene + plagioclase; low Mg/Si; no carbonate.", watson: "Fine-grained vesicular texture; dust coating; no layering.", pixl: "Pyroxene + plagioclase + Fe-Ti oxides; no olivine; no carbonate.", abradable: true } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/world") {
      return send(res, 200, {
        campaign: CAMPAIGN, constraints: CONSTRAINTS, instruments: INSTRUMENTS,
        targets: publicTargets, rover_start: ROVER_START, events: EVENTS,
        models: { jev: JEV_MODEL, llm: LLM_MODEL },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/jev/hazards") {
      const { features, context } = await readJson(req);
      return send(res, 200, await jevCall(hazardQuestions, features, context));
    }
    if (req.method === "POST" && url.pathname === "/api/jev/aegis") {
      const { candidates, criteria, arm } = await readJson(req);
      return send(res, 200, await jevCall(aegisQuestions, candidates, criteria, arm));
    }
    if (req.method === "POST" && url.pathname === "/api/jev/fault") {
      const { event } = await readJson(req);
      return send(res, 200, await jevCall(faultQuestions, event));
    }
    if (req.method === "POST" && url.pathname === "/api/claude/plan") {
      const ctx = await readJson(req);
      return send(res, 200, await claudeCall("plan", PLAN_SCHEMA, planPrompt(ctx)));
    }
    if (req.method === "POST" && url.pathname === "/api/claude/interpret") {
      const ctx = await readJson(req);
      ctx.result = instrumentResult(ctx.target.id, ctx.instrument, ctx.target);
      const r = await claudeCall("interpret", INTERPRET_SCHEMA, interpretPrompt(ctx));
      return send(res, 200, { ...r, result: ctx.result });
    }
    if (req.method === "POST" && url.pathname === "/api/claude/anomaly") {
      const ctx = await readJson(req);
      return send(res, 200, await claudeCall("anomaly", ANOMALY_SCHEMA, anomalyPrompt(ctx)));
    }
    if (req.method === "POST" && url.pathname === "/api/jev/verify") {
      const { plan } = await readJson(req);
      return send(res, 200, await jevCall(verifyQuestions, plan));
    }
    if (req.method === "POST" && url.pathname === "/api/claude/objective") {
      const ctx = await readJson(req);
      return send(res, 200, await claudeCall("objective", OBJECTIVE_SCHEMA, objectivePrompt(ctx)));
    }
    if (req.method === "POST" && url.pathname === "/api/claude/report") {
      const ctx = await readJson(req);
      return send(res, 200, await claudeCall("report", REPORT_SCHEMA, reportPrompt(ctx)));
    }
    if (req.method === "POST" && url.pathname === "/api/claude/describe") {
      // The Navcam frame comes in as a data URL; Claude reads it from a temp file.
      const { sol, name, png } = await readJson(req);
      const file = path.join(os.tmpdir(), `navcam-sol${sol}-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(String(png).replace(/^data:image\/png;base64,/, ""), "base64"));
      const prompt = describePrompt({ sol, name, path: file });
      const r = await askClaude({ system: SYSTEM, prompt, schema: DESCRIBE_SCHEMA, allowRead: true });
      return send(res, 200, { engine: "CLAUDE", kind: "describe", model: r.model, latencyMs: r.latencyMs, costUsd: r.costUsd, tokens: r.tokens, prompt, output: r.output, file });
    }
    if (req.method === "POST" && url.pathname === "/api/instrument") {
      const { target_id, instrument, pick } = await readJson(req);
      return send(res, 200, { result: instrumentResult(target_id, instrument, pick) });
    }

    // static: /public and /node_modules/three
    let file = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    let base = path.join(ROOT, "public");
    if (file.startsWith("/node_modules/")) { base = ROOT; }
    const full = path.join(base, path.normalize(file).replace(/^[\\/]+/, ""));
    if (!full.startsWith(base) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, err.status ?? 500, { error: String(err.message ?? err) });
  }
});

server.listen(PORT, () => console.log(`\n  Jezero ops sim -> http://localhost:${PORT}\n  jev: ${JEV_MODEL}   llm: ${LLM_MODEL}\n`));
