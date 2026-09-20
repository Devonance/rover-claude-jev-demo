"""The sol executive as a py_trees behaviour tree.

    Sol (Selector, no memory)                      -- re-evaluated every tick: safety first
    +-- SafetyHalt (condition)                     -- reports a health-triggered halt (feedback + /ops/tree.safety_halt); never preempts
    +-- Mission (Sequence, memory)
        +-- PlanSol       (Claude action + jev consultations)
        +-- ReviewPlan    (jev verifies every planned activity before uplink -- the sequence review)
        +-- ExecuteSol    (drive / classify / science / objective; resumable)
        +-- Downlink      (jev prioritises the data products; code fills the pass)

Long work runs in a worker thread and the behaviour reports RUNNING until it is done, so the tree
ticks (2 Hz), publishes its state to /ops/tree, and the safety branch is checked between ticks. The
immediate halt itself lives in the drive loop (it must not wait for a tick); the tree shows it and
cancels any running Claude action.
"""
import threading, traceback
import py_trees


class Work(py_trees.behaviour.Behaviour):
    """Run `fn(executive)` in a thread; RUNNING until done; SUCCESS/FAILURE from its return."""
    def __init__(self, name, ex, fn):
        super().__init__(name); self.ex = ex; self.fn = fn; self.thread = None; self.result = None; self.error = None

    def initialise(self):
        if self.thread is None or not self.thread.is_alive():
            self.result = None; self.error = None
            def go():
                try: self.result = self.fn(self.ex)
                except Exception as e:
                    self.error = e; self.ex.get_logger().error(f"{self.name} failed: {e!r}\n{traceback.format_exc()[-800:]}")
            self.thread = threading.Thread(target=go, name=self.name, daemon=True); self.thread.start()

    def update(self):
        if self.thread is not None and self.thread.is_alive():
            self.feedback_message = self.ex.mode
            return py_trees.common.Status.RUNNING
        if self.error is not None or self.result is False:
            return py_trees.common.Status.FAILURE
        return py_trees.common.Status.SUCCESS

    def terminate(self, new_status):
        # interrupted (tree shutdown / sol abort): cancel any running Claude action; the worker sees the halt flag
        if new_status == py_trees.common.Status.INVALID and self.thread is not None and self.thread.is_alive() and not self.ex.halting:
            self.ex.cancel_claude("mission subtree interrupted")


class SafetyHalt(py_trees.behaviour.Behaviour):
    def __init__(self, ex):
        super().__init__("SafetyHalt"); self.ex = ex
    def update(self):
        # The immediate halt lives in the drive loop (it must not wait for a tick) and the anomaly handling runs
        # inside ExecuteSol's worker, so this branch *reports* the halt rather than preempting the mission:
        # preempting would cancel the very action handling the halt and reset the sequence's memory.
        if self.ex.halting:
            self.feedback_message = self.ex.halt_reason
        else:
            self.feedback_message = ""
        return py_trees.common.Status.FAILURE


def build(ex):
    root = py_trees.composites.Selector("Sol", memory=False)
    mission = py_trees.composites.Sequence("Mission", memory=True)
    mission.add_children([
        Work("PlanSol", ex, lambda e: e.bt_plan()),
        Work("ReviewPlan", ex, lambda e: e.bt_review()),
        Work("ExecuteSol", ex, lambda e: e.bt_execute()),
        Work("Downlink", ex, lambda e: e.bt_downlink()),
    ])
    root.add_children([SafetyHalt(ex), mission])
    return py_trees.trees.BehaviourTree(root)


def ascii(tree):
    return py_trees.display.unicode_tree(tree.root, show_status=True)


def active_path(tree):
    path, n = [], tree.root
    while n is not None:
        path.append(n.name)
        nxt = None
        for c in getattr(n, "children", []):
            if c.status == py_trees.common.Status.RUNNING: nxt = c; break
        n = nxt
    return " / ".join(path)
