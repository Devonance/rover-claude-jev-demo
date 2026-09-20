"""Small shared helpers for the nodes."""
import json, math, threading
from jezero_msgs.msg import Feature


def hhmm(m):
    return f"{int(m // 60):02d}:{int(m % 60):02d}"


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


def feature_to_msg(f):
    m = Feature()
    m.id = f["id"]; m.kind = f.get("kind", "rock")
    m.x = float(f["x"]); m.y = float(f["y"]); m.dist = float(f["dist"]); m.rel = float(f.get("rel", 0.0))
    m.d = float(f.get("d") or 0.6)
    m.h_known = f.get("h") is not None
    m.h = float(f["h"]) if m.h_known else 0.0
    m.h_est = float(f.get("h_est") or (f["h"] if m.h_known else 0.0))
    m.tone = f.get("tone", "") or ""
    m.size_words = f.get("size_words", "") or ""
    m.appearance = f["appearance"]; m.bearing_words = f["bearing_words"]; m.stereo_note = f["stereo_note"]
    b = f.get("box") or [0, 0, 0, 0]
    m.box = [int(v) for v in b]
    m.px = int(f.get("px", 0))
    return m


def feature_from_msg(m):
    return {"id": m.id, "kind": m.kind, "x": m.x, "y": m.y, "dist": m.dist, "rel": m.rel, "d": m.d,
            "h": m.h if m.h_known else None, "h_est": m.h_est, "tone": m.tone, "size_words": m.size_words,
            "appearance": m.appearance, "bearing_words": m.bearing_words, "stereo_note": m.stereo_note,
            "box": list(m.box) if any(m.box) else None, "px": m.px}


class Waiter:
    """Wait for a keyed event from a callback thread (cmd_done, feature arrays, ...)."""
    def __init__(self):
        self.lock = threading.Lock(); self.events = {}; self.values = {}

    def arm(self, key):
        with self.lock:
            self.events[key] = threading.Event(); self.values.pop(key, None)

    def fire(self, key, value=None):
        with self.lock:
            ev = self.events.get(key)
            if ev is None:
                ev = self.events[key] = threading.Event()
            self.values[key] = value; ev.set()

    def wait(self, key, timeout):
        with self.lock:
            ev = self.events.get(key)
        if ev is None:
            return None
        ok = ev.wait(timeout)
        with self.lock:
            v = self.values.pop(key, None); self.events.pop(key, None)
        if not ok:
            raise TimeoutError(f"timed out waiting for {key}")
        return v


def call_service(client, req, timeout):
    """Synchronous service call from a worker thread while an executor spins the node."""
    if not client.wait_for_service(timeout_sec=10.0):
        raise RuntimeError(f"service {client.srv_name} unavailable")
    fut = client.call_async(req)
    done = threading.Event()
    fut.add_done_callback(lambda _f: done.set())
    if not done.wait(timeout):
        raise TimeoutError(f"service {client.srv_name} timed out after {timeout}s")
    if fut.exception() is not None:
        raise fut.exception()
    return fut.result()


def jdump(o):
    return json.dumps(o, ensure_ascii=False, default=float)
