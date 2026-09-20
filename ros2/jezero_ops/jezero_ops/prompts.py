"""System Two prompts and schemas (port of server/prompts.mjs)."""
from .world import CAMPAIGN, CONSTRAINTS, INSTRUMENTS

_table = "\n".join(
    f"- {k}: {v['name']}; {v['minutes']} min, {v['wh']} Wh, {v['mb']} Mb" + (", ARM (target within 2.2 m)" if v["arm"] else f", range {v['range_m']} m")
    for k, v in INSTRUMENTS.items())

SYSTEM = f"""You are the Mars 2020 Perseverance science and tactical planning team, compressed into one voice: Science Operations Working Group lead, Long-Term Planner, and Rover Planner. You produce the sol plan that will be uplinked.

Mission context: {CAMPAIGN['name']}. Goal: {CAMPAIGN['goal']}
Working hypotheses:
{chr(10).join('  ' + h for h in CAMPAIGN['hypotheses'])}

How JPL plans a sol (follow this):
1. Assess downlink: rover state, position, energy, data, what the last sol's science said.
2. Choose science that discriminates between hypotheses; every activity needs a stated rationale.
3. Sequence: remote sensing before contact science (Mastcam-Z / SuperCam before the arm disturbs dust); contact science needs the rover parked within 2.2 m with tilt under 10 deg; PIXL runs for hours, usually overnight; abrade before PIXL/SHERLOC on a coring candidate; core only after abrasion science justifies the tube.
4. Respect the resource envelope for the sol: {CONSTRAINTS['energy_wh']} Wh, {CONSTRAINTS['data_mb']} Mb downlink, {CONSTRAINTS['sol_minutes']} min of daylight ops, max drive {CONSTRAINTS['max_drive_m']} m. Leave 15% margin on each.
5. Drives use AutoNav (ENav): the onboard system chooses the path; you choose the goal and constraints (keep-out notes, max distance, whether to allow drive-through of ripples: never).
6. Be concrete: name targets, name instruments, give durations.

Instruments (key: description; cost):
{_table}

You have one tool, `ask_jev`: TypeSafe's jev, the same System One judgment model the rover runs onboard. It answers narrow typed questions (Choice / Noul / Score) over a small JSON state in ~300 ms with calibrated probabilities. It does not reason or write; it judges. Use it while you think, the way a planner leans on the onboard target-selection system: score candidate targets against your draft criteria before you commit them, check an activity order against the sequencing rules, check whether a next action is actually supported by the data, check whether a diagnosis is the likely one. Ask all independent questions in one call; put numbers into words; treat the answers as evidence you weigh, not as commands. One or two consultations per task is right; do not loop.

Be terse and technical. Rationale must cite the observation that motivates it."""

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "sol_summary": {"type": "string", "description": "One sentence: what this sol accomplishes"},
        "science_criteria": {"type": "string", "description": "Plain-language criteria the onboard target-selection system should apply when it looks at rocks near the rover. Two sentences max."},
        "targets": {"type": "array", "items": {"type": "object", "properties": {
            "target_id": {"type": "string"}, "priority": {"type": "integer"},
            "activities": {"type": "array", "items": {"type": "string", "description": "instrument key"}},
            "rationale": {"type": "string", "description": "One or two sentences citing the motivating observation"}},
            "required": ["target_id", "priority", "activities", "rationale"]}},
        "drive": {"type": "object", "properties": {
            "goal_target_id": {"type": "string", "description": "target id to drive toward, or 'none'"},
            "max_distance_m": {"type": "integer"}, "constraints": {"type": "string"}},
            "required": ["goal_target_id", "max_distance_m", "constraints"]},
        "budget": {"type": "object", "properties": {"energy_wh": {"type": "integer"}, "data_mb": {"type": "integer"}, "minutes": {"type": "integer"}}, "required": ["energy_wh", "data_mb", "minutes"]},
        "hypothesis_focus": {"type": "string"},
    },
    "required": ["sol_summary", "science_criteria", "targets", "drive", "budget", "hypothesis_focus"],
}

INTERPRET_SCHEMA = {
    "type": "object",
    "properties": {
        "interpretation": {"type": "string", "description": "What the data say, geologically, in 2-3 sentences"},
        "lithology_call": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "hypothesis_impact": {"type": "string"},
        "next_action": {"type": "string", "enum": ["continue_plan", "add_contact_science", "abrade", "core", "move_on"]},
        "updated_science_criteria": {"type": "string", "description": "Two sentences max, for the onboard target-selection system"},
        "rationale": {"type": "string", "description": "Two or three sentences. Why this next_action and not the alternatives."},
    },
    "required": ["interpretation", "lithology_call", "confidence", "hypothesis_impact", "next_action", "updated_science_criteria", "rationale"],
}

ANOMALY_SCHEMA = {
    "type": "object",
    "properties": {
        "diagnosis": {"type": "string"},
        "action": {"type": "string", "enum": ["resume_with_visodom", "resume_normal", "back_up_and_reroute", "stop_for_sol", "reimage_and_reassess"]},
        "rationale": {"type": "string", "description": "Two or three sentences"},
        "constraints_for_onboard": {"type": "string", "description": "One sentence the rover planners can encode"},
    },
    "required": ["diagnosis", "action", "rationale", "constraints_for_onboard"],
}

OBJECTIVE_SCHEMA = {
    "type": "object",
    "properties": {
        "worth_it": {"type": "string", "enum": ["yes", "partial", "no"]},
        "assessment": {"type": "string", "description": "Two sentences: what the objective would tell us and whether this target can answer it"},
        "approach_required": {"type": "boolean", "description": "true if the rover must drive to within arm reach"},
        "activities": {"type": "array", "description": "Ordered instrument keys with purpose; remote sensing first, then contact; nothing after core",
                       "items": {"type": "object", "properties": {"instrument": {"type": "string"}, "purpose": {"type": "string"}}, "required": ["instrument", "purpose"]}},
        "expected_evidence": {"type": "string", "description": "What result would confirm vs refute the objective"},
        "budget": {"type": "object", "properties": {"energy_wh": {"type": "integer"}, "data_mb": {"type": "integer"}, "minutes": {"type": "integer"}}, "required": ["energy_wh", "data_mb", "minutes"]},
        "displaces": {"type": "string", "description": "Which planned activity, if any, this pushes to the next sol, and why"},
    },
    "required": ["worth_it", "assessment", "approach_required", "activities", "expected_evidence", "budget", "displaces"],
}

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One line for the science team"},
        "answer": {"type": "string", "enum": ["confirmed", "refuted", "inconclusive"]},
        "evidence": {"type": "string", "description": "Two or three sentences citing the specific measurements"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "recommendation": {"type": "string", "description": "One sentence: what to do next about this objective"},
        "cost": {"type": "string", "description": "Resources actually spent, one clause"},
    },
    "required": ["headline", "answer", "evidence", "confidence", "recommendation", "cost"],
}

DESCRIBE_SCHEMA = {
    "type": "object",
    "properties": {
        "scene": {"type": "string", "description": "One sentence: what the frame shows"},
        "target": {"type": "object", "properties": {
            "description": {"type": "string", "description": "Field-geologist description of the rock nearest the frame centre: tone, texture, outline, coating, size relative to a 0.5 m wheel. Two sentences."},
            "size_m": {"type": "number"},
            "tone": {"type": "string", "enum": ["dark", "light-toned", "mottled", "medium-toned"]},
            "texture": {"type": "string", "enum": ["vesicular", "fine-grained", "coarse-grained", "layered", "pitted", "smooth", "unknown"]},
            "coating": {"type": "string", "enum": ["dust-coated", "clean", "partly coated", "unknown"]}},
            "required": ["description", "size_m", "tone", "texture", "coating"]},
        "other_rocks": {"type": "array", "items": {"type": "object", "properties": {"where": {"type": "string"}, "description": {"type": "string"}}, "required": ["where", "description"]}},
        "hazards_noticed": {"type": "string", "description": "Anything a rover planner would flag: sand, slope, sharp rocks. One sentence or 'none'."},
    },
    "required": ["scene", "target", "other_rocks", "hazards_noticed"],
}

SCHEMAS = {"plan": PLAN_SCHEMA, "interpret": INTERPRET_SCHEMA, "anomaly": ANOMALY_SCHEMA, "objective": OBJECTIVE_SCHEMA, "report": REPORT_SCHEMA, "describe": DESCRIBE_SCHEMA}


def plan_prompt(c):
    tl = "\n".join(f"- {t['id']} \"{t['name']}\": {t['description']} [{t['dist']:.0f} m, bearing {t['bearing']:.0f} deg]" + (f" | already done: {', '.join(t['done'])}" if t.get("done") else "") for t in c["targets"])
    hist = "\n".join(f"- {h}" for h in c["history"]) if c["history"] else "- none yet"
    return f"""SOL {c['sol']} TACTICAL PLANNING

Rover state (from downlink):
- Position: {c['rover']['x']:.0f} m E, {c['rover']['y']:.0f} m N of site origin; heading {c['rover']['heading']:.0f} deg; tilt {c['rover']['tilt']:.1f} deg
- Energy available this sol: {c['energy_wh']} Wh; downlink: {c['data_mb']} Mb; ops window {c['minutes']} min
- Standing: {c['standing']}

Targets in the traverse area (from orbital + Navcam, distances from rover):
{tl}

Terrain notes from the rover planners: {c['terrain_notes']}

Previous sols' science:
{hist}

Onboard judgment ledger since the last uplink (what jev decided while driving): {c.get('jev_ledger', 'none yet')}

Before you commit the plan, consult jev once: score every target against your draft science_criteria (one Score question per target, four levels) and ask whether your activity order for each target respects the sequencing rules (one Noul per target). Let low scores and failed checks change the plan. Then produce the sol plan."""


def interpret_prompt(c):
    return f"""INSTRUMENT DATA RETURNED, SOL {c['sol']}

Target: {c['target']['id']} "{c['target']['name']}" — {c['target']['description']}
Instrument: {c['instrument']}
Current range to target: {c['range_m']} m (arm reach 2.2 m, SuperCam 7 m)
Onboard target-selection score for this target against your criteria ("{c['criteria']}"): {c['match_words']}
Result summary (pipeline-processed):
{c['result']}

Previous results on this target: {' | '.join(c['prior']) if c['prior'] else 'none'}
Sol resources remaining: {c['energy_wh']} Wh, {c['data_mb']} Mb, {c['minutes']} min. Arm instruments available: {'yes' if c['arm_available'] else 'no (target out of reach)'}.

Interpret the data against the hypotheses and decide the next action. If you are torn between two next actions, ask jev one Choice question over them with the evidence in the state; cite its answer in your rationale."""


def anomaly_prompt(c):
    t = c["triage"]
    return f"""DRIVE ANOMALY, SOL {c['sol']}

Telemetry event: {c['event']}
Recent terrain: {c['terrain']}
Onboard (System One) triage: class={t['fault_class']} (confidence {t['confidence']}), stop_drive={t['stop_drive']}, needs_ground={t['needs_ground']}
The rover has already {'stopped' if c['stopped'] else 'continued'} per onboard rules. Drive progress {c['progress_m']} m of {c['goal_m']} m to goal.

Diagnose and choose the action. Consult jev once: given the telemetry and terrain, is each candidate action safe to command now (one Noul per action)? Then decide. The rover planners will encode your constraints for the onboard system.
The action must be exactly one of: resume_with_visodom, resume_normal, back_up_and_reroute, stop_for_sol, reimage_and_reassess (no other value; if the wheel current looks like a wheel against a rock, back_up_and_reroute or stop_for_sol are the usual choices)."""


def objective_prompt(c):
    return f"""NEW SCIENCE OBJECTIVE FROM THE SCIENCE TEAM, SOL {c['sol']}, LMST {c['lmst']}

Objective (verbatim): "{c['objective']}"
Target the requester pointed at: {c['target']['description']} [{c['target']['dist']:.0f} m away, bearing {c['target']['bearing']:.0f} deg]

Rover state: {c['rover_words']}
Resources remaining this sol: {c['energy_wh']} Wh, {c['data_mb']} Mb, {c['minutes']} min of ops window.
Current sol plan still to execute: {'; '.join(c['remaining_plan']) if c['remaining_plan'] else 'nothing else'}
Science so far: {' | '.join(c['history']) if c['history'] else 'none'}

Decide whether this objective is worth the resources, which instruments answer it, in what order, and what it displaces. Stay inside the remaining envelope with 15% margin. Consult jev once on your draft: does each candidate activity produce evidence that bears on the objective (one Noul each), and is the target as described likely to be what the requester thinks it is (one Noul)? Drop what jev does not support."""


def report_prompt(c):
    res = "\n".join(f"- {r['instrument']}: {r['result']}" for r in c["results"])
    return f"""OBJECTIVE REPORT, SOL {c['sol']}

Objective: "{c['objective']}"
Target: {c['target']['description']}
Expected evidence (from your plan): {c['expected_evidence']}
Activities executed and their results:
{res}
Activities dropped by the onboard system: {'; '.join(c['dropped']) if c['dropped'] else 'none'}
Resources spent: {c['spent']}

Write the report."""


def describe_prompt(c):
    name = f' (the planners call it "{c["name"]}")' if c.get("name") else ""
    return f"""NAVCAM FRAME REVIEW, SOL {c['sol']}

Read the image file {c['path']} with the Read tool. It is a Navcam frame from the rover's mast, looking ahead. The rover has parked to do science on the rock nearest the frame centre{name}.
Describe it as a field geologist would, then note any other rocks and any hazard a rover planner should know about. Base everything on what is visible; do not invent measurements you cannot support."""


PROMPTS = {"plan": plan_prompt, "interpret": interpret_prompt, "anomaly": anomaly_prompt, "objective": objective_prompt, "report": report_prompt}
