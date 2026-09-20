// Camera coverage on the ground: what the rover has actually looked at.
//
// Every engineering camera already renders a packed-depth frame (vision.js). That depth
// frame is a shadow map: for any point on the ground we can project it into the camera,
// compare its depth against what the camera actually saw first, and know whether the
// camera has a clear line to it. A rock therefore casts a coverage shadow — the ground
// behind it is *not* marked seen, because the rock is what the camera saw.
//
// Two layers, both in world XY:
//   live      a rover-centred window, cleared every update: the current cones, one tint
//             per camera group.
//   explored  global, never cleared: everywhere any camera has ever had a clear line.
//
// Both are accumulated with MaxEquation blending, so one pass per camera and no read of
// the destination in the shader. The terrain material samples both (see attach()).
import * as THREE from "three";

const LIVE_RES = 1024;    // texels across the live window
const LIVE_SPAN = 220;    // m across the live window
const RECENTRE = 60;      // m of rover travel before the live window is re-centred
// Texels across the whole terrain. At 2048 a texel is 0.63 m and the explored trail reads
// as chunky squares when the camera comes down close; 4096 puts it at 0.31 m, which is
// finer than the rover is wide.
const GLOBAL_RES = 4096;

// group -> colour written into the live layer (RGB), matching cameras.js GROUP_COLOR
const GROUP_RGB = {
  navcam: [0.31, 0.82, 0.55],
  front_hazcam: [0.35, 0.72, 0.95],
  front_hazcam_b: [0.35, 0.72, 0.95],
  rear_hazcam: [0.72, 0.56, 1.00],
  // Mastcam-Z is narrow and long. Anything in the tan/yellow family reads as bare Mars
  // here, so its cone gets a colour the terrain never has.
  science: [0.95, 0.55, 0.85],
};

// One vertex per depth texel. The vertex shader reads that texel, unprojects it back to a
// world point, and places it in the coverage map. Nothing has to agree with the DTM: the
// point *is* what the camera measured, so a rock occludes the ground behind it simply by
// being the thing the depth buffer recorded.
const SPLAT_VERT = /* glsl */ `
precision highp float;
uniform sampler2D uDepth;
uniform mat4  uInvViewProj;
uniform vec3  uOrigin;
uniform vec2  uWinMin;
uniform vec2  uWinSpan;
uniform float uNear;
uniform float uFar;
uniform float uRange;
uniform float uTexelAngle;   // radians subtended by one depth texel
uniform float uTexPerMetre;  // coverage texels per metre
varying float vFade;

float unpackDepth(vec4 p) {
  return dot(p, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

void main() {
  vec2 duv = position.xy;                       // this vertex's depth texel, in [0,1]
  float d = unpackDepth(texture2D(uDepth, duv));
  if (d >= 0.9995 || d <= 0.0005) {             // sky, or nothing rendered
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vFade = 0.0; return;
  }
  vec4 h = uInvViewProj * vec4(duv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 world = h.xyz / h.w;
  float range = distance(world, uOrigin);
  if (range > uRange) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vFade = 0.0; return;
  }
  vec2 g = vec2(world.x, -world.z);             // three.js -> game XY
  vec2 uv = (g - uWinMin) / uWinSpan;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  // Footprint is the cross-range size of one texel and nothing more. It must NOT be
  // stretched along the view ray: a splat from a rock's top surface would then spill past
  // the rock and paint the ground behind it, filling in the very shadow this map exists to
  // show. Striping in the far field is the honest cost — that ground really is sampled
  // sparsely — and the 384x216 depth frame keeps it small.
  gl_PointSize = clamp(range * uTexelAngle * uTexPerMetre * 2.2, 1.5, 22.0);
  vFade = 1.0 - smoothstep(uRange * 0.72, uRange, range);
}
`;

const SPLAT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uTint;
varying float vFade;
void main() {
  if (vFade <= 0.02) discard;
  vec2 o = gl_PointCoord - 0.5;
  float a = vFade * (1.0 - smoothstep(0.18, 0.5, length(o)));
  if (a <= 0.02) discard;
  gl_FragColor = vec4(uTint * a, a);
}
`;

// The destination sub-rect is baked into the vertex positions: three.js ignores
// camera.viewport for a plain Camera, and render() restores the render target's own
// viewport, so setViewport() cannot be used here.
const ACCUM_VERT = /* glsl */ `
varying vec2 vUv;
uniform vec4 uDstRect;   // x, y, w, h in 0..1 of the destination
void main() {
  vUv = uv;
  vec2 p = uDstRect.xy + uv * uDstRect.zw;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Copies the live window into the global explored layer (max-blended, so it accumulates).
const ACCUM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uLive;
void main() {
  float a = texture2D(uLive, vUv).a;
  if (a <= 0.02) discard;
  gl_FragColor = vec4(vec3(1.0), a);
}
`;

const rt = (res) =>
  new THREE.WebGLRenderTarget(res, res, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
  });

export class Coverage {
  constructor(renderer, terrain) {
    this.renderer = renderer;
    this.terrain = terrain;
    this.enabled = true;
    this.live = rt(LIVE_RES);
    this.explored = rt(GLOBAL_RES);
    this.centre = new THREE.Vector2(0, 0);
    this.lastSeen = new Map();  // group -> ms, for the status line

    // DTM as a half-float texture the shader can sample
    const N = terrain.N, src = terrain.heightData;
    const half = new Uint16Array(N * N);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    this.heightTex = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.needsUpdate = true;

    // one vertex per depth texel of a camera frame
    const DW = 384, DH = 216;
    const pts = new Float32Array(DW * DH * 3);
    for (let j = 0, k = 0; j < DH; j++) for (let i = 0; i < DW; i++, k += 3) {
      pts[k] = (i + 0.5) / DW; pts[k + 1] = (j + 0.5) / DH; pts[k + 2] = 0;
    }
    this.splatGeo = new THREE.BufferGeometry();
    this.splatGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.depthW = DW; this.depthH = DH;

    this.quad = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: {
        uDepth: { value: null }, uInvViewProj: { value: new THREE.Matrix4() },
        uOrigin: { value: new THREE.Vector3() },
        uWinMin: { value: new THREE.Vector2() }, uWinSpan: { value: new THREE.Vector2() },
        uNear: { value: 0.25 }, uFar: { value: 45 }, uRange: { value: 20 },
        uTexelAngle: { value: 0.008 }, uTexPerMetre: { value: LIVE_RES / LIVE_SPAN },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
    this.accumMat = new THREE.ShaderMaterial({
      vertexShader: ACCUM_VERT, fragmentShader: ACCUM_FRAG, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { uLive: { value: this.live.texture }, uDstRect: { value: new THREE.Vector4(0, 0, 1, 1) } },
    });
    this.passScene = new THREE.Scene();
    this.passMesh = new THREE.Points(this.splatGeo, this.mat);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
    this.passCam = new THREE.Camera();
    this.accumCam = new THREE.Camera();
    this.accumMesh = new THREE.Mesh(this.quad, this.accumMat);
    this.accumMesh.frustumCulled = false;
    this.accumScene = new THREE.Scene();
    this.accumScene.add(this.accumMesh);

    this._vp = new THREE.Matrix4();
  }

  get liveTexture() { return this.live.texture; }
  get exploredTexture() { return this.explored.texture; }

  // World window currently covered by the live layer, in game XY.
  liveWindow() {
    const half = LIVE_SPAN / 2;
    return { minX: this.centre.x - half, minY: this.centre.y - half, span: LIVE_SPAN };
  }

  // Redraw the live layer from the current camera poses, and fold it into explored.
  // `cams` is a list of { spec, vision } as produced by CameraRig.
  update(cams, roverState) {
    if (!this.enabled) return;
    const r = this.renderer;
    if (roverState && Math.hypot(roverState.x - this.centre.x, roverState.y - this.centre.y) > RECENTRE) {
      this.centre.set(roverState.x, roverState.y);
    }
    const win = this.liveWindow();
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    r.setRenderTarget(this.live);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);

    const u = this.mat.uniforms;
    u.uWinMin.value.set(win.minX, win.minY);
    u.uWinSpan.value.set(win.span, win.span);
    u.uTexPerMetre.value = LIVE_RES / win.span;
    for (const c of cams) {
      const cam = c.vision?.cam;
      if (!cam || !c.vision.rtDepth) continue;
      const tint = GROUP_RGB[c.spec.group] ?? [1, 1, 1];
      this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
      u.uInvViewProj.value.copy(this._vp);
      u.uOrigin.value.copy(cam.position);
      u.uDepth.value = c.vision.rtDepth.texture;
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      // Navcams plan out to ~20 m; the Hazcams only clear the near field
      u.uRange.value = c.spec.group === "navcam" ? 20 : c.spec.group === "science" ? 18 : 6.5;
      u.uTexelAngle.value = (cam.fov * Math.PI / 180) / this.depthH;
      u.uTint.value.set(tint[0], tint[1], tint[2]);
      r.render(this.passScene, this.passCam);
      this.lastSeen.set(c.spec.group, performance.now());
    }

    // fold into the global explored layer: draw the live window into its own sub-rect.
    // render() overwrites the renderer viewport, so the sub-rect goes on the camera.
    r.setRenderTarget(this.explored);
    const size = this.terrain.size;
    const fx = (win.minX + size / 2) / size;
    const fy = (win.minY + size / 2) / size;
    const fw = win.span / size;
    this.accumMat.uniforms.uDstRect.value.set(fx, fy, fw, fw);
    r.render(this.accumScene, this.accumCam);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.setClearColor(0x000000, 0);
  }

  // Fraction of the live window that has ever been seen — a cheap "how much do we know"
  // number for the HUD. Sampled sparsely on the CPU, so call it at most once a second.
  exploredFraction() {
    if (!this._probe) this._probe = new Uint8Array(64 * 64 * 4);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    try {
      r.setRenderTarget(this.explored);
      const size = this.terrain.size;
      const win = this.liveWindow();
      const px = Math.round(((win.minX + size / 2) / size) * GLOBAL_RES);
      const py = Math.round(((win.minY + size / 2) / size) * GLOBAL_RES);
      const pw = Math.round((win.span / size) * GLOBAL_RES);
      r.readRenderTargetPixels(this.explored, px, py, 64, 64, this._probe, 0, { x: pw, y: pw });
    } catch { return null; } finally { r.setRenderTarget(prev); }
    let n = 0;
    for (let i = 3; i < this._probe.length; i += 4) if (this._probe[i] > 24) n++;
    return n / (64 * 64);
  }

  // Blend the two layers into the terrain's own material.
  attach(terrainMesh) {
    const self = this;
    const mat = terrainMesh.material;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCovLive = { value: self.live.texture };
      shader.uniforms.uCovExplored = { value: self.explored.texture };
      shader.uniforms.uCovWin = { value: new THREE.Vector4(0, 0, LIVE_SPAN, LIVE_SPAN) };
      shader.uniforms.uCovSize = { value: self.terrain.size };
      shader.uniforms.uCovMix = { value: 1.0 };
      self._shader = shader;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vCovWorld;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n\tvCovWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
varying vec3 vCovWorld;
uniform sampler2D uCovLive;
uniform sampler2D uCovExplored;
uniform vec4 uCovWin;
uniform float uCovSize;
uniform float uCovMix;`)
        .replace("#include <dithering_fragment>", `#include <dithering_fragment>
{
  vec2 gxy = vec2(vCovWorld.x, -vCovWorld.z);
  vec2 gUv = vec2(gxy.x / uCovSize + 0.5, gxy.y / uCovSize + 0.5);
  float seen = texture2D(uCovExplored, gUv).a;
  vec2 lUv = (gxy - uCovWin.xy) / uCovWin.zw;
  vec4 live = vec4(0.0);
  if (lUv.x > 0.0 && lUv.x < 1.0 && lUv.y > 0.0 && lUv.y < 1.0) live = texture2D(uCovLive, lUv);
  // terrain the rover has mapped reads brighter and slightly desaturated: "we have been here"
  vec3 mapped = mix(gl_FragColor.rgb, mix(gl_FragColor.rgb, vec3(0.80, 0.83, 0.88), 0.26), seen * uCovMix);
  // what a camera can see right now reads as its group's tint
  // Mix toward the group's colour rather than adding to the terrain: an additive tint in
  // the terrain's own hue is invisible, which made a whole cone look like unseen ground.
  vec3 tint = live.a > 0.001 ? live.rgb / live.a : vec3(0.0);
  vec3 lit = mix(mapped, tint, clamp(live.a, 0.0, 1.0) * 0.32 * uCovMix);
  gl_FragColor.rgb = lit;
}`);
    };
    mat.needsUpdate = true;
    this._mat = mat;
    // keep the shader's window uniform in step with the scrolling live layer
    this._syncWindow = () => {
      if (!this._shader) return;
      const w = this.liveWindow();
      this._shader.uniforms.uCovWin.value.set(w.minX, w.minY, w.span, w.span);
    };
  }

  sync() { this._syncWindow?.(); }

  setMix(v) { if (this._shader) this._shader.uniforms.uCovMix.value = v; }

  reset() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    for (const target of [this.live, this.explored]) {
      r.setRenderTarget(target); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    }
    r.setRenderTarget(prev);
  }
}
