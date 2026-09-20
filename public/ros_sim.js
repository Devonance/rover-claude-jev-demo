import * as THREE from "three";
// The browser as a ROS 2 simulator. Nothing here decides anything: it moves the rover
// when /rover/cmd says so, renders the Navcam when /navcam/trigger says so, streams
// the rover's state and the local terrain model, and draws
// whatever the executive publishes on /ops/* and /sim/view. rosbridge on ws://localhost:9090.
import { ops } from "./ops.js";
import "./ops_extra.js";
import { renderSwimlane } from "./swimlane.js";
import { MindStrip } from "./mind.js";
import { GROUP_COLOR } from "./cameras.js";

const SPEED = 2.4;
const HM_HALF = 50, HM_RES = 1.0;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const hex = (c) => (typeof c === "string" && c.startsWith("#") ? parseInt(c.slice(1), 16) : c || 0xffffff);
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const pairs = (flat) => { const o = []; for (let i = 0; i + 1 < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };

export class RosSim {
  constructor(view, vision, url = "ws://localhost:9090", rig = null) {
    this.view = view; this.vision = vision; this.rig = rig; this.terrain = view.terrain; this.rover = view.rover; this.tGrid = 0; this.camStatus = {};
    this.url = url; this.frameResolvers = []; this.queue = Promise.resolve();
    this.odo = 0; this.speedFactor = 1; this.timeline = []; this.hud = null; this.world = null; this.lastFeats = [];
    this.tState = 0; this.tHm = 0; this.tReady = 0; this.ready = false; this.gotHud = false; this.connected = false;
    this.stats = { msgsIn: 0, msgsOut: 0, nodes: [], topics: 0 };
    this.mind = new MindStrip(document.getElementById("mind")); this.tMind = 0; this.tTel = 0; this.phase = "parked"; this.slipCmd = 0; this.excursions = [];
    this.connect();
  }
  // ------------------------------------------------------------ plumbing
  update(dt) { const rs = this.frameResolvers; this.frameResolvers = []; for (const r of rs) r(dt); this.tState += dt; this.tHm += dt; this.tReady += dt; this.tGrid += dt; this.tCov = (this.tCov ?? 0) + dt;
    if (this.rig && this.tGrid >= 0.5) { this.tGrid = 0; this.rig.refreshAll(); this.rig.draw(document.getElementById("camgrid")); }
    // coverage: re-aim every camera's depth frame and repaint the ground the rig can see.
    // Depth-only, no readback, so this is cheap enough to run several times a second.
    if (this.rig && this.view.coverage && this.tCov >= 0.25) {
      this.tCov = 0;
      for (const c of this.rig.cams) c.vision.captureDepth();
      this.view.coverage.update(this.rig.cams, this.rover.state);
      this.view.coverage.sync();
    }
    this.tMind += dt; if (this.tMind >= 0.1) { this.tMind = 0; this.mind.draw(); }
    if (this.connected) {
      if (this.tState >= 0.1) { this.tState = 0; this.publishState(); }
      if (this.tHm >= 1.0) { this.tHm = 0; this.publishHeightmap(); }
      this.tTel += dt; if (this.tTel >= 1.0) { this.tTel = 0; this.publishTelemetry(); }
      if (!this.gotHud && this.tReady >= 2.0 && this.ready) { this.tReady = 0; this.pReady.publish(new ROSLIB.Message({ data: "browser simulator ready" })); }
    } }
  nextFrame() { return new Promise((r) => this.frameResolvers.push(r)); }
  status(text, ok) { const el = document.getElementById("ros-status"); if (el) { el.textContent = text; el.classList.toggle("ok", !!ok); } }

  connect() {
    const ros = new ROSLIB.Ros({ url: this.url });
    this.ros = ros;
    const T = (name, messageType, opts = {}) => new ROSLIB.Topic({ ros, name, messageType, ...opts });
    // publishers
    this.pState = T("/rover/state", "jezero_msgs/msg/RoverState");
    this.pHm = T("/sim/heightmap", "jezero_msgs/msg/HeightMap");
    this.pCloud = T("/navcam/points", "sensor_msgs/msg/PointCloud2");
    this.pImg = T("/navcam/image/compressed", "sensor_msgs/msg/CompressedImage");
    this.pDone = T("/rover/cmd_done", "jezero_msgs/msg/CmdDone");
    this.pObj = T("/ops/user_objective", "jezero_msgs/msg/UserObjective");
    this.pReady = T("/sim/ready", "std_msgs/msg/String");
    this.pTel = T("/rover/telemetry", "jezero_msgs/msg/Telemetry");
    // subscribers
    T("/rover/cmd", "jezero_msgs/msg/RoverCmd").subscribe((m) => this.onCmd(m));
    T("/navcam/trigger", "jezero_msgs/msg/CaptureRequest").subscribe((m) => this.onTrigger(m));
    T("/sim/view", "jezero_msgs/msg/ViewCmd").subscribe((m) => this.onView(m));
    T("/ops/decisions", "jezero_msgs/msg/Decision").subscribe((m) => this.onDecision(m));
    T("/ops/hud", "jezero_msgs/msg/Hud").subscribe((m) => this.onHud(m));
    T("/ops/timeline", "jezero_msgs/msg/Timeline").subscribe((m) => this.onTimeline(m));
    T("/perception/features", "jezero_msgs/msg/FeatureArray").subscribe((m) => this.onFeatures(m));
    T("/ops/world", "std_msgs/msg/String").subscribe((m) => this.onWorld(JSON.parse(m.data)));
    T("/nav/costmap", "jezero_msgs/msg/CostMap").subscribe((m) => this.onCostmap(m));
    T("/health/verdict", "jezero_msgs/msg/HealthVerdict").subscribe((m) => this.onHealth(m));
    T("/ops/tree", "jezero_msgs/msg/TreeState").subscribe((m) => this.onTree(m));
    T("/ops/downlink", "jezero_msgs/msg/DownlinkQueue").subscribe((m) => this.onDownlink(m));
    ros.on("connection", () => { this.connected = true; this.status(`rosbridge ${this.url} · connected`, true); ops.log("CODE", "ROS 2 bridge connected", `rosbridge_websocket at <b>${this.url}</b>. The browser is now only the simulator: motion, rendering, HUD. Decisions arrive on <span style="font-family:var(--mono)">/ops/decisions</span>.`); this.pollGraph(); });
    ros.on("error", (e) => this.status(`rosbridge ${this.url} · error`, false));
    ros.on("close", () => { this.connected = false; this.status(`rosbridge ${this.url} · disconnected, retrying`, false); setTimeout(() => this.connect(), 2000); });
  }
  pollGraph() {
    const nodes = new ROSLIB.Service({ ros: this.ros, name: "/rosapi/nodes", serviceType: "rosapi_msgs/srv/Nodes" });
    const topics = new ROSLIB.Service({ ros: this.ros, name: "/rosapi/topics", serviceType: "rosapi_msgs/srv/Topics" });
    const tick = () => {
      if (!this.connected) return;
      nodes.callService(new ROSLIB.ServiceRequest({}), (r) => { this.stats.nodes = r.nodes.filter((n) => !n.includes("rosapi") && !n.includes("transform_listener")); this.renderGraph(); }, () => {});
      topics.callService(new ROSLIB.ServiceRequest({}), (r) => { this.stats.topics = r.topics.length; this.renderGraph(); }, () => {});
      setTimeout(tick, 5000);
    };
    tick();
  }
  renderGraph() {
    const el = document.getElementById("ros-graph"); if (!el) return;
    el.innerHTML = `<b>ROS 2 graph</b> · ${this.stats.nodes.length} nodes · ${this.stats.topics} topics · ↓${this.stats.msgsIn} ↑${this.stats.msgsOut} msgs<div class="nodes">${this.stats.nodes.map((n) => `<span>${n}</span>`).join("")}</div>`;
  }

  // ------------------------------------------------------------ world / HUD / console
  onWorld(w) {
    if (this.world) return;
    this.world = w;
    for (const t of w.targets) this.view.addTarget(t);
    this.rover.pose(this.terrain, w.rover_start.x, w.rover_start.y, (w.rover_start.heading_deg * Math.PI) / 180);
    this.view.setSun(8 * 60);
    ops.log("CODE", "World received on /ops/world", `${w.targets.length} targets, ${w.events.length} scripted events · jev <b>${w.models.jev}</b> · llm <b>${w.models.llm}</b>`);
    this.ready = true;
    this.pReady.publish(new ROSLIB.Message({ data: "browser simulator ready" }));
  }
  onHud(m) {
    this.stats.msgsIn++; this.gotHud = true;
    this.hud = { sol: m.sol || "—", lmst: m.lmst, energy: m.energy, energyMax: m.energy_max, data: m.data, dataMax: m.data_max, odo: m.odometer, tilt: this.rover.tiltDeg(), mode: m.mode };
    this.phase = /AUTONAV|VISODOM/.test(m.mode) ? "driving" : /HALTED|FAULT/.test(m.mode) ? "halted" : /SCIENCE|OBJECTIVE/.test(m.mode) ? "science" : /DOWNLINK/.test(m.mode) ? "comm" : "parked";
    ops.hud(this.hud); this.view.setSun(m.lmst); renderSwimlane(this.timeline, this.hud);
    const slip = document.getElementById("hud-slip"), jv = document.getElementById("hud-jev");
    if (slip) slip.textContent = m.ground_class ? `${m.slip_pct.toFixed(0)}% · ${m.ground_class.replace("_", " ")}` : "—";
    if (jv) jv.textContent = `${m.jev_calls} · ${m.jev_in_claude} (${m.jev_calls ? Math.round((100 * m.jev_in_claude) / m.jev_calls) : 0}%)`;
  }
  onCostmap(m) {
    this.stats.msgsIn++;
    const data = Uint8Array.from(atob(m.cost), (ch) => ch.charCodeAt(0));
    this.view.costmap({ ox: m.origin_x, oy: m.origin_y, res: m.resolution, w: m.width, h: m.height, data });
  }
  onTimeline(m) {
    this.stats.msgsIn++;
    this.timeline = m.blocks.map((b) => ({ id: b.id, lane: b.lane, key: b.key, target: b.target, label: b.label, short: b.short_label, start: b.start, dur: b.dur, end: b.has_end ? b.end : undefined, wh: b.wh, mb: b.mb, status: b.status, tag: b.tag, reason: b.reason, verify: b.has_verify ? { serves: b.verify[0], prereq: b.verify[1], risk: b.verify[2] } : undefined }));
    if (this.hud) renderSwimlane(this.timeline, this.hud);
  }
  onFeatures(m) {
    this.stats.msgsIn++;
    const feats = m.features.map((f) => ({ ...f, h: f.h_known ? f.h : null, box: f.box.some((v) => v) ? f.box : null }));
    const group = m.group || "navcam";
    if (group === "navcam") { this.lastFeats = feats; this.vision.draw(document.getElementById("navcam"), feats, {}); }
    if (this.rig) { this.rig.setFeatures(group, feats, {}); this.rig.draw(document.getElementById("camgrid")); }
    document.getElementById("navcam-foot").textContent = `${group.replace("_", " ")} frame ${m.seq}: ${feats.length} feature${feats.length === 1 ? "" : "s"} measured by perception_node`;
  }
  setCamStatus(group, text) {
    this.camStatus[group] = text;
    const el = document.getElementById("cam-status");
    if (el) el.textContent = ["navcam", "front_hazcam", "rear_hazcam"].filter((g) => this.camStatus[g]).map((g) => this.camStatus[g]).join(" | ");
  }
  onDecision(m) {
    this.stats.msgsIn++;
    const p = m.payload_json ? JSON.parse(m.payload_json) : {};
    const meta = m.meta || undefined;
    try {
      switch (m.kind) {
        case "log": ops.log(m.engine, m.title, p.body, meta); break;
        case "sol": ops.sol(p.sol, p.text); break;
        case "claude_plan": ops.consults(ops.claudePlan(p), p.consults); break;
        case "claude_interpret": ops.consults(ops.claudeInterpret(p.r, p.target, p.instrument), p.r.consults); break;
        case "claude_anomaly": ops.consults(ops.claudeAnomaly(p), p.consults); break;
        case "claude_describe": ops.claudeDescribe(p.r, this.vision.png()); break;
        case "claude_objective": ops.consults(ops.claudeObjective(p), p.consults); break;
        case "claude_report": ops.consults(ops.claudeReport(p.r, p.objective), p.r.consults); break;
        case "jev_hazards": ops.jevHazards(p.r, p.features, p.verdicts, m.title); break;
        case "jev_aegis": ops.jevAegis(p.r, p.candidates, p.chosenId); break;
        case "jev_fault": ops.jevFault(p.r, p.event); break;
        case "jev_verify": ops.jevVerify(p.r, p.names, p.gates); break;
        case "enav": { const arcs = p.arcs.map((a) => ({ ...a, blocked: a.blocked || null })); ops.enav({ arcs, chosen: p.chosen >= 0 ? arcs[p.chosen] : null }, p.note); break; }
        case "vision_frame": ops.visionFrame(this.vision, p.feats); break;
        case "user_objective": ops.userObjective(p.text, p.pick); break;
        case "health": ops.health(p); break;
        case "jev_sample": ops.jevSample(p); break;
        case "jev_placement": ops.jevPlacement(p); break;
        case "jev_contact": ops.jevContact(p); break;
        case "jev_downlink": ops.jevDownlink(p); break;
        default: ops.log(m.engine, m.title, `<pre style="white-space:pre-wrap">${m.payload_json.slice(0, 600)}</pre>`, meta);
      }
    } catch (e) { console.error("decision render", m.kind, e); ops.log(m.engine, m.title, `<span style="color:var(--hot)">render error: ${e.message}</span>`, meta); }
  }
  onView(m) {
    this.stats.msgsIn++;
    const v = this.view, pts = pairs(m.points);
    switch (m.kind) {
      case "camera": v.setCamera(m.text); break;
      case "mark": v.mark(m.x, m.y, hex(m.color), m.r || 1.2, m.ttl_ms || 5000); break;
      case "spots": this.showSpots(JSON.parse(m.json || "[]"), m.ttl_ms || 20000); break;
      case "ring": v.ring(m.x, m.y, m.r, hex(m.color), m.ttl_ms || 0); break;
      case "sand": v.sandPatch(m.x, m.y, m.r); break;
      case "dust_devil": this.dd = v.dustDevil(m.x, m.y); break;
      case "waypoint": v.waypoint(m.x, m.y, m.text, m.engine); break;
      case "planned": m.flag ? v.planned(this.rover.state, { x: m.x, y: m.y }) : v.planned(null); break;
      case "future": v.future(pts.length ? pts : null); break;
      case "arc": v.arc(pts.length ? pts : null); break;
      case "highlight": v.highlightGoal(m.text); break;
      case "navcam_active": document.getElementById("navcam-wrap").classList.toggle("active", m.flag); break;
      case "navcam_draw": { const j = JSON.parse(m.json || "{}"); const feats = (j.feats || []).map((f) => ({ ...f, box: f.box || null })); const grp = j.group || "navcam";
        if (grp === "navcam") this.vision.draw(document.getElementById("navcam"), feats, j.verdicts || {});
        if (this.rig) { this.rig.setFeatures(grp, feats, j.verdicts || {}); this.rig.draw(document.getElementById("camgrid")); } break; }
      case "navcam_foot": document.getElementById("navcam-foot").textContent = m.text; break;
      case "cam_status": this.setCamStatus(m.engine || "navcam", m.text); break;
      case "mind_fb": { const j = JSON.parse(m.json || "{}"); this.mind.claudeFeedback(j); break; }
      case "mind": { const j = JSON.parse(m.json || "{}");
        if (m.engine === "CLAUDE") m.text === "start" ? this.mind.claudeStart(j.label) : this.mind.claudeEnd(j.label, j.consults || [], j.ms || 0);
        else m.text === "start" ? this.mind.jevStart(j.label) : this.mind.jevEnd(j.label); break; }
      case "caption": ops.caption(m.engine, m.text, m.ttl_ms || 4200, m.flag); break;
      case "now": ops.now(m.engine, m.text); break;
      case "done": document.body.dataset.done = "1"; break;
    }
  }

  // ------------------------------------------------------------ engineering telemetry (1 Hz)
  // Housekeeping the way a real rover streams it. Scripted excursions are keyed to the odometer so the
  // health monitor (jev) has something real to catch: the slip event at 165 m, a motor-current
  // excursion at 230 m, dusty air after 300 m.
  publishTelemetry() {
    const st = this.rover.state, odo = this.odo, drv = this.phase === "driving" || this.phase === "halted"; // a halted rover still reports the last drive's slip and its wheel currents
    const slipEvent = odo > 165 && odo < 172, dusty = odo > 300;
    if (slipEvent && !this.slipT0) this.slipT0 = performance.now();
    // 14 s into the slip halt the picture worsens (a wheel against a rock): the health monitor's class changes
    // while the ground is still reasoning, and the executive cancels and re-issues the anomaly action.
    const currentEvent = (this.slipT0 && slipEvent && performance.now() - this.slipT0 > 14000) || (odo > 230 && odo < 236);
    const m = {
      header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "rover" },
      battery_soc_pct: Math.max(20, 100 - odo * 0.12 - (this.hud ? (this.hud.energyMax - this.hud.energy) / this.hud.energyMax * 40 : 0)),
      battery_temp_c: 12 + (dusty ? 6 : 0) + Math.sin(odo / 50) * 3,
      motor_current_max_a: drv ? (currentEvent ? 4.9 : 1.6 + Math.random() * 0.4) : 0.2,
      motor_current_actuator: currentEvent ? "right-middle" : "left-front",
      wheel_slip_pct: drv ? (slipEvent ? 46 : this.terrain.inSand(st.x, st.y) ? 28 : 4 + Math.random() * 3) : 0,
      vo_converged: !(drv && slipEvent), // at ~45 % slip visual odometry does not converge (Curiosity sol 672-style)
      tilt_deg: this.rover.tiltDeg(), suspension_diff_deg: slipEvent ? 3.2 : 0.8, dust_opacity_tau: dusty ? 1.1 : 0.5, phase: this.phase,
    };
    this.stats.msgsOut++; this.pTel.publish(new ROSLIB.Message(m));
    const el = document.getElementById("tel-line");
    if (el) el.textContent = `SOC ${m.battery_soc_pct.toFixed(0)}% · batt ${m.battery_temp_c.toFixed(0)}°C · I max ${m.motor_current_max_a.toFixed(1)} A (${m.motor_current_actuator}) · slip ${m.wheel_slip_pct.toFixed(0)}% · VO ${m.vo_converged ? "ok" : "FAIL"} · τ ${m.dust_opacity_tau.toFixed(1)} · ${m.phase}`;
  }
  onHealth(m) {
    this.stats.msgsIn++;
    const el = document.getElementById("health"); if (!el) return;
    const bad = m.stop_drive > 0.5 || m.needs_ground > 0.5;
    el.className = "panel health " + (bad ? "bad" : m.fault_class !== "nominal" ? "warn" : "ok");
    el.innerHTML = `<div class="ph"><b>ROVER HEALTH</b> <span>jev · continuous · ${m.latency_ms.toFixed(0)} ms</span></div>
      <div class="hv"><span class="k">class</span><b>${m.fault_class}</b> <i>conf ${m.confidence.toFixed(2)}</i></div>
      <div class="hv"><span class="k">stop drive</span><span class="bar"><i style="width:${m.stop_drive * 100}%"></i></span><b>${m.stop_drive.toFixed(2)}</b></div>
      <div class="hv"><span class="k">needs ground</span><span class="bar"><i style="width:${m.needs_ground * 100}%"></i></span><b>${m.needs_ground.toFixed(2)}</b></div>
      <div class="hw">${m.summary_words}</div><div id="tel-line" class="hw"></div>`;
  }
  onTree(m) {
    this.stats.msgsIn++;
    const el = document.getElementById("tree"); if (!el) return;
    el.className = "panel tree " + (m.safety_halt ? "bad" : "");
    el.innerHTML = `<div class="ph"><b>SOL EXECUTIVE · behaviour tree</b> <span>${m.status}${m.safety_halt ? " · SAFETY HALT: " + m.halt_reason : ""}</span></div><pre>${m.ascii}</pre><div class="hw">active: ${m.active_path}</div>`;
  }
  onDownlink(m) {
    this.stats.msgsIn++;
    const el = document.getElementById("downlink"); if (!el) return;
    const rows = m.products.map((p) => `<div class="dl ${p.sent ? "sent" : ""}"><span class="pr">${p.priority}</span><span class="nm">${p.instrument} · ${p.target}</span><span class="mb">${p.mb.toFixed(0)} Mb</span><span class="sc">jev ${p.science_score.toFixed(2)}/3</span><span class="why">${p.rationale}</span></div>`).join("");
    el.innerHTML = `<div class="ph"><b>DOWNLINK QUEUE · sol ${m.sol}</b> <span>${m.queued_mb.toFixed(0)} of ${m.budget_mb.toFixed(0)} Mb this pass · ordered by jev's science score, filled by code</span></div>${rows}`;
    el.classList.add("on");
  }
  // ------------------------------------------------------------ sensors out
  publishState() {
    const st = this.rover.state;
    this.stats.msgsOut++;
    this.pState.publish(new ROSLIB.Message({ header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "map" }, x: st.x, y: st.y, heading: st.heading, tilt_deg: this.rover.tiltDeg(), slope_deg: this.terrain.slopeDeg(st.x, st.y), odometer: this.odo, mast_pan: st.mastPan, arm_deploy: st.armDeploy, in_sand: this.terrain.inSand(st.x, st.y), dust_nearby: this.view.dynamic.length > 0 }));
  }
  publishHeightmap() {
    const st = this.rover.state, n = Math.round((2 * HM_HALF) / HM_RES) + 1;
    const ox = Math.floor(st.x) - HM_HALF, oy = Math.floor(st.y) - HM_HALF;
    const h = new Float32Array(n * n), sand = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = ox + c * HM_RES, y = oy + r * HM_RES; h[r * n + c] = this.terrain.h(x, y); sand[r * n + c] = this.terrain.inSand(x, y) ? 1 : 0; }
    this.stats.msgsOut++;
    this.pHm.publish(new ROSLIB.Message({ header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "map" }, origin_x: ox, origin_y: oy, resolution: HM_RES, width: n, height: n, heights: b64(new Uint8Array(h.buffer)), sand: b64(sand) }));
  }
  onTrigger(m) {
    this.stats.msgsIn++;
    // a stereo pair from one camera group: colour + depth, unprojected to world points (NaN = no match)
    const group = m.group || "navcam";
    let vis = this.vision;
    if (this.rig) { this.rig.refreshAll(); vis = (this.rig.primary[group] ?? this.rig.primary.navcam).vision; this.rig.draw(document.getElementById("camgrid")); this.view.frustum(vis.cam, parseInt((GROUP_COLOR[group] || "#4fd18b").slice(1), 16)); }
    else vis.capture();
    const pts = vis.points();
    // Perception renders at 384x216, but a cloud that size is ~1.8 MB of base64 per frame
    // over rosbridge and there are four camera pairs in a sweep. Decimate 2x2 to the
    // published 192x108, keeping the HIGHEST-relief sample in each block rather than a
    // corner pixel: a small rock survives the downsample instead of being averaged into
    // the ground, which is the whole reason for rendering at the higher resolution.
    const SW = vis.width, SH = vis.height;
    const W = SW >> 1, H = SH >> 1;
    const cloud = new Float32Array(W * H * 4).fill(NaN);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let best = null;
      for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const p = pts[(j * 2 + dj) * SW + (i * 2 + di)];
        if (p && (!best || p.relief > best.relief)) best = p;
      }
      if (!best) continue;
      const o = ((H - 1 - j) * W + i) * 4; // rows read bottom-up from the render target; publish top-down
      cloud[o] = best.gx; cloud[o + 1] = best.gy; cloud[o + 2] = best.relief + this.terrain.h(best.gx, best.gy); cloud[o + 3] = best.lum;
    }
    const hdr = { stamp: { sec: 0, nanosec: 0 }, frame_id: `${group}:${m.id}` };
    this.stats.msgsOut += 2;
    this.pImg.publish(new ROSLIB.Message({ header: hdr, format: "png", data: vis.png().replace(/^data:image\/png;base64,/, "") }));
    this.pCloud.publish(new ROSLIB.Message({ header: hdr, height: H, width: W, fields: [{ name: "x", offset: 0, datatype: 7, count: 1 }, { name: "y", offset: 4, datatype: 7, count: 1 }, { name: "z", offset: 8, datatype: 7, count: 1 }, { name: "intensity", offset: 12, datatype: 7, count: 1 }], is_bigendian: false, point_step: 16, row_step: 16 * W, data: b64(new Uint8Array(cloud.buffer)), is_dense: false }));
    document.getElementById("navcam-foot").textContent = `${group.replace("_", " ")} frame ${vis.seq}: stereo pair published on /navcam/points (${W}×${H}${m.boost ? ", mast raised" : ""})`;
  }

  // ------------------------------------------------------------ motion controller
  onCmd(m) {
    this.stats.msgsIn++;
    this.queue = this.queue.then(async () => {
      let moved = 0, err = 0, tilt = 0, note = "";
      try {
        switch (m.kind) {
          case "arm_instrument": this.armInstrument = ["WATSON", "PIXL", "drill"][Math.round(m.value)] ?? "WATSON"; break;
          case "arm_unstow": { const sh = this.rover.shoulderWorld(); const st = this.rover.state;
            const tgt = new THREE.Vector3(sh.x + Math.cos(st.heading) * 1.15, sh.y + 0.3, sh.z - Math.sin(st.heading) * 1.15);
            err = await this.rover.armTo(tgt, new THREE.Vector3(0, 1, 0), { instrument: this.armInstrument, seconds: 2.2, frame: () => this.nextFrame() }); break; }
          case "arm_preplace": case "arm_contact": case "arm_retract": {
            const sp = this.spotPoint(m.x, m.y, Math.round(m.value)); this.armSpot = sp;
            const lift = m.kind === "arm_contact" ? 0.0 : m.kind === "arm_preplace" ? 0.28 : 0.4;
            const tgt = sp.point.clone().addScaledVector(sp.normal, lift);
            // Solve against the arm's collision model. Obstacles are rocks PERCEPTION measured,
            // not the world's rock list, so the arm is as blind as the rest of the rover.
            const obstacles = this.armObstacles(m.x, m.y);
            const sol = this.rover.solveArmSafe(tgt, sp.normal, obstacles, this.armInstrument, 0.05);
            err = await this.rover.armTo(tgt, sol.normal, { instrument: this.armInstrument, seconds: m.kind === "arm_contact" ? 1.6 : 2.4, frame: () => this.nextFrame() });
            const c = this.rover.armClearance(obstacles, this.armInstrument);
            tilt = Math.acos(Math.max(-1, Math.min(1, sol.normal.y))) * 180 / Math.PI;
            this.armLastClearance = c;
            const body = c.clearance >= 0.05 ? `arm body clear by ${(c.clearance * 100).toFixed(0)} cm`
              : c.clearance >= 0 ? `arm body only ${(c.clearance * 100).toFixed(0)} cm from ${c.offender?.link ?? "a rock"}`
              : `COLLISION: ${c.offender?.link ?? "arm"} would be ${(-c.clearance * 100).toFixed(0)} cm inside a measured rock`;
            const tip = m.kind === "arm_contact" ? `; instrument tip ${(c.tipGap * 100).toFixed(0)} cm from the measured surface` : "";
            note = `${sp.hit ? "instrument over the measured rock surface" : "no surface under the spot; using the rock centre"}; ${body}${tip}` +
                   (sol.tries > 1 ? `; approach re-aimed after ${sol.tries} tries to keep the arm off the rock` : ""); break; }
          case "arm_stow": await this.rover.armStow({ seconds: 2.4, frame: () => this.nextFrame() }); break;
          case "follow": moved = await this.follow(pairs(m.path), m.reverse); break;
          case "turn": await this.turnInPlace(m.value); break;
          case "back_up": await this.backUp(m.value); break;
          case "mast_sweep": await this.mastSweep(); break;
          case "arm": await this.armAnim(m.value); break;
          case "speed": this.speedFactor = m.value || 1; break;
          case "look_at": { if (this.dd) { const v = this.dd.mesh.position.clone(); v.y += 12; this.view.navcamLook = v; } break; }
          case "look_clear": this.view.navcamLook = null; break;
        }
      } catch (e) { console.error("cmd", m.kind, e); }
      this.stats.msgsOut++;
      this.pDone.publish(new ROSLIB.Message({ id: m.id, moved_m: moved, err_m: err, tilt_deg: tilt, note }));
    });
  }
  // A placement spot on the rendered rock: 0 top (ray down at x,y), 1 near face (ray from the shoulder), 2/3 left/right flank.
  // Rocks the arm must not hit, built from what perception measured. `exceptX/Y` is the spot
  // being worked on: that rock is the one the instrument is supposed to touch, so its sphere
  // is shrunk to the part the turret still must not enter rather than dropped entirely.
  armObstacles(exceptX, exceptY) {
    const out = [];
    for (const f of this.lastFeats ?? []) {
      if (f.kind !== "rock") continue;
      const h = f.h ?? f.hEst ?? 0.25;
      const rad = Math.max(0.12, (f.footprint ? Math.max(f.footprint[0], f.footprint[1]) : (f.d ?? 0.4)) / 2);
      const ground = this.terrain.h(f.x, f.y);
      const isTarget = exceptX != null && Math.hypot(f.x - exceptX, f.y - exceptY) < Math.max(0.8, rad);
      // The target rock keeps its FULL measured size. Shrinking it so the instrument could
      // reach was the bug behind the turret ending up inside the boulder: the instrument face
      // is exempted in the collision model itself (rover.js TIP_EXEMPT), which is the right
      // place for that exemption, not here.
      // ellipsoid: measured footprint across, measured relief tall
      out.push({ id: f.id + (isTarget ? " (target)" : ""), c: new THREE.Vector3(f.x, ground + h * 0.5, -f.y), rxz: rad, ry: Math.max(0.08, h * 0.5) });
    }
    return out;
  }
  spotPoint(cx, cy, code) {
    const v = this.view, h = this.terrain.h(cx, cy), st = this.rover.state;
    const objs = [this.terrain.rockMesh, ...v.targets.map((t) => t.group)];
    const right = [Math.sin(st.heading), -Math.cos(st.heading)];
    const sh = this.rover.shoulderWorld();
    let origin, dir;
    if (code === 0) { origin = new THREE.Vector3(cx, h + 8, -cy); dir = new THREE.Vector3(0, -1, 0); }
    else {
      const lat = code === 2 ? -1.3 : code === 3 ? 1.3 : 0;
      const ox = sh.x + right[0] * lat, oy = -sh.z + right[1] * lat;
      origin = new THREE.Vector3(ox, h + 0.45, -oy); dir = new THREE.Vector3(cx - ox, -0.15, -(cy - oy)).normalize();
    }
    const hits = new THREE.Raycaster(origin, dir).intersectObjects(objs, true)
      .filter((hh) => hh.object.isMesh && !hh.object.isSprite && !/Ring|Cylinder/.test(hh.object.geometry?.type ?? ""));
    if (!hits.length) return { point: new THREE.Vector3(cx, h + 0.3, -cy), normal: new THREE.Vector3(0, 1, 0), hit: false };
    const hh = hits[0]; const n = new THREE.Vector3(0, 1, 0);
    if (hh.face) {
      const mw = hh.object.matrixWorld.clone();
      if (hh.object.isInstancedMesh && hh.instanceId != null) { const im = new THREE.Matrix4(); hh.object.getMatrixAt(hh.instanceId, im); mw.multiply(im); }
      n.copy(hh.face.normal).transformDirection(mw); if (n.y < 0) n.negate();
    }
    return { point: hh.point.clone(), normal: n, hit: true };
  }
  showSpots(list, ttl = 20000) {
    for (const m of this.spotMarkers ?? []) this.view.scene.remove(m);
    this.spotMarkers = [];
    for (const s of list) {
      const sp = this.spotPoint(s.x, s.y, s.code);
      const mk = new THREE.Mesh(new THREE.SphereGeometry(s.chosen ? 0.07 : 0.045, 12, 8), new THREE.MeshBasicMaterial({ color: s.chosen ? 0x4fd18b : s.ok ? 0x9ab0c0 : 0xd85a5a }));
      mk.position.copy(sp.point).addScaledVector(sp.normal, 0.03); this.view.scene.add(mk); this.spotMarkers.push(mk);
    }
    setTimeout(() => { for (const m of this.spotMarkers ?? []) this.view.scene.remove(m); }, ttl);
  }
  async follow(path, reverse = false) {
    let moved = 0; const st = this.rover.state;
    for (const [px, py] of path) {
      let dx = px - st.x, dy = py - st.y, d = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      while (d > 0.05) {
        const dt = await this.nextFrame();
        const step = Math.min(d, SPEED * this.speedFactor * (reverse ? 0.5 : 1) * dt);
        const nx = st.x + Math.cos(th) * step, ny = st.y + Math.sin(th) * step;
        let heading = st.heading; if (!reverse) heading += wrap(th - heading) * Math.min(1, 6 * dt);
        this.rover.pose(this.terrain, nx, ny, heading);
        this.rover.advance(reverse ? -step : step);
        const before = this.odo; this.odo += step; moved += step; d -= step;
        if (Math.floor(this.odo * 2) !== Math.floor(before * 2)) this.view.addTrack(nx, ny);
      }
    }
    return moved;
  }
  async turnInPlace(angle) {
    const st = this.rover.state, target = st.heading + angle; let t = 0;
    while (t < 1) { const dt = await this.nextFrame(); t = Math.min(1, t + dt / Math.max(0.4, Math.abs(angle) / 0.8)); this.rover.pose(this.terrain, st.x, st.y, target - angle * (1 - t)); this.rover.advance(dt * 0.6); }
  }
  async backUp(m) {
    const st = this.rover.state, th = st.heading + Math.PI; let d = m;
    while (d > 0) { const dt = await this.nextFrame(); const s = Math.min(d, 1.2 * dt); this.rover.pose(this.terrain, st.x + Math.cos(th) * s, st.y + Math.sin(th) * s, st.heading); this.rover.advance(-s); d -= s; }
  }
  async mastSweep() { for (let t = 0; t < 1;) { const dt = await this.nextFrame(); t = Math.min(1, t + dt / 1.4); this.rover.setMast(Math.sin(t * Math.PI) * 0.7); } }
  async armAnim(to) { const from = this.rover.state.armDeploy; for (let t = 0; t < 1;) { const dt = await this.nextFrame(); t = Math.min(1, t + dt / 1.6); this.rover.setArm(from + (to - from) * (0.5 - 0.5 * Math.cos(t * Math.PI))); } }

  // ------------------------------------------------------------ user objective
  injectObjective(pick, text) {
    this.stats.msgsOut++;
    this.pObj.publish(new ROSLIB.Message({ id: pick.id, name: pick.name ?? "", description: pick.description, x: pick.x, y: pick.y, text }));
  }
}
