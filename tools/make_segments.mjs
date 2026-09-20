// Turn a recorded run's event log into a playback speed plan for tools/encode_ramp.py.
//
//   node tools/make_segments.mjs shots/run/events.json out/segments.json [targetSeconds]
//
// The rule is simple and stated on screen: anything where a decision is visibly landing
// plays at real time; the stretches in between are compressed. Two thirds of a run's wall
// clock is Claude reasoning with nothing moving, so that is where the time comes from.
// If a target length is given, the compressed stretches are scaled together until the
// output fits, and the real-time windows are never touched.
import fs from "node:fs";

const src = process.argv[2];
const dst = process.argv[3] ?? "out/segments.json";
const target = process.argv[4] ? Number(process.argv[4]) : null;

const log = JSON.parse(fs.readFileSync(src, "utf8"));
const events = log.events ?? [];
const total = log.videoSeconds ?? (events.at(-1)?.t ?? 0) + 5;

// Two tiers. With jev now sweeping the whole camera rig about once a second, "jev answered
// something" is no longer rare enough to be interesting on its own: a run has hundreds of
// them and giving each one real time would blow any sensible video length. So only the
// moments where an answer CHANGED something get rover pace, and the routine sweeps that
// pass get a gentle multiplier where you can still read the cards going by.
const CONSEQUENTIAL = /VETO|veto|Confidence gate|collision|placement|Placement|contact|Contact|halt|anomaly|objective|Arrived|escalat|keep-out|slip|stopped|rejected|cancelled/i;
const ROUTINE = /jev|sweep|classif|ENav|arc|interpret|review|downlink/i;
// Claude is thinking: the screen is essentially still until the card lands.
const THINKING = /CLAUDE/i;

const LEAD = 1.2;          // seconds of real time before a consequential event
const TAIL = 3.2;          // and after
const ROUTINE_SPEED = 2;   // fast enough to compress, slow enough to read
const ROUTINE_CAP = Number(process.env.RAMP_ROUTINE_CAP ?? 9);
const ROUTINE_PAD = 2.2;

// 1. mark the windows, most important first
// A run now produces dozens of vetoes and gates. Showing every one of them at rover pace
// is both too long and boring: the fifth identical veto teaches nothing the first did not.
// So consequential events are grouped by kind and only a few of each are kept, spread
// evenly across the run so the picks are not all bunched at the start. Every kind that
// happened at all is represented.
const PER_KIND = Number(process.env.RAMP_PER_KIND ?? 3);
const kindOf = (e) => {
  const t = e.title.toLowerCase();
  for (const k of ["collision", "placement", "contact", "confidence gate", "veto", "halt",
                   "anomaly", "objective", "arrived", "escalat", "keep-out", "slip", "cancelled"]) {
    if (t.includes(k)) return k;
  }
  return "other";
};
const mark = (re, lead, tail, perKind = Infinity) => {
  const hits = events.filter((e) => re.test(e.title) || re.test(e.engine));
  let chosen = hits;
  if (Number.isFinite(perKind)) {
    const byKind = new Map();
    for (const e of hits) { const k = kindOf(e); if (!byKind.has(k)) byKind.set(k, []); byKind.get(k).push(e); }
    chosen = [];
    for (const [, list] of byKind) {
      if (list.length <= perKind) { chosen.push(...list); continue; }
      for (let i = 0; i < perKind; i++) chosen.push(list[Math.round((i * (list.length - 1)) / (perKind - 1))]);
    }
  }
  return chosen.map((e) => [Math.max(0, e.t - lead), Math.min(total, e.t + tail)]);
};
const mergeAll = (ws) => {
  ws.sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const w of ws) {
    const last = m.at(-1);
    if (last && w[0] <= last[1] + 0.4) last[1] = Math.max(last[1], w[1]);
    else m.push([...w]);
  }
  return m;
};
const realWins = mergeAll(mark(CONSEQUENTIAL, LEAD, TAIL, PER_KIND));
const routineWins = mergeAll(mark(ROUTINE, 0.8, ROUTINE_PAD));

// 2. lay the timeline down: real beats routine beats fill
const PHASE = [
  [/plan|interpret|report|assess|anomaly|objective|describ/i, "Claude reasoning"],
  [/sweep|ENav|arc|Navcam features|classif|keep-out|veto|Confidence/i, "AutoNav traverse"],
  [/placement|contact|arm|WATSON|PIXL|abrade|core/i, "arm / contact science"],
  [/Mastcam|LIBS|SuperCam|RIMFAX|MEDA|science|interpret/i, "remote sensing"],
  [/downlink|uplink|relay|SOL /i, "downlink / uplink"],
];
// The console's newest entry is a poor label for a compressed stretch: with jev on the
// telemetry stream it is usually a health card, which says nothing about what the rover is
// doing. Label by the phase instead, from the last entry that was about the mission.
const labelAt = (t) => {
  let cur = null;
  for (const e of events) {
    if (e.t > t) break;
    if (/health|nominal/i.test(e.title)) continue;
    cur = e;
  }
  if (!cur) return "start-up";
  for (const [re, name] of PHASE) if (re.test(cur.title) || re.test(cur.engine)) return name;
  return cur.title.split("—")[0].split("::")[0].trim().slice(0, 30) || "traverse";
};
const inAny = (t, wins) => wins.some(([a, b]) => t >= a && t < b);
// walk the timeline on a fine grid and classify each instant, then run-length encode
const STEP = 0.2;
const raw = [];
for (let t = 0; t < total; t += STEP) {
  const kind = inAny(t, realWins) ? "real" : inAny(t, routineWins) ? "routine" : "fill";
  const last = raw.at(-1);
  if (last && last.kind === kind) last.t1 = Math.min(total, t + STEP);
  else raw.push({ t0: t, t1: Math.min(total, t + STEP), kind, label: labelAt(t) });
}
// Coalesce the timeline before any speed is chosen. jev now answers several times a second,
// so marking a routine window around every event chops the run into a hundred slivers, and a
// hundred slivers cannot be compressed at all: each one still needs to be on screen long
// enough to read, and those floors add up to more than the whole target length. Merge any
// non-real stretch shorter than MIN_SRC into its neighbour first; the real-time windows are
// never merged.
const MIN_SRC = 14;
for (let pass = 0; pass < 4000; pass++) {
  let changed = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].kind === "real" || raw[i].t1 - raw[i].t0 >= MIN_SRC || raw.length < 2) continue;
    const cands = [];
    if (i > 0 && raw[i - 1].kind !== "real") cands.push(i - 1);
    if (i < raw.length - 1 && raw[i + 1].kind !== "real") cands.push(i + 1);
    if (!cands.length) continue;
    const j = cands.length === 2
      ? (raw[cands[0]].t1 - raw[cands[0]].t0 >= raw[cands[1]].t1 - raw[cands[1]].t0 ? cands[0] : cands[1])
      : cands[0];
    const a = raw[Math.min(i, j)], b = raw[Math.max(i, j)];
    // the slower kind wins, so a routine stretch is never sped up to fill speed by merging
    const kind = a.kind === "routine" || b.kind === "routine" ? "routine" : "fill";
    const label = (a.t1 - a.t0) >= (b.t1 - b.t0) ? a.label : b.label;
    raw.splice(Math.min(i, j), 2, { t0: a.t0, t1: b.t1, kind, label });
    changed = true; break;
  }
  if (!changed) break;
}

// 3. choose the compression. Fill that follows a Claude card is the emptiest, so it takes
//    the highest multiplier; driving fill takes a gentler one so the motion still reads.
const baseSpeed = (s) => (/Claude reasoning|planning|plan|interpret|report|assess/i.test(s.label) ? 10 : 4);
for (const s of raw) s.speed = s.kind === "real" ? 1 : s.kind === "routine" ? ROUTINE_SPEED : baseSpeed(s);

const realSecs = raw.filter((s) => s.kind === "real").reduce((a, s) => a + (s.t1 - s.t0), 0);
const fillSecs = raw.filter((s) => s.kind !== "real").reduce((a, s) => a + (s.t1 - s.t0), 0);

// A segment must be on screen long enough to register, and no stretch may be compressed so
// hard it effectively disappears: at x150 a minute of planning becomes four frames, which
// reads as a glitch rather than as time passing.
const MIN_OUT = 1.3;
const MAX_SPEED = 40;
const clampSpeed = (seg, k) => {
  if (seg.kind === "real") return 1;
  const cap = seg.kind === "routine" ? ROUTINE_CAP : MAX_SPEED;
  const byLen = (seg.t1 - seg.t0) / MIN_OUT;      // never shorter than one beat
  return Math.max(1, Math.min(cap, byLen, seg.speed * k));
};

if (target) {
  const fit = (k) => raw.reduce((a, seg) => a + (seg.t1 - seg.t0) / clampSpeed(seg, k), 0);
  let lo = 0.5, hi = 200;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (fit(k) > target) lo = k; else hi = k; }
  for (const seg of raw) seg.speed = Math.max(1, Math.round(clampSpeed(seg, hi) * 10) / 10);
  if (realSecs > target) {
    console.warn(`real-time windows alone are ${realSecs.toFixed(0)} s, over the ${target} s target; they are kept and everything else is compressed to the floor`);
  }
}

// 4. Do not let the badge strobe. Any segment that would be on screen for less than a
// beat is folded into its neighbour, keeping the same total output length by using a
// duration-weighted speed.
for (let pass = 0; pass < 4000; pass++) {
  let changed = false;
  for (let i = 0; i < raw.length; i++) {
    const outLen = (raw[i].t1 - raw[i].t0) / raw[i].speed;
    if (outLen >= MIN_OUT || raw.length < 2) continue;
    // Never fold a real-time window into a compressed one: those windows are the whole
    // point of the ramp, and at 1x they are already long enough not to strobe.
    if (raw[i].kind === "real") continue;
    const cands = [];
    if (i > 0 && raw[i - 1].kind !== "real") cands.push(i - 1);
    if (i < raw.length - 1 && raw[i + 1].kind !== "real") cands.push(i + 1);
    if (!cands.length) continue;
    const j = cands.length === 2 ? (raw[cands[0]].speed <= raw[cands[1]].speed ? cands[0] : cands[1]) : cands[0];
    const a = raw[Math.min(i, j)], b = raw[Math.max(i, j)];
    const srcLen = (a.t1 - a.t0) + (b.t1 - b.t0);
    const outSum = (a.t1 - a.t0) / a.speed + (b.t1 - b.t0) / b.speed;
    const merged = { t0: a.t0, t1: b.t1, kind: a.speed <= b.speed ? a.kind : b.kind,
                     label: a.speed <= b.speed ? a.label : b.label,
                     speed: Math.max(1, Math.round(srcLen / Math.max(outSum, 0.04))) };
    raw.splice(Math.min(i, j), 2, merged);
    changed = true; break;
  }
  if (!changed) break;
}

const finalReal = raw.filter((x) => x.kind === "real");
const realKept = finalReal.reduce((a, x) => a + (x.t1 - x.t0), 0);
const segments = raw.map((s) => ({
  t0: +s.t0.toFixed(2), t1: +s.t1.toFixed(2), speed: s.speed,
  label: s.kind === "real" ? s.label : `${s.label}`,
}));
const outSecs = raw.reduce((a, s) => a + (s.t1 - s.t0) / s.speed, 0);

fs.mkdirSync(dst.replace(/[^/\\]+$/, "") || ".", { recursive: true });
fs.writeFileSync(dst, JSON.stringify({ source: src, sourceSeconds: +total.toFixed(1), segments }, null, 1));
console.log(`source ${total.toFixed(0)} s -> ${outSecs.toFixed(0)} s in ${segments.length} segments`);
console.log(`  real time kept: ${realKept.toFixed(0)} s in ${finalReal.length} windows`);
console.log(`  compressed:     ${(total - realKept).toFixed(0)} s -> ${(outSecs - realKept).toFixed(0)} s`);
console.log(`wrote ${dst}`);
