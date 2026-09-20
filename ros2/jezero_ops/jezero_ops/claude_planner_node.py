"""System Two as ROS 2 *actions*: the ground segment. Claude via the local `claude` CLI in headless
stream-json mode with a JSON schema, and jev available to it as an MCP tool while it reasons.

Why actions and not services now: a Claude call takes 15–105 s, produces observable progress (turns,
jev consultations) and must be cancellable — the executive's safety branch cancels a running plan when
the health monitor says stop, and the CLI subprocess is killed. Feedback streams phase / turns /
consultations / elapsed to the console's "two speeds of mind" strip.

The CLI is a Windows binary launched through WSL interop: prompt on stdin, Navcam frames written to a
Windows path, CLAUDECODE forwarded empty via WSLENV so the CLI does not think it is nested."""
import json, os, subprocess, threading, time
import rclpy
from rclpy.node import Node
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from jezero_msgs.action import Ask, Describe
from .prompts import SYSTEM, SCHEMAS, PROMPTS, describe_prompt

# Repo root, from this file's location: ros2/jezero_ops/jezero_ops/ -> three levels up.
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


def win_path(p):
    """Turn /mnt/c/foo/bar into a Windows path. Anything not under /mnt/<drive> comes back
    unchanged, which is the right answer when the CLI is native rather than reached through
    WSL interop. Used so no home directory has to be written down anywhere."""
    parts = p.replace("\\", "/").split("/")
    if len(parts) > 3 and parts[1] == "mnt" and len(parts[2]) == 1:
        return parts[2].upper() + ":\\" + "\\".join(parts[3:])
    return p


class ClaudePlanner(Node):
    def __init__(self):
        super().__init__("claude_planner")
        self.declare_parameter("llm_model", "sonnet")
        # Claude Code CLI. Override with the `claude_bin` parameter (config/policy.yaml)
        # or the CLAUDE_BIN environment variable.
        self.declare_parameter("claude_bin", os.environ.get("CLAUDE_BIN", "claude"))
        self.declare_parameter("tmp_linux", os.environ.get("JEZERO_TMP", "/tmp"))
        # The CLI is a Windows process reached through WSL interop, so any file path handed to
        # it has to be in Windows form. Derive it rather than writing a home directory down.
        self.declare_parameter("tmp_win", win_path(os.environ.get("JEZERO_TMP", "/tmp")))
        self.declare_parameter("mcp_config_win", win_path(os.path.join(REPO, "tools", "mcp-jev.json")))
        self.declare_parameter("jev_tool", True)
        self.declare_parameter("timeout_s", 300.0)
        cb = ReentrantCallbackGroup()
        self._ask = ActionServer(self, Ask, "/claude/ask", execute_callback=self.exec_ask, goal_callback=self.on_goal,
                                 cancel_callback=self.on_cancel, callback_group=cb)
        self._describe = ActionServer(self, Describe, "/claude/describe", execute_callback=self.exec_describe, goal_callback=self.on_goal,
                                      cancel_callback=self.on_cancel, callback_group=cb)
        self.get_logger().info(f"claude_planner up as ACTIONS /claude/ask /claude/describe (model {self.p('llm_model')}, jev tool {'on' if self.p('jev_tool') else 'off'})")

    def p(self, k): return self.get_parameter(k).value
    def on_goal(self, _req): return GoalResponse.ACCEPT
    def on_cancel(self, _gh): return CancelResponse.ACCEPT

    # ------------------------------------------------------------------ the CLI, streamed
    def run_cli(self, prompt, schema, goal_handle, feedback, allow_read=False, jev_tool=True, retries=1):
        """Run the CLI, streaming feedback; returns (result_event, consults, wall_ms) or raises. Honors cancel by killing the process."""
        tools = []
        if allow_read: tools.append("Read")
        args = [self.p("claude_bin"), "-p", "--model", self.p("llm_model"), "--no-session-persistence", "--output-format", "stream-json", "--verbose",
                "--json-schema", json.dumps(schema), "--system-prompt", SYSTEM]
        if jev_tool and self.p("jev_tool"):
            args += ["--mcp-config", self.p("mcp_config_win")]; tools.append("mcp__jev__ask_jev")
        if tools: args += ["--allowedTools", *tools]
        env = dict(os.environ); env["CLAUDECODE"] = ""; env["WSLENV"] = (env.get("WSLENV", "") + ":CLAUDECODE").strip(":")
        last_err = None
        for attempt in range(retries + 1):
            t0 = time.time()
            # stderr goes to a file, not a pipe: an undrained pipe fills and deadlocks the CLI (it logs a lot with --verbose)
            errf = open(os.path.join(self.p("tmp_linux"), f"claude-stderr-{int(t0)}.log"), "w+", encoding="utf-8", errors="replace")
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf, text=True, cwd=self.p("tmp_linux"), env=env)
            proc.stdin.write(prompt); proc.stdin.close()
            result, consults, pending, turns = None, [], {}, 0
            feedback("starting", turns, consults, t0, "")
            deadline = t0 + float(self.p("timeout_s"))
            # watchdog: cancel or timeout must kill the process even if it is silent
            stop_wd = threading.Event()
            def watchdog():
                while not stop_wd.wait(0.5):
                    if goal_handle.is_cancel_requested or time.time() > deadline:
                        try: proc.kill()
                        except Exception: pass
                        return
            threading.Thread(target=watchdog, daemon=True).start()
            for line in proc.stdout:
                if goal_handle.is_cancel_requested:
                    proc.kill(); feedback("cancelled", turns, consults, t0, "")
                    stop_wd.set(); raise CancelledError()
                if time.time() > deadline:
                    proc.kill(); last_err = RuntimeError("claude timed out"); break
                line = line.strip()
                if not line.startswith("{"): continue
                try: e = json.loads(line)
                except Exception: continue
                t = e.get("type")
                if t == "assistant":
                    turns += 1
                    for c in e.get("message", {}).get("content", []) or []:
                        if c.get("type") == "tool_use" and c.get("name") == "mcp__jev__ask_jev":
                            inp = c.get("input") or {}
                            pending[c.get("id")] = {"note": inp.get("note", ""), "state": inp.get("state", {}), "questions": inp.get("questions", {})}
                            feedback("consulting jev", turns, consults, t0, inp.get("note", ""))
                        elif c.get("type") == "tool_use" and c.get("name") == "StructuredOutput":
                            feedback("structuring", turns, consults, t0, "")
                        elif c.get("type") == "text":
                            feedback("thinking", turns, consults, t0, "")
                elif t == "user":
                    for c in e.get("message", {}).get("content", []) or []:
                        if c.get("type") == "tool_result" and c.get("tool_use_id") in pending:
                            q = pending.pop(c["tool_use_id"]); txt = c.get("content")
                            if isinstance(txt, list): txt = "".join(x.get("text", "") for x in txt if isinstance(x, dict))
                            try: ans = json.loads(txt or "{}")
                            except Exception: ans = {"raw": str(txt)[:500]}
                            q["answers"] = ans.get("answers", ans); q["latency_ms"] = ans.get("latency_ms", 0); q["n"] = len(q["questions"])
                            consults.append(q); feedback("thinking", turns, consults, t0, q["note"])
                elif t == "result":
                    result = e
            stop_wd.set()
            try: proc.wait(timeout=10)
            except Exception: proc.kill()
            if goal_handle.is_cancel_requested:
                feedback("cancelled", turns, consults, t0, ""); raise CancelledError()
            errf.seek(0); err = errf.read()[-2000:]; errf.close()
            wall = (time.time() - t0) * 1000
            if result is None:
                last_err = last_err or RuntimeError(f"claude returned no result (exit {proc.returncode}): {err[-300:]}")
            elif result.get("is_error") or not result.get("structured_output"):
                why = " | ".join(str(x) for x in (result.get("subtype"), result.get("terminal_reason"), result.get("api_error_status"), str(result.get("result"))[:200], err[:200]) if x)
                last_err = RuntimeError(f"claude error: {why[:400]}")
            else:
                feedback("done", turns, consults, t0, "")
                return result, consults, wall
            if attempt < retries:
                self.get_logger().warn(f"claude attempt failed: {str(last_err)[:200]} — retrying"); time.sleep(3)
        raise last_err

    # ------------------------------------------------------------------ Ask
    def exec_ask(self, gh):
        req = gh.request; res = Ask.Result()
        def fb(phase, turns, consults, t0, note):
            f = Ask.Feedback(phase=phase, turns=int(turns), consults=len(consults), elapsed_s=float(time.time() - t0), last_note=str(note or "")[:160])
            try: gh.publish_feedback(f)
            except Exception: pass
        try:
            ctx = json.loads(req.ctx_json); prompt = PROMPTS[req.kind](ctx); res.prompt = prompt
            self.get_logger().info(f"ask[{req.kind}] {len(prompt)} chars (action)")
            result, consults, wall = self.run_cli(prompt, SCHEMAS[req.kind], gh, fb)
            usage = result.get("modelUsage") or {}
            res.ok = True; res.output_json = json.dumps(result["structured_output"])
            res.model = max(usage.items(), key=lambda kv: kv[1].get("outputTokens", 0))[0] if usage else self.p("llm_model")
            res.latency_ms = wall; res.cost_usd = float(result.get("total_cost_usd") or 0.0)
            res.tokens_out = int((result.get("usage") or {}).get("output_tokens") or 0); res.turns = int(result.get("num_turns") or 0)
            res.consults_json = json.dumps(consults)
            self.get_logger().info(f"claude {wall:.0f} ms wall, {result.get('duration_api_ms')} ms api, ${res.cost_usd:.3f}, {res.turns} turns, {len(consults)} jev consult(s) "
                                   + ", ".join(f"[{c['n']} q, {c['latency_ms']} ms]" for c in consults))
            gh.succeed()
        except CancelledError:
            res.ok = False; res.error = "cancelled"; gh.canceled(); self.get_logger().warn(f"ask[{req.kind}] cancelled by the executive")
        except Exception as e:
            res.ok = False; res.error = str(e)[:500]; gh.abort(); self.get_logger().error(f"ask[{req.kind}] failed: {res.error}")
        return res

    # ------------------------------------------------------------------ Describe (vision)
    def exec_describe(self, gh):
        req = gh.request; res = Describe.Result()
        def fb(phase, turns, consults, t0, note):
            try: gh.publish_feedback(Describe.Feedback(phase=phase, elapsed_s=float(time.time() - t0)))
            except Exception: pass
        try:
            name = f"navcam-sol{req.sol}-{int(time.time())}.png"
            with open(os.path.join(self.p("tmp_linux"), name), "wb") as f: f.write(bytes(req.frame.data))
            prompt = describe_prompt({"sol": req.sol, "name": req.target_name, "path": self.p("tmp_win") + "\\" + name}); res.prompt = prompt
            result, consults, wall = self.run_cli(prompt, SCHEMAS["describe"], gh, fb, allow_read=True, jev_tool=False)
            usage = result.get("modelUsage") or {}
            res.ok = True; res.output_json = json.dumps(result["structured_output"])
            res.model = max(usage.items(), key=lambda kv: kv[1].get("outputTokens", 0))[0] if usage else self.p("llm_model")
            res.latency_ms = wall; res.cost_usd = float(result.get("total_cost_usd") or 0.0)
            self.get_logger().info(f"describe {wall:.0f} ms wall, ${res.cost_usd:.3f}")
            gh.succeed()
        except CancelledError:
            res.ok = False; res.error = "cancelled"; gh.canceled()
        except Exception as e:
            res.ok = False; res.error = str(e)[:500]; gh.abort(); self.get_logger().error(f"describe failed: {res.error}")
        return res


class CancelledError(Exception):
    pass


def main():
    rclpy.init(); n = ClaudePlanner()
    ex = MultiThreadedExecutor(num_threads=4); ex.add_node(n)
    try: ex.spin()
    except KeyboardInterrupt: pass
    rclpy.shutdown()
