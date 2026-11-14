// The 3D puzzle globe. A sphere cut into 54 jigsaw pieces (a cube mapped onto a
// sphere, 3×3 pieces per side). Each piece is its own mesh so it can lift off the ball.
import * as THREE from "./vendor/three.module.min.js";

const N = 3;             // pieces per cube side
const SEG = 30;          // mesh resolution per piece
const MARGIN = 0.3;      // extra room around each cell for the tabs
const TAB_OFF = 0.12;    // how far a tab's centre sits past the edge
const TAB_R = 0.145;     // tab radius
const GAP = 0.010;       // hairline gap between pieces
const MISSING = new Set(["2:0:2", "2:1:2"]); // two pieces gone from the top, like the logo

const GLYPHS = ["W", "Ω", "И", "維", "ウィ", "و", "위", "वि", "ვ", "ש", "Ꮤ", "ವಿ", "ط", "Ж", "ব", "λ", "ไ", "ዊ", "維", "ኪ", "Ψ", "ⴰ", "ಕಿ", "ཝི", "Ⴅ", "ㅋ", "Я"];

const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

// Edge k of a cell: midpoint and outward direction in the cell's own 0..1 square.
const EDGES = [
  { m: [1, 0.5], o: [1, 0] },
  { m: [0.5, 1], o: [0, 1] },
  { m: [0, 0.5], o: [-1, 0] },
  { m: [0.5, 0], o: [0, -1] },
];

function dirOf(face, a, b, out = new THREE.Vector3()) {
  const ta = Math.tan((a * Math.PI) / 4), tb = Math.tan((b * Math.PI) / 4);
  return out.set(
    face.n[0] + face.u[0] * ta + face.v[0] * tb,
    face.n[1] + face.u[1] * ta + face.v[1] * tb,
    face.n[2] + face.u[2] * ta + face.v[2] * tb,
  ).normalize();
}

// ── Piece outline as a distance field (same maths in JS for hover and in GLSL for drawing)
const smin = (a, b, k) => { const h = Math.min(Math.max(0.5 + (0.5 * (b - a)) / k, 0), 1); return b + (a - b) * h - k * h * (1 - h); };
// Tabs are circles measured on the ball itself, so two neighbours always share the exact same circle.
function shapeJS(s, t, dir, u) {
  const px = Math.abs(s - 0.5) - 0.5, py = Math.abs(t - 0.5) - 0.5;
  let d = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0);
  u.tabs.forEach((sg, k) => {
    const c = (Math.acos(Math.min(1, dir.dot(u.tabC[k]))) - TAB_R * u.edgeLen[k]) / u.edgeLen[k];
    d = sg > 0 ? smin(d, c, 0.03) : -smin(-d, c, 0.03);
  });
  return d;
}

const SHAPE_GLSL = /* glsl */ `
  uniform vec4 uTabs; uniform vec4 uLen; uniform vec3 uC0, uC1, uC2, uC3;
  float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5*(b-a)/k, 0., 1.); return mix(b, a, h) - k*h*(1.-h); }
  float tabSd(float d, vec3 dir, vec3 c, float len, float sg){
    float cd = (acos(min(1., dot(dir, c))) - ${TAB_R.toFixed(3)} * len) / len;
    return sg > 0. ? smin(d, cd, 0.03) : -smin(-d, cd, 0.03);
  }
  float shape(vec2 p, vec3 dir){
    vec2 q = abs(p - 0.5) - 0.5;
    float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
    d = tabSd(d, dir, uC0, uLen.x, uTabs.x);
    d = tabSd(d, dir, uC1, uLen.y, uTabs.y);
    d = tabSd(d, dir, uC2, uLen.z, uTabs.z);
    d = tabSd(d, dir, uC3, uLen.w, uTabs.w);
    return d;
  }`;

const VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vDir;
  void main(){
    vUv = uv; vDir = normal;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  ${SHAPE_GLSL}
  uniform sampler2D uGlyph; uniform float uHover; uniform float uLift;
  varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vDir;
  void main(){
    float d = shape(vUv, normalize(vDir)) + ${GAP.toFixed(3)};
    float aa = fwidth(d) * 1.2;
    float alpha = 1. - smoothstep(-aa, 0., d);
    if (alpha < 0.01) discard;

    vec3 N = normalize(vN);
    vec3 V = normalize(-vView);
    vec3 L = normalize(vec3(-0.55, 0.75, 0.65));
    float diff = max(dot(N, L), 0.);
    float rim = pow(1. - max(dot(N, V), 0.), 2.2);
    float spec = pow(max(dot(reflect(-L, N), V), 0.), 28.) * 0.18;

    vec3 col = vec3(0.972, 0.972, 0.965) * (0.6 + 0.42 * diff) + spec;
    col -= rim * 0.16;

    // engraved seam just inside the piece edge
    float seam = 1. - smoothstep(0., 0.02, -d);
    col = mix(col, col * 0.74, seam);

    // the letter
    if (vUv.x > 0. && vUv.x < 1. && vUv.y > 0. && vUv.y < 1.) {
      float g = texture2D(uGlyph, vUv).a;
      col = mix(col, vec3(0.07), g * (0.92 - rim * 0.3));
    }

    col += uHover * 0.035 + uLift * 0.12;
    if (!gl_FrontFacing) col = vec3(0.36);
    gl_FragColor = vec4(col, alpha);
  }`;

function glyphTexture(glyph, rot) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (glyph) {
    g.translate(128, 132);
    g.rotate(rot);
    const size = glyph.length > 1 ? 92 : 124;
    g.font = `500 ${size}px "Linux Libertine", "Times New Roman", "Hiragino Mincho ProN", "Noto Serif", serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#000";
    g.fillText(glyph, 0, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// Tiny deterministic hash so both neighbours agree on which side of an edge gets the tab.
function edgeVector(p) {
  const k = [p.x, p.y, p.z].map((c) => Math.round(c * 1000) + 0).join(",");
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  const r = (n) => (((h = Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0) / 4294967295) * 2 - 1 + n;
  return new THREE.Vector3(r(0), r(0), r(0));
}

function buildPiece(face, fi, i, j, index) {
  const da = 2 / N, a0 = -1 + i * da, b0 = -1 + j * da;
  const toAB = (s, t) => [a0 + s * da, b0 + t * da];

  const tabC = [], edgeLen = [];
  const tabs = EDGES.map((e) => {
    const P = dirOf(face, ...toAB(...e.m));
    const Q = dirOf(face, ...toAB(e.m[0] + e.o[0] * 0.01, e.m[1] + e.o[1] * 0.01));
    // exact perpendicular to the shared edge, pointing out of this piece; the neighbour gets its negative
    const px = Math.abs(e.o[1]) * 0.5, py = Math.abs(e.o[0]) * 0.5;
    const C1 = dirOf(face, ...toAB(e.m[0] - px, e.m[1] - py)), C2 = dirOf(face, ...toAB(e.m[0] + px, e.m[1] + py));
    const out = new THREE.Vector3().crossVectors(P, C2.sub(C1)).normalize();
    if (out.dot(Q.sub(P)) < 0) out.negate();
    const sg = out.dot(edgeVector(P)) > 0 ? 1 : -1;
    // both neighbours measure the same edge, so they get the same length and the same circle
    const len = dirOf(face, ...toAB(e.m[0] - px, e.m[1] - py)).angleTo(dirOf(face, ...toAB(e.m[0] + px, e.m[1] + py)));
    const th = TAB_OFF * len;
    tabC.push(P.clone().multiplyScalar(Math.cos(th)).addScaledVector(out, Math.sin(th) * sg).normalize());
    edgeLen.push(len);
    return sg;
  });

  const pos = [], uv = [], idx = [];
  const v = new THREE.Vector3();
  for (let y = 0; y <= SEG; y++) {
    for (let x = 0; x <= SEG; x++) {
      const s = -MARGIN + ((1 + 2 * MARGIN) * x) / SEG;
      const t = -MARGIN + ((1 + 2 * MARGIN) * y) / SEG;
      dirOf(face, ...toAB(s, t), v);
      pos.push(v.x, v.y, v.z);
      uv.push(s, t);
    }
  }
  for (let y = 0; y < SEG; y++) {
    for (let x = 0; x < SEG; x++) {
      const a = y * (SEG + 1) + x, b = a + 1, c = a + SEG + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);

  const glyph = index % 5 === 3 ? null : GLYPHS[index % GLYPHS.length];
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    uniforms: {
      uTabs: { value: new THREE.Vector4(...tabs) },
      uLen: { value: new THREE.Vector4(...edgeLen) },
      uC0: { value: tabC[0] }, uC1: { value: tabC[1] }, uC2: { value: tabC[2] }, uC3: { value: tabC[3] },
      uGlyph: { value: glyphTexture(glyph, (((index * 37) % 11) - 5) * 0.05) },
      uHover: { value: 0 },
      uLift: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { tabs, tabC, edgeLen, center: dirOf(face, ...toAB(0.5, 0.5)), lift: 0, vel: 0, hover: 0 };
  return mesh;
}

export function createGlobe(canvas) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0, 4.6);

  const tilt = new THREE.Group();
  tilt.rotation.set(0.42, 0, -0.22);
  const spin = new THREE.Group();
  spin.rotation.y = -0.9;
  tilt.add(spin);
  scene.add(tilt);

  // dark core that shows through gaps and missing pieces
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.972, 48, 32),
    new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vView;
        void main(){ float l = max(dot(normalize(vN), normalize(vec3(-.4,.8,.5))), 0.);
        gl_FragColor = vec4(vec3(0.26 + 0.16*l), 1.); }`,
    }),
  );
  spin.add(core);

  const pieces = [];
  let index = 0;
  FACES.forEach((face, fi) => {
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (MISSING.has(`${fi}:${i}:${j}`)) { index++; continue; }
      const p = buildPiece(face, fi, i, j, index++);
      pieces.push(p);
      spin.add(p);
    }
  });

  // ── interaction state
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerIn = false, hovered = null, overGlobe = false;
  let dragging = false, lastX = 0, lastY = 0;
  let spinVel = 0, tiltVel = 0;
  const AUTO = reduced ? 0 : 0.0016;
  let burstT = -1;

  function pick() {
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects([core, ...pieces], false);
    for (const h of hits) {
      if (h.object === core) return { globe: true, piece: null };
      const dir = h.object.worldToLocal(h.point.clone()).normalize();
      if (shapeJS(h.uv.x, h.uv.y, dir, h.object.userData) + GAP < 0) return { globe: true, piece: h.object };
    }
    return { globe: false, piece: null };
  }

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointerIn = true;
    if (dragging) {
      spinVel = (e.clientX - lastX) * 0.006;
      tiltVel = (e.clientY - lastY) * 0.003;
      spin.rotation.y += spinVel;
      tilt.rotation.x = THREE.MathUtils.clamp(tilt.rotation.x + tiltVel, -0.2, 1.0);
      lastX = e.clientX; lastY = e.clientY;
    }
  });
  canvas.addEventListener("pointerleave", () => { pointerIn = false; });
  canvas.addEventListener("pointerdown", (e) => {
    if (!overGlobe) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  const end = () => { dragging = false; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const world = new THREE.Vector3(), hovWorld = new THREE.Vector3(), front = new THREE.Vector3(0, 0, 1);
  let last = performance.now();

  function frame(now) {
    const dt = Math.min((now - last) / 16.67, 3);
    last = now;

    if (pointerIn && !dragging) {
      const p = pick();
      overGlobe = p.globe;
      hovered = p.piece;
    } else if (!pointerIn) { overGlobe = false; hovered = null; }
    canvas.style.cursor = dragging ? "grabbing" : overGlobe ? "grab" : "default";

    if (!dragging) {
      spinVel += (AUTO - spinVel) * 0.03 * dt;
      spin.rotation.y += spinVel * dt;
      tilt.rotation.x += (0.42 - tilt.rotation.x) * 0.02 * dt;
    }

    if (hovered) hovWorld.copy(hovered.userData.center).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion()));
    const q = spin.getWorldQuaternion(new THREE.Quaternion());
    const burstAge = burstT < 0 ? -1 : (now - burstT) / 1000;

    for (const p of pieces) {
      const u = p.userData;
      let target = overGlobe ? 0.022 : 0;
      if (hovered) {
        world.copy(u.center).applyQuaternion(q);
        const w = Math.max(0, 1 - world.angleTo(hovWorld) / 0.8);
        target += p === hovered ? 0.17 : 0.05 * w * w;
      }
      if (burstAge >= 0) {
        world.copy(u.center).applyQuaternion(q);
        const delay = world.angleTo(front) * 0.12;
        const k = burstAge - delay;
        if (k > 0 && k < 0.9) target += Math.sin((k / 0.9) * Math.PI) * 0.12;
      }
      u.vel += (target - u.lift) * 0.16 * dt;
      u.vel *= Math.pow(0.7, dt);
      u.lift += u.vel * dt;
      u.hover += ((p === hovered ? 1 : 0) - u.hover) * 0.2 * dt;
      p.position.copy(u.center).multiplyScalar(u.lift);
      p.material.uniforms.uLift.value = Math.max(u.lift, 0);
      p.material.uniforms.uHover.value = u.hover;
    }
    if (burstAge > 2) burstT = -1;

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    // every piece pops out and back in a wave from the front — used when a question is sent
    burst() { if (!reduced) burstT = performance.now(); spinVel = reduced ? 0 : 0.03; },
  };
}
