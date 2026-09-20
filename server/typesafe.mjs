// TypeSafe System One client. Key stays server-side.
import fs from "node:fs";
import path from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";

export function loadApiKey(root) {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  for (const dir of [root, path.join(root, "..", "typesafe-decision-game")]) {
    const f = path.join(dir, ".env");
    if (fs.existsSync(f)) {
      const m = /TYPESAFE_API_KEY\s*=\s*(.+)/.exec(fs.readFileSync(f, "utf8"));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

export async function systemOne({ apiKey, state, questions, retries = 3 }) {
  const body = JSON.stringify({ state, model: MODEL, questions });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      lastErr = err;
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    if (res.ok) return { ...JSON.parse(text), latencyMs };
    if (res.status === 429 || res.status === 529) {
      lastErr = new Error(`${res.status}: ${text.slice(0, 200)}`);
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const err = new Error(`TypeSafe ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  throw lastErr ?? new Error("TypeSafe request failed");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
