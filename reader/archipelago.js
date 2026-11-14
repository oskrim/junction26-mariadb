import { getGraph, getPreview, now as currentTime } from "./api.js";

// Archipelago: an article's neighborhood drawn as a landscape seen from above. Each topic is an island
// on a calm sea, as big as it has articles; each article is a hill on its island, as high as it is
// central (its links to the other articles shown). The article itself is the highest peak, on the
// island in the middle. Bridges arc between islands whose articles link to each other, thicker for more
// links, so tightly knit topics and lone ones show at a glance. A topic with a single article would be
// a lonely one-hill island, so such articles are islets moored by the island they link to most, and the
// articles a step further are low skerries out beyond them. The land is one height field cut into
// terraces with solid sides, like a laser-cut topographic model: that is what makes height readable
// when turned. Dragging turns the view, scrolling zooms, clicking an island lands on it, and clicking
// a hill sails there: what both neighborhoods share glides into its new place, what is gone sinks
// and what is new rises out of the sea.

const MAX_NEAR = 60;
const MAX_FURTHER = 70;
const MAX_PICTURES = 6;
const MAX_SKERRIES = 28;
const MAX_SKERRIES_EACH = 4;
const PEAK = 520; // the article's own height; every other hill is at least four terraces lower
const STEP = 40; // contour interval, and the height of each terrace
const COAST = 6; // where the land starts
const SHORE = 12; // the height of the bottom terrace, so every shore has a wall
const FOOT = 20; // the low land joining the hills of an island
const WATER = [3, 1.3]; // water lines offshore, as on a chart
const SPACING = 104; // between hills on an island
const FOCAL = 0.9; // of the stage height
const REF_H = 900; // stage height the label sizes are designed for
const LABEL_AT = 2600; // distance at which a label shows at its natural size
const VIEW = { yaw: -0.5, pitch: 0.76 }; // about 44° down
const TILT = [0.44, 1.22]; // 25° to 70° from horizontal: never flat, never straight down
const WALL = ["#eeede8", "#e2e0da", "#d5d2cb", "#c8c5bd"]; // terrace sides, lit to shaded
const SHORE_WALL = ["#d6d4cd", "#c9c6bf", "#bcb9b1", "#afaba3"];

export async function mountArchipelago(root, { id }) {
  root.innerHTML = `
    <div class="ar-stage">
      <canvas class="ar-canvas"></canvas>
      <div class="ar-layer"></div>
    </div>
    <header class="ar-key">
      <h2 class="ar-title"></h2>
      <p class="ar-sub"></p>
      <button type="button" class="ar-read">Read article →</button>
      <ul class="ar-legend">
        <li><i class="ar-glyph-hill" aria-hidden="true"></i>Higher hill: more links among these articles</li>
        <li><i class="ar-glyph-bridge" aria-hidden="true"></i>Bridge: links between two topics</li>
        <li><i class="ar-glyph-islet" aria-hidden="true"></i>Islet: the only article of its topic</li>
      </ul>
    </header>
    <button type="button" class="ar-overview" hidden>← Whole archipelago</button>
    <nav class="ar-trail" aria-label="Articles visited"></nav>
    <div class="ar-tip" role="tooltip"></div>
    <p class="ar-hint">Drag to turn · scroll to zoom · click an island to land on it · click a hill to sail to it</p>`;

  const $ = (s) => root.querySelector(s);
  const stage = $(".ar-stage");
  const canvas = $(".ar-canvas");
  const ctx = canvas.getContext("2d");
  const layer = $(".ar-layer");
  const trailEl = $(".ar-trail");
  const tip = $(".ar-tip");
  const overviewButton = $(".ar-overview");
  const keyEl = $(".ar-key");

  let width = 0;
  let height = 0;
  let scene = null;
  const trail = [];
  // The camera orbits `pivot` at `dist`; `to` holds where each is heading.
  const cam = { pivot: [0, 0, 0], yaw: VIEW.yaw, pitch: VIEW.pitch, dist: 6000 };
  const to = { pivot: [0, 0, 0], yaw: VIEW.yaw, pitch: VIEW.pitch, dist: 6000 };
  let landed = null; // the island the camera came down to, if any
  let idleSince = performance.now();
  let swayFrom = VIEW.yaw;
  let drag = null;
  let hovered = null; // { hill } or { body }
  let busy = false;

  new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    width = stage.clientWidth;
    height = stage.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (scene && !landed && !busy) Object.assign(to, fit(scene));
  }).observe(stage);

  await go(id, { from: "start" });

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      to.dist = Math.max(500, Math.min(16000, to.dist * Math.exp(event.deltaY * 0.0012)));
      idleSince = performance.now();
    },
    { passive: false },
  );
  stage.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, yaw: to.yaw, pitch: to.pitch, moved: false };
  });
  addEventListener("pointerup", () => setTimeout(() => (drag = null)));
  addEventListener("pointermove", (event) => {
    if (root.hidden || !drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    to.yaw = drag.yaw - dx * 0.005;
    to.pitch = Math.max(TILT[0], Math.min(TILT[1], drag.pitch + dy * 0.004));
    idleSince = performance.now();
    swayFrom = to.yaw;
  });
  stage.addEventListener("pointermove", (event) => {
    if (drag?.moved || busy) return setHover(null);
    const r = stage.getBoundingClientRect();
    hoverAt(event.clientX - r.left, event.clientY - r.top, event.target);
  });
  stage.addEventListener("pointerleave", () => setHover(null));
  stage.addEventListener("click", () => {
    if (drag?.moved || busy) return;
    if (hovered?.hill && hovered.hill !== scene.center) return go(hovered.hill.id, { from: hovered.hill });
    if (hovered?.body) return land(hovered.body);
    if (!hovered && landed) overview();
  });
  $(".ar-read").addEventListener("click", () => {
    const url = new URL(location.href);
    url.searchParams.set("id", String(scene.center.id));
    url.searchParams.delete("view");
    location.href = url;
  });
  overviewButton.addEventListener("click", overview);
  trailEl.addEventListener("click", (event) => {
    const step = event.target.closest("[data-step]");
    if (!step || busy) return;
    const [target] = trail.splice(Number(step.dataset.step));
    go(target.id, { from: "back" });
  });
  addEventListener("keydown", (event) => {
    if (root.hidden || busy || event.target.closest("input, textarea")) return;
    if (event.key !== "Escape" && event.key !== "Backspace") return;
    if (landed) return overview();
    if (trail.length > 1) {
      trail.pop();
      go(trail.pop().id, { from: "back" });
    }
  });

  // The camera comes down over an island, or goes back up to see them all.
  function land(body) {
    landed = body;
    tip.dataset.key = ""; // so the tip drops its "Click to land"
    Object.assign(to, { pivot: [body.x, 0, body.z], dist: Math.max(1700, body.R * 5.5) });
    overviewButton.hidden = false;
    idleSince = performance.now();
  }

  function overview() {
    landed = null;
    Object.assign(to, fit(scene));
    overviewButton.hidden = true;
    idleSince = performance.now();
  }

  // The view that fits the whole archipelago, hills included, between the switch at the top and the
  // trail at the bottom, at the current turn and tilt: back off until it fits, then centre it.
  function fit(s) {
    const box = { left: 40, right: width - 40, top: 110, bottom: height - 90 };
    const keyBox = { right: keyEl.offsetLeft + keyEl.offsetWidth + 16, bottom: keyEl.offsetTop + keyEl.offsetHeight + 70 };
    const marks = s.bodies.flatMap((b) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [b.x + Math.cos(k * 0.785) * b.R, 0, b.z + Math.sin(k * 0.785) * b.R]));
    for (const h of s.hills) marks.push([h.x, h.summit, h.z]);
    const view = { pivot: [...s.mid], yaw: to.yaw, pitch: to.pitch, dist: 2000 };
    const bounds = () => {
      const { project } = projector(view);
      const ps = marks.map(([x, y, z]) => project(x, y, z));
      if (ps.some((p) => p.z < 50)) return null;
      const xs = ps.map((p) => p.x);
      const ys = ps.map((p) => p.y);
      // The key in the top left is kept clear too.
      const key = ps.some((p) => p.x < keyBox.right && p.y < keyBox.bottom);
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), key };
    };
    for (let round = 0; round < 3; round++) {
      let near = 600;
      let far = 40000;
      for (let k = 0; k < 18; k++) {
        view.dist = (near + far) / 2;
        const b = bounds();
        const fits = b && !b.key && b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom;
        if (fits) far = view.dist;
        else near = view.dist;
      }
      view.dist = far;
      const b = bounds();
      const f = height * FOCAL;
      const across = ((b.left + b.right) / 2 - (box.left + box.right) / 2) * (view.dist / f);
      const along = ((b.top + b.bottom) / 2 - (box.top + box.bottom) / 2) * (view.dist / f / Math.sin(view.pitch));
      const [fw, rt] = cameraBasis(view.yaw, view.pitch);
      const ground = Math.hypot(fw[0], fw[2]) || 1;
      view.pivot = [view.pivot[0] + rt[0] * across - (fw[0] / ground) * along, 0, view.pivot[2] + rt[2] * across - (fw[2] / ground) * along];
    }
    return { pivot: view.pivot, dist: view.dist };
  }

  function projector(view) {
    const f = height * FOCAL;
    const [fw, rt, up] = cameraBasis(view.yaw, view.pitch);
    const eye = sub(view.pivot, scale(fw, view.dist));
    const project = (x, y, z) => {
      const dx = x - eye[0];
      const dy = y - eye[1];
      const dz = z - eye[2];
      const d = dx * fw[0] + dy * fw[1] + dz * fw[2];
      return {
        x: width / 2 + ((dx * rt[0] + dy * rt[1] + dz * rt[2]) * f) / d,
        y: height / 2 - ((dx * up[0] + dy * up[1] + dz * up[2]) * f) / d,
        z: d,
        s: (height / REF_H) * (LABEL_AT / d),
      };
    };
    return { project, fw, rt };
  }

  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (root.hidden || !width || !scene) return;
    const ease = (rate) => 1 - Math.pow(rate, dt);
    // Left alone, the archipelago turns gently back and forth so its hills keep showing their height.
    if (!drag?.moved && !hovered && !busy && !landed && now - idleSince > 3000) {
      to.yaw = swayFrom + Math.sin((now - idleSince - 3000) / 7000) * 0.3;
    }
    const rate = busy ? 0.02 : 0.012;
    cam.pivot = lerp3(cam.pivot, to.pivot, ease(rate));
    cam.yaw += (to.yaw - cam.yaw) * ease(rate);
    cam.pitch += (to.pitch - cam.pitch) * ease(rate);
    cam.dist += (to.dist - cam.dist) * ease(rate);
    if (scene.morph) morph(now);
    draw();
  });

  // Sails to an article. The camera glides to the clicked hill while the new neighborhood loads; then
  // the landscape is handed over in place: hills in both neighborhoods glide to their new places (the
  // article growing into the highest peak), islands reshape around them, what is gone sinks and what
  // is new rises. Going back through the trail works the same way.
  async function go(nextId, { from }) {
    busy = true;
    setHover(null);
    if (from !== "start" && from !== "back") Object.assign(to, { pivot: [from.x, 0, from.z], dist: Math.min(cam.dist, 2200) });
    const built = await build(nextId);
    if (!built) {
      busy = false;
      if (!scene) $(".ar-sub").textContent = "This article's neighborhood could not be loaded.";
      else overview();
      return;
    }
    const old = scene;
    scene = built;
    trail.push({ id: nextId, title: built.center.title });
    renderTrail();
    renderKey();
    landed = null;
    overviewButton.hidden = true;
    const view = fit(scene);
    handOver(old, nextId);
    if (!old) {
      cam.pivot = view.pivot;
      cam.dist = view.dist * 1.3;
    }
    Object.assign(to, view);
    idleSince = performance.now();
    swayFrom = to.yaw;
    const url = new URL(location.href);
    url.searchParams.set("id", nextId);
    history.replaceState(null, "", url);
  }

  // Sets where every hill starts its move into the new scene. The old landscape is first shifted so
  // the new article stands where the new layout puts it, at the middle, and the camera shifts with it.
  function handOver(old, nextId) {
    const anchor = old?.byId.get(nextId) ?? null;
    const [ax, az] = anchor ? [anchor.x, anchor.z] : [0, 0];
    if (old) {
      cam.pivot = [cam.pivot[0] - ax, 0, cam.pivot[2] - az];
      for (const h of [...old.hills, ...(old.morph?.leaving ?? [])]) Object.assign(h, { x: h.x - ax, z: h.z - az });
      for (const b of old.bodies) Object.assign(b, { x: b.x - ax, z: b.z - az });
      for (const br of old.bridges) for (const end of [br.from, br.to]) Object.assign(end, { 0: end[0] - ax, 2: end[2] - az });
      for (const b of old.morph?.oldBodies ?? []) b.el?.remove();
    }
    const before = new Map([...(old?.hills ?? []), ...(old?.morph?.leaving ?? [])].map((h) => [h.id, h]));
    const state = (h) => ({ x: h.x, z: h.z, top: h.top, sigma: h.sigma, foot: h.foot ?? 0, footTop: h.footTop ?? 0 });
    for (const h of scene.hills) {
      h.goal = state(h);
      const was = before.get(h.id);
      const far = Math.min(600, Math.hypot(h.x, h.z) * 0.2);
      if (was) {
        // The same article: it glides from where it was, and its old label gives way to the new one.
        h.from = state(was);
        was.el.remove();
        before.delete(h.id);
        Object.assign(h, { wait: 100, span: 1500, rising: false });
      } else {
        h.from = { ...h.goal, top: 0, footTop: 0 };
        Object.assign(h, { wait: (old ? 600 : 100) + far, span: 1000, rising: true });
      }
    }
    const leaving = [...before.values()];
    for (const h of leaving) {
      h.from = state(h);
      h.goal = { ...h.from, top: 0, footTop: 0 };
      Object.assign(h, { wait: 0, span: 900, rising: false, sinking: true });
    }
    const oldBodies = old ? [...old.bodies, ...(old.morph?.oldBodies ?? [])].filter((b) => b.el) : [];
    const oldBridges = old ? old.bridges.filter((br) => br.backbone) : [];
    scene.morph = { t0: performance.now(), leaving, oldBodies, oldBridges, fadeOld: old ? 1 : 0, reveal: 0 };
    scene.terrain = EMPTY_TERRAIN;
    morph(performance.now());
  }

  // One step of the hand-over: every hill moves along its way, and the land is remade from them.
  function morph(now) {
    const m = scene.morph;
    const t = now - m.t0;
    let moving = false;
    for (const h of [...scene.hills, ...m.leaving]) {
      const p = Math.min(1, Math.max(0, (t - h.wait) / h.span));
      if (p < 1) moving = true;
      const e = h.rising ? 1 - Math.pow(1 - p, 3) : h.sinking ? p * p : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      for (const key of ["x", "z", "top", "sigma", "foot", "footTop"]) h[key] = h.from[key] + (h.goal[key] - h.from[key]) * e;
      h.shown = h.rising ? Math.min(1, p * 1.6) : h.sinking ? 1 - Math.min(1, p * 1.6) : 1;
    }
    m.fadeOld = Math.max(0, 1 - t / 450) * (m.oldBodies.length || m.oldBridges.length ? 1 : 0);
    m.reveal = Math.min(1, Math.max(0, (t - 1000) / 600));
    if (moving || m.reveal < 1) {
      scene.terrain = terrainOf([...scene.hills, ...m.leaving], true);
      return;
    }
    scene.terrain = terrainOf(scene.hills, false);
    m.leaving.forEach((h) => h.el.remove());
    m.oldBodies.forEach((b) => b.el?.remove());
    scene.morph = null;
    busy = false;
    idleSince = now;
  }

  function renderTrail() {
    trailEl.innerHTML = trail
      .map((s, k) =>
        k === trail.length - 1
          ? `<span aria-current="page">${esc(s.title)}</span>`
          : `<button type="button" data-step="${k}">${esc(s.title)}</button><i aria-hidden="true">›</i>`,
      )
      .join("");
    trailEl.hidden = trail.length < 2;
  }

  function renderKey() {
    $(".ar-title").textContent = scene.center.title;
    const islands = scene.bodies.filter((b) => b.kind === "island").length;
    $(".ar-sub").textContent = `${scene.nearCount} linked articles on ${islands} ${islands === 1 ? "island" : "islands"} and ${scene.isletCount} islets, ${scene.furtherCount} a step further`;
  }

  // --- Drawing -------------------------------------------------------------------------------

  function draw() {
    const { project, fw, rt } = projector(cam);
    const m = scene.morph;
    const reveal = m ? m.reveal : 1;
    const focusHill = hovered?.hill ?? null;
    const focusBody = hovered?.body ?? null;
    const linked = focusHill ? scene.links.get(focusHill.id) : null;

    ctx.clearRect(0, 0, width, height);

    // A faint grid of dots on the sea, so the ground plane reads as the view turns.
    const [mx, , mz] = scene.mid;
    const reach = scene.radius * 1.35;
    ctx.fillStyle = "rgb(32,33,34)";
    for (let gx = -reach; gx <= reach; gx += 240) {
      for (let gz = -reach; gz <= reach; gz += 240) {
        const r = Math.hypot(gx, gz) / reach;
        if (r > 1) continue;
        const p = project(mx + gx, 0, mz + gz);
        if (p.z < 50) continue;
        ctx.globalAlpha = 0.16 * (1 - r * r);
        ctx.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5);
      }
    }
    ctx.globalAlpha = 1;

    // Water lines around every shore.
    ctx.strokeStyle = "rgba(92,118,140,0.2)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const loop of scene.terrain.water) tracePath(loop.pts, 0);
    ctx.stroke();

    // The land is terraces, each a white plate with its side wall down to the terrace below, like a
    // laser-cut model. Plates and bridges are painted far to near, each plate after everything whose
    // far edge lies further away, so nearer land covers what is behind it.
    const lifted = (br) => arc(br.from, br.to, br.lift, project);
    const items = [];
    for (const loop of scene.terrain.land) {
      const depth = projectLoop(loop);
      if (depth > 0) items.push({ loop, depth });
    }
    // New bridges come in once the land has settled; the old ones fade as the hand-over starts.
    const bridges = [...(reveal > 0 ? scene.bridges.filter((br) => br.backbone).map((br) => [br, reveal]) : []), ...(m?.fadeOld ? m.oldBridges.map((br) => [br, m.fadeOld]) : [])];
    for (const [br, alpha] of bridges) items.push({ bridge: br, alpha, depth: project((br.from[0] + br.to[0]) / 2, 0, (br.from[2] + br.to[2]) / 2).z });
    items.sort((a, b) => b.depth - a.depth);
    // Light from the upper left of the screen: walls turned away from it are shaded.
    const lx = -rt[0] + 0.6 * fw[0];
    const lz = -rt[2] + 0.6 * fw[2];
    const ll = Math.hypot(lx, lz) || 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const { loop, bridge, alpha } of items) {
      if (bridge) {
        if (focusBody) continue;
        const pts = lifted(bridge);
        if (!pts) continue;
        ctx.strokeStyle = `rgba(32,33,34,${(focusHill ? 0.12 : 0.36) * alpha})`;
        ctx.lineWidth = bridge.width;
        strokePoints(pts);
        continue;
      }
      drawTerrace(loop, focusBody === loop.hill.body, focusHill && loop.hill === focusHill && loop.index > 0, lx / ll, lz / ll);
    }
    ctx.globalAlpha = 1;
    if (focusBody) {
      for (const br of scene.bridges) {
        if (br.a !== focusBody && br.b !== focusBody) continue;
        const pts = lifted(br);
        if (!pts) continue;
        ctx.strokeStyle = "rgba(51,102,204,0.8)";
        ctx.lineWidth = br.width;
        strokePoints(pts);
        // How many links the bridge carries, at its top.
        const mid = pts[12];
        const text = String(br.weight);
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.roundRect(mid.x - tw / 2 - 6, mid.y - 9, tw + 12, 18, 9);
        ctx.fill();
        ctx.fillStyle = "rgb(51,102,204)";
        ctx.textAlign = "center";
        ctx.fillText(text, mid.x, mid.y + 4);
      }
    }

    // Summits, and a hovered hill's links to the others as arcs from peak to peak.
    const hills = m ? [...scene.hills, ...m.leaving] : scene.hills;
    for (const h of hills) h.p = project(h.x, h.summit, h.z);
    if (focusHill && linked) {
      ctx.strokeStyle = "rgba(51,102,204,0.32)";
      ctx.lineWidth = 0.9;
      for (const h of scene.hills) {
        if (h === focusHill || !linked.has(h.id)) continue;
        const pts = arc([focusHill.x, focusHill.summit, focusHill.z], [h.x, h.summit, h.z], 120, project);
        if (pts) strokePoints(pts);
      }
    }
    for (const h of hills) {
      if (h.shown < 0.05 || h.p.z < 50) continue;
      const lit = h === focusHill || linked?.has(h.id);
      ctx.fillStyle = lit ? "rgb(51,102,204)" : `rgba(32,33,34,${(h.hop === 2 ? 0.45 : 0.8) * h.shown})`;
      const r = h === scene.center ? 6 : h.hop === 2 ? 2.2 : 3.4;
      ctx.beginPath();
      ctx.moveTo(h.p.x, h.p.y - r);
      ctx.lineTo(h.p.x + r * 0.95, h.p.y + r * 0.6);
      ctx.lineTo(h.p.x - r * 0.95, h.p.y + r * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    placeLabels(project, fw, hills, focusHill, focusBody, linked);

    // Projects a terrace outline at its top and at the terrace below; returns its farthest depth, or 0
    // when part of it is behind the camera.
    function projectLoop(loop) {
      let far = 0;
      for (let i = 0, k = 0; i < loop.pts.length; i += 2, k++) {
        const top = project(loop.pts[i], loop.y, loop.pts[i + 1]);
        const bottom = project(loop.pts[i], loop.below, loop.pts[i + 1]);
        if (top.z < 50) return 0;
        loop.sx[k] = top.x;
        loop.sy[k] = top.y;
        loop.bx[k] = bottom.x;
        loop.by[k] = bottom.y;
        far = Math.max(far, top.z);
      }
      return far;
    }

    // The wall first, only where it faces the camera, in four shades; then the plate and its edge.
    function drawTerrace(loop, bodyLit, hillLit, lightX, lightZ) {
      const n = loop.sx.length;
      const walls = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const used = [false, false, false, false];
      for (let k = 0; k < n; k++) {
        const nx = loop.nx[k];
        const nz = loop.nz[k];
        if (nx * fw[0] + nz * fw[2] > 0.05) continue;
        const lit = nx * lightX + nz * lightZ;
        const tone = lit > 0.35 ? 0 : lit > -0.15 ? 1 : lit > -0.6 ? 2 : 3;
        const j = (k + 1) % n;
        const w = walls[tone];
        w.moveTo(loop.sx[k], loop.sy[k]);
        w.lineTo(loop.sx[j], loop.sy[j]);
        w.lineTo(loop.bx[j], loop.by[j]);
        w.lineTo(loop.bx[k], loop.by[k]);
        w.closePath();
        used[tone] = true;
      }
      const tones = loop.index === 0 ? SHORE_WALL : WALL;
      for (let t = 0; t < 4; t++) {
        if (!used[t]) continue;
        // A hairline of the same tone closes the seams between neighbouring quads.
        ctx.fillStyle = ctx.strokeStyle = tones[t];
        ctx.lineWidth = 0.6;
        ctx.fill(walls[t]);
        ctx.stroke(walls[t]);
      }
      ctx.beginPath();
      for (let k = 0; k < n; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, loop.sx[k], loop.sy[k]);
      ctx.closePath();
      ctx.fillStyle = "#fdfcf9";
      ctx.fill();
      if (hillLit) {
        ctx.strokeStyle = "rgba(51,102,204,0.85)";
        ctx.lineWidth = 1.1;
      } else if (loop.index === 0) {
        ctx.strokeStyle = bodyLit ? "rgba(51,102,204,0.9)" : "rgba(32,33,34,0.62)";
        ctx.lineWidth = bodyLit ? 1.6 : 1;
      } else {
        ctx.strokeStyle = `rgba(32,33,34,${loop.index % 5 === 0 ? 0.42 : 0.26})`;
        ctx.lineWidth = 0.7;
      }
      ctx.stroke();
    }

    function tracePath(pts, y) {
      for (let i = 0; i < pts.length; i += 2) {
        const p = project(pts[i], y, pts[i + 1]);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
    }
  }

  // The article's label first, then pictures, island names, the peaks and then the low mounds, each
  // nearest first; a label that would land on one already placed is left out. Mounds of a terrace or
  // two are named only when zoomed in, or when linked to the hovered hill.
  function placeLabels(project, fw, hillList, focusHill, focusBody, linked) {
    const taken = [];
    const free = (box) => !taken.some((t) => box.x < t.x + t.w && box.x + box.w > t.x && box.y < t.y + t.h && box.y + box.h > t.y);
    const show = (el, box, s, a, z) => {
      el.style.transform = `translate(${box.x}px, ${box.y}px) scale(${s})`;
      el.style.opacity = a.toFixed(3);
      el.style.zIndex = String(z);
      el.style.pointerEvents = a > 0.2 ? "auto" : "none";
    };

    // Island names lie on the water just in front of their island, towards the viewer. While the
    // landscape is handed over, the old names fade out and the new ones come in once it has settled.
    const m = scene.morph;
    const toward = [-fw[0], -fw[2]];
    const len = Math.hypot(...toward) || 1;
    const isles = [...scene.bodies.filter((b) => b.el).map((b) => [b, m ? m.reveal : 1]), ...(m ? m.oldBodies.map((b) => [b, m.fadeOld]) : [])];
    for (const [b, shown] of isles) {
      const p = project(b.x + (toward[0] / len) * b.R * 0.86, 0, b.z + (toward[1] / len) * b.R * 0.86);
      const s = Math.max(0.7, Math.min(1.2, p.s));
      b.box = { x: p.x - (b.w * s) / 2, y: p.y + 4, w: b.w * s, h: b.h * s };
      b.s = s;
      b.shown = p.z > 50 ? shown : 0;
    }
    const hills = hillList.filter((h) => h.p.z > 50);
    for (const h of hills) {
      const s = Math.max(0.8, Math.min(h === scene.center ? 1 : 1.06, h.p.s));
      h.s = s;
      h.box = { x: h.p.x - (h.w * s) / 2, y: h.p.y - h.h * s - 3, w: h.w * s, h: h.h * s };
    }
    const byNear = (a, b) => a.p.z - b.p.z;
    const peak = (h) => h.summit >= SHORE + 2 * STEP;
    const order = [
      ...hills.filter((h) => h === scene.center),
      ...hills.filter((h) => h.picture && h !== scene.center).sort(byNear),
      ...isles.map(([b]) => b),
      ...hills.filter((h) => !h.picture && h.hop === 1 && peak(h)).sort(byNear),
      ...hills.filter((h) => !h.picture && h.hop === 1 && !peak(h)).sort(byNear),
      ...hills.filter((h) => h.hop === 2).sort(byNear),
    ];
    const hiddenHill = new Set(hillList);
    for (const it of order) {
      if (it.kind) {
        const lit = focusBody === it;
        const room = it.shown > 0.02 && (lit || free(it.box));
        const a = room ? it.shown * (focusBody && !lit ? 0.35 : focusHill ? 0.5 : 1) : 0;
        show(it.el, it.box, it.s, a, 1000);
        if (room && it.shown > 0.5) taken.push(it.box);
        continue;
      }
      hiddenHill.delete(it);
      const lit = it === focusHill || linked?.has(it.id);
      const named = it === scene.center || it.picture || lit || (it.hop === 1 ? peak(it) || it.p.s > 0.95 : it.p.s > 1.1);
      const room = it.shown > 0.05 && named && (it === scene.center || it === focusHill || free(it.box));
      const a = room ? it.shown * (it.hop === 2 ? 0.8 : 1) * (focusHill && !lit ? 0.3 : focusBody && it.body !== focusBody ? 0.4 : 1) : 0;
      it.el.classList.toggle("is-low", it.hop === 1 && !peak(it) && it !== scene.center);
      show(it.el, it.box, it.s, a, (lit ? 50000 : 2000) + (it.picture ? 10000 : 0) - Math.round(it.p.z / 10));
      if (room) taken.push(it.box);
    }
    for (const h of hiddenHill) Object.assign(h.el.style, { opacity: "0", pointerEvents: "none" });
  }

  function strokePoints(pts) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }

  // --- Hover ---------------------------------------------------------------------------------

  function hoverAt(x, y, target) {
    const el = target.closest?.("[data-node], [data-body]");
    if (el?.dataset.node) return setHover({ hill: scene.byId.get(Number(el.dataset.node)) }, x, y);
    if (el?.dataset.body) return setHover({ body: scene.bodies[Number(el.dataset.body)] }, x, y);
    // A summit under the pointer, else whatever land the pointer's ray meets first.
    let best = null;
    let bestD = 14;
    for (const h of scene.hills) {
      if (h.shown < 0.5 || !h.p || h.p.z < 50) continue;
      const d = Math.hypot(h.p.x - x, h.p.y - y);
      if (d < bestD) [best, bestD] = [h, d];
    }
    if (best) return setHover({ hill: best }, x, y);
    const hit = landAt(x, y);
    if (!hit) return setHover(null);
    // The upper part of a hill is the hill; the lower land is its island. Islets are all hill.
    const h = hit.hill;
    if (h.body.kind !== "island" || hit.share > 0.35) return setHover({ hill: h }, x, y);
    setHover({ body: h.body }, x, y);
  }

  // Walks the pointer's ray down through the height field to the first land it meets.
  function landAt(x, y) {
    const f = height * FOCAL;
    const [fw, rt, up] = cameraBasis(cam.yaw, cam.pitch);
    const eye = sub(cam.pivot, scale(fw, cam.dist));
    const dir = [0, 1, 2].map((i) => fw[i] + rt[i] * ((x - width / 2) / f) - up[i] * ((y - height / 2) / f));
    if (dir[1] >= 0) return null;
    const g = scene.terrain.grid;
    if (!g) return null;
    const tTop = Math.max(0, (PEAK * 1.1 - eye[1]) / dir[1]);
    const tSea = -eye[1] / dir[1];
    const stepT = (g.cell * 0.7) / Math.hypot(dir[0], dir[2]);
    for (let t = tTop; t <= tSea + stepT; t += stepT) {
      const px = eye[0] + dir[0] * t;
      const py = eye[1] + dir[1] * t;
      const pz = eye[2] + dir[2] * t;
      const i = Math.round((px - g.x0) / g.cell);
      const j = Math.round((pz - g.z0) / g.cell);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
      const k = j * g.nx + i;
      const owner = g.owner[k];
      if (owner < 0) continue;
      const hill = scene.terrain.hills[owner];
      if (py <= terraceY(g.field[k])) return { hill, share: g.field[k] / hill.top };
    }
    return null;
  }

  async function setHover(next, x, y) {
    const same = next && hovered && next.hill === hovered.hill && next.body === hovered.body;
    if (!same) {
      hovered?.hill?.el.classList.remove("is-hovered");
      hovered?.body?.el?.classList.remove("is-hovered");
      hovered = next;
      next?.hill?.el.classList.add("is-hovered");
      next?.body?.el?.classList.add("is-hovered");
      stage.classList.toggle("is-pointing", !!next && next.hill !== scene?.center);
    }
    if (!next) {
      tip.classList.remove("is-shown");
      return;
    }
    tip.style.transform = `translate(${Math.min(x + 18, width - 300)}px, ${Math.min(y + 18, height - 230)}px)`;
    const key = next.hill ? `h${next.hill.id}` : `b${next.body.index}`;
    if (tip.dataset.key !== key) {
      tip.dataset.key = key;
      if (next.body) {
        tip.innerHTML = islandTip(next.body);
      } else {
        tip.innerHTML = hillTip(next.hill, null);
        const p = await scene.preview(next.hill.title);
        if (hovered?.hill === next.hill) tip.innerHTML = hillTip(next.hill, p);
      }
    }
    tip.classList.add("is-shown");
  }

  function hillTip(h, p) {
    const where =
      h === scene.center
        ? "This article"
        : h.hop === 2
          ? `A step further, through ${esc(h.via.title)}`
          : h.body.kind === "island"
            ? `On ${esc(h.body.name)}`
            : `Islet by ${esc(h.body.parent.name)}`;
    return `${p?.thumbnail ? `<img src="${p.thumbnail.url}" alt="" />` : ""}
      <b>${esc(h.title)}</b><span>${where} · ${h.degree} ${h.degree === 1 ? "link" : "links"} here</span>
      ${p?.extract ? `<p>${esc(clip(p.extract, 170))}</p>` : ""}
      ${h === scene.center ? "" : `<em>Click to sail here</em>`}`;
  }

  function islandTip(b) {
    const ties = scene.bridges
      .filter((br) => br.a === b || br.b === b)
      .map((br) => ({ other: br.a === b ? br.b : br.a, weight: br.weight }))
      .sort((p, q) => q.weight - p.weight);
    const near = b.hills.filter((h) => h.hop !== 2).length;
    const far = b.hills.length - near;
    return `<b>${esc(b.name)}</b>
      <span>${near} ${near === 1 ? "article" : "articles"}${far ? `, ${far} a step further` : ""}${b.islets ? ` · ${b.islets} ${b.islets === 1 ? "islet" : "islets"}` : ""}</span>
      <p>${ties.length ? `Bridged to ${ties.slice(0, 4).map((t) => `${esc(t.other.name)} (${t.weight})`).join(", ")}${ties.length > 4 ? ` and ${ties.length - 4} more` : ""}.` : "No bridges: its articles link to no other topic here."}</p>
      ${landed === b ? "" : `<em>Click to land</em>`}`;
  }

  // --- Layout --------------------------------------------------------------------------------

  async function build(centerId) {
    const graph = await getGraph(currentTime(), centerId).catch(() => null);
    if (!graph) return null;
    const info = new Map(graph.nodes.map((n) => [n.id, n]));
    const self = info.get(centerId);
    if (!self) return null;
    const links = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    for (const e of graph.edges) {
      if (e.source === e.target) continue;
      links.get(e.source)?.add(e.target);
      links.get(e.target)?.add(e.source);
    }
    // Explore's choice of linked articles, and of the articles a step further.
    const all = [...links.get(centerId)];
    const allSet = new Set(all);
    const shared = (n) => [...links.get(n)].filter((m) => allSet.has(m)).length;
    const score = (n) => (info.get(n).chars ?? 0) + 4000 * shared(n);
    const near = all.sort((a, b) => score(b) - score(a)).slice(0, MAX_NEAR);
    const nearSet = new Set(near);
    const further = graph.nodes
      .map((n) => n.id)
      .filter((n) => n !== centerId && !allSet.has(n))
      .map((n) => ({ n, via: [...links.get(n)].filter((m) => nearSet.has(m)) }))
      .filter(({ via }) => via.length)
      .sort((a, b) => b.via.length - a.via.length)
      .slice(0, MAX_FURTHER);

    // Height is how central an article is: its links to the other articles shown.
    const shown = new Set([centerId, ...near, ...further.map(({ n }) => n)]);
    for (const set of links.values()) for (const m of set) if (!shown.has(m)) set.delete(m);
    const degree = (n) => links.get(n).size;
    const maxDegree = Math.max(1, ...near.map(degree));
    // A steep curve: most hills are low mounds of a terrace or two, and only the few truly central
    // articles rise high. Longer articles spread wider.
    const hill = (n, hop) => {
      const t = Math.min(1, degree(n) / maxDegree);
      const size = Math.min(1, Math.max(0, (Math.log10(1 + (info.get(n).chars ?? 0)) - 3) / 2.2));
      const top = n === centerId ? PEAK : hop === 1 ? STEP + 6 + (PEAK - 5 * STEP - 6) * Math.pow(t, 2.8) : 16 + 34 * t;
      // High hills spread wider too, so they stand as mountains rather than towers.
      return { id: n, title: info.get(n).title, hop, degree: degree(n), top, sigma: n === centerId ? 105 : 24 + 34 * size + 46 * Math.pow(t, 2) };
    };

    // Islands are the topics with two or more linked articles, and the article's own topic.
    const topicOf = (n) => info.get(n).topic ?? info.get(n).title;
    const groups = Map.groupBy(near, topicOf);
    const centerHill = hill(centerId, 0);
    const bodies = [];
    const islandOf = new Map();
    const addBody = (kind, name, hills, parent = null) => {
      const b = { kind, name, hills, parent, index: bodies.length, islets: 0 };
      bodies.push(b);
      for (const h of hills) h.body = b;
      return b;
    };
    const centerIsland = addBody("island", topicOf(centerId), [centerHill, ...(groups.get(topicOf(centerId)) ?? []).map((n) => hill(n, 1))]);
    islandOf.set(centerIsland.name, centerIsland);
    groups.delete(topicOf(centerId));
    const singles = [];
    for (const [topic, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      if (members.length < 2) singles.push(...members);
      else islandOf.set(topic, addBody("island", topic, members.map((n) => hill(n, 1))));
    }
    const islands = [...bodies];
    // Links between an article and an island's articles, not counting the article everything links to.
    const tiesTo = (n, island) => island.hills.filter((h) => h.id !== centerId && links.get(n).has(h.id)).length;
    for (const n of singles) {
      const best = islands
        .map((island) => ({ island, w: tiesTo(n, island) / Math.sqrt(island.hills.length) }))
        .reduce((a, b) => (b.w > a.w ? b : a), { island: centerIsland, w: 0 }).island;
      addBody("islet", topicOf(n), [hill(n, 1)], best);
      best.islets++;
    }
    const nearBody = new Map(bodies.flatMap((b) => b.hills.map((h) => [h.id, b])));
    // A step further: on its topic's island when there is one, else a skerry beyond the article it is
    // reached through. Skerries are kept few, the best connected first, so they fringe rather than crowd.
    const skerries = new Map();
    let furtherCount = 0;
    for (const { n, via } of further) {
      const h = hill(n, 2);
      h.via = info.get(via.sort((a, b) => score(b) - score(a))[0]);
      const island = islandOf.get(topicOf(n));
      const parent = nearBody.get(h.via.id);
      if (island) {
        island.hills.push(h);
        h.body = island;
      } else if ((skerries.get(parent) ?? 0) < MAX_SKERRIES_EACH && [...skerries.values()].reduce((a, b) => a + b, 0) < MAX_SKERRIES) {
        skerries.set(parent, (skerries.get(parent) ?? 0) + 1);
        // Skerries stay small and low whatever their links, so they read as the far fringe.
        Object.assign(h, { top: 12 + 10 * (h.degree / maxDegree), sigma: 17 });
        addBody("skerry", topicOf(n), [h], parent);
      } else {
        continue;
      }
      furtherCount++;
    }
    for (const b of bodies) {
      b.hills.sort((p, q) => (p.hop === 0 ? -1 : q.hop === 0 ? 1 : p.hop - q.hop || q.top - p.top));
      packHills(b);
    }

    // Bridges between islands: links between their articles.
    const bridges = [];
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        let weight = 0;
        for (const h of islands[i].hills) if (h.id !== centerId) weight += tiesTo(h.id, islands[j]);
        if (weight) bridges.push({ a: islands[i], b: islands[j], weight });
      }
    }
    // Only the backbone is drawn until an island is hovered: each island's two strongest ties, and any
    // tie among the strongest overall. That keeps the bridges few and telling.
    const strongest = Math.max(0, ...bridges.map((br) => br.weight));
    for (const island of islands) {
      bridges
        .filter((br) => br.a === island || br.b === island)
        .sort((p, q) => q.weight - p.weight)
        .slice(0, 2)
        .forEach((br) => (br.backbone = br.weight > 1));
    }
    for (const br of bridges) if (br.weight >= strongest * 0.5) br.backbone = true;
    arrange(bodies, bridges, centerIsland);

    const hills = bodies.flatMap((b) => b.hills.map((h) => Object.assign(h, { x: b.x + h.dx, z: b.z + h.dz })));
    const byId = new Map(hills.map((h) => [h.id, h]));
    // Until the land is made, a hill's summit is its terrace by its own height.
    for (const h of hills) Object.assign(h, { summit: terraceY(h.top), shown: 0 });

    // Bridge ends stand at the foot of each island's hill nearest the other island.
    const landing = (from, toward) => {
      const h = from.hills.reduce((p, q) => (Math.hypot(q.x - toward.x, q.z - toward.z) < Math.hypot(p.x - toward.x, p.z - toward.z) ? q : p));
      const dx = toward.x - h.x;
      const dz = toward.z - h.z;
      const d = Math.hypot(dx, dz) || 1;
      return [h.x + (dx / d) * h.sigma * 1.3, SHORE, h.z + (dz / d) * h.sigma * 1.3];
    };
    for (const br of bridges) {
      br.from = landing(br.a, br.b);
      br.to = landing(br.b, br.a);
      br.lift = 40 + Math.hypot(br.to[0] - br.from[0], br.to[2] - br.from[2]) * 0.12;
      br.width = 0.7 + 0.8 * Math.log2(br.weight);
    }

    const xs = bodies.flatMap((b) => [b.x - b.R, b.x + b.R]);
    const zs = bodies.flatMap((b) => [b.z - b.R, b.z + b.R]);
    const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
    const radius = Math.max(...bodies.map((b) => Math.hypot(b.x - mid[0], b.z - mid[2]) + b.R));

    const previews = new Map();
    const preview = (title) => {
      if (!previews.has(title)) previews.set(title, getPreview(title).catch(() => null));
      return previews.get(title);
    };
    // Pictures on the most central peaks, at most one per island, and the article's own.
    const ranked = hills.filter((h) => h.hop === 1).sort((a, b) => b.degree - a.degree).slice(0, 24);
    const [centerPreview, ...found] = await Promise.all([preview(centerHill.title), ...ranked.map((h) => preview(h.title))]);
    const pictured = new Map();
    if (centerPreview?.thumbnail) pictured.set(centerHill, centerPreview.thumbnail.url);
    const usedBodies = new Set([centerIsland]);
    ranked.forEach((h, k) => {
      if (pictured.size > MAX_PICTURES || !found[k]?.thumbnail || usedBodies.has(h.body) || usedBodies.has(h.body.parent)) return;
      pictured.set(h, found[k].thumbnail.url);
      usedBodies.add(h.body);
    });

    for (const h of hills) {
      h.picture = pictured.get(h) ?? null;
      h.el = hillEl(h, h === centerHill);
      layer.append(h.el);
      h.w = h.el.offsetWidth;
      h.h = h.el.offsetHeight;
    }
    for (const b of islands) {
      b.el = document.createElement("span");
      b.el.className = "ar-isle";
      b.el.dataset.body = String(b.index);
      b.el.textContent = b.name;
      b.el.style.fontSize = `${Math.round(15 + 2.4 * Math.sqrt(b.hills.length))}px`;
      layer.append(b.el);
      b.w = b.el.offsetWidth;
      b.h = b.el.offsetHeight;
    }

    return {
      center: centerHill,
      hills,
      bodies,
      bridges,
      byId,
      links,
      mid,
      radius,
      preview,
      nearCount: near.length,
      isletCount: bodies.filter((b) => b.kind === "islet").length,
      furtherCount,
    };
  }

  function hillEl(h, isCenter) {
    const el = document.createElement("span");
    el.dataset.node = String(h.id);
    el.className = `ar-peak${isCenter ? " is-center" : ""}${h.hop === 2 ? " is-far" : ""}${h.picture ? " has-picture" : ""}`;
    el.innerHTML = `${h.picture ? `<img src="${h.picture}" alt="" draggable="false">` : ""}<span>${esc(h.title)}</span>`;
    return el;
  }
}

// Hills on an island in a sunflower: the highest in the middle, lower ones further out.
function packHills(body) {
  body.R = 0;
  body.hills.forEach((h, k) => {
    const r = k === 0 ? 0 : SPACING * Math.sqrt(k + 0.4) * (h.hop === 2 ? 0.92 : 1);
    const a = k * 2.39996;
    h.dx = Math.cos(a) * r;
    h.dz = Math.sin(a) * r;
    // On an island every hill stands on a broad, low foot, so the island is one stretch of land.
    if (body.kind === "island" && body.hills.length > 1) Object.assign(h, { foot: h.sigma * 2.2, footTop: FOOT });
    h.reach = hillReach(h);
    body.R = Math.max(body.R, r + h.reach);
  });
}

// How far from its middle a hill's bell, or its foot, still rises above the sea.
function hillReach(h) {
  const bell = h.sigma * Math.sqrt(2 * Math.log(Math.max(h.top, COAST * 1.2) / (COAST * 0.6)));
  const foot = h.foot && h.footTop > COAST * 0.6 ? h.foot * Math.sqrt(2 * Math.log(h.footTop / (COAST * 0.6))) : 0;
  return Math.max(bell, foot);
}

const EMPTY_TERRAIN = { grid: null, land: [], water: [], hills: [] };

// The land made from the hills as they stand: the height field and its terraces. While hills are on
// the move it is made coarser, so it can be remade every frame.
function terrainOf(hills, coarse) {
  const live = hills.filter((h) => h.top > COAST * 0.6 || h.footTop > COAST * 0.6);
  if (!live.length) return EMPTY_TERRAIN;
  for (const h of live) h.reach = hillReach(h);
  const grid = heightField(live, coarse);
  for (const h of hills) h.summit = 0;
  for (const h of live) h.summit = terraceY(sampleField(grid, h.x, h.z));
  return { grid, ...contours(grid, live), hills: live };
}

// Lays the islands out on the sea: bridged islands pull together, islets and skerries keep close to
// their island, and nothing overlaps. The article's island stays in the middle.
function arrange(bodies, bridges, centerIsland) {
  const rand = seeded(bodies.length * 7919 + bridges.length);
  const islands = bodies.filter((b) => b.kind === "island");
  const tieToCenter = new Map(bridges.flatMap((br) => (br.a === centerIsland ? [[br.b, br.weight]] : br.b === centerIsland ? [[br.a, br.weight]] : [])));
  islands
    .filter((b) => b !== centerIsland)
    .sort((a, b) => (tieToCenter.get(b) ?? 0) - (tieToCenter.get(a) ?? 0))
    .forEach((b, k) => {
      const a = k * 2.39996 + 0.6;
      const r = centerIsland.R + b.R + 260 + 120 * Math.sqrt(k);
      Object.assign(b, { x: Math.cos(a) * r, z: Math.sin(a) * r });
    });
  Object.assign(centerIsland, { x: 0, z: 0 });
  for (const b of bodies) {
    if (b.kind === "island") continue;
    const p = b.parent;
    const a = rand() * Math.PI * 2;
    const r = p.R + b.R + 40;
    Object.assign(b, { x: (p.x ?? 0) + Math.cos(a) * r, z: (p.z ?? 0) + Math.sin(a) * r });
  }
  const springs = [
    ...bridges.map((br) => ({ a: br.a, b: br.b, rest: br.a.R + br.b.R + 200 + 260 / Math.sqrt(br.weight), k: 0.012 * Math.min(1, br.weight / 3) })),
    ...bodies.filter((b) => b.parent).map((b) => ({ a: b, b: b.parent, rest: b.R + b.parent.R + (b.kind === "islet" ? 28 : 60), k: 0.06 })),
  ];
  const gap = (a, b) => (a.kind === "island" && b.kind === "island" ? 240 : a.kind === "skerry" || b.kind === "skerry" ? 14 : 26);
  for (let round = 0; round < 600; round++) {
    const heat = 1 - round / 600;
    for (const s of springs) {
      const dx = s.b.x - s.a.x;
      const dz = s.b.z - s.a.z;
      const d = Math.hypot(dx, dz) || 1;
      const pull = (d - s.rest) * s.k * heat;
      move(s.a, (dx / d) * pull, (dz / d) * pull);
      move(s.b, (-dx / d) * pull, (-dz / d) * pull);
    }
    for (const b of islands) move(b, -b.x * 0.002 * heat, -b.z * 0.002 * heat);
    // Islets and skerries drift outwards, away from the middle, so they fringe the archipelago.
    for (const b of bodies) {
      if (b.kind === "island") continue;
      const d = Math.hypot(b.x, b.z) || 1;
      move(b, (b.x / d) * 1.5 * heat, (b.z / d) * 1.5 * heat);
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const min = a.R + b.R + gap(a, b);
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (min - d) / 2;
        move(a, (-dx / d) * push, (-dz / d) * push);
        move(b, (dx / d) * push, (dz / d) * push);
      }
    }
  }
  function move(b, dx, dz) {
    if (b === centerIsland) return;
    b.x += dx;
    b.z += dz;
  }
}

// The land as one height field: each hill is a bell, the land is the highest bell at each point, and a
// gentle warp makes shores and contours wander like real ones.
function heightField(hills, coarse) {
  const pad = 260;
  const x0 = Math.min(...hills.map((h) => h.x - h.reach)) - pad;
  const z0 = Math.min(...hills.map((h) => h.z - h.reach)) - pad;
  const x1 = Math.max(...hills.map((h) => h.x + h.reach)) + pad;
  const z1 = Math.max(...hills.map((h) => h.z + h.reach)) + pad;
  const cell = Math.max(10, Math.max(x1 - x0, z1 - z0) / (coarse ? 170 : 260));
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const field = new Float32Array(nx * nz);
  const owner = new Int16Array(nx * nz).fill(-1);
  // The same noise for every scene, so shores keep their wander while the land is handed over.
  const noise = valueNoise(1);
  const warpX = new Float32Array(nx * nz);
  const warpZ = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      const z = z0 + j * cell;
      warpX[j * nx + i] = (noise(x / 170, z / 170) - 0.5) * 46 + (noise(x / 60 + 31, z / 60) - 0.5) * 12;
      warpZ[j * nx + i] = (noise(x / 170 + 57, z / 170 + 13) - 0.5) * 46 + (noise(x / 60, z / 60 + 77) - 0.5) * 12;
    }
  }
  hills.forEach((h, index) => {
    const span = (h.reach * 1.5 + 30) / cell;
    const ci = (h.x - x0) / cell;
    const cj = (h.z - z0) / cell;
    for (let j = Math.max(0, Math.floor(cj - span)); j <= Math.min(nz - 1, Math.ceil(cj + span)); j++) {
      for (let i = Math.max(0, Math.floor(ci - span)); i <= Math.min(nx - 1, Math.ceil(ci + span)); i++) {
        const k = j * nx + i;
        const dx = (i - ci) * cell + warpX[k];
        const dz = (j - cj) * cell + warpZ[k];
        const d2 = dx * dx + dz * dz;
        const v = Math.max(h.top * Math.exp(-d2 / (2 * h.sigma * h.sigma)), h.foot > 1 ? h.footTop * Math.exp(-d2 / (2 * h.foot * h.foot)) : 0);
        if (v > field[k]) {
          field[k] = v;
          owner[k] = index;
        }
      }
    }
  });
  for (let k = 0; k < field.length; k++) if (field[k] < COAST) owner[k] = -1;
  return { x0, z0, cell, nx, nz, field, owner };
}

function sampleField(g, x, z) {
  const i = Math.round((x - g.x0) / g.cell);
  const j = Math.round((z - g.z0) / g.cell);
  let best = 0;
  // The warp moves a summit a little, so look around the hill's spot for its top.
  for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) best = Math.max(best, g.field[(j + dj) * g.nx + (i + di)] ?? 0);
  return best;
}

// The height a terrace is drawn at, for a height in the field: the bottom terrace is SHORE high and
// each one above is a STEP higher.
function terraceY(v) {
  return v < COAST ? 0 : SHORE + Math.floor(v / STEP) * STEP;
}

// Contour lines by marching squares, joined into closed loops. Each land loop belongs to the hill
// whose bell is highest where it starts, and knows which way is outwards along each of its edges,
// for its wall.
function contours(g, hills) {
  const levels = [COAST];
  for (let l = STEP; l < PEAK; l += STEP) levels.push(l);
  const land = [];
  const water = [];
  const all = [...WATER.map((l) => [l, -1]), ...levels.map((l, k) => [l, k])];
  for (const [level, index] of all) {
    for (const pts of marchingSquares(g, level)) {
      if (index < 0) {
        water.push({ pts });
        continue;
      }
      const i = Math.round((pts[0] - g.x0) / g.cell);
      const j = Math.round((pts[1] - g.z0) / g.cell);
      let owner = -1;
      for (let d = 0; d <= 2 && owner < 0; d++) {
        for (const [di, dj] of [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]]) {
          const o = g.owner[(j + dj) * g.nx + (i + di)];
          if (o >= 0) {
            owner = o;
            break;
          }
        }
      }
      if (owner < 0) continue;
      const n = pts.length / 2;
      const nx = new Float32Array(n);
      const nz = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const dx = pts[((k + 1) % n) * 2] - pts[k * 2];
        const dz = pts[((k + 1) % n) * 2 + 1] - pts[k * 2 + 1];
        const d = Math.hypot(dx, dz) || 1;
        nx[k] = -dz / d;
        nz[k] = dx / d;
      }
      // If the land is on the left of the first edge, outwards is to the right.
      const mx = (pts[0] + pts[2]) / 2 + nx[0] * g.cell * 0.8;
      const mz = (pts[1] + pts[3]) / 2 + nz[0] * g.cell * 0.8;
      if (sampleAt(g, mx, mz) >= level) for (let k = 0; k < n; k++) [nx[k], nz[k]] = [-nx[k], -nz[k]];
      const y = index === 0 ? SHORE : SHORE + index * STEP;
      const below = index === 0 ? 0 : y - STEP;
      land.push({ pts, level, index, hill: hills[owner], y, below, nx, nz, sx: new Float32Array(n), sy: new Float32Array(n), bx: new Float32Array(n), by: new Float32Array(n) });
    }
  }
  return { land, water };
}

function sampleAt(g, x, z) {
  const fi = (x - g.x0) / g.cell;
  const fj = (z - g.z0) / g.cell;
  const i = Math.max(0, Math.min(g.nx - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(g.nz - 2, Math.floor(fj)));
  const u = fi - i;
  const w = fj - j;
  const f = g.field;
  const top = f[j * g.nx + i] * (1 - u) + f[j * g.nx + i + 1] * u;
  const bottom = f[(j + 1) * g.nx + i] * (1 - u) + f[(j + 1) * g.nx + i + 1] * u;
  return top * (1 - w) + bottom * w;
}

function marchingSquares(g, level) {
  const { nx, nz, field, x0, z0, cell } = g;
  const at = new Map(); // edge id → crossing point
  const ends = new Map(); // edge id → segments touching it
  const segs = [];
  const cross = (id, va, vb, xa, za, xb, zb) => {
    if (!at.has(id)) {
      const t = (level - va) / (vb - va);
      at.set(id, [xa + (xb - xa) * t, za + (zb - za) * t]);
    }
    return id;
  };
  const link = (e1, e2) => {
    const s = segs.length;
    segs.push([e1, e2]);
    for (const e of [e1, e2]) {
      if (!ends.has(e)) ends.set(e, []);
      ends.get(e).push(s);
    }
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = field[j * nx + i];
      const b = field[j * nx + i + 1];
      const c = field[(j + 1) * nx + i + 1];
      const d = field[(j + 1) * nx + i];
      const ha = a >= level;
      const hb = b >= level;
      const hc = c >= level;
      const hd = d >= level;
      if (ha === hb && hb === hc && hc === hd) continue;
      const x = x0 + i * cell;
      const z = z0 + j * cell;
      // Edges: top, right, bottom, left.
      const e = [
        ha !== hb ? cross((j * nx + i) * 2, a, b, x, z, x + cell, z) : -1,
        hb !== hc ? cross((j * nx + i + 1) * 2 + 1, b, c, x + cell, z, x + cell, z + cell) : -1,
        hd !== hc ? cross(((j + 1) * nx + i) * 2, d, c, x, z + cell, x + cell, z + cell) : -1,
        ha !== hd ? cross((j * nx + i) * 2 + 1, a, d, x, z, x, z + cell) : -1,
      ];
      const crossing = e.filter((id) => id >= 0);
      if (crossing.length === 2) {
        link(crossing[0], crossing[1]);
        continue;
      }
      // A saddle: cut off the corners that differ from the middle of the cell.
      const middle = (a + b + c + d) / 4 >= level;
      if (ha !== middle) link(e[3], e[0]);
      if (hb !== middle) link(e[0], e[1]);
      if (hc !== middle) link(e[1], e[2]);
      if (hd !== middle) link(e[2], e[3]);
    }
  }
  // Join segments into loops, keeping a point only when it has moved on from the last one kept.
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    const ids = [segs[s0][0]];
    let s = s0;
    let edge = segs[s0][1];
    while (true) {
      used[s] = 1;
      ids.push(edge);
      const next = ends.get(edge).find((n) => !used[n]);
      if (next === undefined) break;
      s = next;
      edge = segs[s][0] === edge ? segs[s][1] : segs[s][0];
    }
    if (ids.length < 6) continue;
    const pts = [];
    let lx = Infinity;
    let lz = Infinity;
    for (const id of ids) {
      const [px, pz] = at.get(id);
      if (Math.hypot(px - lx, pz - lz) < cell * 1.2) continue;
      pts.push(px, pz);
      lx = px;
      lz = pz;
    }
    if (pts.length >= 6) loops.push(smooth(pts));
  }
  return loops;
}

// Rounds a closed line by cutting each corner (Chaikin), so shores read as drawn, not gridded.
function smooth(pts) {
  const out = [];
  const n = pts.length / 2;
  for (let k = 0; k < n; k++) {
    const ax = pts[2 * k];
    const az = pts[2 * k + 1];
    const bx = pts[(2 * k + 2) % pts.length];
    const bz = pts[(2 * k + 3) % pts.length];
    out.push(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25, ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75);
  }
  return Float32Array.from(out);
}

// A curve from a to b that rises `lift` above the straight line at its middle, projected to screen.
function arc(a, b, lift, project) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const p = project(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + 4 * lift * t * (1 - t), a[2] + (b[2] - a[2]) * t);
    if (p.z < 50) return null;
    pts.push(p);
  }
  return pts;
}

function cameraBasis(yaw, pitch) {
  const f = [Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return [f, r, u];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Smooth noise in [0, 1] from a lattice of seeded random values.
function valueNoise(seed) {
  const rand = seeded(seed * 31 + 7);
  const table = Float32Array.from({ length: 256 }, rand);
  const perm = Uint8Array.from({ length: 256 }, (_, i) => i).sort(() => rand() - 0.5);
  const v = (i, j) => table[perm[(perm[i & 255] + j) & 255]];
  return (x, z) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const fx = x - i;
    const fz = z - j;
    const u = fx * fx * (3 - 2 * fx);
    const w = fz * fz * (3 - 2 * fz);
    const top = v(i, j) + (v(i + 1, j) - v(i, j)) * u;
    const bottom = v(i, j + 1) + (v(i + 1, j + 1) - v(i, j + 1)) * u;
    return top + (bottom - top) * w;
  };
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
