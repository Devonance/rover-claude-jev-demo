// The sol state machine. Code owns it. Claude is asked to plan and to interpret;
// jev is asked to classify, choose and verify; everything else is rules and arithmetic.
import { evaluateArcs, lookahead, scriptedFeature, sunState } from "./enav.js";
import { ops } from "./ops.js";
import "./ops_extra.js";
import { renderSwimlane, LANE_OF } from "./swimlane.js";

const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(async (r) => {
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (r) => (r * 180) / Math.PI;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;

const SPEED = 2.4;            // on-screen m/s (time-warped; real AutoNav ~120 m/h)
const WH_PER_M = 1.2;
const MIN_PER_M = 60 / 120;   // 120 m/h
const CONF_FLOOR = 0.55;
const ENERGY_MARGIN = 0.15;
const VERIFY_FLOOR = 0.5;
const REMOTE = new Set(["MastcamZ_multispectral", "SuperCam_LIBS", "RIMFAX", "MEDA_dust"]);
const SHORT = { MastcamZ_multispectral: "Mastcam-Z", SuperCam_LIBS: "LIBS", RIMFAX: "RIMFAX", MEDA_dust: "MEDA", WATSON_closeup: "WATSON", PIXL_map: "PIXL", abrade: "abrade", core: "core" };

export class Game {
  constructor(view, world) {
    this.view = view; this.world = world;
    this.terrain = view.terrain; this.rover = view.rover;
    this.sol = 0; this.lmst = 8 * 60; this.odo = 0; this.solOdo = 0;
    this.energy = world.constraints.energy_wh; this.data = world.constraints.data_mb;
    this.mode = "IDLE"; this.history = []; this.done = {}; this.criteria = "";
    this.obstacles = []; this.keepouts = []; this.firedEvents = new Set(); this.judged = new Set(); this.judgedSpots = [];
    this.speedFactor = 1; this.running = false; this.stepGate = null; this.autoplay = false;
    this.frameResolvers = [];
    this.timeline = []; this.pendingObjective = null; this.objectives = [];
    this.lastK = null; this.lastReason = ""; this.lastWaypointOdo = -99;
    this.perceived = []; // rocks the Navcam has measured: {x, y, d, h, label}
    this.pos = { x: world.rover_start.x, y: world.rover_start.y, heading: (world.rover_start.heading_deg * Math.PI) / 180 };
    this.hud();
  }
  // ------------------------------------------------------------ plumbing
  update(dt) { const rs = this.frameResolvers; this.frameResolvers = []; for (const r of rs) r(dt); }
  nextFrame() { return new Promise((r) => this.frameResolvers.push(r)); }
  hud() {
    const s = { sol: this.sol || "—", lmst: this.lmst, energy: this.energy, energyMax: this.world.constraints.energy_wh, data: this.data, dataMax: this.world.constraints.data_mb, odo: this.odo, tilt: this.rover.tiltDeg(), mode: this.mode };
    ops.hud(s);
    renderSwimlane(this.timeline, s);
  }
  spend({ wh = 0, mb = 0, min = 0 }) { this.energy -= wh; this.data -= mb; this.lmst += min; this.view.setSun(this.lmst); this.hud(); }
  setMode(m) { this.mode = m; this.hud(); }
  async pause(ms) { if (this.autoplay) await sleep(ms); else await this.waitStep(); }
  waitStep() { return new Promise((r) => (this.stepGate = r)); }
  step() { if (this.stepGate) { const g = this.stepGate; this.stepGate = null; g(); } }
  start() {
    if (this.running) return;
    this.autoplay = true;
    document.getElementById("btn-start").disabled = true;
    this.run().catch((e) => { console.error(e); ops.log("CODE", "Run stopped", `<span style="color:var(--hot)">${e.message}</span>`); });
  }
  target(id) { return this.world.targets.find((t) => t.id === id); }
  dist(t) { return Math.hypot(t.x - this.pos.x, t.y - this.pos.y); }
  bearingTo(t) { return Math.atan2(t.y - this.pos.y, t.x - this.pos.x); }
  roverWords() {
    const tilt = this.rover.tiltDeg();
    return { tilt: tilt < 6 ? "gentle tilt, under six degrees" : tilt < 12 ? "moderate tilt around ten degrees" : "steep tilt", ground: this.terrain.inSand(this.pos.x, this.pos.y) ? "one wheel on loose drift material" : "all six wheels on firm pavement", air: this.view.dynamic.length ? "dust lifted nearby" : "clear air", hour: this.lmst < 15 * 60 ? "mid-sol, hours of light left" : "late sol, light running out" };
  }

  // ------------------------------------------------------------ perception map
  // What ENav is allowed to know about rocks: only what the Navcam has seen.
  remember(f, h, label) {
    const near = this.perceived.find((r) => Math.hypot(r.x - f.x, r.y - f.y) < 0.9);
    if (near) { near.h = Math.max(near.h, h); near.d = Math.max(near.d, f.d ?? 0.4); if (label) near.label = label; return near; }
    const r = { x: f.x, y: f.y, d: f.d ?? 0.6, h, label: label ?? "seen" };
    this.perceived.push(r);
    return r;
  }
  alreadyJudged(f) { return this.judgedSpots.some((q) => Math.hypot(q.x - f.x, q.y - f.y) < 1.2); }
  see(sun, opts = {}) {
    const v = this.view.vision;
    v.capture();
    return v.detect(sun, opts);
  }

  // ------------------------------------------------------------ timeline (swimlane)
  addBlock(b) { const blk = { id: `b${this.timeline.length}`, status: "planned", ...b }; this.timeline.push(blk); this.hud(); return blk; }
  planBlocks(items, tag) {
    let t = this.lmst;
    for (const it of items) {
      this.addBlock({ lane: LANE_OF[it.key] ?? "ARM", key: it.key, target: it.target, label: `${SHORT[it.key] ?? it.key}${it.target ? " · " + it.target : ""}`, short: SHORT[it.key] ?? it.key, start: t, dur: it.dur, wh: it.wh, mb: it.mb, tag, verify: it.verify });
      t += it.dur;
    }
  }
  beginBlock(key, target, tag) {
    let b = this.timeline.find((x) => x.status === "planned" && x.key === key && (!target || x.target === target));
    if (!b) b = this.addBlock({ lane: LANE_OF[key] ?? "ARM", key, target, label: `${SHORT[key] ?? key}${target ? " · " + target : ""}`, short: SHORT[key] ?? key, start: this.lmst, dur: 5, tag: tag ?? "opportunistic" });
    b.status = "running"; b.start = this.lmst; b.end = undefined; this.hud();
    return b;
  }
  endBlock(b, { wh, mb } = {}) { if (!b) return; b.status = "done"; b.end = this.lmst; if (wh != null) b.wh = wh; if (mb != null) b.mb = mb; this.hud(); }
  dropBlock(key, target, reason) {
    const b = this.timeline.find((x) => x.status === "planned" && x.key === key && (!target || x.target === target));
    if (b) { b.status = "dropped"; b.reason = reason; b.end = b.start + Math.min(b.dur, 20); }
    this.hud();
  }
  rescheduleRemaining() {
    let t = this.lmst;
    for (const b of this.timeline) if (b.status === "planned") { b.start = Math.max(b.start, t); t = b.start + b.dur; }
    this.hud();
  }

  // ------------------------------------------------------------ the mission
  async run() {
    this.running = true;
    for (let s = 1; s <= 3; s++) {
      this.sol = s; this.solOdo = 0; this.lmst = 8 * 60; this.timeline = [];
      this.energy = this.world.constraints.energy_wh; this.data = this.world.constraints.data_mb;
      this.view.setSun(this.lmst); this.hud();
      ops.sol(s, "uplink received · LMST 08:00");
      const plan = await this.plan();
      await this.execute(plan);
      await this.downlink();
      if (s < 3) await this.pause(2500);
    }
    this.setMode("END");
    ops.now("CODE", "mission segment complete");
    ops.caption("CODE", "End of the three-sol segment. Every plan was Claude's; every fast call was jev's; every rule was code.", 12000);
    ops.log("CODE", "Segment complete", `${this.odo.toFixed(0)} m driven over 3 sols. History:<br>${this.history.map((h) => `• ${h}`).join("<br>")}`);
    this.running = false;
    document.body.dataset.done = "1";
  }

  // ------------------------------------------------------------ CLAUDE: plan
  async plan() {
    this.setMode("PLANNING");
    this.view.setCamera("overview");
    ops.now("CLAUDE", `planning sol ${this.sol} — reading downlink, targets, hypotheses`);
    ops.caption("CLAUDE", `Sol ${this.sol}: the science team (Claude) writes the tactical plan from the downlink.`, 6000);
    const ctx = {
      sol: this.sol,
      rover: { x: this.pos.x, y: this.pos.y, heading: deg(this.pos.heading), tilt: this.rover.tiltDeg() },
      energy_wh: Math.round(this.energy), data_mb: Math.round(this.data), minutes: this.world.constraints.sol_minutes,
      standing: this.sol === 1
        ? "first sol of the campaign; no contact science yet. Campaign-plan intent for this sol: remote sensing then contact science (WATSON, then PIXL or abrasion as justified) on the nearest Máaz-formation float rock, Máaz, before beginning the traverse toward Artuby ridge."
        : this.sol === 2 ? "campaign in progress. Campaign-plan intent for this sol: the traverse toward Rochette on Artuby ridge, with opportunistic science on the way." : "campaign in progress; reach and characterise Rochette (abrade; core only if justified), then image the Séítah contact.",
      targets: this.world.targets.map((t) => ({ id: t.id, name: t.name, description: t.description, dist: this.dist(t), bearing: (deg(this.bearingTo(t)) + 360) % 360, done: this.done[t.id] ?? [] })),
      terrain_notes: `Crater-floor pavement, mean slope ${this.terrain.slopeDeg(this.pos.x, this.pos.y).toFixed(1)}° locally; scattered float rocks up to ~1.5 m; several bright ripple fields between here and Artuby ridge (keep-out); Navcam shadows are long in the morning.`,
      history: this.history,
    };
    const r = await post("/api/claude/plan", ctx);
    ops.claudePlan(r);
    this.criteria = r.output.science_criteria;
    const goal = r.output.drive.goal_target_id;
    this.view.highlightGoal(goal);
    const items = [];
    for (const pt of [...r.output.targets].sort((a, b) => a.priority - b.priority)) {
      const t = this.target(pt.target_id); if (!t) continue;
      const d = this.dist(t);
      if (d > 3 && pt.target_id === goal) items.push({ key: "drive", target: t.name, dur: Math.min(d, r.output.drive.max_distance_m) * MIN_PER_M, wh: Math.round(Math.min(d, r.output.drive.max_distance_m) * WH_PER_M), mb: 12 });
      for (const a of pt.activities) { const ins = this.world.instruments[a]; if (ins) items.push({ key: a, target: t.name, dur: Math.max(ins.minutes, 8), wh: ins.wh, mb: ins.mb }); }
    }
    items.push({ key: "comm", target: "", dur: 30, wh: 15, mb: 0 });
    this.planBlocks(items, "plan");
    const comm = this.timeline.find((b) => b.key === "comm"); if (comm) comm.start = Math.max(comm.start, 16.5 * 60);
    this.hud();
    ops.caption("CLAUDE", r.output.sol_summary, 7000);
    await this.pause(3500);
    return r.output;
  }

  // ------------------------------------------------------------ CODE: execute plan
  async execute(plan) {
    const targets = [...plan.targets].sort((a, b) => a.priority - b.priority);
    const goalId = plan.drive.goal_target_id;
    let driven = false;
    for (const pt of targets) {
      const t = this.target(pt.target_id);
      if (!t) continue;
      await this.maybeObjective();
      const d = this.dist(t);
      const needsArm = pt.activities.some((a) => !REMOTE.has(a));
      if (d <= 3 || (!needsArm && d <= 40 && pt.activities.every((a) => a === "MastcamZ_multispectral"))) {
        await this.science(t, pt.activities, plan);
        continue;
      }
      if (pt.target_id === goalId && !driven) {
        driven = true;
        // A drive cap that would park the rover a few metres short of its own goal is a
        // planning slip, not intent: extend it to reach the goal, never past the flight limit.
        const cap = Math.min(this.world.constraints.max_drive_m, Math.max(plan.drive.max_distance_m, Math.ceil(this.dist(t) * 1.25) + 8));
        if (cap !== plan.drive.max_distance_m) ops.log("CODE", "Drive cap adjusted", ops.rule(`plan max ${plan.drive.max_distance_m} m < distance to ${t.name} (${this.dist(t).toFixed(0)} m) → cap = min(${this.world.constraints.max_drive_m}, 1.25 × dist + 8) = ${cap} m`));
        let arrived = await this.drive(t, cap, plan.drive.constraints);
        while (!arrived && this.driveEndReason.startsWith("paused")) { await this.maybeObjective(); arrived = await this.drive(t, cap, plan.drive.constraints, { quiet: true }); }
        if (arrived) await this.science(t, pt.activities, plan);
        else { ops.log("CODE", "Drive ended before goal", this.driveEndReason); for (const a of pt.activities) this.dropBlock(a, t.name, "not reached this sol"); break; }
      }
    }
    if (!driven && goalId !== "none" && this.target(goalId) && this.dist(this.target(goalId)) > 3) {
      const t = this.target(goalId);
      let arrived = await this.drive(t, plan.drive.max_distance_m, plan.drive.constraints);
      while (!arrived && this.driveEndReason.startsWith("paused")) { await this.maybeObjective(); arrived = await this.drive(t, plan.drive.max_distance_m, plan.drive.constraints, { quiet: true }); }
      if (arrived) await this.science(t, targets.find((p) => p.target_id === goalId)?.activities ?? ["MastcamZ_multispectral"], plan);
    }
    await this.maybeObjective();
  }

  // ------------------------------------------------------------ CODE + JEV: drive
  async drive(goal, maxDist, constraints, opts = {}) {
    this.setMode("AUTONAV");
    this.view.setCamera("chase");
    this.view.planned(this.pos, goal);
    const blk = this.beginBlock("drive", goal.name, opts.tag);
    ops.log("CODE", `Drive to ${goal.name}`, `Goal ${this.dist(goal).toFixed(0)} m away, bearing ${((deg(this.bearingTo(goal)) + 360) % 360).toFixed(0)}°. Max ${maxDist} m this sol. Planner constraints: <i>${constraints}</i>` + ops.rule(`ENav: 9 arcs × 6 m, tilt limit ${this.world.constraints.keepout_tilt_deg}°, step limit ${this.world.constraints.rock_step_limit_m} m, stereo range 9 m`).outerHTML);
    if (!opts.quiet) ops.caption("CODE", `AutoNav engaged: ENav evaluates 9 candidate arcs every cycle; jev is asked about anything geometry can't resolve.`, 6000);
    let sinceImaging = 99, cycles = 0, stuck = 0, solDriven = 0, wh0 = this.energy;
    this.driveEndReason = ""; this.lastK = null;
    const stopR = goal.approach ?? 2.6;
    while (this.dist(goal) > stopR) {
      if (solDriven >= maxDist) { this.driveEndReason = `Reached the planner's max drive distance (${maxDist} m). Rover parks; drive continues next sol.`; break; }
      if (this.energy < this.world.constraints.energy_wh * ENERGY_MARGIN) { this.driveEndReason = "Energy at the 15% margin. Rover parks for the sol."; break; }
      if (this.lmst > 17 * 60) { this.driveEndReason = "End of ops window (LMST 17:00)."; break; }
      if (this.pendingObjective && !opts.isObjective) { this.driveEndReason = "paused for a new science objective"; break; }

      for (const ev of this.world.events) {
        if (!this.firedEvents.has(ev.id) && this.odo >= ev.at_odo) {
          this.firedEvents.add(ev.id);
          if (ev.kind === "telemetry_fault") { const cont = await this.fault(goal, solDriven, maxDist); if (!cont) { this.driveEndReason = "Stopped for the sol after anomaly."; this.endBlock(blk, { wh: Math.round(wh0 - this.energy) }); return false; } }
          else if (ev.kind === "sand_field") { const sx = this.pos.x + Math.cos(this.pos.heading + 0.15) * 8, sy = this.pos.y + Math.sin(this.pos.heading + 0.15) * 8; this.view.sandPatch(sx, sy, 5.5); sinceImaging = 99; }
          else if (ev.kind === "shadow_ambiguity") { sinceImaging = 99; }
          else this.pendingFeature = ev.kind;
        }
      }
      if (sinceImaging >= 6) {
        sinceImaging = 0; cycles++;
        const sun = sunState(this.lmst);
        let feats = this.see(sun);
        if (this.pendingFeature) { const f = scriptedFeature(this.pendingFeature, { ...this.pos, sun }); if (f) feats.unshift(f); this.pendingFeature = null; }
        // measured rocks go straight into the perception map (geometry needs no model);
        // jev is asked only about things not judged before at that spot
        for (const f of feats) if (f.kind === "rock" && f.h != null) this.remember(f, f.h);
        feats = feats.filter((f) => !this.alreadyJudged(f));
        this.view.vision.draw(document.getElementById("navcam"), this.view.vision.lastFrame?.feats ?? [], {});
        if (feats.length) await this.classify(feats, sun);
        else document.getElementById("navcam-foot").textContent = `frame ${this.view.vision.seq}: ${(this.view.vision.lastFrame?.feats ?? []).length} features, all previously judged`;
      }
      const base = { ...this.pos, goal, terrain: this.terrain, obstacles: this.obstacles, keepouts: this.keepouts, tiltLimit: this.world.constraints.keepout_tilt_deg, stepLimit: this.world.constraints.rock_step_limit_m, rocks: this.perceived };
      const res = evaluateArcs(base);
      const blockedN = res.arcs.filter((a) => a.blocked).length;
      const labels = [...new Set(res.arcs.map((a) => a.blocked).filter(Boolean))];
      if (!res.chosen) {
        stuck++;
        const rev = evaluateArcs({ ...base, reverse: true, rocks: null }); // rear Hazcams: local truth behind the rover
        if (rev.chosen && stuck <= 4) {
          ops.enav(res, `No safe forward arc (${labels.slice(0, 3).join(", ")}). Reverse arc κ=${rev.chosen.k} to open space (${stuck}/4).`);
          this.pathChange(`back up: ${labels[0] ?? "boxed in"}`, labels);
          await this.follow(rev.chosen.path.slice(0, 4), true);
          this.spend({ wh: 4, min: 3 });
          continue;
        }
        const turn = (stuck % 2 ? 1 : -1) * (Math.PI / 5);
        ops.enav(res, `No safe arc either way. Turn in place ${deg(turn).toFixed(0)}° and re-evaluate (${stuck}/8).`);
        if (stuck > 8) { this.driveEndReason = "ENav found no safe arc after 8 recovery attempts. Rover stops and waits for ground."; ops.caption("CODE", "ENav: no safe path — stopping for ground assessment", 5000, true); break; }
        await this.turnInPlace(turn);
        this.spend({ wh: 6, min: 4 });
        continue;
      }
      stuck = 0;
      // intended route: where ENav currently thinks it is going, given everything jev has flagged
      this.view.future(lookahead(base, res.chosen, 7));
      if (!this._perceptionNoted) { this._perceptionNoted = true; ops.log("CODE", "Perception map", `ENav plans only on rocks the Navcam has measured (<b>${this.perceived.length}</b> so far) plus jev's keep-outs. Nothing is read from the world's rock list while driving forward; reversing uses the rear Hazcams.`); }
      this.view.arc(res.chosen.path);
      // path-change reasoning: attribute to jev when a jev verdict is what bent the route
      if (this.lastK != null && Math.abs(res.chosen.k - this.lastK) >= 0.05) {
        const dir = res.chosen.k > this.lastK ? "left" : "right";
        if (labels.length) this.pathChange(`${dir}: ${labels.join(", ")}`, labels);
        else if (Math.abs(res.chosen.k) < Math.abs(this.lastK)) this.pathChange(`${dir}: clear ahead, straightening toward ${goal.name}`, []);
        else this.pathChange(`${dir}: lower-cost arc toward ${goal.name}`, []);
      } else if (this.lastK == null && labels.length) this.pathChange(`start: avoiding ${labels.join(", ")}`, labels);
      this.lastK = res.chosen.k;
      if (blockedN || cycles % 4 === 1) ops.enav(res, `chosen κ=${res.chosen.k} · cost ${res.chosen.cost.toFixed(2)} · max tilt ${res.chosen.maxTilt.toFixed(1)}° · ${blockedN} of 9 blocked` + (blockedN ? ` (${labels.join(", ")})` : ""));
      const moved = await this.follow(res.chosen.path.slice(0, 6));
      solDriven += moved; sinceImaging += moved;
      this.spend({ wh: moved * WH_PER_M, min: (moved * MIN_PER_M) / this.speedFactor });
    }
    this.view.planned(null); this.view.future(null); this.view.arc(null);
    this.endBlock(blk, { wh: Math.round(wh0 - this.energy) });
    const arrived = this.dist(goal) <= stopR + 0.5;
    if (arrived) {
      this.driveEndReason = "arrived";
      ops.log("ROVER", `Arrived at ${goal.name}`, `${solDriven.toFixed(1)} m this drive · odometer ${this.odo.toFixed(1)} m · tilt ${this.rover.tiltDeg().toFixed(1)}°`);
      ops.caption("ROVER", `Arrived at ${goal.name} — ${solDriven.toFixed(0)} m of AutoNav.`, 4000);
      this.view.waypoint(this.pos.x, this.pos.y, `arrived · ${goal.name}`, "rover");
      await this.turnInPlace(wrap(this.bearingTo(goal) - this.pos.heading));
    } else if (this.driveEndReason.startsWith("paused")) {
      blk.status = "planned"; blk.dur = Math.max(5, blk.dur - (this.lmst - blk.start));
    }
    return arrived;
  }
  // A waypoint on the travelled path with the reason the route changed here.
  pathChange(text, labels) {
    // Flags mark decisions worth explaining: a jev or ground verdict bending the
    // route, or a reversal. Plain geometry (a rock under a track) is logged in the
    // ENav cards, not flagged, or the track would be a forest of poles.
    const jev = labels.some((l) => l.startsWith("jev:") || l.startsWith("ground:"));
    const reversal = text.startsWith("back up");
    if (!jev && !reversal) return;
    const key = labels.length ? [...labels].filter((l) => l.startsWith("jev:") || l.startsWith("ground:")).sort().join("|") || text : text;
    if (this.odo - this.lastWaypointOdo < 10) return;
    if (key === this.lastReason && this.odo - this.lastWaypointOdo < 30) return;
    this.lastReason = key; this.lastWaypointOdo = this.odo;
    text = text.replace(/rock \d\.\d\d m,? ?/g, "").replace(/, $/, "");
    const engine = jev ? "JEV" : "CODE";
    this.view.waypoint(this.pos.x, this.pos.y, text, engine.toLowerCase());
    ops.log(engine, "Path change", `<span style="font-family:var(--mono);font-size:11px">${text}</span>` + (jev ? `<div style="font-size:11px;color:var(--ink3);margin-top:3px">Route bent because of a jev verdict, not geometry: ENav's arcs are blocked by what jev classified.</div>` : `<div style="font-size:11px;color:var(--ink3);margin-top:3px">ENav geometry (ACE tilt / step / cost) — no model involved.</div>`), `odo ${this.odo.toFixed(0)} m`);
  }
  async follow(path, reverse = false) {
    let moved = 0;
    for (const [px, py] of path) {
      let dx = px - this.pos.x, dy = py - this.pos.y, d = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      while (d > 0.05) {
        const dt = await this.nextFrame();
        const stepLen = Math.min(d, SPEED * this.speedFactor * (reverse ? 0.5 : 1) * dt);
        this.pos.x += Math.cos(th) * stepLen; this.pos.y += Math.sin(th) * stepLen;
        if (!reverse) this.pos.heading += wrap(th - this.pos.heading) * Math.min(1, 6 * dt);
        this.rover.pose(this.terrain, this.pos.x, this.pos.y, this.pos.heading);
        this.rover.advance(reverse ? -stepLen : stepLen);
        this.odo += stepLen; this.solOdo += stepLen; moved += stepLen; d -= stepLen;
        if (Math.floor(this.odo * 2) !== Math.floor((this.odo - stepLen) * 2)) this.view.addTrack(this.pos.x, this.pos.y);
      }
      this.hud();
    }
    return moved;
  }
  async turnInPlace(angle) {
    const target = this.pos.heading + angle;
    let t = 0;
    while (t < 1) {
      const dt = await this.nextFrame(); t = Math.min(1, t + dt / Math.max(0.4, Math.abs(angle) / 0.8));
      this.pos.heading = target - angle * (1 - t);
      this.rover.pose(this.terrain, this.pos.x, this.pos.y, this.pos.heading);
      this.rover.advance(dt * 0.6);
    }
  }

  // ------------------------------------------------------------ JEV: hazards
  async classify(feats, sun) {
    this.setMode("AUTONAV · JEV");
    ops.now("JEV", `classifying ${feats.length} Navcam feature${feats.length > 1 ? "s" : ""} — ${feats.length * 4} questions, 1 request`);
    this.view.setCamera("navcam");
    document.getElementById("navcam-wrap").classList.add("active");
    for (const f of feats) f.markObj = this.view.mark(f.x, f.y, 0x4fd18b, Math.max(0.8, (f.h ?? f.hEst ?? 0.5) * 2));
    const payload = feats.map(({ rock, markObj, box, px, hEst, source, ...f }) => f);
    ops.visionFrame(this.view.vision, feats);
    const r = await post("/api/jev/hazards", { features: payload, context: { sun: sun.words } });
    const verdicts = {};
    let reimage = null;
    for (const f of feats) {
      const t = r.answers[`${f.id}__type`], wh = r.answers[`${f.id}__wheel_hazard`].noul, sk = r.answers[`${f.id}__sinkage`].noul, sc = r.answers[`${f.id}__science`].noul;
      if (t.confidence < CONF_FLOOR) { verdicts[f.id] = { cls: "unsure", text: "UNSURE → re-image" }; reimage = f; continue; }
      if (t.choice === "shadow_only") verdicts[f.id] = { cls: "", text: "ignored (shadow)" };
      else if (t.choice === "dust_devil") verdicts[f.id] = { cls: "", text: sc > 0.6 ? "science opportunity" : "ignored" };
      else if (sk > 0.5) verdicts[f.id] = { cls: "warn", text: "KEEP-OUT (sinkage)" };
      else if (wh > 0.5) verdicts[f.id] = { cls: "warn", text: "OBSTACLE" };
      else verdicts[f.id] = { cls: "", text: "drive-over ok" };
    }
    ops.jevHazards(r, feats, verdicts);
    this.view.vision.draw(document.getElementById("navcam"), this.view.vision.lastFrame?.feats ?? feats, verdicts);
    document.getElementById("navcam-foot").textContent = `frame ${this.view.vision.seq}: ${feats.length} new feature${feats.length > 1 ? "s" : ""} → jev ${r.latencyMs} ms · ` + Object.values(verdicts).map((v) => v.text).join(" / ");
    await sleep(900);
    if (reimage) {
      ops.caption("CODE", `jev's read on ${reimage.id} is below the 0.55 floor — code stops and re-images with the mast raised rather than guess.`, 5000);
      ops.log("CODE", "Confidence gate", ops.rule(`confidence(${reimage.id}__type) = ${r.answers[`${reimage.id}__type`].confidence.toFixed(2)} < ${CONF_FLOOR}\n→ halt, mast pan, re-acquire stereo, ask again`));
      ops.now("CODE", "re-imaging: mast pan for a second stereo pair");
      this.view.waypoint(this.pos.x, this.pos.y, "halt: jev unsure → re-image", "code");
      await this.mastSweep();
      this.spend({ wh: 4, mb: 6, min: 6 });
      // second stereo pair with the mast raised: in this sim that means re-detecting without the shadow dropout
      const again = this.see(sun, { boost: true }).find((g) => Math.hypot(g.x - reimage.x, g.y - reimage.y) < 1.2 && g.kind === "rock");
      const hNow = again?.h ?? reimage.hEst ?? 0.25;
      const f2 = { ...payload.find((p) => p.id === reimage.id), h: hNow, size_words: undefined, stereo_note: `after re-imaging with the mast raised, stereo now shows solid relief, ${hNow.toFixed(2)} m above the surrounding surface` };
      this.view.vision.draw(document.getElementById("navcam"), again ? [again] : [], {});
      ops.now("JEV", `re-classifying ${reimage.id} with the new stereo pair`);
      const r2 = await post("/api/jev/hazards", { features: [f2], context: { sun: sun.words } });
      const t2 = r2.answers[`${f2.id}__type`], wh2 = r2.answers[`${f2.id}__wheel_hazard`].noul;
      ops.jevHazards(r2, [f2], { [f2.id]: wh2 > 0.5 ? { cls: "warn", text: "OBSTACLE (resolved)" } : { cls: "", text: "drive-over ok (resolved)" } });
      ops.caption("JEV", `Resolved: ${t2.choice} (conf ${t2.confidence.toFixed(2)}), wheel hazard ${wh2.toFixed(2)} — ${wh2 > 0.5 ? "added as an obstacle" : "cleared"}.`, 4500);
      if (wh2 > 0.5) { this.remember(f2, Math.max(hNow, this.world.constraints.rock_step_limit_m), "jev: hidden rock"); this.view.ring(f2.x, f2.y, 2.2, 0xea6a5a); }
      else this.remember(f2, hNow);
      this.judged.add(f2.id); this.judgedSpots.push({ x: f2.x, y: f2.y });
      await sleep(600);
    }
    for (const f of feats) {
      const v = verdicts[f.id]; if (!v) continue;
      this.judged.add(f.id); this.judgedSpots.push({ x: f.x, y: f.y });
      if (v.text.startsWith("KEEP-OUT")) { this.keepouts.push({ x: f.x, y: f.y, r: 6, label: "jev: sinkage keep-out" }); this.view.ring(f.x, f.y, 6, 0xea6a5a); if (f.kind === "sand_field") this.view.sandPatch(f.x, f.y, 6); ops.caption("JEV", `Ripple field flagged for sinkage (${r.answers[`${f.id}__sinkage`].noul.toFixed(2)}). ENav adds a 6 m keep-out; the route bends around it.`, 5500, true); }
      else if (v.text === "OBSTACLE") { this.remember(f, Math.max(f.h ?? 0, this.world.constraints.rock_step_limit_m), "jev: wheel hazard"); this.view.ring(f.x, f.y, 2, 0xea6a5a, 30000); }
      else if (v.text === "science opportunity") { await this.dustDevilScience(f); }
      else if (v.text.startsWith("ignored")) { ops.caption("JEV", `${f.id}: ${r.answers[`${f.id}__type`].choice} — no relief, not an obstacle. Geometry alone would have stopped for it.`, 4500); }
    }
    document.getElementById("navcam-wrap").classList.remove("active");
    this.view.setCamera("chase");
    this.setMode("AUTONAV");
    ops.now("CODE", "ENav: arc evaluation");
  }
  async mastSweep() {
    for (let t = 0; t < 1; ) { const dt = await this.nextFrame(); t = Math.min(1, t + dt / 1.4); this.rover.setMast(Math.sin(t * Math.PI) * 0.7); }
  }
  async dustDevilScience(f) {
    const dd = this.view.dustDevil(f.x, f.y);
    ops.caption("JEV", "Dust devil recognised on the horizon — not a hazard, but science. Code schedules the opportunistic MEDA + Navcam movie.", 6000);
    ops.log("CODE", "Opportunistic science", ops.rule(`type == dust_devil && science_interest > 0.6 && data_mb > 60\n→ schedule MEDA_dust (15 min, 8 Wh, 30 Mb)`));
    ops.now("ROVER", "MEDA + Navcam dust-devil movie");
    this.view.waypoint(this.pos.x, this.pos.y, "pause: dust devil → MEDA movie (jev)", "jev");
    const blk = this.beginBlock("MEDA_dust", "", "opportunistic");
    this.view.navcamLook = dd.mesh.position.clone().add(new (dd.mesh.position.constructor)(0, 12, 0));
    await this.mastSweep();
    this.view.navcamLook = null;
    const r = await post("/api/instrument", { target_id: "none", instrument: "MEDA_dust" });
    this.spend({ wh: 8, mb: 30, min: 15 });
    this.endBlock(blk, { wh: 8, mb: 30 });
    ops.log("ROVER", "MEDA dust-devil movie returned", r.result);
    this.history.push(`Sol ${this.sol}: dust-devil movie (MEDA/Navcam) — ${r.result}`);
  }

  // ------------------------------------------------------------ JEV -> CLAUDE: fault
  async fault(goal, solDriven, maxDist) {
    this.setMode("FAULT");
    const event = { phase: "AutoNav drive, mid-arc", description: "Wheel odometry reports 46% slip over the last 2 m; visual odometry converged; drive motor currents nominal; tilt 5.8°; suspension differential +3°.", terrain_words: "bright, fine-grained drift material between two embedded rocks; long morning shadows" };
    ops.caption("ROVER", "Telemetry flag: 46% wheel slip over the last 2 m.", 4500, true);
    ops.now("JEV", "telemetry fault triage — 3 questions");
    const r = await post("/api/jev/fault", { event });
    ops.jevFault(r, event);
    const fc = r.answers.fault_class, stop = r.answers.stop_drive.noul, ground = r.answers.needs_ground.noul;
    const stopped = stop > 0.5;
    if (stopped) { ops.log("CODE", "Onboard rule", ops.rule(`stop_drive = ${stop.toFixed(2)} > 0.50 → halt drive immediately (no Earth round-trip needed for a halt)`)); this.setMode("HALTED"); this.view.waypoint(this.pos.x, this.pos.y, `halt: ${fc.choice} (jev)`, "jev"); }
    const escalate = ground > 0.5 || fc.confidence < CONF_FLOOR;
    if (!escalate) {
      ops.log("CODE", "Onboard rule", ops.rule(`needs_ground = ${ground.toFixed(2)} ≤ 0.50 and confidence ${fc.confidence.toFixed(2)} ≥ ${CONF_FLOOR}\n→ resume at reduced speed with visual odometry every step`));
      this.speedFactor = 0.6; this.setMode("AUTONAV · VISODOM");
      return true;
    }
    ops.caption("CODE", `needs_ground ${ground.toFixed(2)} > 0.5 → escalate to the ground team (Claude). The rover waits.`, 5000);
    ops.now("CLAUDE", "anomaly response — diagnosing the slip event");
    this.view.setCamera("science");
    let a;
    try {
      a = await post("/api/claude/anomaly", { sol: this.sol, event: event.description, terrain: event.terrain_words, triage: { fault_class: fc.choice, confidence: fc.confidence.toFixed(2), stop_drive: stop.toFixed(2), needs_ground: ground.toFixed(2) }, stopped, progress_m: solDriven.toFixed(0), goal_m: Math.min(maxDist, this.dist(goal) + solDriven).toFixed(0) });
    } catch (e) { ops.log("CLAUDE", "Anomaly response unavailable", `<span style="color:var(--hot)">${e.message}</span> — onboard default: resume with visual odometry at reduced speed.`); this.speedFactor = 0.6; this.setMode("AUTONAV · VISODOM"); this.view.setCamera("chase"); return true; }
    ops.claudeAnomaly(a);
    ops.caption("CLAUDE", `${a.output.action}: ${a.output.diagnosis}`, 7000);
    await this.pause(2500);
    this.view.setCamera("chase");
    const act = a.output.action;
    this.view.waypoint(this.pos.x, this.pos.y, `ground: ${act.replace(/_/g, " ")}`, "claude");
    if (act === "stop_for_sol") return false;
    if (act === "back_up_and_reroute") { await this.backUp(3); this.keepouts.push({ x: this.pos.x + Math.cos(this.pos.heading) * 4, y: this.pos.y + Math.sin(this.pos.heading) * 4, r: 6, label: "ground: slip zone" }); }
    if (act === "reimage_and_reassess") { await this.mastSweep(); }
    this.speedFactor = act === "resume_normal" ? 1 : 0.6;
    this.setMode(this.speedFactor < 1 ? "AUTONAV · VISODOM" : "AUTONAV");
    return true;
  }
  async backUp(m) {
    const th = this.pos.heading + Math.PI;
    let d = m;
    while (d > 0) { const dt = await this.nextFrame(); const s = Math.min(d, 1.2 * dt); this.pos.x += Math.cos(th) * s; this.pos.y += Math.sin(th) * s; d -= s; this.rover.pose(this.terrain, this.pos.x, this.pos.y, this.pos.heading); this.rover.advance(-s); }
  }

  // ------------------------------------------------------------ JEV + CLAUDE: science at a planned target
  async science(t, plannedActivities, plan) {
    this.setMode("SCIENCE");
    this.view.setCamera("science");
    const sun = sunState(this.lmst);
    // Look at the target: Navcam frame -> Claude (vision) for a geologist's read; blobs -> candidates
    const seen = this.see(sun, { boost: true });
    this.view.vision.draw(document.getElementById("navcam"), seen, {});
    ops.now("CLAUDE", "reading the Navcam frame — what does the target look like?");
    ops.caption("CLAUDE", "Vision belongs to the LLM: Claude reads the actual Navcam frame and describes the target like a field geologist.", 6000);
    let visual = null;
    try {
      const d = await post("/api/claude/describe", { sol: this.sol, name: t.name, png: this.view.vision.png() });
      ops.claudeDescribe(d, this.view.vision.png());
      visual = d.output;
      ops.caption("CLAUDE", `Navcam read: ${visual.target.description}`, 7000);
    } catch (e) { ops.log("CLAUDE", "Navcam read failed", `<span style="color:var(--hot)">${e.message}</span>`); }
    const tDesc = visual ? `${t.description} Navcam read: ${visual.target.description}` : t.description;
    const nearSeen = seen.filter((f) => f.kind === "rock" && f.h != null && f.h > 0.22 && Math.hypot(f.x - t.x, f.y - t.y) > 2.5).slice(0, 2);
    const candidates = [{ id: t.id, name: t.name, description: tDesc, dist: this.dist(t) }, ...nearSeen.map((f, i) => ({ id: `seen_${i}`, name: `rock in view ${i + 1}`, description: f.appearance, dist: f.dist, x: f.x, y: f.y }))];
    const arm = this.roverWords();
    ops.now("JEV", `onboard target selection — ${candidates.length} candidates vs. the team's criteria`);
    ops.caption("JEV", `AEGIS-style: jev scores each visible candidate against Claude's criteria and picks the instrument.`, 5500);
    for (const c of candidates) if (c.id !== t.id) this.view.mark(c.x, c.y, 0x4fd18b, 1.2, 6000);
    const r = await post("/api/jev/aegis", { candidates, criteria: this.criteria, arm });
    let best = null;
    for (const c of candidates) { const m = r.answers[`${c.id}__match`]; if (!best || m.score > best.score) best = { c, score: m.score, conf: m.confidence, instrument: r.answers[`${c.id}__instrument`].choice }; }
    ops.jevAegis(r, candidates, best.c.id);
    const armSafe = r.answers.arm_deploy_safe.noul;
    let chosenT = best.c.id === t.id ? t : null;
    let acts = plannedActivities.slice();
    if (!chosenT || best.score < 1.5) {
      ops.log("CODE", "Selection rule", ops.rule(`best match = ${best.c.name} (${best.score.toFixed(2)}/3)${best.c.id !== t.id ? " ≠ planned target" : ""}\n→ ${best.score < 1.5 ? "score < 1.5: fall back to the planned target and activities" : "planned target wins ties; onboard pick logged for the science team"}`));
      chosenT = t;
    } else if (best.instrument !== "skip" && !acts.includes(best.instrument)) {
      ops.log("CODE", "Selection rule", ops.rule(`jev instrument ${best.instrument} not in plan [${acts.join(", ")}]\n→ plan wins; onboard suggestion appended if budget allows`));
      acts.push(best.instrument);
    }
    if (acts.some((a) => !REMOTE.has(a)) && armSafe < 0.6) {
      ops.log("CODE", "Arm rule", ops.rule(`arm_deploy_safe = ${armSafe.toFixed(2)} < 0.60 → drop arm activities this sol`));
      ops.caption("CODE", "Arm deploy not cleared — contact science deferred.", 4500, true);
      for (const a of acts.filter((a) => !REMOTE.has(a))) this.dropBlock(a, t.name, "arm not cleared");
      acts = acts.filter((a) => REMOTE.has(a));
    }
    ops.caption("JEV", `Selected ${best.c.name}: match ${best.score.toFixed(1)}/3 → ${best.instrument}`, 4500);
    await sleep(800);
    acts = [...acts.filter((a) => REMOTE.has(a)), ...acts.filter((a) => !REMOTE.has(a))];
    let interpreted = 0, followups = 0;
    for (let i = 0; i < acts.length; i++) {
      await this.maybeObjective();
      const a = acts[i];
      const ok = await this.activity(chosenT, a);
      if (!ok) break;
      const isRemote = REMOTE.has(a);
      if ((isRemote && interpreted === 0) || a === "abrade" || a === "PIXL_map" || a === "core") {
        const resp = await this.interpret(chosenT, a, best);
        interpreted++;
        const na = resp.output.next_action;
        if (followups < 2 && !acts.slice(i + 1).length) {
          const add = na === "abrade" ? "abrade" : na === "core" ? "core" : na === "add_contact_science" ? "WATSON_closeup" : null;
          if (add && !(this.done[chosenT.id] ?? []).includes(add)) { acts.push(add); followups++; ops.log("CODE", "Plan amendment", ops.rule(`Claude next_action = ${na} → append ${add} (follow-up ${followups}/2, budget permitting)`)); const ins = this.world.instruments[add]; this.addBlock({ lane: LANE_OF[add], key: add, target: chosenT.name, label: `${SHORT[add]} · ${chosenT.name}`, short: SHORT[add], start: this.lmst, dur: ins.minutes, wh: ins.wh, mb: ins.mb, tag: "plan" }); }
        }
      }
    }
    this.view.setCamera("chase");
  }
  async activity(t, key, tag) {
    const ins = this.world.instruments[key];
    if (!ins) return true;
    const need = ins.wh * (1 + ENERGY_MARGIN);
    if (this.energy < need || this.data < ins.mb || this.lmst + ins.minutes > 19 * 60) {
      ops.log("CODE", "Scheduler", ops.rule(`${key}: needs ${ins.wh} Wh / ${ins.mb} Mb / ${ins.minutes} min; have ${Math.round(this.energy)} Wh / ${Math.round(this.data)} Mb / until 19:00\n→ dropped (onboard scheduler keeps the margin)`));
      ops.caption("CODE", `${ins.name} dropped by the scheduler: resource margin.`, 4500, true);
      this.dropBlock(key, t.name, "scheduler: margin");
      return false;
    }
    ops.now("ROVER", `${ins.name} on ${t.name}`);
    ops.caption("ROVER", `${ins.name} on ${t.name} (${ins.minutes} min, ${ins.wh} Wh, ${ins.mb} Mb).`, 4000);
    const blk = this.beginBlock(key, t.name, tag);
    if (ins.arm) { await this.armAnim(1); await sleep(1400); await this.armAnim(0); }
    else { await this.mastSweep(); }
    this.spend({ wh: ins.wh, mb: ins.mb, min: ins.minutes });
    this.endBlock(blk, { wh: ins.wh, mb: ins.mb });
    this.rescheduleRemaining();
    this.done[t.id] = [...(this.done[t.id] ?? []), key];
    ops.log("ROVER", `${ins.name} complete`, `${t.name} · LMST now ${hhmm(this.lmst)}`);
    return true;
  }
  async armAnim(to) {
    const from = this.rover.state.armDeploy;
    for (let t = 0; t < 1; ) { const dt = await this.nextFrame(); t = Math.min(1, t + dt / 1.6); this.rover.setArm(from + (to - from) * (0.5 - 0.5 * Math.cos(t * Math.PI))); }
  }
  async interpret(t, instrument, best) {
    ops.now("CLAUDE", `interpreting ${instrument} data from ${t.name}`);
    ops.caption("CLAUDE", `Data down. The science team (Claude) reads the ${this.world.instruments[instrument].name} result against the hypotheses.`, 5500);
    const prior = this.history.filter((h) => h.includes(t.name));
    let r;
    try {
      r = await post("/api/claude/interpret", { sol: this.sol, target: { id: t.id, name: t.name, description: t.description }, instrument, criteria: this.criteria, match_words: best && best.c.id === t.id ? `${best.score.toFixed(1)} of 3 (confidence ${best.conf.toFixed(2)})` : "n/a", prior, range_m: this.dist(t).toFixed(1), energy_wh: Math.round(this.energy), data_mb: Math.round(this.data), minutes: Math.max(0, Math.round(19 * 60 - this.lmst)), arm_available: this.dist(t) <= 3 });
    } catch (e) {
      // Ground link hiccup: the rover keeps the plan it has. Never let a failed call end the sol.
      ops.log("CLAUDE", "Interpretation unavailable", `<span style="color:var(--hot)">${e.message}</span><div style="font-size:11px;color:var(--ink3);margin-top:4px">Code falls back to continue_plan; the data are kept for the next downlink.</div>`);
      ops.caption("CODE", "Ground interpretation unavailable this pass — continuing the uplinked plan.", 4500, true);
      return { output: { interpretation: "unavailable", lithology_call: "pending", confidence: "low", hypothesis_impact: "pending", next_action: "continue_plan", updated_science_criteria: "", rationale: "ground link" } };
    }
    ops.claudeInterpret(r, t, instrument);
    ops.caption("CLAUDE", `${r.output.lithology_call} (${r.output.confidence}) → ${r.output.next_action}`, 6500);
    this.criteria = r.output.updated_science_criteria || this.criteria;
    this.history.push(`Sol ${this.sol}: ${instrument} on ${t.name} → ${r.output.lithology_call} (${r.output.confidence}); ${r.output.hypothesis_impact}`);
    await this.pause(2500);
    return r;
  }

  // ------------------------------------------------------------ USER -> CLAUDE -> JEV -> CODE -> CLAUDE: objectives
  injectObjective(pick, text) {
    this.pendingObjective = { pick, text, at: Date.now() };
    ops.userObjective(text, pick);
    ops.caption("USER", `New science objective received: “${text}”`, 6000);
    this.view.ring(pick.x, pick.y, 2.4, 0xff8fb1);
    this.view.waypoint(pick.x, pick.y, "objective target (user)", "user");
    this.hud();
  }
  async maybeObjective() {
    if (!this.pendingObjective) return;
    const o = this.pendingObjective; this.pendingObjective = null;
    await this.objectiveFlow(o);
  }
  async objectiveFlow(o) {
    const { pick, text } = o;
    const target = { id: pick.id, name: pick.name ?? "picked rock", description: pick.description, x: pick.x, y: pick.y, approach: 2.9 };
    this.setMode("OBJECTIVE");
    this.view.setCamera("overview");
    ops.now("CLAUDE", "assessing the new objective against the sol envelope");
    ops.caption("CLAUDE", "The science team (Claude) weighs the objective: worth it? which instruments? what does it displace?", 6000);
    const remaining = this.timeline.filter((b) => b.status === "planned").map((b) => `${b.label} (${b.wh} Wh, ${Math.round(b.dur)} min)`);
    let r;
    try {
      r = await post("/api/claude/objective", { sol: this.sol, lmst: hhmm(this.lmst), objective: text, target: { description: target.description, dist: this.dist(target), bearing: (deg(this.bearingTo(target)) + 360) % 360 }, rover_words: Object.values(this.roverWords()).join("; "), energy_wh: Math.round(this.energy), data_mb: Math.round(this.data), minutes: Math.max(0, Math.round(19 * 60 - this.lmst)), remaining_plan: remaining, history: this.history });
    } catch (e) { ops.log("CLAUDE", "Objective assessment unavailable", `<span style="color:var(--hot)">${e.message}</span>`); this.setMode("AUTONAV"); return; }
    ops.claudeObjective(r);
    ops.caption("CLAUDE", `${r.output.worth_it.toUpperCase()}: ${r.output.assessment}`, 7000);
    const objRec = { text, pick, plan: r.output, results: [], dropped: [], spent0: { wh: this.energy, mb: this.data, min: this.lmst } };
    this.objectives.push(objRec);
    if (r.output.worth_it === "no") { ops.log("CODE", "Objective declined", "Claude judged it not worth the resources; nothing scheduled."); this.setMode("AUTONAV"); return; }
    const acts = r.output.activities.filter((a) => this.world.instruments[a.instrument]);
    ops.now("JEV", `verifying ${acts.length} planned activities — ${acts.length * 3} questions, 1 request`);
    ops.caption("JEV", "Before anything is scheduled, jev checks every step: serves the objective? prerequisites met? risk acceptable?", 6000);
    const vr = await post("/api/jev/verify", { plan: { objective: text, target: target.description, rover_words: Object.values(this.roverWords()).join("; "), activities: acts.map((a) => ({ name: this.world.instruments[a.instrument].name, measures: MEASURES[a.instrument], purpose: a.purpose, arm: this.world.instruments[a.instrument].arm })) } });
    const gates = acts.map((a, i) => {
      const s = vr.answers[`a${i}__serves_objective`].noul, p = vr.answers[`a${i}__prerequisites_met`].noul, k = vr.answers[`a${i}__risk_acceptable`].noul;
      const ok = s >= VERIFY_FLOOR && p >= VERIFY_FLOOR && k >= VERIFY_FLOOR;
      return { i, a, serves: s, prereq: p, risk: k, ok, why: !ok ? (s < VERIFY_FLOOR ? "does not serve the objective" : p < VERIFY_FLOOR ? "prerequisite not met" : "risk not acceptable now") : "" };
    });
    ops.jevVerify(vr, acts.map((a) => this.world.instruments[a.instrument].name), gates);
    ops.log("CODE", "Verification rule", ops.rule(`each activity needs serves ≥ ${VERIFY_FLOOR} && prerequisites ≥ ${VERIFY_FLOOR} && risk ≥ ${VERIFY_FLOOR}\n→ ${gates.filter((g) => g.ok).length} of ${gates.length} committed to the timeline; the rest are dropped and reported`));
    for (const g of gates.filter((g) => !g.ok)) objRec.dropped.push(`${this.world.instruments[g.a.instrument].name}: ${g.why} (${g.serves.toFixed(2)}/${g.prereq.toFixed(2)}/${g.risk.toFixed(2)})`);
    const items = [];
    if (r.output.approach_required && this.dist(target) > 3) items.push({ key: "drive", target: target.name, dur: this.dist(target) * MIN_PER_M, wh: Math.round(this.dist(target) * WH_PER_M), mb: 0 });
    for (const g of gates) { const ins = this.world.instruments[g.a.instrument]; items.push({ key: g.a.instrument, target: target.name, dur: Math.max(ins.minutes, 8), wh: ins.wh, mb: ins.mb, verify: { serves: g.serves, prereq: g.prereq, risk: g.risk } }); }
    this.planBlocks(items, "objective");
    for (const g of gates.filter((g) => !g.ok)) this.dropBlock(g.a.instrument, target.name, `jev: ${g.why}`);
    this.rescheduleRemaining();
    await this.pause(2500);
    const committed = gates.filter((g) => g.ok);
    if (committed.length === 0) { ops.caption("CODE", "Nothing survived verification; objective reported as not executed.", 5000, true); }
    else {
      if (this.dist(target) > 3 && (r.output.approach_required || committed.some((g) => this.world.instruments[g.a.instrument].arm))) {
        const arrived = await this.drive(target, 80, "approach drive to the picked rock; park inside arm reach", { tag: "objective", isObjective: true, quiet: true });
        if (!arrived) { objRec.dropped.push(`approach drive did not reach the rock (${this.driveEndReason})`); ops.log("CODE", "Approach ended short", `${this.driveEndReason} — ${this.dist(target).toFixed(1)} m from the rock. Remote instruments still run from here; arm activities are dropped.`); }
      }
      this.setMode("OBJECTIVE · SCIENCE");
      this.view.setCamera("science");
      const ordered = [...committed.filter((g) => REMOTE.has(g.a.instrument)), ...committed.filter((g) => !REMOTE.has(g.a.instrument))];
      for (const g of ordered) {
        const ins = this.world.instruments[g.a.instrument];
        if (ins.arm && this.dist(target) > 3) { objRec.dropped.push(`${ins.name}: target out of arm reach`); this.dropBlock(g.a.instrument, target.name, "out of reach"); continue; }
        const ok = await this.activity(target, g.a.instrument, "objective");
        if (!ok) { objRec.dropped.push(`${ins.name}: scheduler margin`); continue; }
        const res = await post("/api/instrument", { target_id: target.id, instrument: g.a.instrument, pick: { description: target.description } });
        objRec.results.push({ instrument: ins.name, result: res.result });
        ops.log("ROVER", `${ins.name} data`, `<div style="font-size:11.5px;color:var(--ink2);border-left:2px solid var(--line2);padding-left:8px">${res.result}</div>`);
      }
    }
    ops.now("CLAUDE", "writing the objective report");
    ops.caption("CLAUDE", "Data in hand — the science team (Claude) writes the report for the requester.", 5000);
    const spent = `${Math.round(objRec.spent0.wh - this.energy)} Wh, ${Math.round(objRec.spent0.mb - this.data)} Mb, ${Math.round(this.lmst - objRec.spent0.min)} min`;
    let rep;
    try {
      rep = await post("/api/claude/report", { sol: this.sol, objective: text, target: { description: target.description }, expected_evidence: r.output.expected_evidence, results: objRec.results, dropped: objRec.dropped, spent });
    } catch (e) { ops.log("CLAUDE", "Report unavailable", `<span style="color:var(--hot)">${e.message}</span>`); this.view.setCamera("chase"); this.setMode("AUTONAV"); return; }
    ops.claudeReport(rep, text);
    ops.caption("CLAUDE", `REPORT — ${rep.output.answer.toUpperCase()} (${rep.output.confidence}): ${rep.output.headline}`, 9000);
    this.history.push(`Sol ${this.sol}: user objective "${text.slice(0, 60)}…" → ${rep.output.answer} (${rep.output.confidence}): ${rep.output.headline}`);
    await this.pause(4000);
    this.view.setCamera("chase");
    this.setMode("AUTONAV");
  }

  // ------------------------------------------------------------ downlink
  async downlink() {
    this.setMode("DOWNLINK");
    const blk = this.beginBlock("comm", "");
    ops.now("ROVER", "relay pass — downlink to Earth via MRO");
    ops.caption("ROVER", `Sol ${this.sol} ends: ${Math.round(this.world.constraints.data_mb - this.data)} Mb downlinked, ${Math.round(this.world.constraints.energy_wh - this.energy)} Wh used, ${this.solOdo.toFixed(0)} m driven.`, 5000);
    ops.log("ROVER", `Sol ${this.sol} downlink`, `Used ${Math.round(this.world.constraints.energy_wh - this.energy)} Wh · ${Math.round(this.world.constraints.data_mb - this.data)} Mb · LMST ${hhmm(this.lmst)}. Position ${this.pos.x.toFixed(0)} E, ${this.pos.y.toFixed(0)} N.`);
    this.spend({ wh: 15, min: 30 });
    this.endBlock(blk, { wh: 15 });
    for (const b of this.timeline) if (b.status === "planned") { b.status = "dropped"; b.reason = "not reached this sol"; }
    this.hud();
    await this.pause(2000);
  }
}

const MEASURES = {
  MastcamZ_multispectral: "visible/near-infrared colour and mineral absorption bands from a distance",
  SuperCam_LIBS: "elemental chemistry of a spot by laser plasma, from up to seven metres",
  RIMFAX: "subsurface radar reflectors along the drive",
  MEDA_dust: "wind, pressure and dust while imaging the sky",
  WATSON_closeup: "millimetre-scale texture and grain imaging with the arm",
  PIXL_map: "micro-scale elemental maps with the arm over hours",
  abrade: "a fresh, dust-free surface for the other arm instruments",
  core: "a sealed rock core for return to Earth",
};
