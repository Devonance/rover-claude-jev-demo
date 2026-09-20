# Jezero Ops — Perseverance sim (Claude + jev) on ROS 2 · v5

Built 18–19 September 2026. **Claude** (System Two) plans sols, reads the Navcam frame, interprets data,
handles anomalies and writes reports; **jev** (TypeSafe's System One) classifies what the nine cameras
see, watches the telemetry stream, picks targets and instruments, reviews the plan before uplink,
**scores where the arm should put its instrument and clears the contact from the hover**, checks sample
defensibility, orders the downlink — and **answers Claude's questions while Claude reasons**, as an MCP
tool. **Code** owns the rules: ENav geometry, a traversability cost map, budgets, slip-budgeted driving,
arm kinematics, fourteen cited flight rules, a behaviour-tree executive. Every decision on screen is
colour-coded by the engine that made it (purple Claude · green jev · blue code · pink user).

Built five times in two days: browser prototype (HTML/CSS/three.js + Node) → ROS 2 Jazzy graph (WSL 2,
browser as simulator over rosbridge, nine-camera rig) → v3 (System One inside System Two, JPL practice)
→ v4 (flight-like: Claude calls are ROS 2 *actions* with feedback and cancel, a py_trees executive, jev on
the 1 Hz telemetry stream) → v5 (the robotic arm is a real kinematic chain driven by inverse kinematics;
code proposes placement spots from the rock geometry, jev scores them and clears contact; photogrammetry
rocks from Poly Haven).

## Start here
- **jezero-ops-ros2-v5-1080p.mp4** — the v5 run (18 min, 1920×1080; overlays sized so the rover stays
  visible in the middle). Watch the science stops: the arm unstows, hovers over the spot jev chose, jev
  reads the workspace in words and says go, the turret lowers onto the rock; the console shows the four
  candidate spots with their scores and the rules that consumed them. On the sol-2 drive the health
  monitor halts on wheel slip (FR-11), escalates to the ground, and the executive cancels and re-issues
  the running Claude action when the telemetry worsens. 3 placements judged, 16 Claude calls (10 of 10
  asks consulted jev, 44 questions from inside Claude's reasoning), 52 health verdicts, 15 Hazcam vetoes,
  0 errors, $1.41 of Claude — **stats-final.txt**.
- **jezero-ops-report.pdf** (.md/.tex) — how it works, what was built, the measurements; all stills from
  the ROS 2 runs. Section 5 is the flight-like pass: topics vs services vs actions, the behaviour tree,
  jev on the telemetry, the arm placed by code and judged by jev, the hardware contract.
- **vision-paper.pdf** (.md/.tex) — "Two Speeds of Mind".
- **decision-graph-3.png** — Decision Graph III: the fourteen places jev is used on the rover, with the
  stream, the typed questions, the cadence and the rule that consumes each answer (also I and II).
- **hardware-contract.md** — every simulator interface mapped to the standard ROS 2 interface a real
  rover provides, and what stays identical.

## Also here
- **ros2-migration.md** — the ROS 2 port: node table, interfaces (topics/services/actions), the tree,
  the fourteen jev uses, run recipe.
- **jezero-ops-ros2.zip** — `jezero_msgs` + `jezero_ops` packages, launch/config/scripts.
- **graph.png / ros2-graph.png**, **graph-evidence.txt**, **stats-final.txt** — the live graph and the
  recorded run's statistics.
- Stills (.jpg): arm-contact, flight-panels, planning-sol2, science-maaz, navcam-obstacles, hazcam-veto,
  route-paths, objective-entry, objective-target, rochette-science, ros2-rig, mind-strip, costmap-veto.
- **jezero-ops-ros2-v4-1080p.mp4**, **jezero-ops-ros2-v2-1080p.mp4**, **jezero-ops-ros2-1080p.mp4**,
  **jezero-ops-1080p.mp4** — the v4, v3, ROS 2 and browser-only runs.

## Sources
USGS Mars 2020 TRN CTX DTM + orthomosaic (Jezero, 18.4385°N 77.4335°E); NASA/JPL-Caltech Perseverance
3D model (its arm chain drives the kinematics); Golombek rock-abundance model with 14 Poly Haven CC0
photogrammetry rock scans; Maki et al. 2020 (engineering cameras); JPL tactical planning, flight-rule and
slip-vs-terrain practice as described in the mission literature. Synthetic parts (rover-scale relief, rock
field, scripted telemetry excursions, truth-table instrument results, the placement-spot words derived
from geometry) are labelled in the report.
