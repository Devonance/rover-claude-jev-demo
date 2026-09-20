// System One question sets. Each builder returns {state, questions}. Numbers
// stay in code: every quantity below is bucketed into words before jev sees it.

const bucketSize = (h) =>
  h < 0.15 ? "ankle-height" : h < 0.3 ? "shin-height" : h < 0.5 ? "knee-height" : h < 0.8 ? "waist-height" : "taller than a wheel";
const bucketDist = (d) => (d < 3 ? "right in front of the rover" : d < 6 ? "a few metres ahead" : "at the edge of Navcam range");

// ---------------------------------------------------------- hazards (per drive step)
export function hazardQuestions(features, context) {
  const state = {
    rover: {
      drive_mode: "AutoNav with ENav, thinking-while-driving",
      wheel_diameter: "about half a metre",
      belly_clearance: "about half a metre",
      sun: context.sun, // e.g. "low in the west, long shadows"
    },
    navcam_features: Object.fromEntries(
      features.map((f) => [
        f.id,
        {
          appearance: f.appearance,
          apparent_size: f.h != null ? bucketSize(f.h) : f.size_words,
          position: `${bucketDist(f.dist)}, ${f.bearing_words}`,
          stereo_range_note: f.stereo_note,
        },
      ])
    ),
  };
  const questions = {};
  for (const f of features) {
    questions[`${f.id}__type`] = {
      type: "choice",
      instructions: {
        question: `What is the feature at \`navcam_features.${f.id}\`?`,
        focus: "Use the appearance and the stereo note together. Shadows have no stereo relief.",
      },
      criteria: {
        embedded_rock: { what: "A rock set into the ground; stereo shows relief." },
        loose_rock: { what: "A rock resting on the surface, perched or half-buried; stereo shows relief." },
        bedrock_slab: { what: "A flat, coherent slab of pavement; low relief, broad." },
        sand_ripples: { what: "Fine-grained bright material with regular ripples; no rock relief." },
        shadow_only: { what: "A dark patch with no stereo relief: a shadow cast by something else.", not_for: "Anything with measured relief." },
        dust_devil: { what: "A moving column of lifted dust; changes between frames." },
      },
    };
    questions[`${f.id}__wheel_hazard`] = {
      type: "noul",
      instructions: {
        question: `Would driving a wheel over \`navcam_features.${f.id}\` risk damaging the wheel or high-centring the rover?`,
        focus: "Relief taller than shin-height matters. Shadows and dust do not.",
      },
      criteria: {
        true: { what: "A solid object with relief at or above knee-height, or a sharp angular edge at shin-height." },
        false: { what: "Nothing solid, or low enough to roll over.", examples: ["a shadow", "ankle-height rounded pebble"] },
      },
    };
    questions[`${f.id}__sinkage`] = {
      type: "noul",
      instructions: {
        question: `Could \`navcam_features.${f.id}\` cause wheel sinkage or excessive slip?`,
        focus: "Loose fine-grained material, ripples, or bright drifts.",
      },
      criteria: {
        true: { what: "Ripple fields, drifts, or fine bright sand." },
        false: { what: "Bedrock, embedded rock, shadow, or dust in the air." },
      },
    };
    questions[`${f.id}__science`] = {
      type: "noul",
      instructions: {
        question: `Is \`navcam_features.${f.id}\` worth an opportunistic observation during the drive?`,
        focus: "Atmospheric phenomena and unusual rock textures are; ordinary float and shadows are not.",
      },
      criteria: {
        true: { what: "A dust devil, an unusually light-toned or layered rock, or a fresh-looking surface." },
        false: { what: "Ordinary dark float, sand, or a shadow." },
      },
    };
  }
  return { state, questions };
}

// ---------------------------------------------------------- AEGIS-style target triage
export function aegisQuestions(candidates, campaignCriteria, armContext) {
  const state = {
    science_criteria_from_planning_team: campaignCriteria,
    candidates: Object.fromEntries(candidates.map((c) => [c.id, { description: c.description, distance: bucketDist(c.dist) }])),
    arm_workspace: armContext, // words: tilt band, surface stability, dust
  };
  const questions = {};
  for (const c of candidates) {
    questions[`${c.id}__match`] = {
      type: "score",
      instructions: {
        question: `How well does \`candidates.${c.id}\` satisfy \`science_criteria_from_planning_team\`?`,
        focus: "Judge the description against the criteria as written, not general interest.",
      },
      criteria: [
        "Does not satisfy the criteria at all.",
        "Weakly related; only one aspect of the criteria applies.",
        "Satisfies most of the criteria.",
        "Exactly the kind of target the criteria describe.",
      ],
    };
    questions[`${c.id}__instrument`] = {
      type: "choice",
      instructions: {
        question: `Which single instrument best answers the planning team's question about \`candidates.${c.id}\`, given its distance?`,
        focus: "Arm instruments need the target within reach. Remote instruments do not.",
      },
      criteria: {
        SuperCam_LIBS: { what: "Remote elemental chemistry by laser, up to about seven metres. First look at composition." },
        MastcamZ_multispectral: { what: "Remote colour and mineral indicators at any distance. Context and stratigraphy." },
        WATSON_closeup: { what: "Arm-mounted close-up texture imaging. Target within reach." },
        PIXL_map: { what: "Arm-mounted fine-scale chemistry map, hours long. Only for a prepared, high-value target within reach." },
        skip: { what: "Not worth instrument time this sol." },
      },
    };
  }
  questions.arm_deploy_safe = {
    type: "noul",
    instructions: {
      question: "Given `arm_workspace`, is it safe to deploy the robotic arm for contact science now?",
      focus: "Tilt, surface stability under the wheels, and airborne dust all matter.",
    },
    criteria: {
      true: { what: "Modest tilt, wheels on firm ground, clear air." },
      false: { what: "Steep tilt, loose material under a wheel, or dust in the air." },
    },
  };
  return { state, questions };
}

// ---------------------------------------------------------- telemetry fault triage
export function faultQuestions(event) {
  const state = {
    drive_phase: event.phase,
    telemetry_event: event.description,
    recent_terrain: event.terrain_words,
  };
  const questions = {
    fault_class: {
      type: "choice",
      instructions: {
        question: "What does `telemetry_event` most likely indicate?",
        focus: "Read the event together with `recent_terrain`.",
      },
      criteria: {
        nominal: { what: "Within normal drive behaviour; no action." },
        wheel_slip_excess: { what: "Wheels turning faster than the rover moves; loose ground." },
        motor_current_high: { what: "A drive actuator drawing more current than expected; possible obstruction." },
        tilt_exceeded: { what: "Rover attitude past the planned limit." },
        visual_odometry_failure: { what: "The rover cannot confirm its motion from images; featureless or shadowed ground." },
        thermal: { what: "A temperature reading outside its allowed range." },
      },
    },
    stop_drive: {
      type: "noul",
      instructions: { question: "Should the rover stop driving now rather than continue?", focus: "Stop when continuing could embed or damage the rover." },
      criteria: { true: { what: "Continuing risks getting stuck or damaging hardware." }, false: { what: "Safe to continue with monitoring." } },
    },
    needs_ground: {
      type: "noul",
      instructions: {
        question: "Does this need the ground team (Earth) to decide, rather than an onboard rule?",
        focus: "Novel, ambiguous, or safety-critical situations go to Earth.",
      },
      criteria: { true: { what: "Ambiguous cause or a decision with mission-level consequences." }, false: { what: "A routine, well-understood event." } },
    },
  };
  return { state, questions };
}

// ---------------------------------------------------------- plan verification (per activity)
// Claude wrote the plan; before code commits resources, jev checks each step.
export function verifyQuestions(plan) {
  const state = {
    objective: plan.objective,
    target: plan.target,
    rover_state: plan.rover_words,
    activities: Object.fromEntries(
      plan.activities.map((a, i) => [
        `a${i}`,
        { instrument: a.name, what_it_measures: a.measures, purpose: a.purpose, comes_after: plan.activities.slice(0, i).map((b) => b.name), uses_the_arm: a.arm ? "yes" : "no" },
      ])
    ),
  };
  const questions = {};
  plan.activities.forEach((a, i) => {
    questions[`a${i}__serves_objective`] = {
      type: "noul",
      instructions: {
        question: `Does \`activities.a${i}\` produce evidence that bears directly on \`objective\` for \`target\`?`,
        focus: "Judge the instrument's measurement against what the objective asks, not general usefulness.",
      },
      criteria: {
        true: { what: "The measurement can confirm or refute the objective." },
        false: { what: "The measurement is unrelated, or redundant with what the objective already assumes." },
      },
    };
    questions[`a${i}__prerequisites_met`] = {
      type: "noul",
      instructions: {
        question: `Given \`activities.a${i}.comes_after\`, is \`activities.a${i}\` in an acceptable position in the sequence?`,
        focus: "Rules: remote sensing before any arm work; abrasion before PIXL on a coring candidate; a core is last; a close-up image should precede PIXL.",
      },
      criteria: {
        true: { what: "Nothing required before it is missing, and nothing that must come later is already done." },
        false: { what: "A prerequisite is missing or the order violates the rules.", examples: ["PIXL before abrasion on a coring candidate", "arm work before any remote sensing"] },
      },
    };
    questions[`a${i}__risk_acceptable`] = {
      type: "noul",
      instructions: {
        question: `Given \`rover_state\`, is it acceptable to run \`activities.a${i}\` now?`,
        focus: "Arm activities need firm ground, modest tilt and clear air; remote sensing tolerates more.",
      },
      criteria: {
        true: { what: "The rover state does not conflict with the activity's needs." },
        false: { what: "Tilt, loose ground, dust, or late hour make the activity risky now." },
      },
    };
  });
  return { state, questions };
}
