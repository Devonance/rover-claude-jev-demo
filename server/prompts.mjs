// System Two prompts and schemas. Claude plays the science team and the
// tactical planners: reads everything, argues from geology, commits a plan.

import { CAMPAIGN, CONSTRAINTS, INSTRUMENTS } from "./world.mjs";

const instrumentTable = Object.entries(INSTRUMENTS)
  .map(([k, v]) => `- ${k}: ${v.name}; ${v.minutes} min, ${v.wh} Wh, ${v.mb} Mb${v.arm ? ", ARM (target within 2.2 m)" : `, range ${v.range_m} m`}`)
  .join("\n");

export const SYSTEM = `You are the Mars 2020 Perseverance science and tactical planning team, compressed into one voice: Science Operations Working Group lead, Long-Term Planner, and Rover Planner. You produce the sol plan that will be uplinked.

Mission context: ${CAMPAIGN.name}. Goal: ${CAMPAIGN.goal}
Working hypotheses:
${CAMPAIGN.hypotheses.map((h) => "  " + h).join("\n")}

How JPL plans a sol (follow this):
1. Assess downlink: rover state, position, energy, data, what the last sol's science said.
2. Choose science that discriminates between hypotheses; every activity needs a stated rationale.
3. Sequence: remote sensing before contact science (Mastcam-Z / SuperCam before the arm disturbs dust); contact science needs the rover parked within 2.2 m with tilt under 10 deg; PIXL runs for hours, usually overnight; abrade before PIXL/SHERLOC on a coring candidate; core only after abrasion science justifies the tube.
4. Respect the resource envelope for the sol: ${CONSTRAINTS.energy_wh} Wh, ${CONSTRAINTS.data_mb} Mb downlink, ${CONSTRAINTS.sol_minutes} min of daylight ops, max drive ${CONSTRAINTS.max_drive_m} m. Leave 15% margin on each.
5. Drives use AutoNav (ENav): the onboard system chooses the path; you choose the goal and constraints (keep-out notes, max distance, whether to allow drive-through of ripples: never).
6. Be concrete: name targets, name instruments, give durations.

Instruments (key: description; cost):
${instrumentTable}

Be terse and technical. Rationale must cite the observation that motivates it.`;

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    sol_summary: { type: "string", description: "One sentence: what this sol accomplishes" },
    science_criteria: {
      type: "string",
      description: "Plain-language criteria the onboard target-selection system should apply when it looks at rocks near the rover. Two sentences max.",
    },
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          priority: { type: "integer" },
          activities: { type: "array", items: { type: "string", description: "instrument key" } },
          rationale: { type: "string", description: "One or two sentences citing the motivating observation" },
        },
        required: ["target_id", "priority", "activities", "rationale"],
      },
    },
    drive: {
      type: "object",
      properties: {
        goal_target_id: { type: "string", description: "target id to drive toward, or 'none'" },
        max_distance_m: { type: "integer" },
        constraints: { type: "string" },
      },
      required: ["goal_target_id", "max_distance_m", "constraints"],
    },
    budget: {
      type: "object",
      properties: { energy_wh: { type: "integer" }, data_mb: { type: "integer" }, minutes: { type: "integer" } },
      required: ["energy_wh", "data_mb", "minutes"],
    },
    hypothesis_focus: { type: "string" },
  },
  required: ["sol_summary", "science_criteria", "targets", "drive", "budget", "hypothesis_focus"],
};

export const INTERPRET_SCHEMA = {
  type: "object",
  properties: {
    interpretation: { type: "string", description: "What the data say, geologically, in 2-3 sentences" },
    lithology_call: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    hypothesis_impact: { type: "string" },
    next_action: { type: "string", enum: ["continue_plan", "add_contact_science", "abrade", "core", "move_on"] },
    updated_science_criteria: { type: "string", description: "Two sentences max, for the onboard target-selection system" },
    rationale: { type: "string", description: "Two or three sentences. Why this next_action and not the alternatives." },
  },
  required: ["interpretation", "lithology_call", "confidence", "hypothesis_impact", "next_action", "updated_science_criteria", "rationale"],
};

export const ANOMALY_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: { type: "string" },
    action: { type: "string", enum: ["resume_with_visodom", "resume_normal", "back_up_and_reroute", "stop_for_sol", "reimage_and_reassess"] },
    rationale: { type: "string", description: "Two or three sentences" },
    constraints_for_onboard: { type: "string", description: "One sentence the rover planners can encode" },
  },
  required: ["diagnosis", "action", "rationale", "constraints_for_onboard"],
};

export function planPrompt(ctx) {
  return `SOL ${ctx.sol} TACTICAL PLANNING

Rover state (from downlink):
- Position: ${ctx.rover.x.toFixed(0)} m E, ${ctx.rover.y.toFixed(0)} m N of site origin; heading ${ctx.rover.heading.toFixed(0)} deg; tilt ${ctx.rover.tilt.toFixed(1)} deg
- Energy available this sol: ${ctx.energy_wh} Wh; downlink: ${ctx.data_mb} Mb; ops window ${ctx.minutes} min
- Standing: ${ctx.standing}

Targets in the traverse area (from orbital + Navcam, distances from rover):
${ctx.targets.map((t) => `- ${t.id} "${t.name}": ${t.description} [${t.dist.toFixed(0)} m, bearing ${t.bearing.toFixed(0)} deg]${t.done.length ? ` | already done: ${t.done.join(", ")}` : ""}`).join("\n")}

Terrain notes from the rover planners: ${ctx.terrain_notes}

Previous sols' science:
${ctx.history.length ? ctx.history.map((h) => `- ${h}`).join("\n") : "- none yet"}

Produce the sol plan.`;
}

export function interpretPrompt(ctx) {
  return `INSTRUMENT DATA RETURNED, SOL ${ctx.sol}

Target: ${ctx.target.id} "${ctx.target.name}" — ${ctx.target.description}
Instrument: ${ctx.instrument}
Current range to target: ${ctx.range_m} m (arm reach 2.2 m, SuperCam 7 m)
Onboard target-selection score for this target against your criteria ("${ctx.criteria}"): ${ctx.match_words}
Result summary (pipeline-processed):
${ctx.result}

Previous results on this target: ${ctx.prior.length ? ctx.prior.join(" | ") : "none"}
Sol resources remaining: ${ctx.energy_wh} Wh, ${ctx.data_mb} Mb, ${ctx.minutes} min. Arm instruments available: ${ctx.arm_available ? "yes" : "no (target out of reach)"}.

Interpret the data against the hypotheses and decide the next action.`;
}

export function anomalyPrompt(ctx) {
  return `DRIVE ANOMALY, SOL ${ctx.sol}

Telemetry event: ${ctx.event}
Recent terrain: ${ctx.terrain}
Onboard (System One) triage: class=${ctx.triage.fault_class} (confidence ${ctx.triage.confidence}), stop_drive=${ctx.triage.stop_drive}, needs_ground=${ctx.triage.needs_ground}
The rover has already ${ctx.stopped ? "stopped" : "continued"} per onboard rules. Drive progress ${ctx.progress_m} m of ${ctx.goal_m} m to goal.

Diagnose and choose the action. The rover planners will encode your constraints for the onboard system.`;
}

// ------------------------------------------------------------ user objectives
export const OBJECTIVE_SCHEMA = {
  type: "object",
  properties: {
    worth_it: { type: "string", enum: ["yes", "partial", "no"] },
    assessment: { type: "string", description: "Two sentences: what the objective would tell us and whether this target can answer it" },
    approach_required: { type: "boolean", description: "true if the rover must drive to within arm reach" },
    activities: {
      type: "array",
      description: "Ordered instrument keys with purpose; remote sensing first, then contact; nothing after core",
      items: { type: "object", properties: { instrument: { type: "string" }, purpose: { type: "string" } }, required: ["instrument", "purpose"] },
    },
    expected_evidence: { type: "string", description: "What result would confirm vs refute the objective" },
    budget: { type: "object", properties: { energy_wh: { type: "integer" }, data_mb: { type: "integer" }, minutes: { type: "integer" } }, required: ["energy_wh", "data_mb", "minutes"] },
    displaces: { type: "string", description: "Which planned activity, if any, this pushes to the next sol, and why" },
  },
  required: ["worth_it", "assessment", "approach_required", "activities", "expected_evidence", "budget", "displaces"],
};

export const REPORT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One line for the science team" },
    answer: { type: "string", enum: ["confirmed", "refuted", "inconclusive"] },
    evidence: { type: "string", description: "Two or three sentences citing the specific measurements" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    recommendation: { type: "string", description: "One sentence: what to do next about this objective" },
    cost: { type: "string", description: "Resources actually spent, one clause" },
  },
  required: ["headline", "answer", "evidence", "confidence", "recommendation", "cost"],
};

export function objectivePrompt(ctx) {
  return `NEW SCIENCE OBJECTIVE FROM THE SCIENCE TEAM, SOL ${ctx.sol}, LMST ${ctx.lmst}

Objective (verbatim): "${ctx.objective}"
Target the requester pointed at: ${ctx.target.description} [${ctx.target.dist.toFixed(0)} m away, bearing ${ctx.target.bearing.toFixed(0)} deg]

Rover state: ${ctx.rover_words}
Resources remaining this sol: ${ctx.energy_wh} Wh, ${ctx.data_mb} Mb, ${ctx.minutes} min of ops window.
Current sol plan still to execute: ${ctx.remaining_plan.length ? ctx.remaining_plan.join("; ") : "nothing else"}
Science so far: ${ctx.history.length ? ctx.history.join(" | ") : "none"}

Decide whether this objective is worth the resources, which instruments answer it, in what order, and what it displaces. Stay inside the remaining envelope with 15% margin.`;
}

export function reportPrompt(ctx) {
  return `OBJECTIVE REPORT, SOL ${ctx.sol}

Objective: "${ctx.objective}"
Target: ${ctx.target.description}
Expected evidence (from your plan): ${ctx.expected_evidence}
Activities executed and their results:
${ctx.results.map((r) => `- ${r.instrument}: ${r.result}`).join("\n")}
Activities dropped by the onboard system: ${ctx.dropped.length ? ctx.dropped.join("; ") : "none"}
Resources spent: ${ctx.spent}

Write the report.`;
}

// ------------------------------------------------------------ vision (Claude reads the Navcam frame)
export const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    scene: { type: "string", description: "One sentence: what the frame shows" },
    target: {
      type: "object",
      properties: {
        description: { type: "string", description: "Field-geologist description of the rock nearest the frame centre: tone, texture, outline, coating, size relative to a 0.5 m wheel. Two sentences." },
        size_m: { type: "number" },
        tone: { type: "string", enum: ["dark", "light-toned", "mottled", "medium-toned"] },
        texture: { type: "string", enum: ["vesicular", "fine-grained", "coarse-grained", "layered", "pitted", "smooth", "unknown"] },
        coating: { type: "string", enum: ["dust-coated", "clean", "partly coated", "unknown"] },
      },
      required: ["description", "size_m", "tone", "texture", "coating"],
    },
    other_rocks: { type: "array", items: { type: "object", properties: { where: { type: "string" }, description: { type: "string" } }, required: ["where", "description"] } },
    hazards_noticed: { type: "string", description: "Anything a rover planner would flag: sand, slope, sharp rocks. One sentence or 'none'." },
  },
  required: ["scene", "target", "other_rocks", "hazards_noticed"],
};

export function describePrompt(ctx) {
  return `NAVCAM FRAME REVIEW, SOL ${ctx.sol}

Read the image file ${ctx.path} with the Read tool. It is a Navcam frame from the rover's mast, looking ahead. The rover has parked to do science on the rock nearest the frame centre${ctx.name ? ` (the planners call it "${ctx.name}")` : ""}.
Describe it as a field geologist would, then note any other rocks and any hazard a rover planner should know about. Base everything on what is visible; do not invent measurements you cannot support.`;
}
