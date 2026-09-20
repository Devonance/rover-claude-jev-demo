// The ops console: renders every decision with its engine badge so it is
// always visible which of CLAUDE / JEV / CODE produced it, and how.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f2 = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));
const pct = (v) => `${Math.round(v * 100)}%`;
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

export const ops = {
  now(engine, text) {
    const n = $("now");
    n.className = `now ${engine.toLowerCase()}`;
    n.querySelector(".now-engine").textContent = engine;
    n.querySelector(".now-text").textContent = text;
  },
  caption(engine, text, ms = 4200, warn = false) {
    const c = el("div", `cap ${engine.toLowerCase()} ${warn ? "warn" : ""}`, esc(text));
    $("captions").append(c);
    while ($("captions").children.length > 2) $("captions").firstChild.remove();
    setTimeout(() => c.remove(), ms);
  },
  hud(s) {
    $("hud-sol").textContent = s.sol;
    const hh = Math.floor(s.lmst / 60), mm = Math.floor(s.lmst % 60);
    $("hud-lmst").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    $("hud-energy").textContent = `${Math.round(s.energy)} Wh`;
    $("hud-energy-bar").style.width = `${Math.max(0, (s.energy / s.energyMax) * 100)}%`;
    $("hud-data").textContent = `${Math.round(s.data)} Mb`;
    $("hud-data-bar").style.width = `${Math.max(0, (s.data / s.dataMax) * 100)}%`;
    $("hud-odo").textContent = `${s.odo.toFixed(1)} m`;
    $("hud-tilt").textContent = `${s.tilt.toFixed(1)}°`;
    $("hud-mode").textContent = s.mode;
  },
  view(label) { $("viewlabel").textContent = label; },

  log(engine, title, body, meta) {
    const e = el("div", `ev ${engine.toLowerCase()}`);
    e.append(el("div", "ev-head", `<span class="badge">${esc(engine)}</span><span class="ev-title">${esc(title)}</span>${meta ? `<span class="ev-meta">${esc(meta)}</span>` : ""}`));
    if (body) {
      const b = el("div", "body");
      if (typeof body === "string") b.innerHTML = body; else b.append(body);
      e.append(b);
    }
    $("stream").append(e);
    $("stream").scrollTop = $("stream").scrollHeight;
    return e;
  },
  sol(n, text) { this.log("SOL", `SOL ${n} — ${text}`); },
  rule(text) { return el("div", "rule", esc(text)); },

  // ------------------------------------------------------------ CLAUDE
  claudePlan(r) {
    const o = r.output;
    const b = el("div");
    b.append(el("div", null, `<b>${esc(o.sol_summary)}</b>`));
    b.append(el("div", null, `<span style="color:var(--claude)">Hypothesis focus:</span> ${esc(o.hypothesis_focus)}`));
    for (const t of [...o.targets].sort((a, b2) => a.priority - b2.priority)) {
      b.append(el("div", "plan-target", `<span class="pr">P${t.priority}</span><span class="nm">${esc(t.target_id)}</span><span class="acts">${esc(t.activities.join(" → "))}</span><span class="why">${esc(t.rationale)}</span>`));
    }
    b.append(el("div", "kv", `<span>drive → <b>${esc(o.drive.goal_target_id)}</b></span><span>max <b>${o.drive.max_distance_m} m</b></span><span>budget <b>${o.budget.energy_wh} Wh</b> · <b>${o.budget.data_mb} Mb</b> · <b>${o.budget.minutes} min</b></span>`));
    b.append(el("div", null, `<div style="margin-top:6px;font-size:11.5px"><span style="color:var(--claude)">Drive constraints for ENav:</span> ${esc(o.drive.constraints)}</div>`));
    b.append(el("div", null, `<div style="margin-top:6px;font-size:11.5px;border:1px dashed var(--line2);border-radius:6px;padding:6px 8px"><span style="color:var(--jev)">Criteria handed to jev for onboard targeting:</span> “${esc(o.science_criteria)}”</div>`));
    const d = el("details", null, `<summary>prompt sent to Claude (${r.prompt.length} chars) · ${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s · $${(r.costUsd ?? 0).toFixed(3)}</summary><pre>${esc(r.prompt)}</pre>`);
    b.append(d);
    return this.log("CLAUDE", "Sol plan (tactical planning)", b, `${(r.latencyMs / 1000).toFixed(1)} s · ${r.tokens.out} tok out`);
  },
  claudeInterpret(r, target, instrument) {
    const o = r.output;
    const b = el("div");
    b.append(el("div", null, `<div style="font-family:var(--mono);font-size:10.5px;color:var(--ink3);margin-bottom:4px">DATA · ${esc(instrument)} on ${esc(target.name)}</div><div style="font-size:11.5px;color:var(--ink2);border-left:2px solid var(--line2);padding-left:8px">${esc(r.result)}</div>`));
    b.append(el("div", null, `<div style="margin-top:6px"><b>${esc(o.lithology_call)}</b> <span class="conf">confidence ${esc(o.confidence)}</span></div><div>${esc(o.interpretation)}</div>`));
    b.append(el("div", null, `<div style="margin-top:4px;font-size:11.5px"><span style="color:var(--claude)">Hypotheses:</span> ${esc(o.hypothesis_impact)}</div>`));
    b.append(el("div", "kv", `<span>next → <b>${esc(o.next_action)}</b></span>`));
    b.append(el("div", null, `<div style="margin-top:4px;font-size:11.5px;color:var(--ink2)">${esc(o.rationale)}</div>`));
    b.append(el("details", null, `<summary>prompt · ${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s</summary><pre>${esc(r.prompt)}</pre>`));
    return this.log("CLAUDE", "Science interpretation", b, `${(r.latencyMs / 1000).toFixed(1)} s`);
  },
  claudeAnomaly(r) {
    const o = r.output;
    const b = el("div");
    b.append(el("div", null, `<b>${esc(o.diagnosis)}</b>`));
    b.append(el("div", "kv", `<span>action → <b>${esc(o.action)}</b></span>`));
    b.append(el("div", null, `<div style="margin-top:4px">${esc(o.rationale)}</div><div style="margin-top:4px;font-size:11.5px"><span style="color:var(--code)">Constraints for onboard:</span> ${esc(o.constraints_for_onboard)}</div>`));
    b.append(el("details", null, `<summary>prompt · ${r.model} · ${(r.latencyMs / 1000).toFixed(1)} s</summary><pre>${esc(r.prompt)}</pre>`));
    return this.log("CLAUDE", "Anomaly response (ground in the loop)", b, `${(r.latencyMs / 1000).toFixed(1)} s`);
  },

  // ------------------------------------------------------------ JEV
  jrow(label, value, kind, thr) {
    if (kind === "noul") {
      return `<div class="jrow"><span class="jl">${esc(label)}</span><span class="jb"><i class="${value < 0.5 ? "low" : ""}" style="width:${value * 100}%"></i>${thr != null ? `<span class="thr" style="left:${thr * 100}%"></span>` : ""}</span><span class="jv">${f2(value)}</span></div>`;
    }
    return `<div class="jrow"><span class="jl">${esc(label)}</span><span class="jb"><i style="width:${value.confidence * 100}%"></i></span><span class="jv choice">${esc(value.choice)}</span></div>`;
  },
  jevHazards(r, features, verdicts, title) {
    const b = el("div");
    for (const f of features) {
      const t = r.answers[`${f.id}__type`];
      const v = verdicts[f.id] ?? { cls: "", text: "" };   // a card must never die on a missing verdict
      const g = el("div", "jgroup");
      g.innerHTML = `<div class="jg-head"><span>${esc(f.id)} · ${esc(t.choice)}</span><span class="verdict ${v.cls}">${esc(v.text)}</span></div><div class="desc">“${esc(f.appearance)}” — ${esc(f.bearing_words)}; ${esc(f.stereo_note)}</div>`
        + this.jrow("feature type", t, "choice")
        + `<div class="conf ${t.confidence < 0.55 ? "low" : ""}">confidence ${f2(t.confidence)}${t.confidence < 0.55 ? " · below 0.55 floor → code will not act on this read" : ""} · ${Object.entries(t.probabilities).filter(([, p]) => p > 0.02).sort((a, c) => c[1] - a[1]).map(([k, p]) => `${k} ${pct(p)}`).join(" · ")}</div>`
        + this.jrow("wheel hazard", r.answers[`${f.id}__wheel_hazard`].noul, "noul", 0.5)
        + this.jrow("sinkage risk", r.answers[`${f.id}__sinkage`].noul, "noul", 0.5)
        + this.jrow("science interest", r.answers[`${f.id}__science`].noul, "noul", 0.6);
      b.append(g);
    }
    return this.log("JEV", title ?? `Navcam features classified (${features.length} × 4 questions, 1 request)`, b, `${r.latencyMs} ms · ${r.usage.input_tokens} tok`);
  },
  jevAegis(r, candidates, chosenId) {
    const b = el("div");
    for (const c of candidates) {
      const m = r.answers[`${c.id}__match`], ins = r.answers[`${c.id}__instrument`];
      const g = el("div", "jgroup");
      g.innerHTML = `<div class="jg-head"><span>${esc(c.name)}</span><span class="verdict ${c.id === chosenId ? "" : "warn"}">${c.id === chosenId ? "SELECTED" : "not selected"}</span></div><div class="desc">“${esc(c.description)}”</div>`
        + `<div class="jrow"><span class="jl">criteria match</span><span class="jb"><i style="width:${(m.score / 3) * 100}%"></i></span><span class="jv">${f2(m.score)} / 3</span></div>`
        + `<div class="conf">levels: ${Object.entries(m.probabilities).map(([k, p]) => `L${k} ${pct(p)}`).join(" · ")} · confidence ${f2(m.confidence)}</div>`
        + this.jrow("instrument", ins, "choice")
        + `<div class="conf">${Object.entries(ins.probabilities).filter(([, p]) => p > 0.02).sort((a, c2) => c2[1] - a[1]).map(([k, p]) => `${k} ${pct(p)}`).join(" · ")}</div>`;
      b.append(g);
    }
    b.append(el("div", null, this.jrow("arm deploy safe", r.answers.arm_deploy_safe.noul, "noul", 0.6)));
    return this.log("JEV", "Onboard target selection (AEGIS-style)", b, `${r.latencyMs} ms`);
  },
  jevFault(r, event) {
    const fc = r.answers.fault_class;
    const b = el("div");
    b.innerHTML = `<div class="desc" style="font-style:italic;color:var(--ink3);font-size:11px">telemetry: “${esc(event.description)}”</div>`
      + this.jrow("fault class", fc, "choice")
      + `<div class="conf ${fc.confidence < 0.55 ? "low" : ""}">confidence ${f2(fc.confidence)} · ${Object.entries(fc.probabilities).filter(([, p]) => p > 0.02).sort((a, c) => c[1] - a[1]).map(([k, p]) => `${k} ${pct(p)}`).join(" · ")}</div>`
      + this.jrow("stop drive", r.answers.stop_drive.noul, "noul", 0.5)
      + this.jrow("needs ground", r.answers.needs_ground.noul, "noul", 0.5);
    return this.log("JEV", "Telemetry fault triage", b, `${r.latencyMs} ms`);
  },

  // ------------------------------------------------------------ CODE
  enav(res, note) {
    const b = el("div");
    const arcs = el("div", "arcs");
    for (const a of res.arcs) {
      const d = el("div", `arc ${a.blocked ? "blocked" : ""} ${res.chosen && a === res.chosen ? "chosen" : ""}`, a.k === 0 ? "0" : (a.k > 0 ? "L" : "R") + Math.abs(a.k).toFixed(2).slice(1));
      d.title = a.blocked ? `blocked: ${a.blocked}` : `cost ${a.cost.toFixed(2)} tilt ${a.maxTilt.toFixed(1)}°`;
      arcs.append(d);
    }
    b.append(arcs);
    b.append(this.rule(note));
    return this.log("CODE", "ENav arc evaluation", b);
  },
};
