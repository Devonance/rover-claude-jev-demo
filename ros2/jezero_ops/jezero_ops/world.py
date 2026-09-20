"""The mission world (port of server/world.mjs). Game coordinates: x east, y north, metres
from the terrain centre (77.4335 E, 18.4385 N in Jezero). Target names are real
Perseverance first-year targets; their truth tables are simplified from published results."""
import random, re

CAMPAIGN = {
    "name": "Crater Floor Campaign, Sols 1-3 (sim)",
    "goal": "Characterise the Máaz formation (crater-floor igneous unit), then reach Artuby ridge, abrade and core a Rochette-type rock, and image the Séítah contact. Every sample decision must be defensible to the Sample Return Science Board.",
    "hypotheses": [
        "H1: The crater floor is a lava flow or shallow intrusion (igneous), not a sedimentary lake deposit.",
        "H2: Séítah is an olivine cumulate altered to carbonate by water; it underlies Máaz.",
    ],
}

CONSTRAINTS = {
    "energy_wh": 900, "data_mb": 300, "sol_minutes": 420, "autonav_speed_m_per_h": 120,
    "max_drive_m": 200, "keepout_tilt_deg": 20, "rock_step_limit_m": 0.20, "belly_clearance_m": 0.5,
}

INSTRUMENTS = {
    "MastcamZ_multispectral": {"name": "Mastcam-Z multispectral", "minutes": 25, "wh": 20, "mb": 45, "range_m": 200, "arm": False},
    "SuperCam_LIBS": {"name": "SuperCam LIBS + RMI", "minutes": 30, "wh": 25, "mb": 20, "range_m": 7, "arm": False},
    "RIMFAX": {"name": "RIMFAX ground radar (drive)", "minutes": 0, "wh": 10, "mb": 12, "range_m": 0, "arm": False},
    "MEDA_dust": {"name": "MEDA + Navcam dust-devil movie", "minutes": 15, "wh": 8, "mb": 30, "range_m": 999, "arm": False},
    "WATSON_closeup": {"name": "WATSON close-up imaging", "minutes": 40, "wh": 35, "mb": 35, "range_m": 2.2, "arm": True},
    "PIXL_map": {"name": "PIXL X-ray fluorescence map", "minutes": 240, "wh": 140, "mb": 60, "range_m": 2.2, "arm": True},
    "abrade": {"name": "Abrade patch + gDRT dust removal", "minutes": 90, "wh": 90, "mb": 25, "range_m": 2.2, "arm": True},
    "core": {"name": "Core sample + seal tube", "minutes": 180, "wh": 160, "mb": 40, "range_m": 2.2, "arm": True},
}

TARGETS = [
    {"id": "maaz", "name": "Máaz", "x": -52, "y": -132,
     "description": "Dark, pitted, blocky float rock about 1.2 m across. Vesicular texture. Blue-grey where dust is thin.",
     "truth": {"lithology": "basalt", "libs": "Fe-rich pyroxene + plagioclase; Mg/Si low; no carbonate signature; small hydration feature from dust coating.",
               "watson": "Fine-grained, vesicular, grains below resolution; thin dust coating; no layering.",
               "pixl": "Pyroxene + plagioclase + Fe-Ti oxides; no olivine; no carbonate.", "abradable": True}},
    {"id": "yeehgo", "name": "Yeehgo", "x": -18, "y": -100,
     "description": "Light-toned rock 0.7 m across with a rough, coated surface and faint lineations.",
     "truth": {"lithology": "basalt with coating", "libs": "Basaltic bulk; surface enriched in S and Cl (coating); lineations are wind-abrasion, not bedding.",
               "watson": "Ventifacted surface; coating flakes; underlying crystalline texture.",
               "pixl": "Similar to Máaz; coating shows sulfate + chloride.", "abradable": False}},
    {"id": "rochette", "name": "Rochette", "x": 70, "y": 10,
     "description": "Resistant, dark, briefcase-sized rock on the crest of Artuby ridge. Stands proud of the surrounding pavement; likely cohesive enough to core.",
     "truth": {"lithology": "basalt (Máaz fm), coherent", "libs": "Pyroxene-rich basalt; high Fe; sulfate-filled fractures (evidence of water).",
               "watson": "Abraded patch shows interlocking crystals and light-toned salt-filled fractures.",
               "pixl": "Pyroxene + plagioclase; fracture fill = sulfates + perchlorate; alteration by water confirmed.", "abradable": True, "coreable": True}},
    {"id": "bastide", "name": "Bastide", "x": 150, "y": 120,
     "description": "Coarse-grained, light-toned polygonally fractured pavement at the Séítah contact. Large crystals visible from orbit-scale imaging; distinct from the dark Máaz pavement.",
     "truth": {"lithology": "olivine cumulate, carbonate-altered", "libs": "High Mg/Si; olivine signature; carbonate peaks; hydration.",
               "watson": "Millimetre-scale olivine grains in a cumulate texture; carbonate veins.",
               "pixl": "Olivine + carbonate + minor pyroxene; classic Séítah assemblage.", "abradable": True, "coreable": True}},
]

ROVER_START = {"x": -60, "y": -140, "heading_deg": 40}

EVENTS = [
    {"id": "sand_hidden_valley", "at_odo": 40, "kind": "sand_field"},
    {"id": "shadow_rock", "at_odo": 85, "kind": "shadow_ambiguity"},
    {"id": "dust_devil", "at_odo": 125, "kind": "dust_devil"},
    {"id": "slip_fault", "at_odo": 165, "kind": "telemetry_fault"},
]

MEASURES = {
    "MastcamZ_multispectral": "visible/near-infrared colour and mineral absorption bands from a distance",
    "SuperCam_LIBS": "elemental chemistry of a spot by laser plasma, from up to seven metres",
    "RIMFAX": "subsurface radar reflectors along the drive",
    "MEDA_dust": "wind, pressure and dust while imaging the sky",
    "WATSON_closeup": "millimetre-scale texture and grain imaging with the arm",
    "PIXL_map": "micro-scale elemental maps with the arm over hours",
    "abrade": "a fresh, dust-free surface for the other arm instruments",
    "core": "a sealed rock core for return to Earth",
}
SHORT = {"MastcamZ_multispectral": "Mastcam-Z", "SuperCam_LIBS": "LIBS", "RIMFAX": "RIMFAX", "MEDA_dust": "MEDA", "WATSON_closeup": "WATSON", "PIXL_map": "PIXL", "abrade": "abrade", "core": "core"}
REMOTE = {"MastcamZ_multispectral", "SuperCam_LIBS", "RIMFAX", "MEDA_dust"}
LANE_OF = {"drive": "DRIVE", "MastcamZ_multispectral": "MASTCAM", "SuperCam_LIBS": "SUPERCAM", "RIMFAX": "RIMFAX",
           "WATSON_closeup": "ARM", "PIXL_map": "ARM", "abrade": "ARM", "core": "ARM", "MEDA_dust": "MEDA", "comm": "COMM"}


def public_targets():
    return [{k: v for k, v in t.items() if k != "truth"} for t in TARGETS]


def synthetic_target(pick):
    """A user-picked float rock gets a truth table from its appearance."""
    light = re.search(r"light-toned", pick.get("description", "") or "", re.I) is not None
    if light:
        return {"truth": {"lithology": "olivine-carbonate float (Séítah-derived)", "libs": "High Mg/Si; olivine signature; carbonate features; hydration band.",
                          "watson": "Coarse mm-scale olivine grains, carbonate-filled fractures, light-toned weathering rind.",
                          "pixl": "Olivine + carbonate + minor pyroxene; matches the Séítah assemblage.", "abradable": True}}
    return {"truth": {"lithology": "basalt float (Máaz fm)", "libs": "Fe-rich pyroxene + plagioclase; low Mg/Si; no carbonate.",
                      "watson": "Fine-grained vesicular texture; dust coating; no layering.",
                      "pixl": "Pyroxene + plagioclase + Fe-Ti oxides; no olivine; no carbonate.", "abradable": True}}


def instrument_result(target_id, instrument, pick=None):
    """Synthetic instrument result from the truth table, worded like a pipeline summary."""
    if instrument == "MEDA_dust":
        return "Dust-devil movie captured: vortex diameter ~15 m, transit 40 s; MEDA pressure drop 0.8 Pa; wind 12 m/s."
    if instrument == "RIMFAX":
        return "Radar profile along drive: layered reflectors dipping gently toward the delta; consistent with stacked flows or cumulate layering."
    t = next((x for x in TARGETS if x["id"] == target_id), None)
    if t is None and pick:
        t = synthetic_target(pick)
    if t is None:
        return "no data"
    tr = t["truth"]
    if instrument.startswith("MastcamZ"):
        oli = "olivine" in tr["lithology"]
        return f"Multispectral (11 bands): {'strong 1 um olivine absorption, weak 2.3 um carbonate feature' if oli else 'flat basaltic spectrum with ferric dust slope; no 1 um olivine band'}; texture {tr['watson'].split(';')[0].lower()}."
    if instrument == "abrade":
        return f"Abrasion patch 5 cm complete; gDRT cleared dust. Fresh surface: {tr['watson']}"
    if instrument == "core":
        return f"Core acquired and sealed (tube {random.randint(1, 20)}). Volume nominal. Lithology per prior analyses: {tr['lithology']}."
    k = "libs" if instrument.startswith("SuperCam") else "watson" if instrument.startswith("WATSON") else "pixl" if instrument.startswith("PIXL") else None
    return tr[k] if k else "no data"


# Flight rules the onboard code cites when it gates. Modelled on the kind of rules the MER/MSL/M2020
# rover planners work under (tilt, arm, drive window, margin); the numbers are this sim's.
FLIGHT_RULES = {
    "FR-01": "Drive only inside the daylight ops window (LMST 08:00-17:00).",
    "FR-02": "Keep 15 % energy and data margin on every sol; the scheduler drops what does not fit.",
    "FR-03": "No arc with predicted tilt above 20 deg; ENav rejects it.",
    "FR-04": "Rocks with relief above 0.20 m are steered around, not driven over; belly clearance 0.48 m.",
    "FR-05": "Ripple fields and drifts are keep-out zones (6 m); never drive through loose fines.",
    "FR-06": "No motion is commanded before the near-field cameras have cleared the next wheel placement.",
    "FR-07": "Reverse only on ground the rear Hazcams have imaged.",
    "FR-08": "A System One read below the 0.55 confidence floor is not acted on: halt, re-image, ask again.",
    "FR-09": "Arm deployment needs tilt under 10 deg, firm ground under all wheels, and clear air.",
    "FR-10": "Remote sensing before contact science; abrasion before PIXL on a coring candidate; a core is last.",
    "FR-11": "Excess wheel slip halts the drive onboard (no Earth round trip); ambiguous causes go to the ground team.",
    "FR-12": "A user objective is executed only after each step is verified to serve it, in order, at acceptable risk.",
    "FR-13": "Final approach to a target is a planned straight bump to the 1.6 m stand-off (measured from the arm envelope: reach 2.05 m, turret 0.84 m across), target excluded from the veto.",
    "FR-14": "Drive distance is budgeted with the predicted slip for the terrain class ahead.",
}

# Predicted wheel slip by terrain class: the shape of the MSL/M2020 slip-vs-terrain tables planners
# use to size a drive (loose sand is where rovers get stuck). Percent of commanded distance lost.
SLIP_BY_CLASS = {"bedrock_pavement": 5.0, "cobble_field": 12.0, "mixed_regolith": 20.0, "sand_drift": 45.0}
