// Sol activity timeline (the COCPIT-style view): lanes per subsystem, planned vs
// executed vs dropped blocks, and cumulative energy / data against the budget.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const LANES = [
  { id: "DRIVE", label: "Drive (AutoNav)", info: "1.2 Wh/m · 120 m/h" },
  { id: "MASTCAM", label: "Mastcam-Z", info: "20 Wh · 25 min · 45 Mb" },
  { id: "SUPERCAM", label: "SuperCam", info: "25 Wh · 30 min · 20 Mb" },
  { id: "RIMFAX", label: "RIMFAX", info: "10 Wh · in-drive · 12 Mb" },
  { id: "ARM", label: "Arm: WATSON / PIXL / abrade / core", info: "35–160 Wh · 40–240 min" },
  { id: "MEDA", label: "MEDA / atmos", info: "8 Wh · 15 min · 30 Mb" },
  { id: "COMM", label: "Relay pass", info: "MRO overflight · 300 Mb" },
];
export const LANE_OF = {
  drive: "DRIVE", MastcamZ_multispectral: "MASTCAM", SuperCam_LIBS: "SUPERCAM", RIMFAX: "RIMFAX",
  WATSON_closeup: "ARM", PIXL_map: "ARM", abrade: "ARM", core: "ARM", MEDA_dust: "MEDA", comm: "COMM",
};
const T0 = 8 * 60, T1 = 19 * 60;
const pct = (m) => `${Math.max(0, Math.min(100, ((m - T0) / (T1 - T0)) * 100))}%`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;

export function renderSwimlane(timeline, s) {
  const root = $("swimlane");
  if (!root) return;
  const lanesHtml = LANES.map((lane) => {
    const blocks = timeline.filter((b) => b.lane === lane.id).map((b) => {
      const end = b.status === "running" ? s.lmst : (b.end ?? b.start + (b.dur ?? 10));
      const w = Math.max(0.6, ((end - b.start) / (T1 - T0)) * 100);
      const v = b.verify ? ` · jev ${b.verify.serves.toFixed(2)}/${b.verify.prereq.toFixed(2)}/${b.verify.risk.toFixed(2)}` : "";
      const title = `${b.label} · ${hhmm(b.start)}–${hhmm(end)} · ${b.wh ?? 0} Wh · ${b.mb ?? 0} Mb${v}${b.reason ? " · " + b.reason : ""}`;
      return `<div class="blk ${b.status} ${b.tag ?? ""}" style="left:${pct(b.start)};width:${w}%" title="${esc(title)}"><span>${esc(b.short ?? b.label)}</span>${b.verify ? `<i class="vf">${Math.round(b.verify.serves * 100)}·${Math.round(b.verify.prereq * 100)}·${Math.round(b.verify.risk * 100)}</i>` : ""}</div>`;
    }).join("");
    return `<div class="lane"><div class="lane-label"><b>${esc(lane.label)}</b><span>${esc(lane.info)}</span></div><div class="lane-track">${blocks}</div></div>`;
  }).join("");
  const hours = [];
  for (let h = 8; h <= 19; h++) hours.push(`<span style="left:${pct(h * 60)}">${h}:00</span>`);
  const eUsed = s.energyMax - s.energy, dUsed = s.dataMax - s.data;
  const ePlan = timeline.filter((b) => b.status !== "dropped").reduce((a, b) => a + (b.wh ?? 0), 0);
  const dPlan = timeline.filter((b) => b.status !== "dropped").reduce((a, b) => a + (b.mb ?? 0), 0);
  root.innerHTML = `
    <div class="sw-head"><b>SOL ${s.sol} ACTIVITY PLAN</b><span class="sw-legend"><i class="planned"></i>planned by Claude <i class="running"></i>executing <i class="done"></i>done <i class="dropped"></i>dropped by code/jev <i class="objective"></i>user objective</span><span class="sw-now">LMST ${hhmm(s.lmst)}</span></div>
    <div class="sw-axis">${hours.join("")}</div>
    <div class="sw-lanes"><div class="sw-nowline" style="left:calc(190px + (100% - 190px) * ${((s.lmst - T0) / (T1 - T0)).toFixed(4)})"></div>${lanesHtml}</div>
    <div class="sw-budget">
      <div class="bud"><span>ENERGY</span><div class="bb"><i class="used" style="width:${Math.min(100, (eUsed / s.energyMax) * 100)}%"></i><i class="plan" style="left:${Math.min(100, (ePlan / s.energyMax) * 100)}%"></i><i class="margin" style="left:85%"></i></div><b>${Math.round(eUsed)} / ${s.energyMax} Wh</b><small>plan ${Math.round(ePlan)} Wh · margin 15%</small></div>
      <div class="bud"><span>DOWNLINK</span><div class="bb alt"><i class="used" style="width:${Math.min(100, (dUsed / s.dataMax) * 100)}%"></i><i class="plan" style="left:${Math.min(100, (dPlan / s.dataMax) * 100)}%"></i><i class="margin" style="left:85%"></i></div><b>${Math.round(dUsed)} / ${s.dataMax} Mb</b><small>plan ${Math.round(dPlan)} Mb</small></div>
    </div>`;
}
