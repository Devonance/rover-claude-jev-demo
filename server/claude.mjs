// The System Two half: Claude, via the local `claude` CLI in headless print mode
// with a JSON schema. This is the science team / tactical planning function.
// Slow (seconds), deliberate, reads everything; called a few times per sol.

import { spawn } from "node:child_process";
import os from "node:os";

export const LLM_MODEL = process.env.LLM_MODEL || "sonnet";

// Resolve the CLI binary once so we can spawn it without a shell (a shell would
// re-quote the JSON schema argument on Windows).
import fs from "node:fs";
import path from "node:path";
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = os.homedir();
  const cands = [
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".local", "bin", "claude"),
    path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return "claude";
}
const CLAUDE_BIN = findClaude();

export async function askClaude(opts) {
  // One retry on transient CLI/API failures; a 13-minute run should not die on one hiccup.
  try { return await askClaudeOnce(opts); } catch (e) {
    console.error("[claude] first attempt failed:", e.message.slice(0, 200), "— retrying once");
    await new Promise((r) => setTimeout(r, 3000));
    return askClaudeOnce(opts);
  }
}

function askClaudeOnce({ system, prompt, schema, timeoutMs = 180_000, allowRead = false }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", LLM_MODEL,
      "--no-session-persistence",
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--system-prompt", system,
      ...(allowRead ? ["--allowedTools", "Read"] : []),
    ];
    // The prompt goes in on stdin: a positional argument after a variadic flag
    // such as --allowedTools would be swallowed by that flag.
    const t0 = Date.now();
    const child = spawn(CLAUDE_BIN, args, {
      cwd: os.tmpdir(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: "" },
    });
    child.stdin.end(prompt);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude timed out"));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(out);
      } catch {
        return reject(new Error(`claude returned non-JSON (exit ${code}): ${(out || err).slice(0, 300)}`));
      }
      if (json.is_error || !json.structured_output) {
        const why = [json.subtype, json.terminal_reason, json.api_error_status, json.result, err.slice(0, 200)].filter(Boolean).join(" | ");
        return reject(new Error(`claude error: ${String(why).slice(0, 400)}`));
      }
      console.log(`[claude] ${Date.now() - t0} ms wall, ${json.duration_api_ms} ms api, $${(json.total_cost_usd ?? 0).toFixed(3)}`);
      resolve({
        output: json.structured_output,
        model: Object.entries(json.modelUsage ?? {}).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0] ?? LLM_MODEL,
        latencyMs: Date.now() - t0,
        apiMs: json.duration_api_ms,
        costUsd: json.total_cost_usd,
        tokens: {
          in: json.usage?.input_tokens ?? 0,
          cacheRead: json.usage?.cache_read_input_tokens ?? 0,
          out: json.usage?.output_tokens ?? 0,
        },
      });
    });
  });
}
