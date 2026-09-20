// Renderers for the objective loop: USER -> CLAUDE (plan) -> JEV (verify) -> CODE -> CLAUDE (report)
import { ops } from "./ops.js";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

Object.assign(ops, {
  // ---- goal-3 renderers: continuous health, sample defensibility, downlink prioritisation
  health(p) {
    const bad = p.stop_drive > 0.5 || p.needs_ground > 0.5;
    const b = el("div");
    b.innerHTML = `<div class="desc" style="font-style:italic;color:var(--ink3);font-size:11px">telemetry, in words: “${esc(p.words)}”</div>`
      + this.jrow("fault class", { choice: p.fault_class, confidence: p.confidence }, "choice")
      + this.jrow("stop drive", p.stop_drive, "noul", 0.5) + this.jrow("needs ground", p.needs_ground, "noul", 0.5);
    return this.log("JEV", `Rover health: ${p.fault_class}${bad ? " — ACTION" : ""}`, b, `${Math.round(p.latency_ms)} ms · continuous`);
  },
  jevSample(p) {
    const r = p.r, a = r.answers;
    const b = el("div");
    b.innerHTML = `<div class="jg-head"><span>${esc(p.target)} — core?</span><span class="verdict ${p.defensible >= 0.5 && p.coherent >= 0.5 ? "" : "warn"}">${p.defensible >= 0.5 && p.coherent >= 0.5 ? "DEFENSIBLE" : "NOT YET · " + esc(p.missing)}</span></div>`
      + this.jrow("defensible to the SRSB", p.defensible, "noul", 0.5) + this.jrow("intact core likely", p.coherent, "noul", 0.5)
      + this.jrow("missing", a.missing, "choice");
    return this.log("JEV", "Sample defensibility (SRSB-style)", b, `${r.latencyMs} ms`);
  },
  jevPlacement(p) {
    const r = p.r, a = r.answers;
    const b = el("div");
    b.innerHTML = `<div class="jg-head" style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><span>${esc(p.instrument)} on ${esc(p.target)} — where to place the turret?</span><span class="verdict ${p.chosen ? "" : "warn"}">${p.chosen ? "SPOT: " + esc(p.chosen.replace("_", " ")) : "NO PLACEMENT"}</span></div>`;
    for (const s of p.spots) {
      const g = el("div", "jgroup");
      g.innerHTML = `<div class="jg-head"><span>${esc(s.id.replace("_", " "))}${s.id === p.chosen ? " ✓" : ""}</span><span class="verdict ${s.ok ? "" : "warn"}">${s.ok ? "acceptable" : "rejected"}</span></div><div class="desc">“${esc(s.words)}”</div>`
        + `<div class="jrow"><span class="jl">placement quality</span><span class="jb"><i class="${s.score < 1.5 ? "low" : ""}" style="width:${(s.score / 3) * 100}%"></i><span class="thr" style="left:50%"></span></span><span class="jv">${s.score.toFixed(2)}/3</span></div>`
        + this.jrow("collision risk", s.collision, "noul", 0.5);
      b.append(g);
    }
    b.append(el("div", "kv", `<span>code proposed the spots from the rock's geometry · jev judged them · code moves the arm</span>`));
    return this.log("JEV", "Arm placement (jev scores the candidate spots)", b, `${r.latencyMs} ms`);
  },
  jevContact(p) {
    const r = p.r, a = r.answers;
    const b = el("div");
    b.innerHTML = `<div class="jg-head" style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><span>hover over the ${esc(p.spot.replace("_", " "))} of ${esc(p.target)}</span><span class="verdict ${p.safe >= 0.5 && p.adjust !== "abort" ? "" : "warn"}">${p.safe >= 0.5 && p.adjust !== "abort" ? "GO FOR CONTACT" : "NO GO · " + esc(p.adjust)}</span></div><div class="desc">“${esc(p.words)}”</div>`
      + this.jrow("safe to contact", p.safe, "noul", 0.5) + this.jrow("good data expected", p.good, "noul", 0.5) + this.jrow("next", a.adjust, "choice");
    return this.log("JEV", "Pre-contact check", b, `${r.latencyMs} ms`);
  },
  jevDownlink(p) {
    const b = el("div");
    b.append(el("div", null, p.queue.map((q) => `<div class="plan-target"><span class="pr">${q.priority}</span><span class="nm">${esc(q.instrument)} · ${esc(q.target)}</span><span class="acts">${q.mb.toFixed(0)} Mb · jev ${q.score.toFixed(2)}/3</span><span class="why">${q.sent ? "this pass" : "held for the next pass"}</span></div>`).join("")));
    b.append(el("div", "kv", `<span>budget <b>${p.budget.toFixed(0)} Mb</b></span><span>queued <b>${p.used.toFixed(0)} Mb</b></span>`));
    return this.log("JEV", "Downlink prioritisation", b, `${p.r.latencyMs} ms`);
  },
  // ---- jev consulted by Claude while it reasoned: rendered under the Claude card
  consults(cardEl, consults) {
    if (!cardEl || !consults?.length) return;
    const body = cardEl.querySelector(".body") ?? cardEl;
    for (const c of consults) {
      const qs = Object.entries(c.questions ?? {}).map(([id, q]) => `${id} (${q.type}): ${q.instructions?.question ?? ""}`).join(" | ");
      const ans = Object.entries(c.answers ?? {}).map(([id, a]) => `${id} → ${a.type === "noul" ? f2(a.noul) : a.type === "score" ? f2(a.score) + " (conf " + f2(a.confidence) + ")" : a.choice + " (conf " + f2(a.confidence) + ")"}`).join("  ·  ");
      body.append(el("div", "consult", `<div class="ch">↳ Claude asked jev mid-reasoning · ${c.n ?? Object.keys(c.questions ?? {}).length} questions · ${c.latency_ms ?? "?"} ms${c.note ? " · " + esc(c.note) : ""}</div><div class="cq">${esc(qs)}</div><div class="cq" style="color:var(--jev)">${esc(ans)}</div>`));
    }
  },
  // ---- perception: the frame the rover saw and what code measured in it
  visionFrame(vision, feats) {
    const c = document.createElement("canvas"); c.width = 336; c.height = 189;
    vision.draw(c, feats, {});
    const b = el("div");
    const img = document.createElement("img"); img.src = c.toDataURL("image/png"); img.style.cssText = "width:100%;border-radius:6px;display:block;margin-bottom:6px";
    b.append(img);
    b.append(el("div", null, feats.map((f) => `<div style="font:10.5px var(--mono);color:var(--ink2);margin-top:2px"><b style="color:var(--ink)">${esc(f.id)}</b> ${esc(f.kind ?? "feature")} · ${f.dist.toFixed(1)} m · ${f.h != null ? f.h.toFixed(2) + " m relief" : "relief unknown"}${f.d ? " · " + f.d.toFixed(1) + " m across" : ""}<br><span style="color:var(--ink3)">“${esc(f.appearance)}”</span></div>`).join("")));
    b.append(el("div", null, `<div style="font-size:11px;color:var(--ink3);margin-top:6px">Rendered from the mast camera; relief from the depth buffer (stereo stand-in), tone from the colour frame; shadowed pixels sampled sparsely as real stereo would. Numbers become words before jev sees them.</div>`));
    return this.log("CODE", `Navcam frame ${vision.seq}: ${feats.length} feature${feats.length > 1 ? "s" : ""} measured`, b, "perception");
  },
  claudeDescribe(r, png) {
    const o = r.output;
    const b = el("div");
    const img = document.createElement("img"); img.src = png; img.style.cssText = "width:100%;border-radius:6px;display:block;margin-bottom:6px";
    b.append(img);
    b.append(el("div", null, `<div style="font-size:11.5px;color:var(--ink2)">${esc(o.scene)}</div><div style="margin-top:5px"><b>${esc(o.target.description)}</b></div>`));
    b.append(el("div", "kv", `<span>size <b>${o.target.size_m} m</b></span><span>tone <b>${esc(o.target.tone)}</b></span><span>texture <b>${esc(o.target.texture)}</b></span><span>coating <b>${esc(o.target.coating)}</b></span>`));
    if (o.other_rocks?.length) b.append(el("div", null, `<div style="margin-top:5px;font-size:11.5px"><span style="color:var(--claude)">Also in frame:</span> ${o.other_rocks.map((x) => `${esc(x.where)} — ${esc(x.description)}`).join("; ")}</div>`));
    b.append(el("div", null, `<div style="margin-top:4px;font-size:11.5px"><span style="color:var(--claude)">Hazards noticed:</span> ${esc(o.hazards_noticed)}</div>`));
    b.append(el("details", null, `<summary>prompt · ${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s (image read via the CLI's Read tool)</summary><pre>${esc(r.prompt)}</pre>`));
    return this.log("CLAUDE", "Navcam frame read (vision)", b, `${(r.latencyMs / 1000).toFixed(1)} s`);
  },
  userObjective(text, pick) {
    const b = el("div");
    b.append(el("div", null, `<b>“${esc(text)}”</b>`));
    b.append(el("div", null, `<div style="margin-top:4px;font-size:11.5px;color:var(--ink2)">Pointed at: ${esc(pick.description)} <span style="font-family:var(--mono);color:var(--ink3)">(${pick.x.toFixed(0)} E, ${pick.y.toFixed(0)} N)</span></div>`));
    b.append(el("div", null, `<div style="margin-top:6px;font-size:11px;color:var(--ink3)">Routed: Claude assesses &amp; plans → jev verifies each step → code schedules inside the envelope → Claude reports.</div>`));
    return this.log("USER", "New science objective", b, "from the science team");
  },
  claudeObjective(r) {
    const o = r.output;
    const b = el("div");
    b.append(el("div", null, `<b style="color:var(--claude)">${esc(o.worth_it.toUpperCase())}</b> — ${esc(o.assessment)}`));
    const list = el("div", null, o.activities.map((a, i) => `<div class="plan-target"><span class="pr">${i + 1}</span><span class="nm">${esc(a.instrument)}</span><span class="why">${esc(a.purpose)}</span></div>`).join(""));
    b.append(list);
    b.append(el("div", "kv", `<span>approach → <b>${o.approach_required ? "drive to arm reach" : "not needed"}</b></span><span>budget <b>${o.budget.energy_wh} Wh</b> · <b>${o.budget.data_mb} Mb</b> · <b>${o.budget.minutes} min</b></span>`));
    b.append(el("div", null, `<div style="margin-top:6px;font-size:11.5px"><span style="color:var(--claude)">Expected evidence:</span> ${esc(o.expected_evidence)}</div><div style="margin-top:4px;font-size:11.5px"><span style="color:var(--claude)">Displaces:</span> ${esc(o.displaces)}</div>`));
    b.append(el("details", null, `<summary>prompt · ${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s</summary><pre>${esc(r.prompt)}</pre>`));
    return this.log("CLAUDE", "Objective assessment & plan", b, `${(r.latencyMs / 1000).toFixed(1)} s`);
  },
  jevVerify(r, names, gates) {
    const b = el("div");
    for (const g of gates) {
      const grp = el("div", "jgroup");
      grp.innerHTML = `<div class="jg-head"><span>${esc(names[g.i])}</span><span class="verdict ${g.ok ? "" : "warn"}">${g.ok ? "COMMITTED" : "DROPPED · " + esc(g.why)}</span></div>`
        + this.jrow("serves objective", g.serves, "noul", 0.5)
        + this.jrow("prerequisites met", g.prereq, "noul", 0.5)
        + this.jrow("risk acceptable", g.risk, "noul", 0.5);
      b.append(grp);
    }
    return this.log("JEV", `Plan verification (${gates.length} activities × 3 questions, 1 request)`, b, `${r.latencyMs} ms`);
  },
  claudeReport(r, objective) {
    const o = r.output;
    const b = el("div", "report");
    b.innerHTML = `<div class="rep-head"><span class="rep-answer ${esc(o.answer)}">${esc(o.answer.toUpperCase())}</span><span class="conf">confidence ${esc(o.confidence)}</span></div>
      <div style="font-weight:600;margin-top:4px">${esc(o.headline)}</div>
      <div style="margin-top:4px">${esc(o.evidence)}</div>
      <div style="margin-top:4px;font-size:11.5px"><span style="color:var(--claude)">Recommendation:</span> ${esc(o.recommendation)}</div>
      <div style="margin-top:2px;font-size:11px;color:var(--ink3)">Cost: ${esc(o.cost)} · objective: “${esc(objective)}”</div>`;
    b.append(el("details", null, `<summary>prompt · ${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s</summary><pre>${esc(r.prompt)}</pre>`));
    return this.log("CLAUDE", "Objective report", b, `${(r.latencyMs / 1000).toFixed(1)} s`);
  },
});
