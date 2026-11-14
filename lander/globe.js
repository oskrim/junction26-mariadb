// The 3D puzzle globe. A sphere cut into 96 jigsaw pieces (a cube mapped onto a
// sphere, 4×4 pieces per side). Each piece is its own mesh so it can lift off the ball.
import * as THREE from "./vendor/three.module.min.js";

const N = 4;             // pieces per cube side
const SEG = 26;          // mesh resolution per piece
const MARGIN = 0.26;     // extra room around each cell for the tabs
const TAB_OFF = 0.078;   // how far a tab's centre sits past the edge (share of the edge length)
const TAB_R = 0.108;     // tab radius (share of the edge length), jittered per edge
const NECK = 0.045;      // how soft the neck of each tab is
const GAP = 0.0045;      // hairline gap between pieces
const MISSING = new Set(["2:1:3", "2:2:3"]); // two pieces gone from the top, like the logo

// The letters on the real logo: "Wiki" in many scripts, each in a matching serif face.
const SERIF = '"Times New Roman", "Noto Serif", serif';
const GLYPHS = [
  ["W", SERIF], ["Ω", SERIF], ["И", SERIF], ["維", '"Hiragino Mincho ProN", serif'],
  ["ウィ", '"Hiragino Mincho ProN", serif'], ["و", '"Geeza Pro", serif'], ["위", '"AppleMyungjo", serif'],
  ["वि", '"ITF Devanagari", "Kohinoor Devanagari", serif'], ["ვ", SERIF], ["ו", SERIF],
  ["ವಿ", '"Kannada Sangam MN", serif'], ["Ж", SERIF], ["ཝི", '"Kailasa", serif'], ["ψ", SERIF],
  ["ვი", SERIF], ["ウ", '"Hiragino Mincho ProN", serif'], ["ক", '"Bangla MN", serif'], ["Λ", SERIF],
];

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
    const c = (Math.acos(Math.min(1, dir.dot(u.tabC[k]))) - u.tabR[k]) / u.edgeLen[k];
    d = sg > 0 ? smin(d, c, NECK) : -smin(-d, c, NECK);
  });
  return d;
}

const SHAPE_GLSL = /* glsl */ `
  uniform vec4 uTabs; uniform vec4 uLen; uniform vec4 uRad; uniform vec3 uC0, uC1, uC2, uC3;
  float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5*(b-a)/k, 0., 1.); return mix(b, a, h) - k*h*(1.-h); }
  float tabSd(float d, vec3 dir, vec3 c, float len, float rad, float sg){
    float cd = (acos(min(1., dot(dir, c))) - rad) / len;
    return sg > 0. ? smin(d, cd, ${NECK.toFixed(3)}) : -smin(-d, cd, ${NECK.toFixed(3)});
  }
  float shape(vec2 p, vec3 dir){
    vec2 q = abs(p - 0.5) - 0.5;
    float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
    d = tabSd(d, dir, uC0, uLen.x, uRad.x, uTabs.x);
    d = tabSd(d, dir, uC1, uLen.y, uRad.y, uTabs.y);
    d = tabSd(d, dir, uC2, uLen.z, uRad.z, uTabs.z);
    d = tabSd(d, dir, uC3, uLen.w, uRad.w, uTabs.w);
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
    float d = shape(vUv, normalize(vDir)) + ${GAP.toFixed(4)};
    // screen-space slope of the outline, used for the bevel; taken before any discard
    vec2 g = vec2(dFdx(d), dFdy(d));
    float aa = min(length(g) * 1.3, 0.03);
    float alpha = 1. - smoothstep(-aa, 0., d);
    if (alpha < 0.01) discard;
    vec2 gn = g / max(length(g), 1e-6);
    float inside = -d;

    vec3 N = normalize(vN);
    vec3 V = normalize(-vView);
    vec3 L = normalize(vec3(-0.5, 0.62, 0.6));
    float wrap = clamp(dot(N, L) * 0.5 + 0.5, 0., 1.);
    float facing = max(dot(N, V), 0.);

    // paper-white ball that falls off to soft grey away from the light, like the logo
    vec3 col = mix(vec3(0.47, 0.475, 0.485), vec3(0.99, 0.99, 0.985), pow(wrap, 1.35));
    col *= mix(0.8, 1., smoothstep(0., 0.6, facing));
    col += pow(max(dot(reflect(-L, N), V), 0.), 9.) * 0.05;

    // each piece is slightly pillowed: edges facing the light catch it, the others fall into shadow
    float band = pow(1. - smoothstep(0., 0.075, inside), 1.6);
    float lit = dot(gn, normalize(vec2(-0.6, 0.7)));
    col *= 1. + band * lit * 0.32;
    // soft groove where pieces meet
    col *= mix(0.6, 1., smoothstep(0., 0.02, inside));

    // the letter, printed on the piece
    if (vUv.x > 0. && vUv.x < 1. && vUv.y > 0. && vUv.y < 1.) {
      float ink = texture2D(uGlyph, vUv).a;
      col = mix(col, vec3(0.11, 0.11, 0.12), ink * mix(0.55, 0.95, smoothstep(0.05, 0.5, facing)));
    }

    col += uHover * 0.03;
    if (!gl_FrontFacing) col = vec3(0.3);
    gl_FragColor = vec4(col, alpha);
  }`;

function glyphTexture(glyph, rot) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (glyph) {
    const [text, font] = glyph;
    g.translate(128, 130);
    g.rotate(rot);
    g.font = `400 ${text.length > 1 ? 84 : 112}px ${font}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#000";
    g.fillText(text, 0, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}

// Tiny deterministic random numbers seeded by an edge's midpoint, so both neighbours
// agree on everything about the edge they share: which side gets the tab, where, how big.
function edgeRandom(p) {
  const k = [p.x, p.y, p.z].map((c) => Math.round(c * 1000) + 0).join(",");
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0) / 4294967295;
}

function buildPiece(face, fi, i, j, index) {
  const da = 2 / N, a0 = -1 + i * da, b0 = -1 + j * da;
  const toAB = (s, t) => [a0 + s * da, b0 + t * da];

  const tabC = [], edgeLen = [], tabR = [];
  const tabs = EDGES.map((e) => {
    const P = dirOf(face, ...toAB(...e.m));
    const Q = dirOf(face, ...toAB(e.m[0] + e.o[0] * 0.01, e.m[1] + e.o[1] * 0.01));
    // exact perpendicular to the shared edge, pointing out of this piece; the neighbour gets its negative
    const px = Math.abs(e.o[1]) * 0.5, py = Math.abs(e.o[0]) * 0.5;
    const C1 = dirOf(face, ...toAB(e.m[0] - px, e.m[1] - py)), C2 = dirOf(face, ...toAB(e.m[0] + px, e.m[1] + py));
    const len = C1.angleTo(C2);
    const along = C2.clone().sub(C1);
    const out = new THREE.Vector3().crossVectors(P, along).normalize();
    if (out.dot(Q.sub(P)) < 0) out.negate();
    const rnd = edgeRandom(P);
    const sg = out.dot(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)) > 0 ? 1 : -1;
    // hand-cut feel: each tab slides a little along its edge and varies in size
    if (along.x + along.y * 1.7 + along.z * 2.3 < 0) along.negate(); // same direction for both neighbours
    const mid = P.clone().addScaledVector(along, (rnd() - 0.5) * 0.18).normalize();
    const th = (TAB_OFF + (rnd() - 0.5) * 0.02) * len;
    tabC.push(mid.multiplyScalar(Math.cos(th)).addScaledVector(out, Math.sin(th) * sg).normalize());
    tabR.push(TAB_R * (0.9 + rnd() * 0.2) * len);
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

  const glyph = index % 7 === 3 ? null : GLYPHS[(index * 5) % GLYPHS.length];
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    uniforms: {
      uTabs: { value: new THREE.Vector4(...tabs) },
      uLen: { value: new THREE.Vector4(...edgeLen) },
      uRad: { value: new THREE.Vector4(...tabR) },
      uC0: { value: tabC[0] }, uC1: { value: tabC[1] }, uC2: { value: tabC[2] }, uC3: { value: tabC[3] },
      uGlyph: { value: glyphTexture(glyph, (((index * 37) % 7) - 3) * 0.04) },
      uHover: { value: 0 },
      uLift: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { tabs, tabC, tabR, edgeLen, center: dirOf(face, ...toAB(0.5, 0.5)), lift: 0, vel: 0, hover: 0 };
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
