"""System One question sets (port of server/jev.mjs). Numbers stay in code: every
quantity is bucketed into words before jev sees it."""


def bucket_size(h):
    return "ankle-height" if h < 0.15 else "shin-height" if h < 0.3 else "knee-height" if h < 0.5 else "waist-height" if h < 0.8 else "taller than a wheel"


def bucket_dist(d):
    return "right in front of the rover" if d < 3 else "a few metres ahead" if d < 6 else "at the edge of Navcam range"


def hazard_questions(features, sun_words, ground_words=None):
    """features: list of dicts with id, appearance, h (or None), size_words, dist, bearing_words, stereo_note.
    ground_words: code's description of the ground in the intended corridor; adds one terrain-class question."""
    state = {
        "rover": {"drive_mode": "AutoNav with ENav, thinking-while-driving", "wheel_diameter": "about half a metre", "belly_clearance": "about half a metre", "sun": sun_words},
        "navcam_features": {f["id"]: {
            "appearance": f["appearance"],
            "apparent_size": bucket_size(f["h"]) if f.get("h") is not None else f.get("size_words", ""),
            "position": f"{bucket_dist(f['dist'])}, {f['bearing_words']}",
            "stereo_range_note": f["stereo_note"]} for f in features},
    }
    q = {}
    if ground_words:
        state["ground_ahead"] = ground_words
        q["ground__class"] = {"type": "choice",
            "instructions": {"question": "What kind of ground is `ground_ahead` for the next few metres of driving?", "focus": "Judge the surface the wheels will roll on, not the rocks standing on it."},
            "criteria": {
                "bedrock_pavement": {"what": "Coherent flat rock or firm crusted pavement; wheels grip well."},
                "cobble_field": {"what": "Firm ground strewn with pebbles and cobbles; some slip, some bumping."},
                "mixed_regolith": {"what": "Loose regolith with scattered rocks; moderate slip."},
                "sand_drift": {"what": "Fine bright sand, ripples or drifts; wheels sink and slip badly."}}}
    for f in features:
        i = f["id"]
        q[f"{i}__type"] = {"type": "choice",
            "instructions": {"question": f"What is the feature at `navcam_features.{i}`?", "focus": "Use the appearance and the stereo note together. Shadows have no stereo relief."},
            "criteria": {
                "embedded_rock": {"what": "A rock set into the ground; stereo shows relief."},
                "loose_rock": {"what": "A rock resting on the surface, perched or half-buried; stereo shows relief."},
                "bedrock_slab": {"what": "A flat, coherent slab of pavement; low relief, broad."},
                "sand_ripples": {"what": "Fine-grained bright material with regular ripples; no rock relief."},
                "shadow_only": {"what": "A dark patch with no stereo relief: a shadow cast by something else.", "not_for": "Anything with measured relief."},
                "dust_devil": {"what": "A moving column of lifted dust; changes between frames."}}}
        q[f"{i}__wheel_hazard"] = {"type": "noul",
            "instructions": {"question": f"Would driving a wheel over `navcam_features.{i}` risk damaging the wheel or high-centring the rover?", "focus": "Relief taller than shin-height matters. Shadows and dust do not."},
            "criteria": {"true": {"what": "A solid object with relief at or above knee-height, or a sharp angular edge at shin-height."},
                         "false": {"what": "Nothing solid, or low enough to roll over.", "examples": ["a shadow", "ankle-height rounded pebble"]}}}
        q[f"{i}__sinkage"] = {"type": "noul",
            "instructions": {"question": f"Could `navcam_features.{i}` cause wheel sinkage or excessive slip?", "focus": "Loose fine-grained material, ripples, or bright drifts."},
            "criteria": {"true": {"what": "Ripple fields, drifts, or fine bright sand."}, "false": {"what": "Bedrock, embedded rock, shadow, or dust in the air."}}}
        q[f"{i}__science"] = {"type": "noul",
            "instructions": {"question": f"Is `navcam_features.{i}` worth an opportunistic observation during the drive?", "focus": "Atmospheric phenomena and unusual rock textures are; ordinary float and shadows are not."},
            "criteria": {"true": {"what": "A dust devil, an unusually light-toned or layered rock, or a fresh-looking surface."}, "false": {"what": "Ordinary dark float, sand, or a shadow."}}}
    return state, q


# Which camera pair saw a feature, in words jev can use. In a whole-rig sweep the features
# from every pair arrive in one request, so each one carries its camera in its id prefix
# (see sol_executive.camera_sweep) and that prefix is turned back into words here.
CAM_WORDS = {
    "nav": "the mast Navcam stereo pair, looking down the route",
    "fh": "the front Hazcam stereo pair, looking straight down at the ground the front wheels are about to roll onto",
    "fhb": "the backup front Hazcam stereo pair",
    "rear": "the rear Hazcam stereo pair, looking at the ground behind the rover",
}


def cam_of(fid):
    pre = fid.split("__", 1)[0] if "__" in fid else ""
    return CAM_WORDS.get(pre)


def _where(dist, group):
    """Where a feature is, honestly. A whole-rig sweep carries near-field Hazcam features and
    Navcam features ten metres out in the same request; describing them all as "under the next
    wheel placement" is what drove jev's confidence down to the floor and made the gate halt
    the rover on almost every sweep."""
    if dist < 1.6: return "under the next wheel placement"
    if dist < 4.0: return "within the next metre or two of travel"
    if group != "sweep": return "within the next metre or two of travel"
    if dist < 8.0: return "a few metres ahead on the route, not under a wheel yet"
    return "out at the edge of Navcam range on the route ahead"


def hazcam_questions(features, group, sun_words):
    """Near-field check from a Hazcam pair (0.3-4 m): is the rover about to roll onto something
    it should not? Same four answer keys as the Navcam set so code and the console treat them alike,
    but the questions are about the next wheel placement, not the route.

    group == "sweep" means every camera pair on the rover at once: one request carrying
    whatever each pair measured, so a rock only the rear pair can see still stops the move."""
    if group == "sweep":
        where = "around the rover; each one carries the camera pair that measured it"
        situation = "about to move; this is every engineering camera on the rover reporting at once"
    else:
        where = "just ahead of the front wheels and in the arm workspace" if group == "front_hazcam" else "just behind the rear wheels"
        situation = f"about to move; these features are {where}, seen by the {group.replace('_', ' ')} stereo pair"
    state = {
        "rover": {"situation": situation, "wheel_diameter": "about half a metre",
                  "belly_clearance": "about half a metre", "sun": sun_words},
        "hazcam_features": {f["id"]: {k: v for k, v in {
            "appearance": f["appearance"],
            "apparent_size": bucket_size(f["h"]) if f.get("h") is not None else f.get("size_words", ""),
            "seen_by": cam_of(f["id"]),
            "position": f"{_where(f['dist'], group)}, {f['bearing_words']}",
            "stereo_range_note": f["stereo_note"]}.items() if v} for f in features},
    }
    q = {}
    for f in features:
        i = f["id"]
        q[f"{i}__type"] = {"type": "choice",
            "instructions": {"question": f"What is the feature at `hazcam_features.{i}`?", "focus": "Wheel-scale judgment. Shadows and dust have no stereo relief."},
            "criteria": {
                "embedded_rock": {"what": "A rock set into the ground; stereo shows relief."},
                "loose_rock": {"what": "A rock resting on the surface, perched or half-buried; stereo shows relief."},
                "bedrock_slab": {"what": "Flat coherent pavement; low relief, broad."},
                "sand_ripples": {"what": "Fine-grained bright drift; no rock relief."},
                "shadow_only": {"what": "A dark patch with no stereo relief.", "not_for": "Anything with measured relief."},
                "dust_devil": {"what": "Lifted dust in the air; not on the ground."}}}
        q[f"{i}__wheel_hazard"] = {"type": "noul",
            "instructions": {"question": f"If the rover drives on, would a wheel rolling onto `hazcam_features.{i}` risk damaging the wheel or high-centring the rover?",
                             "focus": "Judge the object, using `position` for how soon it matters. Shin-height and taller solid relief matters; ankle-height rounded pebbles do not."},
            "criteria": {"true": {"what": "Solid relief at or above shin-height under a wheel, or a sharp edge a wheel would drop onto."},
                         "false": {"what": "Nothing solid, or low and rounded enough to roll over.", "examples": ["a shadow", "ankle-height rounded pebble", "flat bedrock"]}}}
        q[f"{i}__sinkage"] = {"type": "noul",
            "instructions": {"question": f"Could `hazcam_features.{i}` let the wheel sink or slip on the next move?", "focus": "Loose fine-grained material under the wheel."},
            "criteria": {"true": {"what": "Drift, ripples, fine bright sand under the wheel track."}, "false": {"what": "Bedrock, embedded rock, shadow, or dust in the air."}}}
        q[f"{i}__science"] = {"type": "noul",
            "instructions": {"question": f"Is `hazcam_features.{i}` worth flagging to the science team as an unusual surface?", "focus": "Unusual tone, texture or a fresh surface; ordinary float and shadows are not."},
            "criteria": {"true": {"what": "An unusually light-toned, layered or fresh-looking surface."}, "false": {"what": "Ordinary dark float, sand, or a shadow."}}}
    return state, q


def aegis_questions(candidates, criteria, arm):
    state = {"science_criteria_from_planning_team": criteria,
             "candidates": {c["id"]: {"description": c["description"], "distance": bucket_dist(c["dist"])} for c in candidates},
             "arm_workspace": arm}
    q = {}
    for c in candidates:
        i = c["id"]
        q[f"{i}__match"] = {"type": "score",
            "instructions": {"question": f"How well does `candidates.{i}` satisfy `science_criteria_from_planning_team`?", "focus": "Judge the description against the criteria as written, not general interest."},
            "criteria": ["Does not satisfy the criteria at all.", "Weakly related; only one aspect of the criteria applies.", "Satisfies most of the criteria.", "Exactly the kind of target the criteria describe."]}
        q[f"{i}__instrument"] = {"type": "choice",
            "instructions": {"question": f"Which single instrument best answers the planning team's question about `candidates.{i}`, given its distance?", "focus": "Arm instruments need the target within reach. Remote instruments do not."},
            "criteria": {
                "SuperCam_LIBS": {"what": "Remote elemental chemistry by laser, up to about seven metres. First look at composition."},
                "MastcamZ_multispectral": {"what": "Remote colour and mineral indicators at any distance. Context and stratigraphy."},
                "WATSON_closeup": {"what": "Arm-mounted close-up texture imaging. Target within reach."},
                "PIXL_map": {"what": "Arm-mounted fine-scale chemistry map, hours long. Only for a prepared, high-value target within reach."},
                "skip": {"what": "Not worth instrument time this sol."}}}
    q["arm_deploy_safe"] = {"type": "noul",
        "instructions": {"question": "Given `arm_workspace`, is it safe to deploy the robotic arm for contact science now?", "focus": "Tilt, surface stability under the wheels, and airborne dust all matter."},
        "criteria": {"true": {"what": "Modest tilt, wheels on firm ground, clear air."}, "false": {"what": "Steep tilt, loose material under a wheel, or dust in the air."}}}
    return state, q


def fault_questions(phase, description, terrain_words):
    state = {"drive_phase": phase, "telemetry_event": description, "recent_terrain": terrain_words}
    q = {
        "fault_class": {"type": "choice",
            "instructions": {"question": "What does `telemetry_event` most likely indicate?", "focus": "Read the event together with `recent_terrain`."},
            "criteria": {
                "nominal": {"what": "Within normal drive behaviour; no action."},
                "wheel_slip_excess": {"what": "Wheels turning faster than the rover moves; loose ground."},
                "motor_current_high": {"what": "A drive actuator drawing more current than expected; possible obstruction."},
                "tilt_exceeded": {"what": "Rover attitude past the planned limit."},
                "visual_odometry_failure": {"what": "The rover cannot confirm its motion from images; featureless or shadowed ground."},
                "thermal": {"what": "A temperature reading outside its allowed range."}}},
        "stop_drive": {"type": "noul",
            "instructions": {"question": "Should the rover stop driving now rather than continue?", "focus": "Stop when continuing could embed or damage the rover."},
            "criteria": {"true": {"what": "Continuing risks getting stuck or damaging hardware."}, "false": {"what": "Safe to continue with monitoring."}}},
        "needs_ground": {"type": "noul",
            "instructions": {"question": "Does this need the ground team (Earth) to decide, rather than an onboard rule?", "focus": "Novel, ambiguous, or safety-critical situations go to Earth."},
            "criteria": {"true": {"what": "Ambiguous cause or a decision with mission-level consequences."}, "false": {"what": "A routine, well-understood event."}}},
    }
    return state, q


def verify_questions(plan):
    acts = plan["activities"]
    state = {"objective": plan["objective"], "target": plan["target"], "rover_state": plan["rover_words"],
             "activities": {f"a{i}": {"instrument": a["name"], "what_it_measures": a["measures"], "purpose": a["purpose"],
                                      "comes_after": [b["name"] for b in acts[:i]], "uses_the_arm": "yes" if a["arm"] else "no"} for i, a in enumerate(acts)}}
    q = {}
    for i, _ in enumerate(acts):
        q[f"a{i}__serves_objective"] = {"type": "noul",
            "instructions": {"question": f"Does `activities.a{i}` produce evidence that bears directly on `objective` for `target`?", "focus": "Judge the instrument's measurement against what the objective asks, not general usefulness."},
            "criteria": {"true": {"what": "The measurement can confirm or refute the objective."}, "false": {"what": "The measurement is unrelated, or redundant with what the objective already assumes."}}}
        q[f"a{i}__prerequisites_met"] = {"type": "noul",
            "instructions": {"question": f"Given `activities.a{i}.comes_after`, is `activities.a{i}` in an acceptable position in the sequence?", "focus": "Rules: remote sensing before any arm work; abrasion before PIXL on a coring candidate; a core is last; a close-up image should precede PIXL."},
            "criteria": {"true": {"what": "Nothing required before it is missing, and nothing that must come later is already done."},
                         "false": {"what": "A prerequisite is missing or the order violates the rules.", "examples": ["PIXL before abrasion on a coring candidate", "arm work before any remote sensing"]}}}
        q[f"a{i}__risk_acceptable"] = {"type": "noul",
            "instructions": {"question": f"Given `rover_state`, is it acceptable to run `activities.a{i}` now?", "focus": "Arm activities need firm ground, modest tilt and clear air; remote sensing tolerates more."},
            "criteria": {"true": {"what": "The rover state does not conflict with the activity's needs."}, "false": {"what": "Tilt, loose ground, dust, or late hour make the activity risky now."}}}
    return state, q


# ---------------------------------------------------------- continuous health (telemetry stream)
def health_questions(summary_words):
    state = {"rover_housekeeping": summary_words}
    q = {
        "fault_class": {"type": "choice",
            "instructions": {"question": "What does `rover_housekeeping` most likely indicate right now?", "focus": "Read the whole summary; one dominant condition."},
            "criteria": {
                "nominal": {"what": "Everything within normal drive behaviour; no action."},
                "wheel_slip_excess": {"what": "Wheels turning faster than the rover moves; loose ground."},
                "motor_current_high": {"what": "A drive actuator drawing more current than expected; possible obstruction or a wheel against a rock."},
                "tilt_exceeded": {"what": "Attitude at or past the planned limit."},
                "visual_odometry_failure": {"what": "The rover cannot confirm its motion from images."},
                "thermal": {"what": "A temperature outside its allowed band."},
                "power_low": {"what": "Battery approaching the reserve that must be kept for heating."},
                "dust_storm": {"what": "Optical depth high enough to cut power and imaging."}}},
        "stop_drive": {"type": "noul",
            "instructions": {"question": "Given `rover_housekeeping`, should the rover stop driving now rather than continue?", "focus": "Stop when continuing could embed or damage the rover or drain the reserve."},
            "criteria": {"true": {"what": "Continuing risks getting stuck, damaging hardware, or breaching the power reserve."}, "false": {"what": "Safe to continue with monitoring."}}},
        "needs_ground": {"type": "noul",
            "instructions": {"question": "Does `rover_housekeeping` need the ground team to decide, rather than an onboard rule?", "focus": "Novel, ambiguous, or mission-level consequences go to Earth; routine, well-understood events do not."},
            "criteria": {"true": {"what": "Ambiguous cause or a decision with mission-level consequences."}, "false": {"what": "A routine, well-understood condition."}}},
    }
    return state, q


# ---------------------------------------------------------- frame usability (before planning on it)
def frame_questions(frame_words):
    state = {"navcam_frame": frame_words}
    q = {"usable": {"type": "noul",
            "instructions": {"question": "Is `navcam_frame` good enough to plan a drive on?", "focus": "Stereo coverage and exposure matter; a frame with large holes or a washed-out or black foreground is not."},
            "criteria": {"true": {"what": "Most of the near field has stereo matches and the exposure shows ground texture."},
                         "false": {"what": "Large parts of the near field have no stereo, or the frame is over- or under-exposed, or the mast was moving."}}},
         "reason": {"type": "choice",
            "instructions": {"question": "If `navcam_frame` is degraded, what is the most likely cause?"},
            "criteria": {"fine": {"what": "Nothing wrong."}, "shadow": {"what": "Deep shadow with no stereo texture."}, "glare": {"what": "Sun in the frame or washed-out exposure."},
                         "dust": {"what": "Airborne dust lowering contrast."}, "motion": {"what": "Blur or a mast that had not settled."}}}}
    return state, q


# ---------------------------------------------------------- downlink prioritisation (data products vs the sol's hypotheses)
def downlink_questions(products, hypotheses_words):
    state = {"science_hypotheses": hypotheses_words,
             "data_products": {p["id"]: {"instrument": p["instrument"], "target": p["target"], "content": p["content"], "size": p["size_words"]} for p in products}}
    q = {}
    for p in products:
        i = p["id"]
        q[f"{i}__value"] = {"type": "score",
            "instructions": {"question": f"How much does `data_products.{i}` advance `science_hypotheses` if it comes down in this relay pass rather than a later one?",
                             "focus": "Judge what the team can do with it tomorrow, not general interest."},
            "criteria": ["Adds nothing the team needs soon.", "Useful context; can wait a sol.", "Needed to plan tomorrow's activities.", "Decisive for a hypothesis or a sample decision; must come down now."]}
    return state, q


# ---------------------------------------------------------- sample defensibility (before a core is committed)
# The arm's real envelope, measured off the model by tools/arm_metrics.mjs rather than
# assumed. jev cannot judge whether a spot is reachable without knowing how long the arm is
# and how big the thing on the end of it is; before these numbers were given to it, it was
# scoring placements that put a 0.84 m turret disc through the middle of a boulder.
ARM_ENVELOPE = ("the instrument reaches about 2 m from a shoulder mounted 0.8 m above the ground; "
                "the turret on the end is a disc about 0.8 m across and 0.3 m thick, and the instrument "
                "sits on its rim, 0.37 m from the turret's own pivot; only the instrument face may touch "
                "anything, so a spot is only usable if the whole turret disc still clears the rock when "
                "the face is against it")


def placement_questions(spots, instrument_words, rover_words):
    """spots: {id: words}. Code found the candidate spots from the rock's geometry and measured
    the arm clearance for each; jev judges each for the instrument."""
    state = {"instrument": instrument_words, "rover": rover_words, "arm_envelope": ARM_ENVELOPE,
             "candidate_spots": spots}
    q = {}
    for i in spots:
        q[f"{i}__quality"] = {"type": "score",
            "instructions": {"question": f"How good is `candidate_spots.{i}` as a placement for `instrument`?",
                             "focus": "The instrument wants a facet it can sit square against, within reach, lit well enough to image, not buried in dust."},
            "criteria": ["Unusable: out of reach, or a surface the instrument cannot sit against.", "Marginal: reachable but sloping, rough, dusty or in shadow.",
                         "Good: reachable and flat enough, minor issues.", "Ideal: flat, clean, well lit, comfortably inside the workspace."]}
        q[f"{i}__collision"] = {"type": "noul",
            "instructions": {"question": f"Would placing the turret on `candidate_spots.{i}` risk the arm or turret touching the rock edge, the ground or the rover?",
                             "focus": "Read `arm_envelope` with the spot's own clearance note. A wide turret on a narrow or steeply tilted face is the common failure; so is a spot that needs the arm stretched out flat over the rock."},
            "criteria": {"true": {"what": "A steep or narrow face, a spot near the ground, or a reach that lays the arm out over the rock."},
                         "false": {"what": "A facet with room around it for the whole turret disc, reached without stretching."}}}
    return state, q


def contact_questions(workspace_words, instrument_words):
    """The pre-contact check from the hover position: standoff, surface attitude, placement solution, clearance."""
    state = {"workspace_view": workspace_words, "instrument": instrument_words, "arm_envelope": ARM_ENVELOPE}
    q = {
        "safe_to_contact": {"type": "noul",
            "instructions": {"question": "From the hover position described in `workspace_view`, is it safe to lower `instrument` onto the surface now?",
                             "focus": "A clean placement solution, a surface tilt the turret can match, and nothing else within the turret's clearance."},
            "criteria": {"true": {"what": "Small solution error, moderate tilt, clear surroundings."}, "false": {"what": "Large solution error, steep tilt, or something within the clearance."}}},
        "good_data": {"type": "noul",
            "instructions": {"question": "Would `instrument` return good data from this placement?", "focus": "Dust, shadow and a tilted facet all degrade the measurement."},
            "criteria": {"true": {"what": "Clean, lit, near-square facet."}, "false": {"what": "Dusty, shadowed or badly tilted."}}},
        "adjust": {"type": "choice",
            "instructions": {"question": "What should the arm do next?"},
            "criteria": {"contact": {"what": "Lower to contact and measure."}, "shift": {"what": "Move to another candidate spot first."},
                         "abort": {"what": "Do not place the instrument this sol."}}},
    }
    return state, q


def sample_questions(target_words, evidence_words, campaign_words):
    state = {"candidate": target_words, "evidence_in_hand": evidence_words, "campaign_goal": campaign_words}
    q = {
        "defensible": {"type": "noul",
            "instructions": {"question": "Would coring `candidate` now be defensible to the Sample Return Science Board given `evidence_in_hand`?",
                             "focus": "A core needs a characterised, coherent target whose science value to `campaign_goal` is established by the measurements already made."},
            "criteria": {"true": {"what": "Lithology established, abrasion and chemistry done, value to the campaign clear."},
                         "false": {"what": "Lithology uncertain, no abrasion or chemistry yet, or the target is ordinary for this unit."}}},
        "missing": {"type": "choice",
            "instructions": {"question": "If anything is missing before coring `candidate`, what is it?"},
            "criteria": {"nothing": {"what": "Ready to core."}, "abrasion": {"what": "No abraded surface examined yet."}, "chemistry": {"what": "No elemental chemistry on the fresh surface."},
                         "texture": {"what": "No close-up texture imaging."}, "context": {"what": "Unclear where the rock sits in the stratigraphy."}}},
        "coherent": {"type": "noul",
            "instructions": {"question": "Is `candidate` likely to yield an intact core rather than crumble?", "focus": "Resistant, blocky, standing proud of the pavement is good; friable or crumbly is not."},
            "criteria": {"true": {"what": "Coherent, resistant rock."}, "false": {"what": "Friable, layered-and-flaking, or sand-cemented."}}},
    }
    return state, q
