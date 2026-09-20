"""The sol executive: the state machine that code owns (port of public/game.js).

Claude is asked to plan and to interpret (via /claude/ask, /claude/describe); jev is asked to
classify, choose, triage and verify (via /jev/*); ENav geometry is a service; the simulator
executes motion commands and streams the rover state. Every decision is published on
/ops/decisions with the engine that made it, so the console (and a bag) can replay it.
"""
import html, json, math, re, threading, time
import py_trees
from rclpy.action import ActionClient
from .sol_tree import build as build_tree, ascii as tree_ascii, active_path as tree_active
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy, HistoryPolicy
from std_msgs.msg import String
from sensor_msgs.msg import CompressedImage
from jezero_msgs.msg import (RoverState, CmdDone, RoverCmd, CaptureRequest, FeatureArray, PerceptionMap, Rock, KeepOut, KeepOutArray,
                             Decision, Hud, Timeline, TimelineBlock, ViewCmd, UserObjective, HealthVerdict, TreeState, DownlinkQueue, DataProduct)
from jezero_msgs.srv import Classify, Aegis, Fault, Verify, EvaluateArcs, Judge
from jezero_msgs.action import Ask, Describe
from .world import CAMPAIGN, CONSTRAINTS, INSTRUMENTS, TARGETS, ROVER_START, EVENTS, MEASURES, SHORT, REMOTE, LANE_OF, FLIGHT_RULES, SLIP_BY_CLASS, public_targets, instrument_result
from .geometry import scripted_feature, sun_state
from .common import hhmm, wrap, feature_from_msg, feature_to_msg, Waiter, call_service, jdump

WH_PER_M = 1.2
MIN_PER_M = 60 / 120
esc = lambda s: html.escape(str(s if s is not None else ""), quote=True)


class SolExecutive(Node):
    def __init__(self):
        super().__init__("sol_executive")
        for k, v in dict(autostart=True, conf_floor=0.55, energy_margin=0.15, verify_floor=0.5, keepout_r=6.0, sols=3, downlink_reserve_mb=40.0, health_stop=0.5, health_ground=0.5).items():
            self.declare_parameter(k, v)
        self.P = lambda k: self.get_parameter(k).value
        cb = ReentrantCallbackGroup()
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL, reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST)
        # publishers
        self.pub_dec = self.create_publisher(Decision, "/ops/decisions", 100)
        self.pub_hud = self.create_publisher(Hud, "/ops/hud", 10)
        self.pub_tl = self.create_publisher(Timeline, "/ops/timeline", 10)
        self.pub_view = self.create_publisher(ViewCmd, "/sim/view", 50)
        self.pub_cmd = self.create_publisher(RoverCmd, "/rover/cmd", 10)
        self.pub_trig = self.create_publisher(CaptureRequest, "/navcam/trigger", 10)
        self.pub_map = self.create_publisher(PerceptionMap, "/perception/map", latched)
        self.pub_ko = self.create_publisher(KeepOutArray, "/nav/keepouts", latched)
        self.pub_world = self.create_publisher(String, "/ops/world", latched)
        # subscriptions
        self.state = None; self.waiter = Waiter(); self.frames = {}; self.pngs = {}; self.pending_objective = None; self.sim_ready = False
        self.create_subscription(RoverState, "/rover/state", self.on_state, 20, callback_group=cb)
        self.create_subscription(CmdDone, "/rover/cmd_done", self.on_cmd_done, 20, callback_group=cb)
        self.create_subscription(FeatureArray, "/perception/features", self.on_features, 10, callback_group=cb)
        self.create_subscription(CompressedImage, "/navcam/image/compressed", self.on_png, 5, callback_group=cb)
        self.create_subscription(UserObjective, "/ops/user_objective", self.on_objective, 10, callback_group=cb)
        self.create_subscription(String, "/sim/ready", self.on_ready, 10, callback_group=cb)
        self.create_subscription(HealthVerdict, "/health/verdict", self.on_health, 10, callback_group=cb)
        self.pub_tree = self.create_publisher(TreeState, "/ops/tree", 10)
        self.pub_dl = self.create_publisher(DownlinkQueue, "/ops/downlink", 10)
        # service clients
        self.c_classify = self.create_client(Classify, "/jev/classify", callback_group=cb)
        self.c_aegis = self.create_client(Aegis, "/jev/aegis", callback_group=cb)
        self.c_fault = self.create_client(Fault, "/jev/fault", callback_group=cb)
        self.c_verify = self.create_client(Verify, "/jev/verify", callback_group=cb)
        self.c_enav = self.create_client(EvaluateArcs, "/enav/evaluate", callback_group=cb)
        self.c_judge = self.create_client(Judge, "/jev/judge", callback_group=cb)
        self.a_ask = ActionClient(self, Ask, "/claude/ask", callback_group=cb)
        self.a_describe = ActionClient(self, Describe, "/claude/describe", callback_group=cb)
        self.claude_goal = None; self.claude_lock = threading.Lock()
        # mission state
        self.sol = 0; self.lmst = 8 * 60; self.sol_odo = 0.0
        self.energy = CONSTRAINTS["energy_wh"]; self.data = CONSTRAINTS["data_mb"]
        self.mode = "IDLE"; self.history = []; self.done = {}; self.criteria = ""
        self.keepouts = []; self.fired = set(); self.judged_spots = []; self.perceived = []
        self.speed_factor = 1.0; self.timeline = []; self.objectives = []
        self.last_k = None; self.last_reason = ""; self.last_wp_odo = -99.0; self.pending_feature = None; self.perception_noted = False
        self.cmd_id = 0; self.cap_id = 0; self.running = False; self.drive_end_reason = ""
        self.n_jev = 0; self.n_jev_in_claude = 0; self.n_claude = 0; self.slip_pct = 0.0; self.ground_class = ""
        self.health = None; self.health_seq = 0; self.health_handled = 0; self.health_alarm = None; self.health_alarm_t = 0.0; self.health_grace_odo = -1.0; self.health_grace_t = 0.0; self.health_grace_classes = set(); self.halt_classes = set(); self.halting = False; self.halt_reason = ""; self.products = []; self.last_done = {}; self.arm_spot = None; self.tree = None; self.plan_out = None; self.exec_state = None; self.review = None
        self.ledger = {"frames": 0, "judged": 0, "obstacles": 0, "keepouts": 0, "vetoes": 0, "unsure": 0, "shadows": 0, "ground": {}}
        self.pub_world.publish(String(data=jdump({"campaign": CAMPAIGN, "constraints": CONSTRAINTS, "instruments": INSTRUMENTS, "targets": public_targets(),
                                                   "rover_start": ROVER_START, "events": EVENTS, "models": {"jev": "jev-latest", "llm": "claude (ROS 2 planner node)"}})))
        self.world_msg = String(data=jdump({"campaign": CAMPAIGN, "constraints": CONSTRAINTS, "instruments": INSTRUMENTS, "targets": public_targets(),
                                             "rover_start": ROVER_START, "events": EVENTS, "models": {"jev": "jev-latest", "llm": "claude (ROS 2 planner node)"}}))
        self.create_timer(2.0, lambda: self.pub_world.publish(self.world_msg), callback_group=cb)  # rosbridge clients may miss the latched copy
        self.get_logger().info("sol_executive up; waiting for the simulator on /sim/ready")

    # ------------------------------------------------------------------ callbacks
    def on_state(self, m): self.state = m
    def on_png(self, m):
        try: rid = int((m.header.frame_id or "navcam:0").split(":")[1])
        except Exception: rid = 0
        self.pngs[rid] = m
    def on_features(self, m):
        if (m.group or "navcam") == "navcam": self.last_frame_cov = float(m.stereo_coverage); self.last_frame_shadow = float(m.shadow_fraction)
        self.frames[m.request_id] = m; self.waiter.fire(f"feat:{m.request_id}", m)
    def on_objective(self, m):
        pick = {"id": m.id, "name": m.name or None, "description": m.description, "x": m.x, "y": m.y}
        self.pending_objective = {"pick": pick, "text": m.text}
        self.emit("user_objective", "USER", "New science objective", {"text": m.text, "pick": pick}, "from the science team")
        self.caption("USER", f"New science objective received: “{m.text}”", 6000)
        self.view("ring", x=m.x, y=m.y, r=2.4, color="#ff8fb1")
        self.view("waypoint", x=m.x, y=m.y, text="objective target (user)", engine="user")
        self.hud()
    def on_health(self, v):
        prev = self.health; self.health = v; self.health_seq += 1
        stop = v.stop_drive > self.P("health_stop")
        if self.halting: self.halt_classes.add(v.fault_class)
        if stop and not self.halting:
            # latch it: the drive loop consumes the alarm on its next pass even if the next verdict is already nominal
            self.health_alarm = v; self.health_alarm_t = time.time()
        if stop and prev is not None and prev.stop_drive > self.P("health_stop") and prev.fault_class != v.fault_class:
            # the picture changed while a halt is being handled: cancel the running Claude action so it re-plans on the new state
            self.cancel_claude(f"telemetry changed during the anomaly: {prev.fault_class} -> {v.fault_class}")
        # jev reads EVERY telemetry sample (about one a second, a few cents a run), but the
        # console is a narrative, not a log: a card for each of a thousand identical nominal
        # verdicts would bury every decision that matters. So a card goes up when the picture
        # changes or stops being nominal, and the rest are counted in the HUD and drawn on the
        # live health panel. Nothing is hidden - the stream is on /health/verdict either way.
        interesting = (v.fault_class != "nominal" or stop or v.needs_ground > self.P("health_stop")
                       or prev is None or prev.fault_class != v.fault_class
                       or abs(v.stop_drive - prev.stop_drive) > 0.18)
        # (the live health panel in the browser subscribes to /health/verdict directly, so it
        #  keeps ticking at 1 Hz whether or not a card goes up here)
        if interesting or self.health_seq % 25 == 1:
            tag = "Health: " if interesting else "Health (periodic): "
            self.emit("health", "JEV", f"{tag}{v.fault_class} (stop {v.stop_drive:.2f}, ground {v.needs_ground:.2f})",
                      {"fault_class": v.fault_class, "confidence": v.confidence, "stop_drive": v.stop_drive, "needs_ground": v.needs_ground, "words": v.summary_words, "latency_ms": v.latency_ms}, f"{v.latency_ms:.0f} ms · continuous · sample {self.health_seq}")
        self.n_jev += 1

    def cancel_claude(self, why):
        with self.claude_lock:
            gh = self.claude_goal
        if gh is not None:
            try: gh.cancel_goal_async()
            except Exception: pass
            self.log("CODE", "Claude action cancelled", esc(why) + '<div style="font-size:11px;color:var(--ink3);margin-top:3px">Actions, not services: the ground call is a goal with feedback, and the executive can withdraw it when the situation changes.</div>')

    def on_ready(self, m):
        if self.sim_ready: return
        self.sim_ready = True
        self.get_logger().info(f"simulator ready: {m.data}")
        if self.P("autostart") and not self.running:
            threading.Thread(target=self.safe_run_tree, daemon=True).start()

    # ------------------------------------------------------------------ UI plumbing
    def emit(self, kind, engine, title, payload, meta=""):
        d = Decision(); d.stamp = self.get_clock().now().to_msg(); d.engine = engine; d.kind = kind; d.title = title; d.meta = meta; d.payload_json = jdump(payload)
        self.pub_dec.publish(d)
        self.get_logger().info(f"[{engine}] {title}")
    def log(self, engine, title, body_html="", meta=""):
        self.emit("log", engine, title, {"body": body_html}, meta)
    def rule(self, text, fr=None):
        cite = f'<div class="fr">{esc(fr)} — {esc(FLIGHT_RULES[fr])}</div>' if fr else ''
        return f'<div class="rule">{esc(text)}</div>' + cite
    def spend_drive(self, moved):
        """Energy and time per metre grow with predicted slip (wheels turn further than the rover moves)."""
        f = 1.0 / max(0.3, 1.0 - self.slip_pct / 100.0)
        self.spend(wh=moved * WH_PER_M * f, minutes=(moved * MIN_PER_M * f) / self.speed_factor)
    def view(self, kind, **kw):
        v = ViewCmd(); v.kind = kind
        for k in ("x", "y", "r", "ttl_ms"): setattr(v, k, float(kw.get(k, 0.0)))
        for k in ("text", "color", "engine"): setattr(v, k, str(kw.get(k, "")))
        v.points = [float(c) for p in kw.get("points", []) for c in p]; v.flag = bool(kw.get("flag", False)); v.json = jdump(kw["json"]) if "json" in kw else ""
        self.pub_view.publish(v)
    def now(self, engine, text): self.view("now", engine=engine, text=text)
    def caption(self, engine, text, ms=4200, warn=False): self.view("caption", engine=engine, text=text, ttl_ms=ms, flag=warn)
    def set_camera(self, mode): self.view("camera", text=mode)
    def hud(self):
        h = Hud(sol=int(self.sol), lmst=float(self.lmst), energy=float(self.energy), energy_max=float(CONSTRAINTS["energy_wh"]), data=float(self.data),
                data_max=float(CONSTRAINTS["data_mb"]), odometer=float(self.odo), tilt=float(self.tilt), mode=self.mode,
                slip_pct=float(self.slip_pct), ground_class=self.ground_class, jev_calls=int(self.n_jev), jev_in_claude=int(self.n_jev_in_claude), claude_calls=int(self.n_claude))
        self.pub_hud.publish(h)
        t = Timeline(sol=int(self.sol))
        for b in self.timeline:
            m = TimelineBlock(id=b["id"], lane=b["lane"], key=b["key"], target=b.get("target") or "", label=b["label"], short_label=b["short"], start=float(b["start"]),
                              dur=float(b.get("dur", 5)), end=float(b.get("end") or 0.0), has_end=b.get("end") is not None, wh=float(b.get("wh") or 0), mb=float(b.get("mb") or 0),
                              status=b["status"], tag=b.get("tag") or "", reason=b.get("reason") or "", has_verify="verify" in b)
            if "verify" in b: m.verify = [float(b["verify"]["serves"]), float(b["verify"]["prereq"]), float(b["verify"]["risk"])]
            t.blocks.append(m)
        self.pub_tl.publish(t)
    def spend(self, wh=0.0, mb=0.0, minutes=0.0):
        self.energy -= wh; self.data -= mb; self.lmst += minutes; self.hud()
    def set_mode(self, m): self.mode = m; self.hud()
    def pause(self, ms): time.sleep(ms / 1000)

    # ------------------------------------------------------------------ rover state helpers
    @property
    def pos(self): return self.state
    @property
    def odo(self): return float(self.state.odometer) if self.state else 0.0
    @property
    def tilt(self): return float(self.state.tilt_deg) if self.state else 0.0
    def dist(self, t): return math.hypot(t["x"] - self.state.x, t["y"] - self.state.y)
    def bearing_to(self, t): return math.atan2(t["y"] - self.state.y, t["x"] - self.state.x)
    def bearing_deg(self, t): return (math.degrees(self.bearing_to(t)) + 360) % 360
    def target(self, tid): return next((t for t in TARGETS if t["id"] == tid), None)
    def rover_words(self):
        tilt = self.tilt; st = self.state
        return {"tilt": "gentle tilt, under six degrees" if tilt < 6 else "moderate tilt around ten degrees" if tilt < 12 else "steep tilt",
                "ground": "one wheel on loose drift material" if st.in_sand else "all six wheels on firm pavement",
                "air": "dust lifted nearby" if st.dust_nearby else "clear air",
                "hour": "mid-sol, hours of light left" if self.lmst < 15 * 60 else "late sol, light running out"}

    # ------------------------------------------------------------------ simulator commands
    def on_cmd_done(self, m):
        self.last_done = {"moved": m.moved_m, "err": m.err_m, "tilt": m.tilt_deg, "note": m.note}
        self.waiter.fire(f"cmd:{m.id}", m.moved_m)

    def cmd(self, kind, path=None, reverse=False, value=0.0, x=0.0, y=0.0, timeout=180.0):
        self.cmd_id += 1; cid = self.cmd_id
        m = RoverCmd(id=cid, kind=kind, reverse=reverse, value=float(value), x=float(x), y=float(y))
        m.path = [float(c) for p in (path or []) for c in p]
        self.waiter.arm(f"cmd:{cid}"); self.pub_cmd.publish(m)
        moved = self.waiter.wait(f"cmd:{cid}", timeout)
        self.hud()
        return float(moved or 0.0)
    def follow(self, path, reverse=False): return self.cmd("follow", path=path, reverse=reverse)
    def turn_in_place(self, angle): self.cmd("turn", value=angle)
    def fault_from_health(self, v, goal, sol_driven, max_dist):
        """Same rules as the scripted triage, driven by the continuous verdict."""
        self.set_mode("FAULT"); self.halting = True; self.halt_reason = f"{v.fault_class}: stop {v.stop_drive:.2f}"
        self.publish_tree()
        event = {"phase": "AutoNav drive, mid-arc", "description": v.summary_words, "terrain_words": f"ground ahead classed {self.ground_class or 'unknown'}; predicted slip {self.slip_pct:.0f} %"}
        self.caption("ROVER", f"Health monitor: {v.fault_class} — jev says stop ({v.stop_drive:.2f}).", 4500, True)
        fc = {"choice": v.fault_class, "confidence": v.confidence}; stop = v.stop_drive; ground = v.needs_ground
        self.log("CODE", "Onboard rule", self.rule(f"stop_drive = {stop:.2f} > 0.50 → halt drive immediately (no Earth round-trip needed for a halt)", fr="FR-11"))
        self.set_mode("HALTED"); self.view("waypoint", x=self.state.x, y=self.state.y, text=f"halt: {fc['choice']} (jev health)", engine="jev")
        escalate = ground > self.P("health_ground") or fc["confidence"] < self.P("conf_floor")
        try:
            if not escalate:
                self.log("CODE", "Onboard rule", self.rule(f"needs_ground = {ground:.2f} ≤ 0.50 and confidence {fc['confidence']:.2f} ≥ {self.P('conf_floor')}\n→ resume at reduced speed with visual odometry every step"))
                self.speed_factor = 0.6; self.cmd("speed", value=0.6); self.set_mode("AUTONAV · VISODOM"); return True
            self.caption("CODE", f"needs_ground {ground:.2f} > 0.5 → escalate to the ground team (Claude). The rover waits.", 5000)
            self.now("CLAUDE", "anomaly response — diagnosing from the telemetry"); self.set_camera("science")
            try:
                a = self.claude("anomaly", {"sol": self.sol, "event": event["description"], "terrain": event["terrain_words"],
                                            "triage": {"fault_class": fc["choice"], "confidence": f"{fc['confidence']:.2f}", "stop_drive": f"{stop:.2f}", "needs_ground": f"{ground:.2f}"},
                                            "stopped": True, "progress_m": f"{sol_driven:.0f}", "goal_m": f"{min(max_dist, self.dist(goal) + sol_driven):.0f}"})
            except Exception as e:
                self.log("CLAUDE", "Anomaly response unavailable", f'<span style="color:var(--hot)">{esc(e)}</span> — onboard default: resume with visual odometry at reduced speed.')
                self.speed_factor = 0.6; self.cmd("speed", value=0.6); self.set_mode("AUTONAV · VISODOM"); self.set_camera("map"); return True
            self.emit("claude_anomaly", "CLAUDE", "Anomaly response (ground in the loop)", a, f"{a['latencyMs'] / 1000:.1f} s")
            self.caption("CLAUDE", f"{a['output']['action']}: {a['output']['diagnosis']}", 7000); self.pause(2500); self.set_camera("map")
            act = a["output"]["action"]
            self.view("waypoint", x=self.state.x, y=self.state.y, text=f"ground: {act.replace('_', ' ')}", engine="claude")
            if act == "stop_for_sol": return False
            if act == "back_up_and_reroute":
                th = self.state.heading + math.pi
                self.hazcam_check("rear_hazcam", [(self.state.x + math.cos(th) * d, self.state.y + math.sin(th) * d) for d in (1, 2, 3)], sun_state(self.lmst), "rear Hazcams")
                self.back_up(3); self.add_keepout(self.state.x + math.cos(self.state.heading) * 4, self.state.y + math.sin(self.state.heading) * 4, 6, "ground: slip zone", "CLAUDE")
            if act == "reimage_and_reassess": self.mast_sweep()
            self.speed_factor = 1.0 if act == "resume_normal" else 0.6; self.cmd("speed", value=self.speed_factor)
            self.set_mode("AUTONAV · VISODOM" if self.speed_factor < 1 else "AUTONAV"); return True
        finally:
            self.halting = False; self.halt_reason = ""; self.publish_tree()

    def back_up(self, m): self.cmd("back_up", value=m)
    def mast_sweep(self): self.cmd("mast_sweep")
    def arm_anim(self, to): self.cmd("arm", value=to)

    def see(self, boost=False, group="navcam"):
        """Trigger a stereo pair from one camera group; perception returns the measured features."""
        self.cap_id += 1; cid = self.cap_id
        self.waiter.arm(f"feat:{cid}")
        self.pub_trig.publish(CaptureRequest(id=cid, group=group, boost=boost))
        fa = self.waiter.wait(f"feat:{cid}", 20.0)
        return [feature_from_msg(f) for f in fa.features], cid

    # ------------------------------------------------------------------ JEV: whole-rig sweep
    SWEEP_GROUPS = [("navcam", "nav"), ("front_hazcam", "fh"), ("front_hazcam_b", "fhb"), ("rear_hazcam", "rear")]

    def camera_sweep(self, path, sun, goal=None, label="all cameras"):
        """Image every camera pair on the rover and put everything new in the corridor to jev
        in ONE request. Any single pair answering "about to roll onto it" vetoes the move and
        ENav re-plans before a wheel turns; a rock only the rear pair can see still stops us.

        This is affordable only because of what System One costs: a question is about 180 input
        tokens and a request answers all of them in the same ~250 ms whether it carries four
        questions or fifty, so sweeping the whole rig once a second costs a fraction of a cent
        and no extra latency. Asking an LLM this often would be impossible on both counts.
        Returns True if the move was vetoed."""
        feats_all, per_group, caps = [], {}, {}
        for group, pre in self.SWEEP_GROUPS:
            try:
                feats, cap = self.see(group=group)
            except Exception as e:
                self.get_logger().warn(f"sweep: {group} capture failed: {e}"); continue
            caps[group] = cap
            per_group[group] = feats
            for f in feats:
                if f.get("kind") == "rock" and f.get("h") is not None:
                    self.remember(f, f["h"])
                g = dict(f); g["id"] = f"{pre}__{f['id']}"; g["_group"] = group
                feats_all.append(g)

        def near_path(f):
            if not path: return True
            return any(math.hypot(f["x"] - px, f["y"] - py) < 1.65 + (f.get("d") or 0.4) / 2 for px, py in path)

        def is_goal(f):
            return goal is not None and math.hypot(f["x"] - goal["x"], f["y"] - goal["y"]) < 1.8

        def needs_judgment(f):
            return f.get("h") is None or f["h"] >= 0.15 or f.get("kind") != "rock"

        new = [f for f in feats_all if not self.already_judged(f) and near_path(f) and not is_goal(f) and needs_judgment(f)]
        self.sweeps = getattr(self, "sweeps", 0) + 1
        seen_n = sum(len(v) for v in per_group.values())
        if not new:
            self.view("cam_status", text=f"{label}: {len(per_group)} pairs, {seen_n} features measured, nothing new in the corridor; no question asked", engine="navcam")
            return False

        fa = FeatureArray(); fa.request_id = caps.get("front_hazcam", 0); fa.group = "sweep"
        fa.features = [feature_to_msg(f) for f in new]
        r = self.jev(self.c_classify, Classify.Request(features=fa, sun_words=sun["words"]), label="sweep")
        ans = r["answers"]; verdicts = {}; veto = False; unsure = None; vetoed_by = []
        self.ledger["frames"] += len(per_group); self.ledger["judged"] += len(new)
        for f in new:
            i = f["id"]; t = ans[f"{i}__type"]; wh = ans[f"{i}__wheel_hazard"]["noul"]; sk = ans[f"{i}__sinkage"]["noul"]
            self.judged_spots.append((f["x"], f["y"]))
            if t["confidence"] < self.P("conf_floor"):
                verdicts[i] = {"cls": "unsure", "text": "UNSURE -> halt, re-image"}; unsure = f; continue
            if t["choice"] == "shadow_only":
                verdicts[i] = {"cls": "", "text": "shadow - roll on"}
            elif sk > 0.5:
                verdicts[i] = {"cls": "warn", "text": f"VETO: sinkage ({f['_group']})"}; veto = True; vetoed_by.append(f["_group"])
                self.add_keepout(f["x"], f["y"], 3.0, f"jev: {f['_group']} sinkage veto", "JEV")
            elif wh > 0.5:
                verdicts[i] = {"cls": "warn", "text": f"VETO: about to roll onto it ({f['_group']})"}; veto = True; vetoed_by.append(f["_group"])
                self.remember(f, max(f.get("h") or 0, CONSTRAINTS["rock_step_limit_m"]), f"jev: {f['_group']} veto")
            else:
                verdicts[i] = {"cls": "", "text": "roll on - ok"}
        groups_txt = ", ".join(f"{g} {len(v)}" for g, v in per_group.items())
        self.emit("jev_hazards", "JEV",
                  f"Camera sweep — {len(per_group)} pairs, {len(new)} new ({len(new) * 4} questions, 1 request)",
                  {"r": r, "features": new, "verdicts": verdicts, "group": "sweep"},
                  f"{r['latencyMs']} ms - {r['usage'].get('input_tokens', 0)} tok - {groups_txt}")
        for group, feats in per_group.items():
            self.view("navcam_draw", json={"feats": feats, "verdicts": {}, "group": group})
        self.view("cam_status", text=f"{label}: {len(new)} asked -> jev {r['latencyMs']} ms - " + " / ".join(v["text"] for v in verdicts.values()), engine="navcam")
        if unsure is not None:
            self.ledger["unsure"] += 1
            self.log("CODE", "Confidence gate (whole-rig sweep)",
                     self.rule(f"confidence({unsure['id']}__type) = {ans[unsure['id'] + '__type']['confidence']:.2f} < {self.P('conf_floor')}\n-> do not commit the wheel; halt and re-image", fr="FR-08"))
            self.spend(wh=2, minutes=2); veto = True
        if veto:
            self.ledger["vetoes"] += 1
            self.log("CODE", "Move vetoed by the camera sweep",
                     self.rule("any one camera pair may stop the move; the rock enters the perception map and ENav re-plans before a wheel turns\nvetoed by: " + ", ".join(sorted(set(vetoed_by)) or ["confidence gate"]), fr="FR-06"))
        return veto

    # ------------------------------------------------------------------ JEV: near-field (Hazcam) check
    def hazcam_check(self, group, path, sun, label, goal=None):
        """The last look before a wheel is committed. Returns True if jev vetoed the move.
        Measured rocks always enter the perception map; jev is asked only about features not
        judged before, and only those inside the corridor the rover is about to drive. On a
        final approach the target rock itself is excluded: the stand-off keeps the wheels off it."""
        feats, cap = self.see(group=group)
        for f in feats:
            if f.get("kind") == "rock" and f.get("h") is not None: self.remember(f, f["h"])
        def near_path(f):  # inside the wheel corridor (half-width 1.65 m + the rock's own radius)
            return any(math.hypot(f["x"] - px, f["y"] - py) < 1.65 + (f.get("d") or 0.4) / 2 for px, py in path) if path else True
        def is_goal(f):
            return goal is not None and math.hypot(f["x"] - goal["x"], f["y"] - goal["y"]) < 1.8
        def needs_judgment(f):  # geometry clears ankle-height measured rocks on its own; jev is for the rest
            return f.get("h") is None or f["h"] >= 0.15 or f.get("kind") != "rock"
        new = [f for f in feats if not self.already_judged(f) and near_path(f) and not is_goal(f) and needs_judgment(f)]
        self.hazcam_calls = getattr(self, "hazcam_calls", 0) + 1
        if not new:
            self.view("cam_status", text=f"{label}: frame {cap} clear — {len(feats)} feature{'s' if len(feats) != 1 else ''}, nothing new in the corridor; no question asked", engine=group)
            return False
        self.view("cam_status", text=f"{label}: frame {cap} — {len(new)} new in the corridor → jev", engine=group)
        fa = FeatureArray(); fa.request_id = cap; fa.group = group; fa.features = [feature_to_msg(f) for f in new]
        r = self.jev(self.c_classify, Classify.Request(features=fa, sun_words=sun["words"]), label=group)
        ans = r["answers"]; verdicts = {}; veto = False; unsure = None
        self.ledger["frames"] += 1; self.ledger["judged"] += len(new)
        for f in new:
            i = f["id"]; t = ans[f"{i}__type"]; wh = ans[f"{i}__wheel_hazard"]["noul"]; sk = ans[f"{i}__sinkage"]["noul"]
            self.judged_spots.append((f["x"], f["y"]))
            if t["confidence"] < self.P("conf_floor"): verdicts[i] = {"cls": "unsure", "text": "UNSURE -> halt, re-image"}; unsure = f; continue
            if t["choice"] == "shadow_only": verdicts[i] = {"cls": "", "text": "shadow - roll on"}
            elif sk > 0.5: verdicts[i] = {"cls": "warn", "text": "VETO: sinkage"}; veto = True; self.add_keepout(f["x"], f["y"], 3.0, f"jev: {label} sinkage veto", "JEV")
            elif wh > 0.5: verdicts[i] = {"cls": "warn", "text": "VETO: about to roll onto it"}; veto = True; self.remember(f, max(f.get("h") or 0, CONSTRAINTS["rock_step_limit_m"]), f"jev: {label} veto")
            else: verdicts[i] = {"cls": "", "text": "roll on - ok"}
        self.emit("jev_hazards", "JEV", f"{label}: {len(new)} feature{'s' if len(new) > 1 else ''} before the wheel is committed ({len(new) * 4} questions, 1 request)", {"r": r, "features": new, "verdicts": verdicts, "group": group}, f"{r['latencyMs']} ms - {r['usage'].get('input_tokens', 0)} tok")
        self.view("navcam_draw", json={"feats": feats, "verdicts": verdicts, "group": group})
        self.view("cam_status", text=f"{label}: frame {cap} -> jev {r['latencyMs']} ms - " + " / ".join(v["text"] for v in verdicts.values()), engine=group)
        if unsure is not None:
            self.ledger["unsure"] += 1
            self.log("CODE", "Confidence gate (Hazcam)", self.rule(f"confidence({unsure['id']}__type) = {ans[unsure['id'] + '__type']['confidence']:.2f} < {self.P('conf_floor')}\n-> do not commit the wheel; halt and re-image", fr="FR-08"))
            self.spend(wh=2, minutes=2); veto = True
        if veto:
            self.ledger["vetoes"] += 1
            body = '<span style="font-family:var(--mono);font-size:11px">' + esc(", ".join(f"{k}: {v['text']}" for k, v in verdicts.items() if v["cls"])) + '</span><div style="font-size:11px;color:var(--ink3);margin-top:3px">The near-field pair saw something the Navcam plan did not resolve; the rock is now in the perception map and ENav re-plans before any wheel moves.</div>' + self.rule('no motion before the near-field pair has cleared the next wheel placement', fr='FR-07' if group == 'rear_hazcam' else 'FR-06')
            self.log("JEV", f"{label} veto", body, f"odo {self.odo:.0f} m")
            self.caption("JEV", f"{label}: veto - {', '.join(v['text'] for v in verdicts.values() if v['cls'])}. ENav re-plans.", 4500, True)
        return veto

    # ------------------------------------------------------------------ perception map / keep-outs
    def remember(self, f, h, label=None):
        near = next((r for r in self.perceived if math.hypot(r["x"] - f["x"], r["y"] - f["y"]) < 0.9), None)
        if near:
            near["h"] = max(near["h"], h); near["d"] = max(near["d"], f.get("d") or 0.4)
            if label: near["label"] = label
        else:
            near = {"x": f["x"], "y": f["y"], "d": f.get("d") or 0.6, "h": h, "label": label or "seen"}; self.perceived.append(near)
        pm = PerceptionMap(); pm.rocks = [Rock(x=float(r["x"]), y=float(r["y"]), d=float(r["d"]), h=float(r["h"]), label=r["label"]) for r in self.perceived]
        self.pub_map.publish(pm)
        return near
    def add_keepout(self, x, y, r, label, engine):
        self.keepouts.append({"x": x, "y": y, "r": r, "label": label})
        ka = KeepOutArray(); ka.keepouts = [KeepOut(x=float(k["x"]), y=float(k["y"]), r=float(k["r"]), label=k["label"], engine=engine) for k in self.keepouts]
        self.pub_ko.publish(ka)
    def already_judged(self, f): return any(math.hypot(q[0] - f["x"], q[1] - f["y"]) < 1.2 for q in self.judged_spots)

    # ------------------------------------------------------------------ timeline
    def add_block(self, **b):
        blk = {"id": f"b{len(self.timeline)}", "status": "planned", **b}; self.timeline.append(blk); self.hud(); return blk
    def plan_blocks(self, items, tag):
        t = self.lmst
        for it in items:
            self.add_block(lane=LANE_OF.get(it["key"], "ARM"), key=it["key"], target=it.get("target", ""), label=f"{SHORT.get(it['key'], it['key'])}{' · ' + it['target'] if it.get('target') else ''}",
                           short=SHORT.get(it["key"], it["key"]), start=t, dur=it["dur"], wh=it["wh"], mb=it["mb"], tag=tag, **({"verify": it["verify"]} if it.get("verify") else {}))
            t += it["dur"]
    def begin_block(self, key, target, tag=None):
        b = next((x for x in self.timeline if x["status"] == "planned" and x["key"] == key and (not target or x.get("target") == target)), None)
        if b is None:
            b = self.add_block(lane=LANE_OF.get(key, "ARM"), key=key, target=target, label=f"{SHORT.get(key, key)}{' · ' + target if target else ''}", short=SHORT.get(key, key), start=self.lmst, dur=5, tag=tag or "opportunistic")
        b["status"] = "running"; b["start"] = self.lmst; b["end"] = None; self.hud(); return b
    def end_block(self, b, wh=None, mb=None):
        if not b: return
        b["status"] = "done"; b["end"] = self.lmst
        if wh is not None: b["wh"] = wh
        if mb is not None: b["mb"] = mb
        self.hud()
    def drop_block(self, key, target, reason):
        b = next((x for x in self.timeline if x["status"] == "planned" and x["key"] == key and (not target or x.get("target") == target)), None)
        if b: b["status"] = "dropped"; b["reason"] = reason; b["end"] = b["start"] + min(b.get("dur", 5), 20)
        self.hud()
    def reschedule_remaining(self):
        t = self.lmst
        for b in self.timeline:
            if b["status"] == "planned": b["start"] = max(b["start"], t); t = b["start"] + b.get("dur", 5)
        self.hud()

    # ------------------------------------------------------------------ model calls
    def jev(self, client, req, label="jev"):
        self.n_jev += 1; self.view("mind", engine="JEV", text="start", json={"label": label})
        res = call_service(client, req, 60.0)
        self.view("mind", engine="JEV", text="end", json={"label": label})
        raw = res.verdicts.answers_json if hasattr(res, "verdicts") else res.answers_json
        j = json.loads(raw or "{}")
        if "error" in j: raise RuntimeError(j["error"])
        lat = res.verdicts.latency_ms if hasattr(res, "verdicts") else res.latency_ms
        return {"answers": j["answers"], "latencyMs": round(lat), "usage": j.get("usage", {}), "model": j.get("model", ""), "state": j.get("state"), "questions": j.get("questions")}
    def action_call(self, client, goal, on_feedback, timeout=600.0):
        """Send a goal, stream feedback, wait for the result; the goal handle is kept so a health verdict can cancel it."""
        if not client.wait_for_server(timeout_sec=10.0): raise RuntimeError(f"action server {client._action_name} unavailable")
        done = threading.Event(); box = {}
        fut = client.send_goal_async(goal, feedback_callback=lambda fb: on_feedback(fb.feedback))
        def on_accepted(f):
            gh = f.result()
            if not gh.accepted: box["err"] = "goal rejected"; done.set(); return
            with self.claude_lock: self.claude_goal = gh
            rf = gh.get_result_async()
            def on_result(rf2):
                box["res"] = rf2.result(); done.set()
            rf.add_done_callback(on_result)
        fut.add_done_callback(on_accepted)
        if not done.wait(timeout): raise TimeoutError("action timed out")
        with self.claude_lock: self.claude_goal = None
        if "err" in box: raise RuntimeError(box["err"])
        return box["res"].result, box["res"].status

    def claude(self, kind, ctx, _retry=True):
        self.n_claude += 1; self.view("mind", engine="CLAUDE", text="start", json={"label": kind})
        def fb(f):
            self.view("mind_fb", engine="CLAUDE", text=f.phase, json={"phase": f.phase, "turns": f.turns, "consults": f.consults, "elapsed_s": f.elapsed_s, "note": f.last_note})
            self.now("CLAUDE", f"{kind}: {f.phase} · turn {f.turns} · {f.consults} jev consult{'s' if f.consults != 1 else ''} · {f.elapsed_s:.0f} s")
        res, status = self.action_call(self.a_ask, Ask.Goal(kind=kind, ctx_json=jdump(ctx)), fb)
        if not res.ok and res.error == "cancelled" and _retry:
            self.view("mind", engine="CLAUDE", text="end", json={"label": kind + " (cancelled)", "consults": [], "ms": 0})
            self.log("CLAUDE", f"{kind}: cancelled, re-issuing with the current state", "The goal was withdrawn; the same question is asked again against the telemetry as it is now.")
            return self.claude(kind, ctx, _retry=False)
        consults = json.loads(res.consults_json or "[]") if res.ok else []
        self.n_jev += len(consults); self.n_jev_in_claude += len(consults)
        self.view("mind", engine="CLAUDE", text="end", json={"label": kind, "consults": [{"n": c.get("n", 0), "ms": c.get("latency_ms", 0), "note": c.get("note", "")} for c in consults], "ms": res.latency_ms})
        self.hud()
        if not res.ok: raise RuntimeError(res.error)
        return {"output": json.loads(res.output_json), "prompt": res.prompt, "model": res.model, "latencyMs": res.latency_ms, "costUsd": res.cost_usd, "tokens": {"out": res.tokens_out}, "turns": res.turns, "consults": consults}

    def judge(self, kind, args, label):
        r = self.jev(self.c_judge, Judge.Request(kind=kind, args_json=jdump(args)), label=label)
        return r

    # ------------------------------------------------------------------ the mission (behaviour tree)
    def publish_tree(self):
        if self.tree is None: return
        t = TreeState(ascii=tree_ascii(self.tree), active_path=tree_active(self.tree), status=str(self.tree.root.status).split(".")[-1], safety_halt=self.halting, halt_reason=self.halt_reason)
        self.pub_tree.publish(t)

    def run_tree(self):
        """One behaviour tree per sol, ticked at 2 Hz; the safety branch is re-evaluated every tick."""
        self.running = True
        while self.state is None: time.sleep(0.2)
        for s in range(1, int(self.P("sols")) + 1):
            self.sol = s; self.sol_odo = 0.0; self.lmst = 8 * 60; self.timeline = []; self.products = []
            self.energy = CONSTRAINTS["energy_wh"]; self.data = CONSTRAINTS["data_mb"]; self.hud()
            self.emit("sol", "SOL", f"SOL {s} — uplink received · LMST 08:00", {"sol": s, "text": "uplink received · LMST 08:00"})
            self.tree = build_tree(self); self.tree.setup()
            self.log("CODE", "Sol executive: behaviour tree", "<pre style=\"font:10.5px var(--mono);white-space:pre\">" + esc(tree_ascii(self.tree)) + "</pre><div style=\"font-size:11px;color:var(--ink3)\">Selector(no memory): the safety branch is re-checked every tick and preempts the mission; long work runs in threads and reports RUNNING.</div>")
            attempts = 0
            while True:
                self.tree.tick(); self.publish_tree()
                st = self.tree.root.status
                if st == py_trees.common.Status.FAILURE and not self.halting and attempts < 1:
                    attempts += 1
                    self.log("CODE", "Sol tree failed — retrying once", "A leaf reported FAILURE (usually a ground-call timeout); the sol is re-run from planning.")
                    self.tree = build_tree(self); self.tree.setup(); continue
                if st in (py_trees.common.Status.SUCCESS, py_trees.common.Status.FAILURE) and not self.halting: break
                time.sleep(0.5)
            if s < int(self.P("sols")): self.pause(2500)
        self.set_mode("END")
        self.now("CODE", "mission segment complete")
        self.caption("CODE", "End of the three-sol segment. Every plan was Claude's; every fast call was jev's; every rule was code.", 12000)
        self.log("CODE", "Segment complete", f"{self.odo:.0f} m driven over {self.sol} sols. History:<br>" + "<br>".join("• " + esc(h) for h in self.history))
        self.view("done"); self.running = False

    # ---- tree leaves
    def bt_plan(self):
        self.plan_out = self.plan(); return True

    def bt_review(self):
        """Sequence review before uplink: jev verifies every planned activity (serves the sol's intent, order, risk)."""
        o = self.plan_out
        acts = []
        for pt in sorted(o["targets"], key=lambda p: p["priority"]):
            t = self.target(pt["target_id"])
            if not t: continue
            for a in pt["activities"]:
                if a in INSTRUMENTS: acts.append({"name": INSTRUMENTS[a]["name"] + " on " + t["name"], "measures": MEASURES[a], "purpose": pt["rationale"], "arm": INSTRUMENTS[a]["arm"], "key": a, "target": t["name"]})
        if not acts: return True
        self.now("JEV", f"sequence review before uplink — {len(acts)} activities × 3 questions, 1 request")
        self.caption("JEV", "Before the plan is uplinked, jev reviews every activity the way a sequence review board would: serves the intent? in order? acceptable risk now?", 6000)
        plan = {"objective": o["sol_summary"] + " Hypothesis focus: " + o["hypothesis_focus"], "target": "the targets named in the plan", "rover_words": "; ".join(self.rover_words().values()),
                "activities": [{k: a[k] for k in ("name", "measures", "purpose", "arm")} for a in acts]}
        vr = self.jev(self.c_verify, Verify.Request(plan_json=jdump(plan)), label="review")
        VF = self.P("verify_floor"); gates = []
        for i, a in enumerate(acts):
            sv = vr["answers"][f"a{i}__serves_objective"]["noul"]; pr = vr["answers"][f"a{i}__prerequisites_met"]["noul"]; rk = vr["answers"][f"a{i}__risk_acceptable"]["noul"]
            ok = sv >= VF and pr >= VF and rk >= VF
            gates.append({"i": i, "a": a, "serves": sv, "prereq": pr, "risk": rk, "ok": ok, "why": "" if ok else ("does not serve the sol's intent" if sv < VF else "prerequisite not met" if pr < VF else "risk not acceptable now")})
        self.emit("jev_verify", "JEV", f"Sequence review ({len(gates)} activities × 3 questions, 1 request)", {"r": vr, "names": [a["name"] for a in acts], "gates": gates}, f"{vr['latencyMs']} ms")
        dropped = [g for g in gates if not g["ok"]]
        for g in dropped:
            for pt in o["targets"]:
                if g["a"]["key"] in pt["activities"] and self.target(pt["target_id"]) and self.target(pt["target_id"])["name"] == g["a"]["target"]:
                    pt["activities"] = [x for x in pt["activities"] if x != g["a"]["key"]]
            self.drop_block(g["a"]["key"], g["a"]["target"], f"review: {g['why']}")
        self.log("CODE", "Sequence review rule", self.rule(f"each planned activity needs serves ≥ {VF} && prerequisites ≥ {VF} && risk ≥ {VF} before uplink\n→ {len(gates) - len(dropped)} of {len(gates)} uplinked; {len(dropped)} dropped and reported to the planners", fr="FR-10"))
        self.review = gates; return True

    def bt_execute(self):
        self.execute(self.plan_out); return True

    def bt_downlink(self):
        self.downlink(); return True

    # ------------------------------------------------------------------ the mission
    def safe_run_tree(self):
        try: self.run_tree()
        except Exception as e:
            self.get_logger().error(f"run stopped: {e!r}")
            self.log("CODE", "Run stopped", f'<span style="color:var(--hot)">{esc(e)}</span>')

    def safe_run(self):
        try: self.run()
        except Exception as e:
            self.get_logger().error(f"run stopped: {e!r}")
            self.log("CODE", "Run stopped", f'<span style="color:var(--hot)">{esc(e)}</span>')
    def run(self):
        self.running = True
        while self.state is None: time.sleep(0.2)
        for s in range(1, int(self.P("sols")) + 1):
            self.sol = s; self.sol_odo = 0.0; self.lmst = 8 * 60; self.timeline = []
            self.energy = CONSTRAINTS["energy_wh"]; self.data = CONSTRAINTS["data_mb"]; self.hud()
            self.emit("sol", "SOL", f"SOL {s} — uplink received · LMST 08:00", {"sol": s, "text": "uplink received · LMST 08:00"})
            plan = self.plan()
            self.execute(plan)
            self.downlink()
            if s < int(self.P("sols")): self.pause(2500)
        self.set_mode("END")
        self.now("CODE", "mission segment complete")
        self.caption("CODE", "End of the three-sol segment. Every plan was Claude's; every fast call was jev's; every rule was code.", 12000)
        self.log("CODE", "Segment complete", f"{self.odo:.0f} m driven over {self.sol} sols. History:<br>" + "<br>".join("• " + esc(h) for h in self.history))
        self.view("done"); self.running = False

    def ledger_words(self):
        L = self.ledger
        if not L["frames"]: return "none yet (first sol)"
        g = ", ".join(f"{k} {v}x" for k, v in sorted(L["ground"].items(), key=lambda kv: -kv[1])) or "n/a"
        return (f"{L['frames']} camera frames judged; {L['judged']} features classified; {L['obstacles']} obstacles and {L['keepouts']} keep-outs added; "
                f"{L['vetoes']} near-field vetoes before a wheel moved; {L['unsure']} reads below the confidence floor (re-imaged); {L['shadows']} shadows ignored; ground classes seen: {g}")

    # ------------------------------------------------------------------ CLAUDE: plan
    def plan(self):
        self.set_mode("PLANNING"); self.set_camera("overview")
        self.now("CLAUDE", f"planning sol {self.sol} — reading downlink, targets, hypotheses")
        self.caption("CLAUDE", f"Sol {self.sol}: the science team (Claude) writes the tactical plan from the downlink.", 6000)
        standing = ("first sol of the campaign; no contact science yet. Campaign-plan intent for this sol: remote sensing then contact science (WATSON, then PIXL or abrasion as justified) on the nearest Máaz-formation float rock, Máaz, before beginning the traverse toward Artuby ridge." if self.sol == 1
                    else "campaign in progress. Campaign-plan intent for this sol: the traverse toward Rochette on Artuby ridge, with opportunistic science on the way." if self.sol == 2
                    else "campaign in progress; reach and characterise Rochette (abrade; core only if justified), then image the Séítah contact.")
        ctx = {"sol": self.sol, "rover": {"x": self.state.x, "y": self.state.y, "heading": math.degrees(self.state.heading), "tilt": self.tilt},
               "energy_wh": round(self.energy), "data_mb": round(self.data), "minutes": CONSTRAINTS["sol_minutes"], "standing": standing,
               "targets": [{"id": t["id"], "name": t["name"], "description": t["description"], "dist": self.dist(t), "bearing": self.bearing_deg(t), "done": self.done.get(t["id"], [])} for t in TARGETS],
               "terrain_notes": f"Crater-floor pavement, mean slope {self.state.slope_deg:.1f}° locally; scattered float rocks up to ~1.5 m; several bright ripple fields between here and Artuby ridge (keep-out); Navcam shadows are long in the morning.",
               "history": self.history, "jev_ledger": self.ledger_words()}
        r = self.claude("plan", ctx)
        self.emit("claude_plan", "CLAUDE", "Sol plan (tactical planning)", r, f"{r['latencyMs'] / 1000:.1f} s · {r['tokens']['out']} tok out")
        o = r["output"]; self.criteria = o["science_criteria"]
        goal = o["drive"]["goal_target_id"]; self.view("highlight", text=goal)
        items = []
        for pt in sorted(o["targets"], key=lambda p: p["priority"]):
            t = self.target(pt["target_id"])
            if not t: continue
            d = self.dist(t)
            if d > 3 and pt["target_id"] == goal:
                dd = min(d, o["drive"]["max_distance_m"]); items.append({"key": "drive", "target": t["name"], "dur": dd * MIN_PER_M, "wh": round(dd * WH_PER_M), "mb": 12})
            for a in pt["activities"]:
                ins = INSTRUMENTS.get(a)
                if ins: items.append({"key": a, "target": t["name"], "dur": max(ins["minutes"], 8), "wh": ins["wh"], "mb": ins["mb"]})
        items.append({"key": "comm", "target": "", "dur": 30, "wh": 15, "mb": 0})
        self.plan_blocks(items, "plan")
        comm = next((b for b in self.timeline if b["key"] == "comm"), None)
        if comm: comm["start"] = max(comm["start"], 16.5 * 60)
        self.ledger = {"frames": 0, "judged": 0, "obstacles": 0, "keepouts": 0, "vetoes": 0, "unsure": 0, "shadows": 0, "ground": {}}
        self.hud(); self.caption("CLAUDE", o["sol_summary"], 7000); self.pause(3500)
        return o

    # ------------------------------------------------------------------ CODE: execute plan
    def execute(self, plan):
        targets = sorted(plan["targets"], key=lambda p: p["priority"]); goal_id = plan["drive"]["goal_target_id"]; driven = False
        for pt in targets:
            t = self.target(pt["target_id"])
            if not t: continue
            self.maybe_objective()
            d = self.dist(t); needs_arm = any(a not in REMOTE for a in pt["activities"])
            if d <= 3 or (not needs_arm and d <= 40 and all(a == "MastcamZ_multispectral" for a in pt["activities"])):
                self.science(t, pt["activities"], plan); continue
            if pt["target_id"] == goal_id and not driven:
                driven = True
                cap = min(CONSTRAINTS["max_drive_m"], max(plan["drive"]["max_distance_m"], math.ceil(self.dist(t) * 1.25) + 8))
                if cap != plan["drive"]["max_distance_m"]:
                    self.log("CODE", "Drive cap adjusted", self.rule(f"plan max {plan['drive']['max_distance_m']} m < distance to {t['name']} ({self.dist(t):.0f} m) → cap = min({CONSTRAINTS['max_drive_m']}, 1.25 × dist + 8) = {cap} m", fr="FR-02"))
                arrived = self.drive(t, cap, plan["drive"]["constraints"])
                while not arrived and self.drive_end_reason.startswith("paused"):
                    self.maybe_objective(); arrived = self.drive(t, cap, plan["drive"]["constraints"], quiet=True)
                if arrived: self.science(t, pt["activities"], plan)
                else:
                    self.log("CODE", "Drive ended before goal", esc(self.drive_end_reason))
                    for a in pt["activities"]: self.drop_block(a, t["name"], "not reached this sol")
                    break
        if not driven and goal_id != "none" and self.target(goal_id) and self.dist(self.target(goal_id)) > 3:
            t = self.target(goal_id)
            arrived = self.drive(t, plan["drive"]["max_distance_m"], plan["drive"]["constraints"])
            while not arrived and self.drive_end_reason.startswith("paused"):
                self.maybe_objective(); arrived = self.drive(t, plan["drive"]["max_distance_m"], plan["drive"]["constraints"], quiet=True)
            if arrived:
                acts = next((p["activities"] for p in targets if p["target_id"] == goal_id), ["MastcamZ_multispectral"]); self.science(t, acts, plan)
        self.maybe_objective()

    # ------------------------------------------------------------------ CODE + JEV: drive
    def enav(self, goal, reverse=False, lookahead=0):
        res = call_service(self.c_enav, EvaluateArcs.Request(x=float(self.state.x), y=float(self.state.y), heading=float(self.state.heading), goal_x=float(goal["x"]), goal_y=float(goal["y"]), reverse=reverse, lookahead_steps=int(lookahead)), 30.0).eval
        arcs = [{"k": a.k, "blocked": a.blocked or None, "cost": a.cost, "maxTilt": a.max_tilt, "path": [(a.path[i], a.path[i + 1]) for i in range(0, len(a.path), 2)]} for a in res.arcs]
        chosen = arcs[res.chosen] if res.chosen >= 0 else None
        la = [(res.lookahead[i], res.lookahead[i + 1]) for i in range(0, len(res.lookahead), 2)]
        return {"arcs": arcs, "chosen": chosen, "chosenIdx": int(res.chosen), "lookahead": la}
    def enav_card(self, res, note):
        self.emit("enav", "CODE", "ENav arc evaluation", {"arcs": [{"k": a["k"], "blocked": a["blocked"], "cost": a["cost"], "maxTilt": a["maxTilt"]} for a in res["arcs"]], "chosen": res["chosenIdx"], "note": note})

    def drive(self, goal, max_dist, constraints, quiet=False, tag=None, is_objective=False):
        self.set_mode("AUTONAV"); self.set_camera("map")
        self.view("planned", x=goal["x"], y=goal["y"], flag=True)
        blk = self.begin_block("drive", goal["name"], tag)
        self.log("CODE", f"Drive to {goal['name']}", f"Goal {self.dist(goal):.0f} m away, bearing {self.bearing_deg(goal):.0f}°. Max {max_dist} m this sol. Planner constraints: <i>{esc(constraints)}</i>"
                 + self.rule(f"ENav: 9 arcs × 6 m, tilt limit {CONSTRAINTS['keepout_tilt_deg']}°, step limit {CONSTRAINTS['rock_step_limit_m']} m, stereo range 9 m\ncadence: Navcam pair every 6 m -> plan; front Hazcam pair before every segment and mid-arc -> veto; rear pair before any reverse", fr="FR-03") + self.rule(FLIGHT_RULES['FR-04'], fr='FR-06'))
        if not quiet: self.caption("CODE", "AutoNav engaged: ENav evaluates 9 candidate arcs every cycle; jev is asked about anything geometry can't resolve.", 6000)
        since_img, cycles, stuck, sol_driven, wh0 = 99.0, 0, 0, 0.0, self.energy
        self.drive_end_reason = ""; self.last_k = None
        # Science stand-off, measured rather than assumed (tools/arm_collision_eval.mjs).
        # The arm reaches 2.05 m from a shoulder 0.83 m up, and the turret is a 0.84 m disc.
        # At 2.3 m the arm has to stretch out over the rock to reach its top facet and the
        # forearm grazes it: 0 of 10 top placements were collision-free. At 1.6 m the arm
        # comes down steeply and all 10 were clear. Closer than about 1.3 m the rock is
        # under the front wheels and inside the folded arm again.
        stop_r = goal.get("approach", 1.6)
        while self.dist(goal) > stop_r:
            if sol_driven >= max_dist: self.drive_end_reason = f"Reached the planner's max drive distance ({max_dist} m). Rover parks; drive continues next sol."; break
            if self.energy < CONSTRAINTS["energy_wh"] * self.P("energy_margin"): self.drive_end_reason = "Energy at the 15% margin. Rover parks for the sol."; break
            if self.lmst > 17 * 60: self.drive_end_reason = f"End of ops window (LMST 17:00) — {FLIGHT_RULES['FR-01']}"; break
            if self.pending_objective and not is_objective: self.drive_end_reason = "paused for a new science objective"; break
            for ev in EVENTS:
                if ev["id"] not in self.fired and self.odo >= ev["at_odo"]:
                    self.fired.add(ev["id"])
                    if ev["kind"] == "telemetry_fault":
                        pass  # the slip excursion now arrives through /rover/telemetry and the health monitor (below)
                    elif ev["kind"] == "sand_field":
                        sx = self.state.x + math.cos(self.state.heading + 0.15) * 8; sy = self.state.y + math.sin(self.state.heading + 0.15) * 8
                        self.view("sand", x=sx, y=sy, r=5.5); since_img = 99
                    elif ev["kind"] == "shadow_ambiguity": since_img = 99
                    else: self.pending_feature = ev["kind"]
            # continuous health: a stop verdict from jev halts the drive at once (FR-11); ground escalation only if jev says so
            alarm = self.health_alarm
            in_grace = alarm is not None and alarm.fault_class in self.health_grace_classes and (self.odo < self.health_grace_odo or time.time() - self.health_grace_t < 60.0)
            if alarm is not None and time.time() - self.health_alarm_t < 8.0 and not in_grace:
                self.health_alarm = None; self.health_handled = self.health_seq; self.halt_classes = {alarm.fault_class}
                ok = self.fault_from_health(alarm, goal, sol_driven, max_dist)
                # after a handled halt the same class is not re-litigated for the next stretch (the excursion that
                # triggered it is still in the last-two-metres window); a different class is
                self.health_grace_odo = self.odo + 15.0; self.health_grace_t = time.time(); self.health_grace_classes = set(self.halt_classes) | {alarm.fault_class}; self.health_alarm = None
                if not ok:
                    self.drive_end_reason = "Stopped for the sol after anomaly."; self.end_block(blk, wh=round(wh0 - self.energy)); return False
            elif alarm is not None and (time.time() - self.health_alarm_t >= 8.0 or in_grace):
                self.health_alarm = None  # stale (the state it described has passed) or covered by the grace after a handled halt
            if since_img >= 6:
                since_img = 0; cycles += 1
                sun = sun_state(self.lmst)
                feats, cap = self.see()
                if self.pending_feature:
                    f = scripted_feature(self.pending_feature, self.state.x, self.state.y, self.state.heading, sun)
                    if f: feats.insert(0, f)
                    self.pending_feature = None
                for f in feats:
                    if f.get("kind") == "rock" and f.get("h") is not None: self.remember(f, f["h"])
                new = [f for f in feats if not self.already_judged(f)]
                if new: self.classify(new, sun, cap, feats)
                else: self.view("navcam_foot", text=f"frame {cap}: {len(feats)} features, all previously judged")
            # Final approach: inside 7 m the goal rock itself sits in the perception map and would
            # veto every arc that reaches the stand-off. Flight planners command a straight "bump"
            # to the stand-off distance here; so does code, after the Navcam has cleared the ground.
            d_goal = self.dist(goal)
            if d_goal <= 7.0:
                th = self.bearing_to(goal); run = max(0.0, d_goal - stop_r + 0.3)
                n = max(1, math.ceil(run / 0.5))
                path = [(self.state.x + math.cos(th) * min(run, 0.5 * i), self.state.y + math.sin(th) * min(run, 0.5 * i)) for i in range(1, n + 1)]
                self.log("CODE", "Final approach (planned bump)", self.rule(f"goal {d_goal:.1f} m away, inside the 7 m approach zone; Navcam cleared the ground\n→ straight {run:.1f} m to the {stop_r:.1f} m stand-off, then face the target", fr="FR-13"))
                self.view("arc", points=path)
                if self.camera_sweep(path, sun_state(self.lmst), goal=goal, label="camera sweep (approach)"):
                    self.spend(wh=1, minutes=1); continue
                moved = self.follow(path); sol_driven += moved
                self.spend_drive(moved)
                continue
            res = self.enav(goal, lookahead=7)
            blocked_n = sum(1 for a in res["arcs"] if a["blocked"]); labels = list(dict.fromkeys(a["blocked"] for a in res["arcs"] if a["blocked"]))
            if not res["chosen"]:
                stuck += 1
                rev = self.enav(goal, reverse=True)
                if rev["chosen"] and stuck <= 4:
                    self.enav_card(res, f"No safe forward arc ({', '.join(labels[:3])}). Reverse arc κ={rev['chosen']['k']} to open space ({stuck}/4).")
                    self.path_change(f"back up: {labels[0] if labels else 'boxed in'}", labels)
                    if self.hazcam_check("rear_hazcam", rev["chosen"]["path"][:4], sun_state(self.lmst), "rear Hazcams"):
                        self.spend(wh=1, minutes=1); continue
                    self.follow(rev["chosen"]["path"][:4], reverse=True); self.spend(wh=4, minutes=3); continue
                if stuck == 5:
                    # keep-out escape: the rover has ended up inside a keep-out (its own veto or a sand ring around a
                    # science stop) and every arc starts blocked. Shrink those rings to the rover's position so ENav can
                    # leave by the shortest path; the zone stays for everything beyond that radius.
                    inside = [k for k in self.keepouts if math.hypot(k["x"] - self.state.x, k["y"] - self.state.y) < k["r"] + 0.8]
                    if inside:
                        for k in inside: k["r"] = max(1.0, math.hypot(k["x"] - self.state.x, k["y"] - self.state.y) - 0.6)
                        ka = KeepOutArray(); ka.keepouts = [KeepOut(x=float(k["x"]), y=float(k["y"]), r=float(k["r"]), label=k["label"], engine="CODE") for k in self.keepouts]
                        self.pub_ko.publish(ka)
                        self.log("CODE", "Keep-out escape", self.rule(f"rover sits inside {len(inside)} keep-out zone(s) ({', '.join(k['label'] for k in inside)[:80]}) → radii shrunk to the rover's position so ENav can leave by the shortest path", fr="FR-05"))
                        self.caption("CODE", "Keep-out escape: leaving the zone by the shortest path.", 4500, True)
                        continue
                turn = (1 if stuck % 2 else -1) * (math.pi / 5)
                self.enav_card(res, f"No safe arc either way. Turn in place {math.degrees(turn):.0f}° and re-evaluate ({stuck}/10).")
                if stuck > 10:
                    self.drive_end_reason = "ENav found no safe arc after 10 recovery attempts. Rover stops and waits for ground."
                    self.caption("CODE", "ENav: no safe path — stopping for ground assessment", 5000, True); break
                self.turn_in_place(turn); self.spend(wh=6, minutes=4); continue
            stuck = 0
            self.view("future", points=res["lookahead"])
            if not self.perception_noted:
                self.perception_noted = True
                self.log("CODE", "Perception map", f"ENav plans only on rocks the Navcam has measured (<b>{len(self.perceived)}</b> so far) plus jev's keep-outs. Nothing is read from the world's rock list while driving forward; reversing uses the rear Hazcams.")
            self.view("arc", points=res["chosen"]["path"])
            k = res["chosen"]["k"]
            if self.last_k is not None and abs(k - self.last_k) >= 0.05:
                d = "left" if k > self.last_k else "right"
                if labels: self.path_change(f"{d}: {', '.join(labels)}", labels)
                elif abs(k) < abs(self.last_k): self.path_change(f"{d}: clear ahead, straightening toward {goal['name']}", [])
                else: self.path_change(f"{d}: lower-cost arc toward {goal['name']}", [])
            elif self.last_k is None and labels: self.path_change(f"start: avoiding {', '.join(labels)}", labels)
            self.last_k = k
            if blocked_n or cycles % 4 == 1:
                self.enav_card(res, f"chosen κ={k} · cost {res['chosen']['cost']:.2f} · max tilt {res['chosen']['maxTilt']:.1f}° · {blocked_n} of 9 blocked" + (f" ({', '.join(labels)})" if blocked_n else ""))
            # near-field check before the wheels are committed, then again half-way along the segment
            seg = res["chosen"]["path"][:6]; sun_now = sun_state(self.lmst)
            # Whole rig before the wheels are committed, and again half-way along the arc.
            # Every pair images; everything new in the corridor goes to jev in one request.
            if self.camera_sweep(seg, sun_now, goal=goal, label="camera sweep"):
                self.spend(wh=1, minutes=1); continue
            moved = self.follow(seg[:3]); sol_driven += moved; since_img += moved
            self.spend_drive(moved)
            if self.camera_sweep(seg[3:], sun_now, goal=goal, label="camera sweep (mid-arc)"):
                self.spend(wh=1, minutes=1); continue
            moved = self.follow(seg[3:]); sol_driven += moved; since_img += moved
            self.spend_drive(moved)
        self.view("planned"); self.view("future"); self.view("arc")
        self.end_block(blk, wh=round(wh0 - self.energy))
        arrived = self.dist(goal) <= stop_r + 0.5
        if arrived:
            self.drive_end_reason = "arrived"
            self.log("ROVER", f"Arrived at {goal['name']}", f"{sol_driven:.1f} m this drive · odometer {self.odo:.1f} m · tilt {self.tilt:.1f}°")
            self.caption("ROVER", f"Arrived at {goal['name']} — {sol_driven:.0f} m of AutoNav.", 4000)
            self.view("waypoint", x=self.state.x, y=self.state.y, text=f"arrived · {goal['name']}", engine="rover")
            self.turn_in_place(wrap(self.bearing_to(goal) - self.state.heading))
        elif self.drive_end_reason.startswith("paused"):
            blk["status"] = "planned"; blk["dur"] = max(5, blk.get("dur", 5) - (self.lmst - blk["start"]))
        return arrived

    def path_change(self, text, labels):
        jev = any(l.startswith("jev:") or l.startswith("ground:") for l in labels); reversal = text.startswith("back up")
        if not jev and not reversal: return
        key = "|".join(sorted(l for l in labels if l.startswith("jev:") or l.startswith("ground:"))) or text if labels else text
        if self.odo - self.last_wp_odo < 10: return
        if key == self.last_reason and self.odo - self.last_wp_odo < 30: return
        self.last_reason = key; self.last_wp_odo = self.odo
        import re
        text = re.sub(r"rock \d\.\d\d m,? ?", "", text).rstrip(", ")
        engine = "JEV" if jev else "CODE"
        self.view("waypoint", x=self.state.x, y=self.state.y, text=text, engine=engine.lower())
        self.log(engine, "Path change", f'<span style="font-family:var(--mono);font-size:11px">{esc(text)}</span>' + (
            '<div style="font-size:11px;color:var(--ink3);margin-top:3px">Route bent because of a jev verdict, not geometry: ENav\'s arcs are blocked by what jev classified.</div>' if jev else
            '<div style="font-size:11px;color:var(--ink3);margin-top:3px">ENav geometry (ACE tilt / step / cost) — no model involved.</div>'), f"odo {self.odo:.0f} m")

    # ------------------------------------------------------------------ JEV: hazards
    def classify(self, feats, sun, cap, all_feats):
        self.set_mode("AUTONAV · JEV")
        self.now("JEV", f"classifying {len(feats)} Navcam feature{'s' if len(feats) > 1 else ''} — {len(feats) * 4} questions, 1 request")
        self.set_camera("navcam"); self.view("navcam_active", flag=True)
        for f in feats: self.view("mark", x=f["x"], y=f["y"], color="#4fd18b", r=max(0.8, (f.get("h") or f.get("h_est") or 0.5) * 2))
        self.emit("vision_frame", "CODE", f"Navcam frame {cap}: {len(feats)} feature{'s' if len(feats) > 1 else ''} measured", {"feats": feats, "seq": cap}, "perception")
        fa = FeatureArray(); fa.request_id = cap; fa.group = "navcam"
        fa.features = [feature_to_msg(f) for f in feats]
        # usability gate: is this frame good enough to plan on? (words from what perception measured)
        n_all = len(all_feats); shadowed = sum(1 for f in all_feats if f.get("h") is None and f.get("kind") == "rock")
        cov = getattr(self, "last_frame_cov", 1.0); shf = getattr(self, "last_frame_shadow", 0.0)
        cov_w = "stereo matched across nearly all of the near field" if cov > 0.9 else "stereo matched on most of the near field" if cov > 0.7 else "stereo missing on large parts of the near field" if cov > 0.4 else "stereo returned almost nothing in the near field"
        sh_w = "no deep shadow on the ground ahead" if shf < 0.1 else "some deep shadow on the ground ahead" if shf < 0.35 else "much of the ground ahead in deep shadow"
        fw = (f"{cov_w}; {sh_w}; exposure normal, ground texture visible; mast settled; sun {sun['words']}; {n_all} features measured, {shadowed} of them rocks whose relief could not be measured")
        fr_ = self.judge("frame", {"frame_words": fw}, label="frame")
        usable = fr_["answers"]["usable"]["noul"]; why = fr_["answers"]["reason"]["choice"]
        self.ledger.setdefault("frames_unusable", 0)
        if usable < 0.5:
            self.ledger["frames_unusable"] += 1
            self.log("CODE", "Frame usability gate", self.rule(f"jev: P(usable) = {usable:.2f} < 0.50, cause {why} → do not plan on this frame; mast pan and re-image", fr="FR-08"))
            self.caption("JEV", f"Navcam frame judged not usable ({why}, {usable:.2f}) — re-imaging before planning on it.", 4500, True)
            self.mast_sweep(); self.spend(wh=2, minutes=2)
        rocks_seen = [f for f in all_feats if f.get("kind") == "rock" and f.get("h") is not None]
        bright = any(f.get("kind") in ("bright_patch", "sand_field") for f in all_feats)
        ground = ("loose drift material under the wheels now; " if self.state.in_sand else "firm dark pavement under the wheels; ") + \
                 ("a bright fine-grained ripple patch lies in the corridor ahead; " if bright else "") + \
                 (f"{len(rocks_seen)} rocks measured within Navcam range, the largest {max(f['h'] for f in rocks_seen):.2f} m tall" if rocks_seen else "few rocks, mostly smooth ground")
        r = self.jev(self.c_classify, Classify.Request(features=fa, sun_words=sun["words"], ground_words=ground), label="navcam")
        ans = r["answers"]; verdicts = {}; reimage = None
        self.ledger["frames"] += 1; self.ledger["judged"] += len(feats)
        gc = ans.get("ground__class")
        if gc:
            self.ground_class = gc["choice"]; self.slip_pct = SLIP_BY_CLASS.get(gc["choice"], 20.0)
            self.ledger["ground"][gc["choice"]] = self.ledger["ground"].get(gc["choice"], 0) + 1
            self.log("CODE", "Slip budget", self.rule(f"jev: ground ahead = {gc['choice']} (conf {gc['confidence']:.2f}) → predicted slip {self.slip_pct:.0f} % → energy and time per metre × {1 / max(0.3, 1 - self.slip_pct / 100):.2f}", fr="FR-14"))
            self.hud()
        for f in feats:
            i = f["id"]; t = ans[f"{i}__type"]; wh = ans[f"{i}__wheel_hazard"]["noul"]; sk = ans[f"{i}__sinkage"]["noul"]; sc = ans[f"{i}__science"]["noul"]
            if t["confidence"] < self.P("conf_floor"): verdicts[i] = {"cls": "unsure", "text": "UNSURE → re-image"}; reimage = f; continue
            if t["choice"] == "shadow_only": verdicts[i] = {"cls": "", "text": "ignored (shadow)"}
            elif t["choice"] == "dust_devil": verdicts[i] = {"cls": "", "text": "science opportunity" if sc > 0.6 else "ignored"}
            elif sk > 0.5: verdicts[i] = {"cls": "warn", "text": "KEEP-OUT (sinkage)"}
            elif wh > 0.5: verdicts[i] = {"cls": "warn", "text": "OBSTACLE"}
            else: verdicts[i] = {"cls": "", "text": "drive-over ok"}
        self.emit("jev_hazards", "JEV", f"Navcam features classified ({len(feats)} × 4 questions + ground class, 1 request)", {"r": r, "features": feats, "verdicts": verdicts}, f"{r['latencyMs']} ms · {r['usage'].get('input_tokens', 0)} tok")
        self.view("navcam_draw", json={"feats": all_feats, "verdicts": verdicts})
        self.view("navcam_foot", text=f"frame {cap}: {len(feats)} new feature{'s' if len(feats) > 1 else ''} → jev {r['latencyMs']} ms · " + " / ".join(v["text"] for v in verdicts.values()))
        time.sleep(0.9)
        if reimage:
            conf = ans[f"{reimage['id']}__type"]["confidence"]
            self.caption("CODE", f"jev's read on {reimage['id']} is below the {self.P('conf_floor')} floor — code stops and re-images with the mast raised rather than guess.", 5000)
            self.ledger["unsure"] += 1
            self.log("CODE", "Confidence gate", self.rule(f"confidence({reimage['id']}__type) = {conf:.2f} < {self.P('conf_floor')}\n→ halt, mast pan, re-acquire stereo, ask again", fr="FR-08"))
            self.now("CODE", "re-imaging: mast pan for a second stereo pair")
            self.view("waypoint", x=self.state.x, y=self.state.y, text="halt: jev unsure → re-image", engine="code")
            self.mast_sweep(); self.spend(wh=4, mb=6, minutes=6)
            again_all, cap2 = self.see(boost=True)
            again = next((g for g in again_all if g.get("kind") == "rock" and math.hypot(g["x"] - reimage["x"], g["y"] - reimage["y"]) < 1.2), None)
            h_now = (again or {}).get("h") or reimage.get("h_est") or 0.25
            f2 = {**reimage, "h": h_now, "size_words": "", "stereo_note": f"after re-imaging with the mast raised, stereo now shows solid relief, {h_now:.2f} m above the surrounding surface"}
            self.view("navcam_draw", json={"feats": [again] if again else [], "verdicts": {}})
            self.now("JEV", f"re-classifying {reimage['id']} with the new stereo pair")
            fa2 = FeatureArray(); fa2.request_id = cap2; fa2.features = [feature_to_msg(f2)]
            r2 = self.jev(self.c_classify, Classify.Request(features=fa2, sun_words=sun["words"]))
            t2 = r2["answers"][f"{f2['id']}__type"]; wh2 = r2["answers"][f"{f2['id']}__wheel_hazard"]["noul"]
            self.emit("jev_hazards", "JEV", "Navcam features classified (1 × 4 questions, 1 request)", {"r": r2, "features": [f2], "verdicts": {f2["id"]: {"cls": "warn", "text": "OBSTACLE (resolved)"} if wh2 > 0.5 else {"cls": "", "text": "drive-over ok (resolved)"}}}, f"{r2['latencyMs']} ms")
            self.caption("JEV", f"Resolved: {t2['choice']} (conf {t2['confidence']:.2f}), wheel hazard {wh2:.2f} — {'added as an obstacle' if wh2 > 0.5 else 'cleared'}.", 4500)
            if wh2 > 0.5: self.remember(f2, max(h_now, CONSTRAINTS["rock_step_limit_m"]), "jev: hidden rock"); self.view("ring", x=f2["x"], y=f2["y"], r=2.2, color="#ea6a5a")
            else: self.remember(f2, h_now)
            self.judged_spots.append((f2["x"], f2["y"])); time.sleep(0.6)
        for f in feats:
            v = verdicts.get(f["id"])
            if not v: continue
            self.judged_spots.append((f["x"], f["y"]))
            if v["text"].startswith("KEEP-OUT"):
                self.ledger["keepouts"] += 1
                self.add_keepout(f["x"], f["y"], self.P("keepout_r"), "jev: sinkage keep-out", "JEV"); self.view("ring", x=f["x"], y=f["y"], r=6, color="#ea6a5a")
                self.log("CODE", "Keep-out zone", self.rule(f"{f['id']}: sand_ripples, P(sinkage) = {ans[f['id'] + '__sinkage']['noul']:.2f} > 0.50 → 6 m keep-out", fr="FR-05"))
                if f.get("kind") == "sand_field": self.view("sand", x=f["x"], y=f["y"], r=6)
                self.caption("JEV", f"Ripple field flagged for sinkage ({ans[f['id'] + '__sinkage']['noul']:.2f}). ENav adds a 6 m keep-out; the route bends around it.", 5500, True)
            elif v["text"] == "OBSTACLE":
                self.ledger["obstacles"] += 1
                self.remember(f, max(f.get("h") or 0, CONSTRAINTS["rock_step_limit_m"]), "jev: wheel hazard"); self.view("ring", x=f["x"], y=f["y"], r=2, color="#ea6a5a", ttl_ms=30000)
            elif v["text"] == "science opportunity": self.dust_devil_science(f)
            elif v["text"].startswith("ignored"):
                self.ledger["shadows"] += 1
                self.caption("JEV", f"{f['id']}: {ans[f['id'] + '__type']['choice']} — no relief, not an obstacle. Geometry alone would have stopped for it.", 4500)
        self.view("navcam_active", flag=False); self.set_camera("map"); self.set_mode("AUTONAV"); self.now("CODE", "ENav: arc evaluation")

    def dust_devil_science(self, f):
        self.view("dust_devil", x=f["x"], y=f["y"])
        self.caption("JEV", "Dust devil recognised on the horizon — not a hazard, but science. Code schedules the opportunistic MEDA + Navcam movie.", 6000)
        self.log("CODE", "Opportunistic science", self.rule("type == dust_devil && science_interest > 0.6 && data_mb > 60\n→ schedule MEDA_dust (15 min, 8 Wh, 30 Mb)"))
        self.now("ROVER", "MEDA + Navcam dust-devil movie")
        self.view("waypoint", x=self.state.x, y=self.state.y, text="pause: dust devil → MEDA movie (jev)", engine="jev")
        blk = self.begin_block("MEDA_dust", "", "opportunistic")
        self.cmd("look_at", x=f["x"], y=f["y"]); self.mast_sweep(); self.cmd("look_clear")
        result = instrument_result("none", "MEDA_dust")
        self.spend(wh=8, mb=30, minutes=15); self.end_block(blk, wh=8, mb=30)
        self.log("ROVER", "MEDA dust-devil movie returned", esc(result))
        self.history.append(f"Sol {self.sol}: dust-devil movie (MEDA/Navcam) — {result}")

    # ------------------------------------------------------------------ JEV -> CLAUDE: fault
    def fault(self, goal, sol_driven, max_dist):
        self.set_mode("FAULT")
        event = {"phase": "AutoNav drive, mid-arc", "description": "Wheel odometry reports 46% slip over the last 2 m; visual odometry converged; drive motor currents nominal; tilt 5.8°; suspension differential +3°.",
                 "terrain_words": "bright, fine-grained drift material between two embedded rocks; long morning shadows"}
        self.caption("ROVER", "Telemetry flag: 46% wheel slip over the last 2 m.", 4500, True)
        self.now("JEV", "telemetry fault triage — 3 questions")
        r = self.jev(self.c_fault, Fault.Request(phase=event["phase"], description=event["description"], terrain_words=event["terrain_words"]), label="fault")
        self.emit("jev_fault", "JEV", "Telemetry fault triage", {"r": r, "event": event}, f"{r['latencyMs']} ms")
        fc = r["answers"]["fault_class"]; stop = r["answers"]["stop_drive"]["noul"]; ground = r["answers"]["needs_ground"]["noul"]
        stopped = stop > 0.5
        if stopped:
            self.log("CODE", "Onboard rule", self.rule(f"stop_drive = {stop:.2f} > 0.50 → halt drive immediately (no Earth round-trip needed for a halt)", fr="FR-11"))
            self.set_mode("HALTED"); self.view("waypoint", x=self.state.x, y=self.state.y, text=f"halt: {fc['choice']} (jev)", engine="jev")
        escalate = ground > 0.5 or fc["confidence"] < self.P("conf_floor")
        if not escalate:
            self.log("CODE", "Onboard rule", self.rule(f"needs_ground = {ground:.2f} ≤ 0.50 and confidence {fc['confidence']:.2f} ≥ {self.P('conf_floor')}\n→ resume at reduced speed with visual odometry every step"))
            self.speed_factor = 0.6; self.cmd("speed", value=0.6); self.set_mode("AUTONAV · VISODOM"); return True
        self.caption("CODE", f"needs_ground {ground:.2f} > 0.5 → escalate to the ground team (Claude). The rover waits.", 5000)
        self.now("CLAUDE", "anomaly response — diagnosing the slip event"); self.set_camera("science")
        try:
            a = self.claude("anomaly", {"sol": self.sol, "event": event["description"], "terrain": event["terrain_words"],
                                        "triage": {"fault_class": fc["choice"], "confidence": f"{fc['confidence']:.2f}", "stop_drive": f"{stop:.2f}", "needs_ground": f"{ground:.2f}"},
                                        "stopped": stopped, "progress_m": f"{sol_driven:.0f}", "goal_m": f"{min(max_dist, self.dist(goal) + sol_driven):.0f}"})
        except Exception as e:
            self.log("CLAUDE", "Anomaly response unavailable", f'<span style="color:var(--hot)">{esc(e)}</span> — onboard default: resume with visual odometry at reduced speed.')
            self.speed_factor = 0.6; self.cmd("speed", value=0.6); self.set_mode("AUTONAV · VISODOM"); self.set_camera("map"); return True
        self.emit("claude_anomaly", "CLAUDE", "Anomaly response (ground in the loop)", a, f"{a['latencyMs'] / 1000:.1f} s")
        self.caption("CLAUDE", f"{a['output']['action']}: {a['output']['diagnosis']}", 7000); self.pause(2500); self.set_camera("map")
        act = a["output"]["action"]
        self.view("waypoint", x=self.state.x, y=self.state.y, text=f"ground: {act.replace('_', ' ')}", engine="claude")
        if act == "stop_for_sol": return False
        if act == "back_up_and_reroute":
            th = self.state.heading + math.pi
            self.hazcam_check("rear_hazcam", [(self.state.x + math.cos(th) * d, self.state.y + math.sin(th) * d) for d in (1, 2, 3)], sun_state(self.lmst), "rear Hazcams")
            self.back_up(3); self.add_keepout(self.state.x + math.cos(self.state.heading) * 4, self.state.y + math.sin(self.state.heading) * 4, 6, "ground: slip zone", "CLAUDE")
        if act == "reimage_and_reassess": self.mast_sweep()
        self.speed_factor = 1.0 if act == "resume_normal" else 0.6; self.cmd("speed", value=self.speed_factor)
        self.set_mode("AUTONAV · VISODOM" if self.speed_factor < 1 else "AUTONAV"); return True

    # ------------------------------------------------------------------ JEV + CLAUDE: science at a target
    def science(self, t, planned, plan):
        self.set_mode("SCIENCE"); self.set_camera("science")
        seen, cap = self.see(boost=True)
        self.view("navcam_draw", json={"feats": seen, "verdicts": {}})
        self.now("CLAUDE", "reading the Navcam frame — what does the target look like?")
        self.caption("CLAUDE", "Vision belongs to the LLM: Claude reads the actual Navcam frame and describes the target like a field geologist.", 6000)
        visual = None
        png = self.pngs.get(cap)
        try:
            if png is None: raise RuntimeError("no Navcam PNG for this capture")
            self.n_claude += 1; self.view("mind", engine="CLAUDE", text="start", json={"label": "describe"})
            res, _ = self.action_call(self.a_describe, Describe.Goal(frame=png, target_name=t["name"], sol=int(self.sol)),
                                      lambda f: self.view("mind_fb", engine="CLAUDE", text=f.phase, json={"phase": f.phase, "turns": 0, "consults": 0, "elapsed_s": f.elapsed_s, "note": ""}))
            self.view("mind", engine="CLAUDE", text="end", json={"label": "describe", "consults": [], "ms": res.latency_ms}); self.hud()
            if not res.ok: raise RuntimeError(res.error)
            d = {"output": json.loads(res.output_json), "prompt": res.prompt, "model": res.model, "latencyMs": res.latency_ms, "costUsd": res.cost_usd, "consults": []}
            self.emit("claude_describe", "CLAUDE", "Navcam frame read (vision)", {"r": d, "cap": cap}, f"{res.latency_ms / 1000:.1f} s")
            visual = d["output"]; self.caption("CLAUDE", f"Navcam read: {visual['target']['description']}", 7000)
        except Exception as e:
            self.log("CLAUDE", "Navcam read failed", f'<span style="color:var(--hot)">{esc(e)}</span>')
        t_desc = f"{t['description']} Navcam read: {visual['target']['description']}" if visual else t["description"]
        near = [f for f in seen if f.get("kind") == "rock" and f.get("h") is not None and f["h"] > 0.22 and math.hypot(f["x"] - t["x"], f["y"] - t["y"]) > 2.5][:2]
        cands = [{"id": t["id"], "name": t["name"], "description": t_desc, "dist": self.dist(t)}] + [{"id": f"seen_{i}", "name": f"rock in view {i + 1}", "description": f["appearance"], "dist": f["dist"], "x": f["x"], "y": f["y"]} for i, f in enumerate(near)]
        arm = self.rover_words()
        self.now("JEV", f"onboard target selection — {len(cands)} candidates vs. the team's criteria")
        self.caption("JEV", "AEGIS-style: jev scores each visible candidate against Claude's criteria and picks the instrument.", 5500)
        for c in cands:
            if c["id"] != t["id"]: self.view("mark", x=c["x"], y=c["y"], color="#4fd18b", r=1.2, ttl_ms=6000)
        r = self.jev(self.c_aegis, Aegis.Request(candidates_json=jdump(cands), criteria=self.criteria, arm_json=jdump(arm)), label="aegis")
        best = None
        for c in cands:
            m = r["answers"][f"{c['id']}__match"]
            if best is None or m["score"] > best["score"]: best = {"c": c, "score": m["score"], "conf": m["confidence"], "instrument": r["answers"][f"{c['id']}__instrument"]["choice"]}
        self.emit("jev_aegis", "JEV", "Onboard target selection (AEGIS-style)", {"r": r, "candidates": cands, "chosenId": best["c"]["id"]}, f"{r['latencyMs']} ms")
        arm_safe = r["answers"]["arm_deploy_safe"]["noul"]
        chosen_t = t if best["c"]["id"] == t["id"] else None
        acts = list(planned)
        if not chosen_t or best["score"] < 1.5:
            self.log("CODE", "Selection rule", self.rule(f"best match = {best['c']['name']} ({best['score']:.2f}/3){' ≠ planned target' if best['c']['id'] != t['id'] else ''}\n→ " + ("score < 1.5: fall back to the planned target and activities" if best["score"] < 1.5 else "planned target wins ties; onboard pick logged for the science team")))
            chosen_t = t
        elif best["instrument"] != "skip" and best["instrument"] not in acts:
            self.log("CODE", "Selection rule", self.rule(f"jev instrument {best['instrument']} not in plan [{', '.join(acts)}]\n→ plan wins; onboard suggestion appended if budget allows")); acts.append(best["instrument"])
        if any(a not in REMOTE for a in acts) and arm_safe < 0.6:
            self.log("CODE", "Arm rule", self.rule(f"arm_deploy_safe = {arm_safe:.2f} < 0.60 → drop arm activities this sol", fr="FR-09"))
            self.caption("CODE", "Arm deploy not cleared — contact science deferred.", 4500, True)
            for a in [a for a in acts if a not in REMOTE]: self.drop_block(a, t["name"], "arm not cleared")
            acts = [a for a in acts if a in REMOTE]
        self.caption("JEV", f"Selected {best['c']['name']}: match {best['score']:.1f}/3 → {best['instrument']}", 4500); time.sleep(0.8)
        acts = [a for a in acts if a in REMOTE] + [a for a in acts if a not in REMOTE]
        self.log("CODE", "Ordering rule", self.rule("remote sensing → contact science: " + " → ".join(acts), fr="FR-10"))
        interpreted = 0; followups = 0; i = 0
        while i < len(acts):
            self.maybe_objective()
            a = acts[i]
            if not self.activity(chosen_t, a): break
            if (a in REMOTE and interpreted == 0) or a in ("abrade", "PIXL_map", "core"):
                resp = self.interpret(chosen_t, a, best); interpreted += 1
                na = resp["output"]["next_action"]
                if followups < 2 and not acts[i + 1:]:
                    add = "abrade" if na == "abrade" else "core" if na == "core" else "WATSON_closeup" if na == "add_contact_science" else None
                    if add and add not in self.done.get(chosen_t["id"], []):
                        acts.append(add); followups += 1
                        self.log("CODE", "Plan amendment", self.rule(f"Claude next_action = {na} → append {add} (follow-up {followups}/2, budget permitting)"))
                        ins = INSTRUMENTS[add]
                        self.add_block(lane=LANE_OF[add], key=add, target=chosen_t["name"], label=f"{SHORT[add]} · {chosen_t['name']}", short=SHORT[add], start=self.lmst, dur=ins["minutes"], wh=ins["wh"], mb=ins["mb"], tag="plan")
            i += 1
        self.set_camera("map")

    def activity(self, t, key, tag=None):
        ins = INSTRUMENTS.get(key)
        if not ins: return True
        need = ins["wh"] * (1 + self.P("energy_margin"))
        if key == "core":
            # sample defensibility: would the Sample Return Science Board accept this core, on the evidence in hand?
            ev = "; ".join(h for h in self.history if t["name"] in h)[-600:] or "no measurements on this target yet"
            sq = self.judge("sample", {"target_words": t["description"], "evidence_words": f"done on this target: {', '.join(self.done.get(t['id'], [])) or 'nothing'}. {ev}", "campaign_words": CAMPAIGN["goal"]}, label="sample")
            d_ = sq["answers"]["defensible"]["noul"]; miss = sq["answers"]["missing"]["choice"]; coh = sq["answers"]["coherent"]["noul"]
            self.emit("jev_sample", "JEV", "Sample defensibility check (SRSB-style, 3 questions, 1 request)", {"r": sq, "target": t["name"], "defensible": d_, "missing": miss, "coherent": coh}, f"{sq['latencyMs']} ms")
            if d_ < 0.5 or coh < 0.5:
                self.log("CODE", "Sample rule", self.rule(f"defensible {d_:.2f}, coherent {coh:.2f}, missing = {miss} → core NOT committed; {miss} first", fr="FR-10"))
                self.caption("CODE", f"Core withheld: jev finds the sample not yet defensible ({miss}).", 5000, True); self.drop_block(key, t["name"], f"jev: not defensible ({miss})"); return False
            self.log("CODE", "Sample rule", self.rule(f"defensible {d_:.2f} ≥ 0.50, coherent {coh:.2f} ≥ 0.50, missing = {miss} → core committed", fr="FR-10"))
        if self.energy < need or self.data < ins["mb"] or self.lmst + ins["minutes"] > 19 * 60:
            self.log("CODE", "Scheduler", self.rule(f"{key}: needs {ins['wh']} Wh / {ins['mb']} Mb / {ins['minutes']} min; have {round(self.energy)} Wh / {round(self.data)} Mb / until 19:00\n→ dropped (onboard scheduler keeps the margin)", fr="FR-02"))
            self.caption("CODE", f"{ins['name']} dropped by the scheduler: resource margin.", 4500, True); self.drop_block(key, t["name"], "scheduler: margin"); return False
        self.now("ROVER", f"{ins['name']} on {t['name']}")
        self.caption("ROVER", f"{ins['name']} on {t['name']} ({ins['minutes']} min, {ins['wh']} Wh, {ins['mb']} Mb).", 4000)
        blk = self.begin_block(key, t["name"], tag)
        if ins["arm"]:
            if not self.place_arm(t, key):
                self.end_block(blk, wh=0); self.drop_block(key, t["name"], "arm: no cleared placement"); return False
            time.sleep(1.6)
            sp = self.arm_spot; self.cmd("arm_retract", x=sp["x"], y=sp["y"], value=sp["code"]); self.cmd("arm_stow")
        else: self.mast_sweep()
        self.spend(wh=ins["wh"], mb=ins["mb"], minutes=ins["minutes"]); self.end_block(blk, wh=ins["wh"], mb=ins["mb"]); self.reschedule_remaining()
        self.done.setdefault(t["id"], []).append(key)
        self.products.append({"id": f"p{len(self.products)}", "instrument": SHORT.get(key, key), "target": t["name"], "mb": float(ins["mb"]),
                              "content": f"{ins['name']} of {t['name']}: {instrument_result(t['id'], key, t)[:140]}", "size_words": "small" if ins["mb"] < 30 else "medium" if ins["mb"] < 50 else "large"})
        self.log("ROVER", f"{ins['name']} complete", f"{esc(t['name'])} · LMST now {hhmm(self.lmst)}")
        return True


    # ------------------------------------------------------------------ arm placement (code geometry -> jev -> code -> jev -> contact)
    INSTRUMENT_WORDS = {"WATSON_closeup": "WATSON close-up imager: needs a facet within a few degrees of square to the camera at a standoff of a few centimetres",
                        "PIXL_map": "PIXL X-ray fluorescence head: needs a flat, clean facet it can hold square for hours at a two-centimetre standoff",
                        "abrade": "abrasion tool with the dust-removal tool: needs a flat, coherent facet it can press against squarely",
                        "core": "coring drill: needs a flat, coherent facet it can press against squarely with the stabilisers on the rock"}
    SPOT_CODES = {"top": 0, "near_face": 1, "left_flank": 2, "right_flank": 3}

    def placement_spots(self, t):
        desc = t["description"].lower()
        m_ = re.search(r"(\d+(?:\.\d+)?)\s*m across", desc); d = float(m_.group(1)) if m_ else (1.0 if "briefcase" in desc else 0.9)
        h = t.get("h") or 0.45 * d
        smooth = any(k in desc for k in ("slab", "rounded", "blocky", "briefcase", "pavement"))
        dust = "dust-coated" if ("coated" in desc and "thin" not in desc and "partly" not in desc) else "partly dust-coated" if ("coated" in desc or "dust" in desc) else "clean surface"
        rough = "pitted, rough" if "pitted" in desc or "vesicular" in desc else "smooth" if smooth else "blocky, uneven"
        sun = sun_state(self.lmst); hd = self.state.heading
        sun_az = math.pi if sun["shadow_dir"] == "west" else 0.0  # morning: sun in the east (shadows west); afternoon: sun in the west
        rel = (sun_az - hd + math.pi) % (2 * math.pi) - math.pi  # sun direction relative to the rover heading
        shoulder = self.dist(t) - 1.15  # the shoulder sits about 1.15 m ahead of the rover centre
        spots = []
        for name, code in self.SPOT_CODES.items():
            if name == "top":
                reach, height = shoulder, h; att = "near-horizontal top facet" if smooth else "sloping, uneven top"; light = "well lit" if not sun["low"] else "low sun, raking light"
            elif name == "near_face":
                reach, height = shoulder - d / 2, h / 2; att = "steep, near-vertical face turned toward the rover"; light = "lit" if abs(rel) > math.pi / 2 else "in the rock's own shadow"
            else:
                reach, height = math.hypot(shoulder, d / 2), 0.4 * h; att = "sloping flank"; light = "lit" if (rel < 0) == (name == "left_flank") else "in shadow"
            reach_w = "well inside the arm workspace" if reach < 1.7 else "inside the arm workspace" if reach < 1.95 else "near the edge of the arm workspace" if reach < 2.1 else "beyond the arm workspace"
            words = f"{att}; {reach_w}; {light}; {dust}; {rough}; about {max(0.05, height):.1f} m above the ground"
            spots.append({"id": name, "code": code, "words": words, "reach": reach, "x": t["x"], "y": t["y"]})
        return spots

    def workspace_words(self, spot, done):
        err_mm = (done.get("err", 0.0) or 0.0) * 1000; tilt = done.get("tilt", 0.0) or 0.0
        sol = "placement solution reaches the spot" if err_mm < 20 else "placement solution short of the spot by a few centimetres" if err_mm < 80 else "the arm cannot reach the spot"
        tw = "surface within a few degrees of level" if tilt < 12 else "surface tilted noticeably" if tilt < 30 else "surface steeply tilted"
        # The clearance line used to be the constant "nothing else within the turret's clearance".
        # It is now a measurement: the simulator checks the solved pose against capsules for
        # every arm link and spheres for every rock perception measured, and reports the
        # smallest gap. Only the instrument face is allowed to touch anything.
        return f"turret hovering about thirty centimetres over the {spot['id'].replace('_', ' ')}; {sol}; {tw}; {done.get('note') or 'no workspace report'}"

    def place_arm(self, t, key):
        ins = INSTRUMENTS[key]; iw = self.INSTRUMENT_WORDS.get(key, ins["name"])
        self.cmd("arm_instrument", value={"WATSON_closeup": 0, "PIXL_map": 1}.get(key, 2))
        spots = self.placement_spots(t)
        self.now("JEV", f"arm placement — {len(spots)} candidate spots on {t['name']}")
        self.caption("JEV", "Code proposes placement spots from the rock's geometry; jev scores each for the instrument and flags collision risk.", 5500)
        r = self.judge("placement", {"spots": {s["id"]: s["words"] for s in spots}, "instrument_words": iw, "rover_words": "; ".join(self.rover_words().values())}, label="placement")
        for s in spots:
            s["score"] = r["answers"][f"{s['id']}__quality"]["score"]; s["conf"] = r["answers"][f"{s['id']}__quality"]["confidence"]; s["collision"] = r["answers"][f"{s['id']}__collision"]["noul"]
            s["ok"] = s["score"] >= 1.25 and s["collision"] < 0.5 and s["reach"] < 2.1
        ranked = sorted([s for s in spots if s["ok"]], key=lambda s: -s["score"])
        chosen = ranked[0]["id"] if ranked else None
        self.emit("jev_placement", "JEV", f"Arm placement — jev scores {len(spots)} candidate spots ({len(spots) * 2} questions, 1 request)", {"r": r, "spots": spots, "chosen": chosen, "instrument": SHORT.get(key, key), "target": t["name"]}, f"{r['latencyMs']} ms")
        self.view("spots", json=jdump([{"x": s["x"], "y": s["y"], "code": s["code"], "ok": s["ok"], "chosen": s["id"] == chosen} for s in spots]), ttl_ms=40000)
        if not ranked:
            self.log("CODE", "Placement rule", self.rule("no spot with quality ≥ 1.25 and collision risk < 0.50 inside the workspace → no contact science on this target this sol", fr="FR-09"))
            self.caption("CODE", "No acceptable placement — contact science deferred.", 4500, True); return False
        self.log("CODE", "Placement rule", self.rule(f"best spot = {chosen} (quality {ranked[0]['score']:.2f}/3, collision {ranked[0]['collision']:.2f}) → unstow, hover, check, then contact", fr="FR-09"))
        self.caption("ROVER", "Arm unstowing.", 2500); self.cmd("arm_unstow")
        for attempt, spot in enumerate(ranked[:2]):
            self.now("ROVER", f"arm to the {spot['id'].replace('_', ' ')} of {t['name']} — hover")
            self.caption("ROVER", f"Turret to the {spot['id'].replace('_', ' ')}: hover thirty centimetres above the surface.", 3500)
            self.cmd("arm_preplace", x=spot["x"], y=spot["y"], value=spot["code"]); done = dict(self.last_done)
            words = self.workspace_words(spot, done)
            # Geometry is code's job, not a judgment call: if the solved pose puts a link of
            # the arm inside a rock perception has measured, there is nothing to ask jev about.
            if "COLLISION" in (done.get("note") or ""):
                self.log("CODE", "Arm collision rule",
                         self.rule("a link of the arm other than the instrument face would enter a measured rock -> do not contact; try the next spot\n" + (done.get("note") or ""), fr="FR-09"))
                self.caption("CODE", "Placement rejected by the arm collision model.", 4000, True)
                continue
            self.now("JEV", "pre-contact check from the hover position")
            self.caption("JEV", "Before contact: jev reads the workspace in words — solution error, surface tilt, clearance — and says go or not.", 5000)
            r2 = self.judge("contact", {"workspace_words": words, "instrument_words": iw}, label="contact")
            safe = r2["answers"]["safe_to_contact"]["noul"]; good = r2["answers"]["good_data"]["noul"]; adj = r2["answers"]["adjust"]["choice"]
            self.emit("jev_contact", "JEV", f"Pre-contact check — {spot['id'].replace('_', ' ')} (3 questions, 1 request)", {"r": r2, "spot": spot["id"], "words": words, "safe": safe, "good": good, "adjust": adj, "target": t["name"]}, f"{r2['latencyMs']} ms")
            can_shift = attempt == 0 and len(ranked) > 1
            if safe >= 0.5 and adj != "abort" and not (adj == "shift" and can_shift):
                self.log("CODE", "Contact rule", self.rule(f"safe_to_contact {safe:.2f} ≥ 0.50, good_data {good:.2f}, adjust = {adj}" + (" (no other acceptable spot)" if adj == "shift" else "") + " → lower to contact", fr="FR-09"))
                self.caption("ROVER", f"Contact: {ins['name']} on the {spot['id'].replace('_', ' ')}.", 4000)
                self.cmd("arm_contact", x=spot["x"], y=spot["y"], value=spot["code"]); self.arm_spot = spot; return True
            self.log("CODE", "Contact rule", self.rule(f"safe_to_contact {safe:.2f}, adjust = {adj} → " + ("try the next spot" if can_shift and adj != "abort" else "no contact this sol"), fr="FR-09"))
            self.caption("CODE", "Contact not cleared by jev from the hover position.", 4000, True)
            if adj == "abort": break
        self.cmd("arm_stow"); return False

    def interpret(self, t, instrument, best):
        self.now("CLAUDE", f"interpreting {instrument} data from {t['name']}")
        self.caption("CLAUDE", f"Data down. The science team (Claude) reads the {INSTRUMENTS[instrument]['name']} result against the hypotheses.", 5500)
        prior = [h for h in self.history if t["name"] in h]
        result = instrument_result(t["id"], instrument, t)
        try:
            r = self.claude("interpret", {"sol": self.sol, "target": {"id": t["id"], "name": t["name"], "description": t["description"]}, "instrument": instrument, "criteria": self.criteria,
                                          "match_words": f"{best['score']:.1f} of 3 (confidence {best['conf']:.2f})" if best and best["c"]["id"] == t["id"] else "n/a", "prior": prior,
                                          "range_m": f"{self.dist(t):.1f}", "energy_wh": round(self.energy), "data_mb": round(self.data), "minutes": max(0, round(19 * 60 - self.lmst)),
                                          "arm_available": self.dist(t) <= 3, "result": result})
            r["result"] = result
        except Exception as e:
            self.log("CLAUDE", "Interpretation unavailable", f'<span style="color:var(--hot)">{esc(e)}</span><div style="font-size:11px;color:var(--ink3);margin-top:4px">Code falls back to continue_plan; the data are kept for the next downlink.</div>')
            self.caption("CODE", "Ground interpretation unavailable this pass — continuing the uplinked plan.", 4500, True)
            return {"output": {"interpretation": "unavailable", "lithology_call": "pending", "confidence": "low", "hypothesis_impact": "pending", "next_action": "continue_plan", "updated_science_criteria": "", "rationale": "ground link"}}
        self.emit("claude_interpret", "CLAUDE", "Science interpretation", {"r": r, "target": {"name": t["name"]}, "instrument": instrument}, f"{r['latencyMs'] / 1000:.1f} s")
        o = r["output"]; self.caption("CLAUDE", f"{o['lithology_call']} ({o['confidence']}) → {o['next_action']}", 6500)
        self.criteria = o.get("updated_science_criteria") or self.criteria
        self.history.append(f"Sol {self.sol}: {instrument} on {t['name']} → {o['lithology_call']} ({o['confidence']}); {o['hypothesis_impact']}")
        self.pause(2500); return r

    # ------------------------------------------------------------------ USER -> CLAUDE -> JEV -> CODE -> CLAUDE
    def maybe_objective(self):
        if not self.pending_objective: return
        o = self.pending_objective; self.pending_objective = None; self.objective_flow(o)

    def objective_flow(self, o):
        pick, text = o["pick"], o["text"]
        target = {"id": pick["id"], "name": pick.get("name") or "picked rock", "description": pick["description"], "x": pick["x"], "y": pick["y"], "approach": 2.9}
        self.set_mode("OBJECTIVE"); self.set_camera("overview")
        self.now("CLAUDE", "assessing the new objective against the sol envelope")
        self.caption("CLAUDE", "The science team (Claude) weighs the objective: worth it? which instruments? what does it displace?", 6000)
        remaining = [f"{b['label']} ({b.get('wh', 0)} Wh, {round(b.get('dur', 0))} min)" for b in self.timeline if b["status"] == "planned"]
        try:
            r = self.claude("objective", {"sol": self.sol, "lmst": hhmm(self.lmst), "objective": text, "target": {"description": target["description"], "dist": self.dist(target), "bearing": self.bearing_deg(target)},
                                          "rover_words": "; ".join(self.rover_words().values()), "energy_wh": round(self.energy), "data_mb": round(self.data), "minutes": max(0, round(19 * 60 - self.lmst)),
                                          "remaining_plan": remaining, "history": self.history})
        except Exception as e:
            self.log("CLAUDE", "Objective assessment unavailable", f'<span style="color:var(--hot)">{esc(e)}</span>'); self.set_mode("AUTONAV"); return
        self.emit("claude_objective", "CLAUDE", "Objective assessment & plan", r, f"{r['latencyMs'] / 1000:.1f} s")
        o_ = r["output"]; self.caption("CLAUDE", f"{o_['worth_it'].upper()}: {o_['assessment']}", 7000)
        rec = {"text": text, "pick": pick, "plan": o_, "results": [], "dropped": [], "spent0": {"wh": self.energy, "mb": self.data, "min": self.lmst}}; self.objectives.append(rec)
        if o_["worth_it"] == "no":
            self.log("CODE", "Objective declined", "Claude judged it not worth the resources; nothing scheduled."); self.set_mode("AUTONAV"); return
        acts = [a for a in o_["activities"] if a["instrument"] in INSTRUMENTS]
        self.now("JEV", f"verifying {len(acts)} planned activities — {len(acts) * 3} questions, 1 request")
        self.caption("JEV", "Before anything is scheduled, jev checks every step: serves the objective? prerequisites met? risk acceptable?", 6000)
        plan = {"objective": text, "target": target["description"], "rover_words": "; ".join(self.rover_words().values()),
                "activities": [{"name": INSTRUMENTS[a["instrument"]]["name"], "measures": MEASURES[a["instrument"]], "purpose": a["purpose"], "arm": INSTRUMENTS[a["instrument"]]["arm"]} for a in acts]}
        vr = self.jev(self.c_verify, Verify.Request(plan_json=jdump(plan)), label="verify")
        VF = self.P("verify_floor"); gates = []
        for i, a in enumerate(acts):
            s = vr["answers"][f"a{i}__serves_objective"]["noul"]; p = vr["answers"][f"a{i}__prerequisites_met"]["noul"]; k = vr["answers"][f"a{i}__risk_acceptable"]["noul"]
            ok = s >= VF and p >= VF and k >= VF
            gates.append({"i": i, "a": a, "serves": s, "prereq": p, "risk": k, "ok": ok, "why": "" if ok else ("does not serve the objective" if s < VF else "prerequisite not met" if p < VF else "risk not acceptable now")})
        self.emit("jev_verify", "JEV", f"Plan verification ({len(gates)} activities × 3 questions, 1 request)", {"r": vr, "names": [INSTRUMENTS[a["instrument"]]["name"] for a in acts], "gates": gates}, f"{vr['latencyMs']} ms")
        self.log("CODE", "Verification rule", self.rule(f"each activity needs serves ≥ {VF} && prerequisites ≥ {VF} && risk ≥ {VF}\n→ {sum(1 for g in gates if g['ok'])} of {len(gates)} committed to the timeline; the rest are dropped and reported", fr="FR-12"))
        for g in gates:
            if not g["ok"]: rec["dropped"].append(f"{INSTRUMENTS[g['a']['instrument']]['name']}: {g['why']} ({g['serves']:.2f}/{g['prereq']:.2f}/{g['risk']:.2f})")
        items = []
        if o_["approach_required"] and self.dist(target) > 3: items.append({"key": "drive", "target": target["name"], "dur": self.dist(target) * MIN_PER_M, "wh": round(self.dist(target) * WH_PER_M), "mb": 0})
        for g in gates:
            ins = INSTRUMENTS[g["a"]["instrument"]]; items.append({"key": g["a"]["instrument"], "target": target["name"], "dur": max(ins["minutes"], 8), "wh": ins["wh"], "mb": ins["mb"], "verify": {"serves": g["serves"], "prereq": g["prereq"], "risk": g["risk"]}})
        self.plan_blocks(items, "objective")
        for g in gates:
            if not g["ok"]: self.drop_block(g["a"]["instrument"], target["name"], f"jev: {g['why']}")
        self.reschedule_remaining(); self.pause(2500)
        committed = [g for g in gates if g["ok"]]
        if not committed: self.caption("CODE", "Nothing survived verification; objective reported as not executed.", 5000, True)
        else:
            if self.dist(target) > 3 and (o_["approach_required"] or any(INSTRUMENTS[g["a"]["instrument"]]["arm"] for g in committed)):
                arrived = self.drive(target, 80, "approach drive to the picked rock; park inside arm reach", quiet=True, tag="objective", is_objective=True)
                if not arrived:
                    rec["dropped"].append(f"approach drive did not reach the rock ({self.drive_end_reason})")
                    self.log("CODE", "Approach ended short", f"{esc(self.drive_end_reason)} — {self.dist(target):.1f} m from the rock. Remote instruments still run from here; arm activities are dropped.")
            self.set_mode("OBJECTIVE · SCIENCE"); self.set_camera("science")
            ordered = [g for g in committed if g["a"]["instrument"] in REMOTE] + [g for g in committed if g["a"]["instrument"] not in REMOTE]
            for g in ordered:
                ins = INSTRUMENTS[g["a"]["instrument"]]
                if ins["arm"] and self.dist(target) > 3: rec["dropped"].append(f"{ins['name']}: target out of arm reach"); self.drop_block(g["a"]["instrument"], target["name"], "out of reach"); continue
                if not self.activity(target, g["a"]["instrument"], "objective"): rec["dropped"].append(f"{ins['name']}: scheduler margin"); continue
                result = instrument_result(target["id"], g["a"]["instrument"], {"description": target["description"]})
                rec["results"].append({"instrument": ins["name"], "result": result})
                self.log("ROVER", f"{ins['name']} data", f'<div style="font-size:11.5px;color:var(--ink2);border-left:2px solid var(--line2);padding-left:8px">{esc(result)}</div>')
        self.now("CLAUDE", "writing the objective report")
        self.caption("CLAUDE", "Data in hand — the science team (Claude) writes the report for the requester.", 5000)
        spent = f"{round(rec['spent0']['wh'] - self.energy)} Wh, {round(rec['spent0']['mb'] - self.data)} Mb, {round(self.lmst - rec['spent0']['min'])} min"
        try:
            rep = self.claude("report", {"sol": self.sol, "objective": text, "target": {"description": target["description"]}, "expected_evidence": o_["expected_evidence"], "results": rec["results"], "dropped": rec["dropped"], "spent": spent})
        except Exception as e:
            self.log("CLAUDE", "Report unavailable", f'<span style="color:var(--hot)">{esc(e)}</span>'); self.set_camera("map"); self.set_mode("AUTONAV"); return
        self.emit("claude_report", "CLAUDE", "Objective report", {"r": rep, "objective": text}, f"{rep['latencyMs'] / 1000:.1f} s")
        ro = rep["output"]; self.caption("CLAUDE", f"REPORT — {ro['answer'].upper()} ({ro['confidence']}): {ro['headline']}", 9000)
        self.history.append(f"Sol {self.sol}: user objective \"{text[:60]}…\" → {ro['answer']} ({ro['confidence']}): {ro['headline']}")
        self.pause(4000); self.set_camera("map"); self.set_mode("AUTONAV")

    # ------------------------------------------------------------------ downlink
    def downlink(self):
        self.set_mode("DOWNLINK"); blk = self.begin_block("comm", "")
        # jev orders the data products by what the team needs next; code fills the pass within the budget
        budget = max(0.0, float(CONSTRAINTS["data_mb"]) - float(self.P("downlink_reserve_mb")))
        if self.products:
            self.now("JEV", f"downlink prioritisation — {len(self.products)} data products vs the hypotheses")
            hyp = " ".join(CAMPAIGN["hypotheses"]) + " Tomorrow's intent: " + (self.plan_out or {}).get("sol_summary", "")
            r = self.judge("downlink", {"products": self.products, "hypotheses_words": hyp}, label="downlink")
            for p_ in self.products:
                a = r["answers"].get(f"{p_['id']}__value", {}); p_["score"] = float(a.get("score", 0.0)); p_["rationale"] = f"level {p_['score']:.1f}/3 · conf {float(a.get('confidence', 0)):.2f}"
            ordered = sorted(self.products, key=lambda p_: -p_["score"]); used = 0.0; q = DownlinkQueue(sol=int(self.sol), budget_mb=float(budget))
            for i, p_ in enumerate(ordered, 1):
                send = used + p_["mb"] <= budget; used += p_["mb"] if send else 0.0
                q.products.append(DataProduct(id=p_["id"], instrument=p_["instrument"], target=p_["target"], mb=float(p_["mb"]), science_score=float(p_["score"]), rationale=p_["rationale"], priority=i, sent=send))
            q.queued_mb = float(used); self.pub_dl.publish(q)
            self.emit("jev_downlink", "JEV", f"Downlink prioritisation ({len(self.products)} products × 1 score, 1 request)", {"r": r, "queue": [{"id": p.id, "instrument": p.instrument, "target": p.target, "mb": p.mb, "score": p.science_score, "priority": p.priority, "sent": p.sent} for p in q.products], "budget": budget, "used": used}, f"{r['latencyMs']} ms")
            self.log("CODE", "Downlink rule", self.rule(f"order by jev score, fill {budget:.0f} Mb (300 Mb pass minus {self.P('downlink_reserve_mb'):.0f} Mb engineering reserve)\n→ {sum(1 for p in q.products if p.sent)} of {len(q.products)} products this pass, {used:.0f} Mb; the rest wait for the next pass", fr="FR-02"))
        self.now("ROVER", "relay pass — downlink to Earth via MRO")
        used_wh = round(CONSTRAINTS["energy_wh"] - self.energy); used_mb = round(CONSTRAINTS["data_mb"] - self.data)
        self.caption("ROVER", f"Sol {self.sol} ends: {used_mb} Mb downlinked, {used_wh} Wh used, {self.sol_odo:.0f} m driven.", 5000)
        self.log("ROVER", f"Sol {self.sol} downlink", f"Used {used_wh} Wh · {used_mb} Mb · LMST {hhmm(self.lmst)}. Position {self.state.x:.0f} E, {self.state.y:.0f} N.")
        self.spend(wh=15, minutes=30); self.end_block(blk, wh=15)
        for b in self.timeline:
            if b["status"] == "planned": b["status"] = "dropped"; b["reason"] = "not reached this sol"
        self.hud(); self.pause(2000)


def main():
    rclpy.init(); n = SolExecutive()
    ex = MultiThreadedExecutor(num_threads=8); ex.add_node(n)
    try: ex.spin()
    except KeyboardInterrupt: pass
    rclpy.shutdown()
