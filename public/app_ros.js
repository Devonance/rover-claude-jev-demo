// ROS 2 simulator page: the browser renders and moves; every decision lives in the ROS graph.
import { createView } from "./view.js";
import { ops } from "./ops.js";
import { Vision } from "./vision.js";
import { RosSim } from "./ros_sim.js";
import { CameraRig } from "./cameras.js";
import { Coverage } from "./coverage.js";

const canvas = document.getElementById("gl");
const { view, loadAssets, tick } = createView(canvas);
ops.now("CODE", "loading USGS terrain and NASA rover model…");
const { terrain, rover } = await loadAssets();
ops.log("CODE", "Assets loaded", `Terrain: <b>${terrain.N}×${terrain.N}</b> grid, ${terrain.size} m, ${terrain.rocks.length.toLocaleString()} rocks (${terrain.rockSource}) · ${terrain.meta.sources.dtm.split(",")[1]}, ${terrain.meta.sources.ortho.split(",")[1]}. Rover: ${terrain.meta.sources.rover.split(",")[0]}, ${rover.wheels.length} wheels articulated.<div style="font-size:11px;color:var(--ink3);margin-top:4px">Synthetic: ${terrain.meta.synthetic.rocks}; ${terrain.meta.synthetic.micro_relief}.</div>`);
const rig = new CameraRig(view.renderer, view.scene, terrain, rover);
// Ground coverage: what the camera rig can actually see, rocks casting their own shadows.
view.coverage = new Coverage(view.renderer, terrain);
view.coverage.attach(terrain.mesh);
view.vision = rig.primary.navcam.vision;
const url = new URLSearchParams(location.search).get("ros") ?? "ws://localhost:9090";
const sim = new RosSim(view, view.vision, url, rig);
ops.now("CODE", `connecting to rosbridge at ${url}`);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  sim.update(dt);
  tick(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// the same shims the local page exposes, so tools/autorun.mjs works unchanged
window.game = sim; window.view = view;
document.getElementById("btn-start").disabled = true; document.getElementById("btn-start").textContent = "▶ runs from ROS";
document.getElementById("btn-step").disabled = true;

const objPanel = document.getElementById("objective");
let currentPick = null;
function openObjective(pick) {
  currentPick = pick;
  view.ring(pick.x, pick.y, 2.0, 0xff8fb1, 20000);
  document.getElementById("obj-pick").innerHTML = `Pointed at: <b>${pick.name ?? "float rock"}</b> — ${pick.description} <span style="font-family:var(--mono);color:var(--ink3)">(${pick.x.toFixed(0)} E, ${pick.y.toFixed(0)} N)</span>`;
  objPanel.classList.add("on");
  document.getElementById("obj-text").focus();
}
canvas.addEventListener("click", (e) => { const rect = canvas.getBoundingClientRect(); const pick = view.pickAt(e.clientX - rect.left, e.clientY - rect.top); if (pick) openObjective(pick); });
window.demoPick = (i) => { const p = view.screenPosOfRock(i); let pick = view.pickAt(p.sx, p.sy); if (!pick || pick.rockIndex !== i) { const r = view.terrain.rocks[i]; pick = { id: `pick_${r.i}`, rockIndex: r.i, x: r.x, y: r.y, description: view.perceivedDesc(r.x, r.y) }; } openObjective(pick); return true; };
window.pickRockForDemo = (i) => { const r = view.terrain.rocks[i]; return { pos: view.screenPosOfRock(i), rock: r }; };
document.getElementById("obj-send").addEventListener("click", () => {
  const text = document.getElementById("obj-text").value.trim();
  if (!text || !currentPick) return;
  sim.injectObjective(currentPick, text);
  objPanel.classList.remove("on");
  document.getElementById("obj-text").value = "";
});
document.getElementById("obj-cancel").addEventListener("click", () => objPanel.classList.remove("on"));
document.getElementById("btn-swim").addEventListener("click", (e) => { const w = document.getElementById("swimlane-wrap"); w.classList.toggle("hidden"); e.currentTarget.classList.toggle("on", !w.classList.contains("hidden")); });
document.getElementById("btn-obj").addEventListener("click", () => document.getElementById("pick-hint").classList.toggle("on"));
