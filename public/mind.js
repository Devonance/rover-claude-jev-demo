// The "two speeds of mind" strip: System Two (Claude) thinking intervals in purple, System One
// (jev) calls as green ticks — and the jev consultations Claude made *inside* its own reasoning
// drawn as green ticks inside the purple block. Last WINDOW seconds, scrolling.
const WINDOW = 150;
const C = { claude: "#b48cff", jev: "#4fd18b", code: "#5aa7e6", ink: "#e8edf2", ink3: "#7d8794", bg: "rgba(8,10,13,.78)" };

export class MindStrip {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext("2d");
    this.claude = []; // {t0, t1|null, label, consults:[{at, n, ms}]}
    this.jev = [];    // {t, label, ms}
    this.stats = { claude: 0, jev: 0, inside: 0, claudeMs: 0, jevMs: 0 };
  }
  now() { return performance.now() / 1000; }
  claudeStart(label) { this.claude.push({ t0: this.now(), t1: null, label, consults: [] }); }
  claudeEnd(label, consults = [], ms = 0) {
    const cur = [...this.claude].reverse().find((c) => c.t1 == null) ?? { t0: this.now() - ms / 1000, label, consults: [] };
    if (cur.t1 == null && !this.claude.includes(cur)) this.claude.push(cur);
    cur.t1 = this.now(); cur.label = label;
    const dur = cur.t1 - cur.t0;
    // we know each consultation's latency, not its exact moment: spread them along the block
    cur.consults = consults.map((k, i) => ({ at: cur.t0 + dur * ((i + 1) / (consults.length + 1)), n: k.n, ms: k.ms, note: k.note }));
    this.stats.claude++; this.stats.inside += consults.length; this.stats.claudeMs += dur * 1000; this.stats.jevMs += consults.reduce((a, k) => a + (k.ms || 0), 0);
  }
  claudeFeedback(j) { const cur = [...this.claude].reverse().find((c) => c.t1 == null); if (cur) { cur.fb = j; if (j.consults > (cur.liveConsults || 0)) { cur.liveConsults = j.consults; (cur.liveTicks ??= []).push(this.now()); } } }
  jevStart(label) { this._jev0 = this.now(); this._jevLabel = label; }
  jevEnd(label) { const t = this._jev0 ?? this.now(); this.jev.push({ t, label: label || this._jevLabel, ms: (this.now() - t) * 1000 }); this.stats.jev++; this.stats.jevMs += (this.now() - t) * 1000; }
  draw() {
    const g = this.g, W = this.c.width, H = this.c.height, now = this.now(), t0 = now - WINDOW;
    g.clearRect(0, 0, W, H);
    g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, 0, W, H, 8); g.fill();
    const X = (t) => 92 + ((t - t0) / WINDOW) * (W - 104);
    g.font = "600 9.5px ui-monospace, monospace"; g.textBaseline = "middle";
    g.fillStyle = C.claude; g.fillText("SYSTEM TWO", 8, 14); g.fillStyle = C.ink3; g.fillText("Claude", 8, 25);
    g.fillStyle = C.jev; g.fillText("SYSTEM ONE", 8, 44); g.fillStyle = C.ink3; g.fillText("jev", 8, 55);
    // lanes
    g.strokeStyle = "rgba(255,255,255,.08)"; g.beginPath(); g.moveTo(92, 34); g.lineTo(W - 8, 34); g.stroke();
    // Claude blocks
    for (const c of this.claude) {
      const a = Math.max(t0, c.t0), b = c.t1 ?? now; if (b < t0) continue;
      g.fillStyle = "rgba(180,140,255,.28)"; g.fillRect(X(a), 8, Math.max(2, X(b) - X(a)), 18);
      g.strokeStyle = C.claude; g.strokeRect(X(a) + 0.5, 8.5, Math.max(2, X(b) - X(a)) - 1, 17);
      if (X(b) - X(a) > 40 && g.measureText(c.label).width < X(b) - X(a) - 6) { g.fillStyle = C.ink; g.fillText(c.label, X(a) + 4, 17); }
      for (const k of c.consults) { const x = X(k.at); g.strokeStyle = C.jev; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 9); g.lineTo(x, 25); g.stroke(); g.lineWidth = 1; g.fillStyle = C.jev; g.fillText(`${k.n}q`, x + 2, 12); }
      for (const t of c.liveTicks || []) { if (c.t1 != null) break; const x = X(t); g.strokeStyle = C.jev; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 9); g.lineTo(x, 25); g.stroke(); g.lineWidth = 1; }
      if (c.t1 == null) { g.fillStyle = C.claude; const fbt = c.fb ? `${c.fb.phase} · turn ${c.fb.turns} · ${c.fb.consults} jev · ${Math.round(c.fb.elapsed_s)}s` : "thinking…"; const tw = g.measureText(fbt).width; const tx = X(b) - tw - 6; if (tx > X(a) + 40) g.fillText(fbt, tx, 17); }
    }
    // jev ticks
    for (const j of this.jev) { if (j.t < t0) continue; const x = X(j.t); g.strokeStyle = C.jev; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 38); g.lineTo(x, 54); g.stroke(); g.lineWidth = 1; }
    // footer stats
    const s = this.stats, share = s.jev + s.inside ? Math.round((100 * s.inside) / (s.jev + s.inside)) : 0;
    g.fillStyle = C.ink3; g.font = "9.5px ui-monospace, monospace";
    g.fillText(`last ${WINDOW}s · Claude ${s.claude} calls · jev ${s.jev + s.inside} calls, ${s.inside} of them inside Claude's reasoning (${share}%) · jev time inside Claude ${(s.jevMs / 1000).toFixed(1)}s of ${(s.claudeMs / 1000).toFixed(0)}s`, 92, H - 8);
    this.jev = this.jev.filter((j) => j.t > t0 - 5); this.claude = this.claude.filter((c) => (c.t1 ?? now) > t0 - 5);
  }
}
