// jev as an MCP tool for the Claude CLI: System One inside System Two's reasoning.
// stdio server; one tool, ask_jev(state, questions) -> TypeSafe answers. Every call is
// visible to the caller of the CLI as a tool_use / tool_result pair in stream-json.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  for (const dir of [ROOT, path.join(ROOT, "..", "typesafe-decision-game")]) {
    const f = path.join(dir, ".env");
    if (fs.existsSync(f)) { const m = /TYPESAFE_API_KEY\s*=\s*(.+)/.exec(fs.readFileSync(f, "utf8")); if (m) return m[1].trim().replace(/^["']|["']$/g, ""); }
  }
  return "";
}
const KEY = loadKey();
const LOG = process.env.JEV_MCP_LOG || path.join(ROOT, "out", "mcp_jev.log");

const server = new McpServer({ name: "jev", version: "1.0.0" });
server.registerTool("ask_jev", {
  title: "Ask jev (System One judgment)",
  description: [
    "Ask TypeSafe's jev, a fast System One judgment model, a set of narrow typed questions over a small JSON state. ~200-400 ms.",
    "It does not reason or generate text: it returns a calibrated probability per question. Use it as evidence while you plan:",
    "score candidate targets against your draft science criteria, check whether an activity order violates the sequencing rules,",
    "check whether a next_action is supported by the data, or ask any closed question you would otherwise guess at.",
    "`state`: a JSON object of named fields (words and short descriptions; put numbers into words like 'knee-height', 'a few metres').",
    "`questions`: an object of id -> question. Types: {type:'choice', instructions:{question, focus?}, criteria:{option:{what}}} returns a choice + confidence + probabilities;",
    "{type:'noul', instructions:{question, focus?}, criteria?:{true:{what}, false:{what}}} returns P(yes);",
    "{type:'score', instructions:{question}, criteria:[level0 text, level1 text, ...]} returns a probability-weighted score over the ordered levels.",
    "Reference state fields in questions with backticks, e.g. `candidates.maaz`. Ask all independent questions in one call.",
  ].join(" "),
  inputSchema: { state: z.record(z.any()), questions: z.record(z.any()), note: z.string().optional().describe("one line: why you are asking") },
}, async ({ state, questions, note }) => {
  const t0 = Date.now();
  let body;
  try {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ state, model: "jev-latest", questions }) });
    body = await r.json();
    if (!r.ok) throw new Error(`TypeSafe ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: String(e.message || e) }) }], isError: true };
  }
  const ms = Date.now() - t0;
  const out = { answers: body.answers, latency_ms: ms, model: body.model, usage: body.usage, note: note || "" };
  try { fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ms, n: Object.keys(questions).length, note: note || "", answers: body.answers }) + "\n"); } catch {}
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
});

await server.connect(new StdioServerTransport());
