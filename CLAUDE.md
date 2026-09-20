# CLAUDE.md

Working notes for Claude Code in this repo. This is a demo, not production software; the
point of it is that every decision is attributable to one of three engines, so the most
useful thing you can do here is keep that attribution honest.

## The one rule

**Code owns the workflow. Models answer narrow questions.**

- **jev** (System One, TypeSafe) answers typed questions and returns probabilities. It is
  never asked what to do next, never asked to plan, and never sees a number — only words.
- **Claude** (System Two, via the local CLI) plans, interprets and reports against a JSON
  schema. It is never asked to classify a blob or pick a steering arc.
- **Code** owns geometry, budgets, thresholds and the state machine. If something can be
  computed, compute it; do not ask a model.

If you find yourself adding a threshold to a prompt, or a judgment to a geometry function,
you are on the wrong side of this line.

## Two perception pipelines, and they must stay in step

There are two independent implementations of the same feature detector:

| | |
|---|---|
| `public/vision.js` | browser page, the coverage overlay, the arm's obstacle set |
| `ros2/jezero_ops/jezero_ops/geometry.py` (`detect`) | the ROS 2 run, which is what gets recorded |

**Change one and you must change the other.** They have diverged before and the result was a
fix that only worked on the page nobody records. Both implement: patch-coherent shadow
dropout on a 4×4 block hash, 8-connected components, hysteresis thresholding (seed at
relief > 0.075, grow at > 0.028, at least 3 seed pixels), 2nd–98th percentile boxes, and
per-camera-group windows (Navcam 1.9–13 m; Hazcam pairs 0.3–4 m beyond the wheel line).

## Measure, do not assert

Every claim in the README has a tool behind it. If you change perception, the arm, or the
coverage map, re-run the relevant one and put the new number in the README. Start the server
first (`npm start`), then:

```bash
node tools/perception_eval.mjs       # recall and box quality vs the world rock list
node tools/recall_probe.mjs          # close-range recall on the biggest rocks (must stay ~8/8)
node tools/traverse_eval.mjs         # rocks driven over per 100 m
node tools/coverage_eval.mjs         # does a rock actually occlude the coverage map
node tools/arm_metrics.mjs           # arm envelope measured off the GLB
node tools/arm_collision_eval.mjs    # "accepted but penetrating" must be 0
```

The world's rock list (`terrain.rocks`) is **ground truth for evaluation only**. Nothing in
the decision path may read it. If a feature description or an obstacle comes from the rock
list rather than from a camera, that is a bug, not a shortcut.

## Things that have bitten before

- **Independent per-pixel dropout destroys connectivity.** Modelling stereo shadow dropout by
  discarding random pixels tore shadowed boulders into sub-threshold fragments, and the only
  thing left connected was the flat dark skirt — so a 0.87 m rock was reported as a shadow.
  Dropout must be spatially coherent.
- **Guessed collision volumes.** The turret was modelled as a 0.12 m capsule; it is actually a
  0.83 × 0.34 × 0.84 m disc. Measure geometry off the model (`tools/arm_metrics.mjs`), never
  estimate it.
- **Question framing moves jev's confidence.** Describing a feature 9 m away as "under the
  next wheel placement" pushed confidence to 0.3–0.5, and the 0.55 gate then halted the rover
  on nearly every sweep. State words must match the measurement.
- **three.js ignores `camera.viewport` for a plain `Camera`,** and `render()` restores the
  render target's viewport. To draw into a sub-rect, bake it into the quad's vertex positions.
- **Coverage splats must not be stretched along the view ray.** Stretching to hide striping
  makes a splat from a rock's top surface spill onto the ground behind it, filling in the very
  occlusion shadow the map exists to show.
- **Heredocs with quotes and backslashes get mangled** by the shell here. Write patch scripts
  to a file with the Write tool instead.

## Running things

```bash
npm start                  # http://localhost:4180  (needs TYPESAFE_API_KEY and a logged-in claude CLI)
npm run smoke              # headless page load, reports console errors
npm run autorun            # headless full run
```

ROS 2 (WSL 2, Ubuntu 24.04, ROS 2 Jazzy) is the configuration the video is recorded from;
`ros2/setup_wsl.sh` provisions and `ros2/start_graph.sh` launches. `jezero_ops` is symlinked
into the workspace, so Python edits are live without a rebuild; `jezero_msgs` is copied and
needs `colcon build` if a message changes.

## Video

A run takes about 20 minutes of wall clock and roughly two thirds of that is Claude actually
reasoning, which cannot be sped up. The video is short because it is **re-timed afterwards**,
not because the run is fast: `tools/make_segments.mjs` turns the recorder's event log into a
per-segment speed plan, and `tools/encode_ramp.py` renders it with the multiplier burned into
the corner. Never speed up a recording without showing the multiplier on screen.

## Secrets and paths

No API keys in the repo. `TYPESAFE_API_KEY` comes from the environment or a gitignored
`.env`; `JEZERO_ENV_DIR` overrides where that is looked for. No absolute user paths anywhere
in tracked files — derive them (`REPO` in the Python nodes, `win_path()` for WSL interop,
`$(dirname "${BASH_SOURCE[0]}")` in the shell scripts).

## Style

Match the surrounding code: dense, commented where the *why* is not obvious, no ceremony.
Comments explain the reason a thing is the way it is, especially when it is the way it is
because the obvious version was wrong. Prose in the docs is plain and avoids overclaiming —
this is a demo and the documentation says so.
