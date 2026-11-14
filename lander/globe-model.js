// The real Wikipedia puzzle globe (official 3D render, CC BY-SA 3.0, slimmed from 122 MB to ~150 KB).
// 51 pieces, each its own mesh so it can lift off the ball. The letters are an image wrapped
// around the ball with the seams (model/surface.png) instead of millions of carved triangles.
import * as THREE from "./vendor/three.module.min.js";
import { MeshoptDecoder } from "./vendor/meshopt_decoder.module.js";

const RADIUS = 0.57; // outer radius of the model, in its own units
const GAP = 0.004; // half the groove between two pieces, in model units

const VERT = /* glsl */ `
  uniform vec3 uDir;
  varying vec3 vP; varying vec3 vR; varying vec3 vView;
  void main(){
    vP = position;
    vR = normalMatrix * position;
    // pull every point of the piece the same small distance toward its middle, so an even groove opens
    // between neighbours: the seams are these real gaps, drawn exactly where the pieces meet
    vec3 c = uDir * ${(RADIUS - 0.012).toFixed(3)};
    vec3 off = position - c;
    vec3 p = position - normalize(off) * min(${GAP.toFixed(4)}, length(off) * 0.5);
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D uLetters; uniform float uHover; uniform float uLift;
  varying vec3 vP; varying vec3 vR; varying vec3 vView;
  const float PI = 3.14159265;
  void main(){
    vec3 Nf = normalize(cross(dFdx(vView), dFdy(vView)));   // the face's own direction
    vec3 Nr = normalize(vR);                                  // straight out from the centre
    float r = length(vP);
    float k = dot(Nf, Nr);
    vec3 V = normalize(-vView);
    vec3 L = normalize(vec3(-0.5, 0.62, 0.6));

    vec3 col;
    if (k > 0.6 && r > ${(RADIUS - 0.0035).toFixed(4)}) {
      // outer surface: paper white falling off to soft grey, letters printed on
      vec3 N = Nr;
      float wrap = clamp(dot(N, L) * 0.5 + 0.5, 0., 1.);
      float facing = max(dot(N, V), 0.);
      col = mix(vec3(0.56, 0.565, 0.575), vec3(0.995), pow(wrap, 1.25));
      col *= mix(0.84, 1., smoothstep(0., 0.6, facing));
      col += pow(max(dot(reflect(-L, N), V), 0.), 10.) * 0.04;
      vec2 uv = vec2(atan(vP.y, vP.x) / (2. * PI) + 0.5, acos(clamp(vP.z / r, -1., 1.)) / PI);
      // one grey channel: 0–0.39 is a seam between pieces, 0.39–1 is a letter. Only the letters are printed:
      // the seams come from the pieces' own cut edges, where they really are, not from the flat image
      float t = texture2D(uLetters, uv).r;
      float ink = clamp((t - 0.39) / 0.61, 0., 1.);
      col = mix(col, vec3(0.12, 0.12, 0.13), ink * mix(0.55, 0.95, smoothstep(0.05, 0.5, facing)));
    } else if (r < ${(RADIUS - 0.022).toFixed(3)}) {
      // inside of the shell, seen through the open top
      float wrap = clamp(dot(-Nr, L) * 0.5 + 0.5, 0., 1.);
      col = mix(vec3(0.34), vec3(0.6), wrap);
    } else {
      // the cut edges of each piece, darker toward the inside like a groove
      float wrap = clamp(dot(Nf, L) * 0.5 + 0.5, 0., 1.);
      float depth = smoothstep(${(RADIUS - 0.025).toFixed(3)}, ${RADIUS.toFixed(3)}, r);
      col = mix(vec3(0.2), vec3(0.58), wrap) * mix(0.7, 1., depth);
    }
    col += uHover * 0.03;
    gl_FragColor = vec4(col, 1.);
  }`;

async function loadPieces() {
  await MeshoptDecoder.ready;
  const base = new URL("./model/", import.meta.url);
  const [manifest, bin] = await Promise.all([
    fetch(new URL("globe.json", base)).then((r) => r.json()),
    fetch(new URL("globe.bin", base)).then((r) => r.arrayBuffer()),
  ]);
  const bytes = new Uint8Array(bin);
  return manifest.pieces.map((p) => {
    const q = new Int16Array(p.vertices * 4);
    MeshoptDecoder.decodeVertexBuffer(new Uint8Array(q.buffer), p.vertices, 8, bytes.subarray(p.vb[0], p.vb[0] + p.vb[1]));
    const idx = new Uint16Array(p.indices);
    MeshoptDecoder.decodeIndexBuffer(new Uint8Array(idx.buffer), p.indices, 2, bytes.subarray(p.ib[0], p.ib[0] + p.ib[1]));
    const pos = new Float32Array(p.vertices * 3);
    for (let i = 0; i < p.vertices; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] = q[i * 4 + a] * manifest.scale;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return { geo, dir: new THREE.Vector3(...p.dir) };
  });
}

export function createGlobe(canvas) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0, 4.6);

  const tilt = new THREE.Group();
  tilt.rotation.set(0.38, 0, -0.12);
  const spin = new THREE.Group();
  spin.rotation.y = 0.2;
  tilt.add(spin);
  scene.add(tilt);
  // the model is Z-up; turn it so the open top faces up, and scale it to radius 1
  const model = new THREE.Group();
  model.rotation.x = -Math.PI / 2;
  model.scale.setScalar(1 / RADIUS);
  spin.add(model);

  const letters = new THREE.TextureLoader().load(new URL("./model/surface.png", import.meta.url).href);
  letters.flipY = false;
  letters.generateMipmaps = false;
  letters.minFilter = THREE.LinearFilter;
  letters.anisotropy = 8;

  const pieces = [];
  loadPieces().then((list) => {
    for (const { geo, dir } of list) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: { uLetters: { value: letters }, uHover: { value: 0 }, uLift: { value: 0 }, uDir: { value: dir } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { center: dir, lift: 0, vel: 0, hover: 0 };
      pieces.push(mesh);
      model.add(mesh);
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
    const h = ray.intersectObjects(pieces, false)[0];
    return h ? { globe: true, piece: h.object } : { globe: false, piece: null };
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

    const q = model.getWorldQuaternion(new THREE.Quaternion());
    if (hovered) hovWorld.copy(hovered.userData.center).applyQuaternion(q);
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
      p.position.copy(u.center).multiplyScalar(u.lift * RADIUS);
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
