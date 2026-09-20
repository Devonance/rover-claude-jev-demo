"""System One judgment as ROS 2 services. jev (TypeSafe) answers narrow typed questions
over a filtered state; the question sets are the same as the browser version. The API key
stays in this node (TYPESAFE_API_KEY or a .env next to the repo)."""
import json, os, time
import requests
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from jezero_msgs.srv import Classify, Aegis, Fault, Verify, Judge
from jezero_msgs.msg import Verdict, VerdictArray
from .questions import hazard_questions, hazcam_questions, aegis_questions, fault_questions, verify_questions, frame_questions, downlink_questions, sample_questions, health_questions, placement_questions, contact_questions
from .common import feature_from_msg

ENDPOINT = "https://api.typesafe.ai/v1/systemone"


def load_key():
    k = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if k:
        return k
    # TYPESAFE_API_KEY in the environment is the normal path. Failing that, look for a
    # .env in this repo, its parent, or wherever JEZERO_ENV_DIR points. No absolute paths.
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", "..", ".."))
    for d in [x for x in (os.environ.get("JEZERO_ENV_DIR"), repo, os.path.dirname(repo)) if x]:
        f = os.path.join(d, ".env")
        if os.path.exists(f):
            for line in open(f, encoding="utf-8"):
                if line.strip().startswith("TYPESAFE_API_KEY"):
                    return line.split("=", 1)[1].strip().strip("\"'")
    return ""


class JevJudge(Node):
    def __init__(self):
        super().__init__("jev_judge")
        self.declare_parameter("model", "jev-latest")
        self.model = self.get_parameter("model").value
        self.key = load_key()
        if not self.key:
            self.get_logger().error("no TYPESAFE_API_KEY; jev services will fail")
        cb = ReentrantCallbackGroup()
        self.create_service(Classify, "/jev/classify", self.classify, callback_group=cb)
        self.create_service(Aegis, "/jev/aegis", self.aegis, callback_group=cb)
        self.create_service(Fault, "/jev/fault", self.fault, callback_group=cb)
        self.create_service(Verify, "/jev/verify", self.verify, callback_group=cb)
        self.create_service(Judge, "/jev/judge", self.judge, callback_group=cb)
        self.get_logger().info(f"jev_judge up ({self.model}); services /jev/classify /jev/aegis /jev/fault /jev/verify /jev/judge (frame|downlink|sample|health)")

    def call(self, state, questions):
        body = {"state": state, "model": self.model, "questions": questions}
        last = None
        for attempt in range(4):
            t0 = time.time()
            try:
                r = requests.post(ENDPOINT, json=body, headers={"Authorization": f"Bearer {self.key}"}, timeout=30)
            except requests.RequestException as e:
                last = e; time.sleep(0.4 * 2 ** attempt); continue
            ms = (time.time() - t0) * 1000
            if r.ok:
                j = r.json(); j["latency_ms"] = ms; return j
            if r.status_code in (429, 529):
                last = RuntimeError(f"{r.status_code}: {r.text[:200]}"); time.sleep(0.4 * 2 ** attempt); continue
            raise RuntimeError(f"TypeSafe {r.status_code}: {r.text[:300]}")
        raise last or RuntimeError("TypeSafe request failed")

    def classify(self, req, res):
        feats = [feature_from_msg(m) for m in req.features.features]
        out = VerdictArray(); out.header = req.features.header
        if not feats:
            res.verdicts = out; return res
        group = req.features.group or "navcam"
        near_field = group.endswith("hazcam") or group.endswith("hazcam_b") or group == "sweep"
        state, q = hazcam_questions(feats, group, req.sun_words) if near_field else hazard_questions(feats, req.sun_words, req.ground_words or None)
        try:
            j = self.call(state, q)
        except Exception as e:
            self.get_logger().error(f"classify failed: {e}"); out.answers_json = json.dumps({"error": str(e)}); res.verdicts = out; return res
        ans = j["answers"]
        out.latency_ms = float(j["latency_ms"]); out.input_tokens = int(j.get("usage", {}).get("input_tokens", 0))
        out.answers_json = json.dumps({"answers": ans, "state": state, "questions": q, "usage": j.get("usage", {}), "model": j.get("model", self.model)})
        for f in feats:
            i = f["id"]; t = ans[f"{i}__type"]
            v = Verdict(id=i, feature_type=t["choice"], type_confidence=float(t["confidence"]),
                        wheel_hazard=float(ans[f"{i}__wheel_hazard"]["noul"]), sinkage_risk=float(ans[f"{i}__sinkage"]["noul"]),
                        science_interest=float(ans[f"{i}__science"]["noul"]))
            out.verdicts.append(v)
        self.get_logger().info(f"[{group}] classified {len(feats)} features in {out.latency_ms:.0f} ms: " + ", ".join(f"{v.id}={v.feature_type}({v.type_confidence:.2f}) wheel {v.wheel_hazard:.2f}" for v in out.verdicts))
        res.verdicts = out
        return res

    def _generic(self, builder, args, res, what):
        state, q = builder(*args)
        try:
            j = self.call(state, q)
        except Exception as e:
            self.get_logger().error(f"{what} failed: {e}"); res.answers_json = json.dumps({"error": str(e)}); return res
        res.latency_ms = float(j["latency_ms"])
        res.answers_json = json.dumps({"answers": j["answers"], "state": state, "questions": q, "usage": j.get("usage", {}), "model": j.get("model", self.model)})
        self.get_logger().info(f"{what}: {len(q)} questions in {res.latency_ms:.0f} ms")
        return res

    def aegis(self, req, res):
        return self._generic(aegis_questions, (json.loads(req.candidates_json), req.criteria, json.loads(req.arm_json)), res, "aegis")

    def fault(self, req, res):
        return self._generic(fault_questions, (req.phase, req.description, req.terrain_words), res, "fault triage")

    def judge(self, req, res):
        a = json.loads(req.args_json or "{}")
        builders = {"frame": lambda: frame_questions(a["frame_words"]),
                    "downlink": lambda: downlink_questions(a["products"], a["hypotheses_words"]),
                    "sample": lambda: sample_questions(a["target_words"], a["evidence_words"], a["campaign_words"]),
                    "health": lambda: health_questions(a["summary_words"]),
                    "placement": lambda: placement_questions(a["spots"], a["instrument_words"], a["rover_words"]),
                    "contact": lambda: contact_questions(a["workspace_words"], a["instrument_words"])}
        if req.kind not in builders:
            res.answers_json = json.dumps({"error": f"unknown kind {req.kind}"}); return res
        return self._generic(builders[req.kind], (), res, f"judge[{req.kind}]")

    def verify(self, req, res):
        return self._generic(verify_questions, (json.loads(req.plan_json),), res, "plan verification")


def main():
    rclpy.init(); n = JevJudge()
    ex = rclpy.executors.MultiThreadedExecutor(num_threads=4); ex.add_node(n)
    try: ex.spin()
    except KeyboardInterrupt: pass
    rclpy.shutdown()
