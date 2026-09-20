// The engineering-camera rig: Perseverance's nine Navcam/Hazcam/Mastcam-Z views, each a small
// render camera on the rover, drawn as a 3x3 grid. Stereo pairs share one point cloud (from the
// left camera's depth buffer, standing in for stereo correlation); the right camera and the
// backup front pair are display only.
import { Vision } from "./vision.js";

// [lon fwd, lat left, height], yaw (rad, +left), pitch (rad, negative = down), fov (deg), group, label
export const RIG = [
  { id: "navL", label: "NAVCAM L", group: "navcam", primary: true, mast: true, lat: 0.21, pitch: -0.2, fov: 88 },
  { id: "navR", label: "NAVCAM R", group: "navcam", mast: true, lat: -0.21, pitch: -0.2, fov: 88 },
  { id: "mcz", label: "MASTCAM-Z", group: "science", mast: true, lat: 0.12, pitch: -0.12, fov: 26 },
  { id: "fhLA", label: "FRONT HAZCAM L-A", group: "front_hazcam", primary: true, lon: 1.45, lat: 0.35, h: 0.62, yaw: 0, pitch: -0.62, fov: 112 },
  { id: "fhRA", label: "FRONT HAZCAM R-A", group: "front_hazcam", lon: 1.45, lat: -0.35, h: 0.62, yaw: 0, pitch: -0.62, fov: 112 },
  { id: "fhLB", label: "FRONT HAZCAM L-B (backup)", group: "front_hazcam_b", lon: 1.45, lat: 0.25, h: 0.55, yaw: 0, pitch: -0.62, fov: 112 },
  { id: "rhL", label: "REAR HAZCAM L", group: "rear_hazcam", primary: true, lon: -1.5, lat: 0.3, h: 0.62, yaw: Math.PI, pitch: -0.62, fov: 112 },
  { id: "rhR", label: "REAR HAZCAM R", group: "rear_hazcam", lon: -1.5, lat: -0.3, h: 0.62, yaw: Math.PI, pitch: -0.62, fov: 112 },
  { id: "fhRB", label: "FRONT HAZCAM R-B (backup)", group: "front_hazcam_b", lon: 1.45, lat: -0.25, h: 0.55, yaw: 0, pitch: -0.62, fov: 112 },
];
const GROUP_COLOR = { navcam: "#4fd18b", front_hazcam: "#5aa7e6", rear_hazcam: "#b48cff", science: "#e6b45a", front_hazcam_b: "#6f7c88" };

export class CameraRig {
  constructor(renderer, scene, terrain, rover) {
    this.cams = RIG.map((spec) => ({ spec, vision: new Vision(renderer, scene, terrain, rover, spec) }));
    this.byId = Object.fromEntries(this.cams.map((c) => [c.spec.id, c]));
    this.primary = Object.fromEntries(this.cams.filter((c) => c.spec.primary).map((c) => [c.spec.group, c]));
    this.status = {}; this.feats = {}; this.verdicts = {};
    this.tile = { w: 176, h: 99, bar: 12 };
  }
  // the primary camera of a group renders colour + depth (its point cloud goes to perception)
  capture(group) { const c = this.primary[group] ?? this.primary.navcam; c.vision.capture(); return c.vision; }
  // refresh every tile's colour frame (display only) — cheap: nine 192x108 renders
  refreshAll() { for (const c of this.cams) c.vision.capture(); }
  setFeatures(group, feats, verdicts) { this.feats[group] = feats; this.verdicts[group] = verdicts ?? {}; }
  setStatus(group, text) { this.status[group] = text; }
  draw(canvas) {
    const g = canvas.getContext("2d");
    const { w, h, bar } = this.tile;
    g.fillStyle = "#0b0e12"; g.fillRect(0, 0, canvas.width, canvas.height);
    this.cams.forEach((c, i) => {
      const col = i % 3, row = (i / 3) | 0;
      const x0 = col * (w + 2), y0 = row * (h + bar + 2);
      const grp = c.spec.group;
      const feats = c.spec.primary ? (this.feats[grp] ?? []) : [];
      c.vision.draw(canvas, feats, this.verdicts[grp] ?? {}, { x: x0, y: y0 + bar, w, h });
      g.fillStyle = "#12161c"; g.fillRect(x0, y0, w, bar);
      g.font = "600 9px ui-monospace, monospace"; g.textBaseline = "middle";
      g.fillStyle = GROUP_COLOR[grp] ?? "#9aa5b1"; g.fillText(c.spec.label, x0 + 4, y0 + bar / 2);
      if (c.spec.primary) { g.fillStyle = "#9aa5b1"; g.textAlign = "right"; g.fillText(`→ jev · ${c.vision.seq} fr`, x0 + w - 4, y0 + bar / 2); g.textAlign = "left"; }
    });
  }
}
export { GROUP_COLOR };
