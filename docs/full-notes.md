# Jezero Ops — Perseverance in-situ sim

A rover-operations sim that splits intelligence the way the two systems are
actually good at it:

| engine | role | how it is called | speed |
|---|---|---|---|
| **CLAUDE** (System Two) | the science team and tactical planners: reads the downlink, argues from geology, writes the sol plan, interprets instrument data, handles anomalies escalated from onboard | `claude -p --json-schema …` via the local CLI, one structured call per decision | 15–80 s |
| **JEV** (System One, TypeSafe) | the onboard judgment: what is that Navcam feature, is it a wheel hazard, will it sink a wheel, which candidate matches the team's criteria, which instrument, is this telemetry a fault, should we stop, does Earth need to decide | `POST /v1/systemone`, one request per decision point with all questions fanned out | ~200–300 ms |
| **CODE** (deterministic) | ENav arc geometry, ACE-style tilt and clearance, keep-outs, resource accounting (Wh / Mb / minutes), the sol state machine, wheel kinematics, the guard rails (confidence floors, margins) | `public/enav.js`, `public/game.js` | — |

Every decision is rendered in the ops console with its engine badge, its inputs
(the prompt, or the state + questions), and its outputs (the structured plan, or
the probability bars). Nothing is hidden.

```
npm start                      # http://localhost:4180   (needs TYPESAFE_API_KEY and a logged-in claude CLI)
node tools/autorun.mjs         # headless full run, screenshots to shots/run
node tools/record.mjs out.webm # record a full run
blender -b --python tools/encode_blender.py -- out.webm out.mp4
```

## Real things

- **Terrain**: USGS Astrogeology *Mars 2020 Terrain Relative Navigation CTX DTM
  Mosaic* (20 m/px) and the matching 6 m/px orthomosaic, cropped to 1.28 km
  centred on 18.4385°N 77.4335°E — the Máaz / Séítah / Artuby-ridge area
  Perseverance worked in its first year. Fergason et al. 2020,
  doi:10.5066/P906QQT8. Relief in the box: 46 m.
- **Rover**: NASA/JPL-Caltech *Mars Perseverance Rover 3D model*
  (`25042_Perseverance.glb`, science.nasa.gov). Wheels separated in Blender
  (`tools/prep_rover.py`) so they spin; mast and arm pivots animated.
- **Procedures** (encoded in the Claude system prompt and the code rules):
  tactical sol planning (assess downlink → choose discriminating science →
  sequence remote sensing before contact science → respect energy/data/time
  envelope with margin → uplink); contact-science ordering (abrade → gDRT →
  WATSON/PIXL → core → seal); AutoNav/ENav (heightmap, candidate arcs, ACE tilt
  and clearance checks, keep-outs, thinking-while-driving, ~120 m/h); AEGIS-style
  onboard target selection; anomaly escalation (onboard rule halts, ground
  decides).
- **Target names** and simplified "truth" tables follow published results:
  Máaz (basalt), Yeehgo, Rochette (first cored rock; sulfate-filled fractures),
  Séítah/Bastide (olivine cumulate altered to carbonate).

## Synthetic things (labelled in the UI)

- Rover-scale micro-relief: fractal noise (0.45/0.18/0.06 m at ~40/10/2.5 m).
- Rock field: Golombek cumulative-fractional-area model, k = 0.07, D ≥ 0.35 m,
  h/D ≈ 0.5 → 54,814 rocks in the central 800 m box.
- Ripple fields, the dust devil, the slip telemetry event, and the
  shadowed-rock ambiguity are scripted so the run exercises the decision paths.
- Instrument "data" are one-paragraph pipeline summaries looked up from the
  target's truth table, not simulated spectra.

## What to watch for in a run

1. **Planning** — Claude's plan, with the criteria it hands to jev for onboard
   targeting, the drive goal, and the ENav constraints.
2. **AutoNav** — ENav evaluates nine arcs every cycle (blue). Every ~6 m the
   Navcam "sees" features; jev classifies them in one request (green).
   A shadow is ignored; a ripple field becomes a 9 m keep-out; a rock with
   `wheel_hazard > 0.5` becomes an obstacle.
3. **Confidence gate** — when jev's `feature_type` confidence is below 0.55,
   code refuses to act: the rover stops, pans the mast, re-images, asks again.
4. **Dust devil** — jev says `dust_devil`, `science_interest 0.9`: not a hazard,
   but code schedules the MEDA/Navcam movie.
5. **Fault** — 46 % wheel slip. jev triages (stop? needs ground?). If Earth is
   needed, Claude diagnoses and constrains the onboard system.
6. **Science** — jev scores visible candidates against Claude's criteria and
   picks the instrument; code enforces remote-before-contact ordering, arm
   safety, and the scheduler margin; Claude interprets the data and may amend
   the plan (abrade → core).

## Perception (the rover sees; nothing is read from the rock list)

`public/vision.js`. A camera on the mast renders a colour frame and a packed depth
frame (the stereo stand-in) every imaging cycle. Depth is unprojected to world
points, relief above the local ground is measured, connected blobs become
features with distance, bearing, extent, max relief, tone and outline. Pixels in
deep shadow are sampled sparsely, as real stereo is. Those numbers are turned into
words and sent to jev (jev is text-only by design — see its docs). ENav plans on
the resulting *perception map* plus jev's keep-outs; the rear Hazcams (local
truth behind the rover) are used only when reversing. At science stops the Navcam
frame is also read by Claude (vision) for a geologist's description before jev
selects the target and instrument. The Navcam picture-in-picture (top-left) shows
the frame, the boxes, and jev's verdicts.

## Interactive features

- **Sol activity plan (swimlane)** — bottom of the viewport. One lane per
  subsystem (drive, Mastcam-Z, SuperCam, RIMFAX, arm, MEDA, relay pass) with each
  instrument's Wh / minutes / Mb. Blocks are *planned by Claude* (outlined),
  *executing* (amber), *done* (blue), *dropped by code or jev* (red hatch), or
  *user objective* (pink). Cumulative energy and downlink are drawn against the
  budget with the 15 % margin line and the plan's total.
- **Click a rock → objective.** Any rock in the scene (or a named target) can be
  clicked; type what you want checked. The loop is
  USER → CLAUDE (worth it? which instruments? what does it displace? inside the
  remaining envelope) → JEV (per activity: serves the objective? prerequisites
  met? risk acceptable now? each a probability, floor 0.5) → CODE (approach
  drive, execution, scheduler margin) → CLAUDE (report: confirmed / refuted /
  inconclusive, evidence, cost, recommendation).
- **Paths.** Gold = travelled. Cyan dashed = where ENav currently intends to go,
  recomputed every cycle against every keep-out jev has added, so it bends the
  moment a verdict lands. Blue = the arc being driven now. Flags along the track
  say why the route changed and which engine caused it (jev verdict vs ENav
  geometry vs ground decision).

## Files

```
server/index.mjs     HTTP + the two intelligence proxies
server/claude.mjs    claude CLI wrapper (structured output)
server/typesafe.mjs  TypeSafe client
server/jev.mjs       the System One question sets
server/prompts.mjs   the System Two prompts and schemas
server/world.mjs     campaign, constraints, instruments, targets, events
public/app.js        three.js scene, cameras, markers
public/game.js       the sol state machine
public/enav.js       ENav arcs (wheel-track + belly footprint), lookahead
public/vision.js     Navcam render -> depth/colour -> blobs -> words
public/terrain.js    DTM/ortho loader, rock instancing
public/rover.js      GLB loader, pose, wheels, mast, arm
public/ops.js        the console renderer
tools/build_terrain.py   USGS products -> game terrain
tools/prep_rover.py      Blender: split wheels, re-export
tools/record.mjs         Playwright recorder
tools/encode_blender.py  Blender VSE -> H.264 (Standard view transform; AgX would dim the video)
tools/decision_graph.py  generates docs/decision-graph.svg (+ Playwright PNG render)
tools/_gen_ros2.py       generates the ros2/ package skeleton
ros2/                    jezero_msgs + jezero_ops: the WORKING ROS 2 Jazzy port (WSL 2); setup_wsl.sh, start_graph.sh, stats.sh
public/ros.html          the browser as a ROS 2 simulator (roslibjs -> rosbridge); app_ros.js, ros_sim.js, cameras.js (9-camera rig), view.js
tools/autorun_ros.mjs    recorded run of the ROS page; tools/ros2_graph.py draws docs/ros2/graph.svg
tools/mcp_jev_server.mjs jev as an MCP tool for the Claude CLI (System One inside System Two); tools/mcp-jev.json
tools/decision_graph2.py Decision Graph II: what Claude asked jev mid-reasoning (docs/decision-graph-2.svg)
public/mind.js           the "two speeds of mind" strip; view.costmap()/frustum() draw ENav's cost map and camera FOVs
```

## Reports

- `docs/jezero-ops-report.md` / `.tex` — how the three engines work together,
  what was built, and the honest limits.
- `docs/vision-paper.md` / `.tex` — "Two Speeds of Mind", the theory behind the
  System One / System Two split.
- `docs/decision-graph.png` / `.svg` — the rover's decision graph (state → jev
  typed questions → code gates → actions) with one real imaging cycle highlighted.
- `docs/decision-graph-2.png` / `.svg` — Decision Graph II: System One inside System
  Two — what Claude asked jev while reasoning, jev's answers, what Claude did with them.
- `docs/ros2-migration.md` — the ROS 2 port: node table, run recipe, camera
  cadence, what is still a simulator shortcut, next steps toward Gazebo/Space ROS.

## ROS 2

The decision graph also runs as ROS 2 Jazzy nodes (WSL 2, Ubuntu 24.04) with the browser as a
simulator on rosbridge: `ros2/setup_wsl.sh` provisions, `colcon build` in `/root/ws` builds
(`jezero_ops` is symlinked to the repo), `ros2/start_graph.sh` launches, then open
`http://localhost:4180/ros.html`. Details in `docs/ros2-migration.md`.
