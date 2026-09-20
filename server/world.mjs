// The mission world. Game coordinates: x east, y north, metres from the terrain
// centre (77.4335 E, 18.4385 N in Jezero). z is up. Terrain is the real USGS
// CTX DTM; target positions are placed by us inside that terrain.
//
// Target names are real Perseverance first-year targets; their "truth" tables
// are simplified from published results so the science loop has real answers.

export const CAMPAIGN = {
  name: "Crater Floor Campaign, Sols 1-3 (sim)",
  goal:
    "Characterise the Máaz formation (crater-floor igneous unit), then reach Artuby ridge, abrade and core a Rochette-type rock, and image the Séítah contact. Every sample decision must be defensible to the Sample Return Science Board.",
  hypotheses: [
    "H1: The crater floor is a lava flow or shallow intrusion (igneous), not a sedimentary lake deposit.",
    "H2: Séítah is an olivine cumulate altered to carbonate by water; it underlies Máaz.",
  ],
};

// Sol resource envelope (simplified from the tactical planning constraints).
export const CONSTRAINTS = {
  energy_wh: 900,          // usable energy for driving + science above survival heating
  data_mb: 300,            // one MRO/MAVEN relay pass, downlink volume
  sol_minutes: 420,        // daylight ops window we allow activities in
  autonav_speed_m_per_h: 120,
  max_drive_m: 200,
  keepout_tilt_deg: 20,    // ENav tilt limit we use (flight limit ~30 deg, planners keep margin)
  rock_step_limit_m: 0.20, // rocks taller than this are steered around, not driven over
  belly_clearance_m: 0.5,
};

export const INSTRUMENTS = {
  MastcamZ_multispectral: { name: "Mastcam-Z multispectral", minutes: 25, wh: 20, mb: 45, range_m: 200, arm: false },
  SuperCam_LIBS: { name: "SuperCam LIBS + RMI", minutes: 30, wh: 25, mb: 20, range_m: 7, arm: false },
  RIMFAX: { name: "RIMFAX ground radar (drive)", minutes: 0, wh: 10, mb: 12, range_m: 0, arm: false },
  MEDA_dust: { name: "MEDA + Navcam dust-devil movie", minutes: 15, wh: 8, mb: 30, range_m: 999, arm: false },
  WATSON_closeup: { name: "WATSON close-up imaging", minutes: 40, wh: 35, mb: 35, range_m: 2.2, arm: true },
  PIXL_map: { name: "PIXL X-ray fluorescence map", minutes: 240, wh: 140, mb: 60, range_m: 2.2, arm: true },
  abrade: { name: "Abrade patch + gDRT dust removal", minutes: 90, wh: 90, mb: 25, range_m: 2.2, arm: true },
  core: { name: "Core sample + seal tube", minutes: 180, wh: 160, mb: 40, range_m: 2.2, arm: true },
};

export const TARGETS = [
  {
    id: "maaz",
    name: "Máaz",
    x: -52, y: -132,
    description:
      "Dark, pitted, blocky float rock about 1.2 m across. Vesicular texture. Blue-grey where dust is thin.",
    truth: {
      lithology: "basalt",
      libs: "Fe-rich pyroxene + plagioclase; Mg/Si low; no carbonate signature; small hydration feature from dust coating.",
      watson: "Fine-grained, vesicular, grains below resolution; thin dust coating; no layering.",
      pixl: "Pyroxene + plagioclase + Fe-Ti oxides; no olivine; no carbonate.",
      abradable: true,
    },
  },
  {
    id: "yeehgo",
    name: "Yeehgo",
    x: -18, y: -100,
    description:
      "Light-toned rock 0.7 m across with a rough, coated surface and faint lineations.",
    truth: {
      lithology: "basalt with coating",
      libs: "Basaltic bulk; surface enriched in S and Cl (coating); lineations are wind-abrasion, not bedding.",
      watson: "Ventifacted surface; coating flakes; underlying crystalline texture.",
      pixl: "Similar to Máaz; coating shows sulfate + chloride.",
      abradable: false,
    },
  },
  {
    id: "rochette",
    name: "Rochette",
    x: 70, y: 10,
    description:
      "Resistant, dark, briefcase-sized rock on the crest of Artuby ridge. Stands proud of the surrounding pavement; likely cohesive enough to core.",
    truth: {
      lithology: "basalt (Máaz fm), coherent",
      libs: "Pyroxene-rich basalt; high Fe; sulfate-filled fractures (evidence of water).",
      watson: "Abraded patch shows interlocking crystals and light-toned salt-filled fractures.",
      pixl: "Pyroxene + plagioclase; fracture fill = sulfates + perchlorate; alteration by water confirmed.",
      abradable: true,
      coreable: true,
    },
  },
  {
    id: "bastide",
    name: "Bastide",
    x: 150, y: 120,
    description:
      "Coarse-grained, light-toned polygonally fractured pavement at the Séítah contact. Large crystals visible from orbit-scale imaging; distinct from the dark Máaz pavement.",
    truth: {
      lithology: "olivine cumulate, carbonate-altered",
      libs: "High Mg/Si; olivine signature; carbonate peaks; hydration.",
      watson: "Millimetre-scale olivine grains in a cumulate texture; carbonate veins.",
      pixl: "Olivine + carbonate + minor pyroxene; classic Séítah assemblage.",
      abradable: true,
      coreable: true,
    },
  },
];

export const ROVER_START = { x: -60, y: -140, heading_deg: 40 };

// Scripted events the onboard system has to deal with. Where they trigger is
// decided by drive progress; what they are is decided by Jev when it sees them.
export const EVENTS = [
  { id: "sand_hidden_valley", at_odo: 40, kind: "sand_field" },
  { id: "shadow_rock", at_odo: 85, kind: "shadow_ambiguity" },
  { id: "dust_devil", at_odo: 125, kind: "dust_devil" },
  { id: "slip_fault", at_odo: 165, kind: "telemetry_fault" },
];
