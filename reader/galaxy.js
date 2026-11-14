import { getArticle, getArticles, getGraph, getPreview, getTopics, now as currentTime } from "./api.js";

// Galaxy: the whole library as a night sky, and where this article sits in it. Every article that has a
// topic is a star, and each topic is a cloud of stars; the clouds lie along the arms of a flat spiral,
// the biggest topics in the core and the smallest out on the arms. The article's neighborhood (what it
// links to, and a step further) is lit as a constellation: bright stars joined by thin lines along its
// links, with the article itself brightest. A neighborhood kept inside one cloud is a tight knot; one
// that reaches across topics throws long lines over the disc. It opens on the whole library and flies
// in. Dragging turns the galaxy and scrolling zooms. Hovering a star names it and clicking one makes it
// the center; over a cloud too small or dense to pick a star from, the whole topic is hovered, and
// clicking flies into it until its stars stand apart. Each named topic has a line on what it is.
// Exploring grows the sky: an opened article's links that weren't stars yet are born out of its star,
// constellations left behind stay softly lit, and the camera pulls back and travels to the next one. Stars and lines are drawn on a canvas in a few batched paths; article labels are elements
// placed nearest first, leaving out any that would land on a nearer one.

const LIBRARY = 568873; // every article on the server; only those with a topic start out as stars
const RADIUS = 9000; // of the disc
const BIRTH = 900; // ms a new star takes to fly out from the article that links to it
const BIRTH_SPREAD = 1300; // ms over which one article's new stars are born
const MAX_BORN = 300; // new stars per article, so a long list article doesn't flood the sky
const ARMS = 3;
const WIND = 4.4; // how far an arm turns from the core to the rim, in radians
const FOCAL = 0.9; // of the stage height
const MIN_DIST = 150;
const MAX_DIST = 70000;
const MAX_LABELS = 34;
const MAX_TOPIC_LABELS = 26;
// Faint stars come in a few brightnesses, each drawn as one path per tint.
const LEVELS = [
  { alpha: 0.24, size: 1 },
  { alpha: 0.42, size: 1.2 },
  { alpha: 0.64, size: 1.5 },
  { alpha: 0.9, size: 2 },
];
const TINTS = [
  [222, 228, 255],
  [190, 208, 255],
  [255, 226, 196],
  [255, 206, 218],
  [198, 238, 232],
  [222, 206, 255],
];
const LIT = [150, 186, 255]; // the constellation's lines and glow
const BORN = [196, 214, 255]; // stars born while exploring, and constellations lit before
const VIEWS = {
  library: { pitch: 1.0, dist: 20000 },
  neighborhood: { pitch: 0.78 },
};

export async function mountGalaxy(root, { id }) {
  root.innerHTML = `
    <div class="gx">
      <div class="gx-stage">
        <canvas class="gx-canvas"></canvas>
        <div class="gx-layer"></div>
      </div>
      <header class="gx-count" aria-live="polite"><b>Mapping the library…</b><span></span><em></em></header>
      <div class="gx-views" role="radiogroup" aria-label="View">
        <button type="button" role="radio" data-gx-view="library" aria-checked="false">Library</button>
        <button type="button" role="radio" data-gx-view="neighborhood" aria-checked="true">Neighborhood</button>
      </div>
      <nav class="gx-trail" aria-label="Articles visited"></nav>
      <div class="gx-tip" role="tooltip"></div>
      <p class="gx-hint">Each star is an article, each cloud a topic · drag to turn · scroll to zoom · click a star to center it, a cloud to fly in</p>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const stage = $(".gx-stage");
  const canvas = $(".gx-canvas");
  const ctx = canvas.getContext("2d");
  const layer = $(".gx-layer");
  const countEl = $(".gx-count");
  const trailEl = $(".gx-trail");
  const tip = $(".gx-tip");
  const viewButtons = $(".gx-views");

  let width = 0;
  let height = 0;
  let sky = null; // the library: every star and every topic cloud
  let lit = null; // the current constellation
  const past = []; // constellations lit before, kept softly lit
  const litTitles = new Set(); // every article lit so far, for the count
  const placed = new Map(); // title → position of every article lit so far
  // Stars born while exploring: articles linked from an opened article that weren't stars yet. Each
  // flies out from that article's star (from) to its place (xyz), starting at t0.
  const born = { count: 0, xyz: new Float32Array(0), from: new Float32Array(0), t0: new Float64Array(0), sx: new Float32Array(0), sy: new Float32Array(0), sz: new Float32Array(0), title: [], parent: [] };
  const trail = [];
  // The camera orbits `pivot` at `dist`; `to` holds where each is heading. It starts far out, above.
  const cam = { pivot: [0, 0, 0], yaw: 0.4, pitch: 1.25, dist: 60000 };
  const to = { pivot: [0, 0, 0], yaw: 0.2, pitch: VIEWS.library.pitch, dist: VIEWS.library.dist };
  let view = "neighborhood";
  let idleSince = performance.now();
  let drag = null;
  let litFade = 0;
  let litFadeTo = 0;
  let hovered = null; // { node } for a lit star, { star } for a faint one, { cloud } for a whole topic
  let hoverKey = "";
  let busy = false;

  new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    width = stage.clientWidth;
    height = stage.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }).observe(stage);

  const topics = await getTopics().catch(() => null);
  if (!topics) {
    countEl.querySelector("b").textContent = "The library could not be loaded.";
    return;
  }
  sky = buildSky(topics);
  countEl.querySelector("b").textContent = `${fmt(sky.count)} articles in ${fmt(sky.clouds.length)} topics`;

  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (root.hidden || !width || !sky) return;
    const ease = (rate) => 1 - Math.pow(rate, dt);
    // Left alone, the galaxy turns slowly.
    if (!drag?.moved && !hovered && !busy && now - idleSince > 4000) to.yaw += dt * 0.025;
    const rate = busy ? 0.05 : 0.18;
    cam.pivot = lerp3(cam.pivot, to.pivot, ease(rate));
    cam.yaw += (to.yaw - cam.yaw) * ease(0.1);
    cam.pitch += (to.pitch - cam.pitch) * ease(0.15);
    // Distance eases in log space, so a long flight in or out keeps an even pace.
    cam.dist = Math.exp(Math.log(cam.dist) + (Math.log(to.dist) - Math.log(cam.dist)) * ease(rate));
    litFade += (litFadeTo - litFade) * ease(0.02);
    draw();
  });

  viewButtons.addEventListener("click", (event) => {
    const b = event.target.closest("[data-gx-view]");
    if (b) setView(b.dataset.gxView);
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      to.dist = clamp(to.dist * Math.exp(event.deltaY * 0.0014), MIN_DIST, MAX_DIST);
      idleSince = performance.now();
      markView(null);
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
    to.pitch = clamp(drag.pitch + dy * 0.004, -1.45, 1.45);
    idleSince = performance.now();
  });
  stage.addEventListener("pointermove", (event) => {
    // The galaxy holds still while the pointer looks for a star.
    idleSince = performance.now();
    if (drag?.moved) return setHover(null);
    const r = stage.getBoundingClientRect();
    hoverAt(event.clientX - r.left, event.clientY - r.top, event.target);
  });
  stage.addEventListener("pointerleave", () => setHover(null));
  stage.addEventListener("click", (event) => {
    if (drag?.moved || busy) return;
    const read = event.target.closest("[data-read]");
    if (read) {
      const url = new URL(location.href);
      url.searchParams.set("id", read.dataset.read);
      url.searchParams.delete("view");
      location.href = url;
      return;
    }
    if (hovered?.cloud) return flyTo(hovered.cloud);
    if (hovered?.born != null) {
      getPreview(born.title[hovered.born])
        .catch(() => null)
        .then((p) => p?.id && go(p.id, { from: "star" }));
      return;
    }
    const target = hovered?.node ?? (hovered?.star != null ? { id: sky.ids[hovered.star] } : null);
    if (target && target !== lit?.center) go(target.id, { from: "star" });
  });
  trailEl.addEventListener("click", (event) => {
    const step = event.target.closest("[data-step]");
    if (!step || busy) return;
    const [target] = trail.splice(Number(step.dataset.step));
    go(target.id, { from: "back" });
  });
  addEventListener("keydown", (event) => {
    if (root.hidden || event.target.closest("input, textarea")) return;
    if ((event.key === "Backspace" || event.key === "Escape") && trail.length > 1 && !busy) {
      trail.pop();
      go(trail.pop().id, { from: "back" });
    }
  });

  // The opening: a moment on the whole library, then into the article's constellation.
  await Promise.all([go(id, { from: "start" }), wait(1400)]);
  if (lit) setView("neighborhood");

  // travel: arriving from another star, the camera mostly moves rather than turns, so the trip reads as
  // a journey across the galaxy instead of a spin around it.
  function setView(name, { travel = false } = {}) {
    if (name === "neighborhood" && !lit) return;
    if (name === "library") Object.assign(to, { pivot: [0, 0, 0], pitch: VIEWS.library.pitch, dist: VIEWS.library.dist });
    else {
      const yaw = towardCore(lit.center.pos);
      const turn = travel ? clamp(yaw - cam.yaw, -0.6, 0.6) : yaw - cam.yaw;
      Object.assign(to, { pivot: aheadOf(lit.center.pos, lit.frame), yaw: cam.yaw + turn, pitch: VIEWS.neighborhood.pitch, dist: lit.frame });
    }
    idleSince = performance.now();
    markView(name);
  }

  // The yaw that looks past the article's star towards the galaxy's core, so the disc fills the view
  // behind it rather than the empty sky beyond the rim.
  function towardCore([x, , z]) {
    return Math.hypot(x, z) < 500 ? to.yaw : nearestAngle(Math.atan2(-x, -z), cam.yaw);
  }

  // A little past the star towards the core, so the star sits low in the view with the disc above it.
  function aheadOf([x, y, z], dist) {
    const r = Math.hypot(x, z);
    if (r < 500) return [x, y, z];
    const step = Math.min(r, dist * 0.18);
    return [x - (x / r) * step, y, z - (z / r) * step];
  }

  // Into a topic's cloud, close enough that its stars stand apart to be pointed at one by one.
  function flyTo(cloud) {
    setHover(null);
    Object.assign(to, { pivot: [...cloud.center], pitch: Math.max(to.pitch, 0.9), dist: clamp(cloud.extent * 3.2, MIN_DIST, MAX_DIST) });
    idleSince = performance.now();
    markView(null);
  }

  function markView(name) {
    view = name;
    for (const b of viewButtons.querySelectorAll("[data-gx-view]")) b.setAttribute("aria-checked", String(b.dataset.gxView === name));
  }

  // Lights an article's constellation. The camera pulls back while the neighborhood loads; the
  // articles it links to that weren't stars yet are born out of its star; then the camera travels to
  // frame the new constellation. The one left behind stays softly lit.
  async function go(nextId, { from }) {
    busy = true;
    setHover(null);
    litFadeTo = 0;
    if (from !== "start") to.dist = clamp(cam.dist * 1.35, 3000, 24000);
    const [built] = await Promise.all([buildLit(nextId), wait(from === "start" ? 0 : 500)]);
    if (!built) {
      busy = false;
      litFadeTo = lit ? 1 : 0;
      return;
    }
    if (lit) {
      lit.nodes.forEach((n) => n.el.remove());
      past.push(lit);
    }
    const again = past.findIndex((c) => c.center.id === nextId);
    if (again >= 0) past.splice(again, 1);
    lit = built;
    litFade = 0;
    litFadeTo = 1;
    for (const n of built.nodes) {
      litTitles.add(n.title);
      placed.set(n.title, n.pos);
    }
    const newStars = bear(built, from === "start" ? 1300 : 0);
    trail.push({ id: nextId, title: built.center.title });
    renderTrail();
    const neighbors = built.nodes.length - 1;
    const lighting = neighbors
      ? `${built.center.title}’s ${fmt(neighbors)} neighbors lit, across ${fmt(built.topicCount)} ${built.topicCount === 1 ? "topic" : "topics"}`
      : `${built.center.title} has no neighbors with a topic`;
    countEl.querySelector("span").textContent = newStars ? `${lighting} · ${fmt(newStars)} new ${newStars === 1 ? "star" : "stars"}` : lighting;
    countEl.querySelector("em").textContent = `You’ve lit ${fmt(litTitles.size)} of ${fmt(LIBRARY)} articles`;
    if (from !== "start") {
      // A moment for the new stars to burst out before the trip.
      await wait(700);
      setView("neighborhood", { travel: true });
    }
    busy = false;
    idleSince = performance.now();
    const url = new URL(location.href);
    url.searchParams.set("id", nextId);
    history.replaceState(null, "", url);
  }

  // New stars for the articles the constellation's article links to that aren't stars yet, placed in a
  // loose flattened shell around its star and born one after another.
  function bear(built, after) {
    const titles = built.linkTitles.filter((t) => !placed.has(t)).slice(0, MAX_BORN);
    if (!titles.length) return 0;
    const n = born.count + titles.length;
    if (n > born.title.length) {
      const grow = (old, size) => {
        const next = new old.constructor(size);
        next.set(old);
        return next;
      };
      const size = Math.max(n, born.title.length * 2);
      for (const key of ["xyz", "from"]) born[key] = grow(born[key], size * 3);
      born.t0 = grow(born.t0, size);
      for (const key of ["sx", "sy", "sz"]) born[key] = grow(born[key], size);
      born.title.length = born.parent.length = size;
    }
    const [cx, cy, cz] = built.center.pos;
    const start = performance.now() + after;
    titles.forEach((title, k) => {
      const i = born.count + k;
      const rand = seeded(hash(title));
      const a = rand() * Math.PI * 2;
      const r = 350 + 1500 * rand() ** 0.8;
      const pos = [cx + Math.cos(a) * r, cy + (rand() - 0.5) * r * 0.5, cz + Math.sin(a) * r];
      born.xyz.set(pos, i * 3);
      born.from.set(built.center.pos, i * 3);
      born.t0[i] = start + (k / titles.length) * BIRTH_SPREAD + rand() * 120;
      born.title[i] = title;
      born.parent[i] = built.center.title;
      placed.set(title, pos);
      litTitles.add(title);
    });
    born.count = n;
    return titles.length;
  }

  function renderTrail() {
    trailEl.innerHTML = trail
      .map((s, k) =>
        k === trail.length - 1
          ? `<span aria-current="page">${esc(s.title)}</span>`
          : `<button type="button" data-step="${k}">${esc(s.title)}</button><i aria-hidden="true">›</i>`,
      )
      .join("");
  }

  // --- Drawing -------------------------------------------------------------------------------

  function draw() {
    const f = height * FOCAL;
    const [fw, rt, up] = cameraBasis(cam.yaw, cam.pitch);
    const eye = sub(cam.pivot, scale(fw, cam.dist));
    const cx = width / 2;
    const cy = height / 2;
    const project = (p) => {
      const dx = p[0] - eye[0];
      const dy = p[1] - eye[1];
      const dz = p[2] - eye[2];
      const z = dx * fw[0] + dy * fw[1] + dz * fw[2];
      return { x: cx + ((dx * rt[0] + dy * rt[1] + dz * rt[2]) * f) / z, y: cy - ((dx * up[0] + dy * up[1] + dz * up[2]) * f) / z, z };
    };

    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";

    // Topic clouds: a soft glow behind each, brighter where the constellation reaches.
    for (const c of sky.clouds) {
      c.p = project(c.center);
      c.px = c.p.z > 50 ? (c.radius * f) / c.p.z : 0;
      if (c.px < 3 || c.count < 3) continue;
      const r = Math.min(c.px * 1.6, 900);
      const glow = (0.035 + Math.min(0.06, c.count / 4000)) * (1 - 0.5 * litFade * (c.lit ? 0 : 1));
      ctx.globalAlpha = glow;
      ctx.drawImage(sky.sprites[c.tint], c.p.x - r, c.p.y - r, r * 2, r * 2);
      if (c.lit || c === hovered?.cloud) {
        ctx.globalAlpha = c === hovered?.cloud ? 0.3 : 0.09 * litFade;
        ctx.drawImage(sky.litSprite, c.p.x - r, c.p.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;

    // Faint stars: projected into the arrays hover reads, and batched into a path per brightness and tint.
    const { xyz, sx, sy, sz, mag, tint } = sky;
    const paths = LEVELS.map(() => TINTS.map(() => new Path2D()));
    const hot = new Path2D(); // the hovered topic's stars
    const hotCloud = hovered?.cloud ? sky.clouds.indexOf(hovered.cloud) : -1;
    const dim = 1 - 0.35 * litFade;
    // In among the clouds, stars grow and brighten so each one can be seen and pointed at.
    const grow = clamp(4000 / cam.dist, 1, 3);
    const boost = Math.log2(grow);
    for (let i = 0; i < sky.count; i++) {
      const dx = xyz[i * 3] - eye[0];
      const dy = xyz[i * 3 + 1] - eye[1];
      const dz = xyz[i * 3 + 2] - eye[2];
      const z = dx * fw[0] + dy * fw[1] + dz * fw[2];
      sz[i] = z;
      if (z < 50) continue;
      const x = cx + ((dx * rt[0] + dy * rt[1] + dz * rt[2]) * f) / z;
      const y = cy - ((dx * up[0] + dy * up[1] + dz * up[2]) * f) / z;
      sx[i] = x;
      sy[i] = y;
      if (x < -4 || y < -4 || x > width + 4 || y > height + 4) continue;
      // Nearer than the pivot is brighter, and some stars are brighter than others anyway.
      const level = Math.min(3, Math.max(0, Math.floor((cam.dist / z) * 1.6 - 0.4 + mag[i] * 1.4 + boost)));
      const isHot = sky.cloudOf[i] === hotCloud;
      const s = (isHot ? Math.max(2, LEVELS[level].size) : LEVELS[level].size) * grow;
      const path = isHot ? hot : paths[level][tint[i]];
      // Tiny squares from afar; up close they would read as squares, so they become dots.
      if (grow < 1.5) path.rect(x - s / 2, y - s / 2, s, s);
      else {
        path.moveTo(x + s / 2, y);
        path.arc(x, y, s / 2, 0, Math.PI * 2);
      }
    }
    LEVELS.forEach((lv, l) =>
      TINTS.forEach((t, k) => {
        ctx.fillStyle = `rgba(${t[0]},${t[1]},${t[2]},${lv.alpha * dim})`;
        ctx.fill(paths[l][k]);
      }),
    );
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill(hot);

    drawBorn(eye, fw, rt, up, f, grow, boost, dim);
    drawPast(project);
    const taken = [];
    if (lit && litFade > 0.01) drawLit(project, f, taken);
    ctx.globalCompositeOperation = "source-over";
    drawTopicLabels(taken);
  }

  // Born stars, batched like the rest; those still flying out are drawn as bright flashes trailing a
  // thin line back to the article they came from.
  function drawBorn(eye, fw, rt, up, f, grow, boost, dim) {
    if (!born.count) return;
    const now = performance.now();
    const cx = width / 2;
    const cy = height / 2;
    const paths = LEVELS.map(() => new Path2D());
    const flash = new Path2D();
    const trails = new Path2D();
    const toScreen = (x, y, z) => {
      const dx = x - eye[0];
      const dy = y - eye[1];
      const dz = z - eye[2];
      const d = dx * fw[0] + dy * fw[1] + dz * fw[2];
      return [cx + ((dx * rt[0] + dy * rt[1] + dz * rt[2]) * f) / d, cy - ((dx * up[0] + dy * up[1] + dz * up[2]) * f) / d, d];
    };
    const { xyz, from } = born;
    for (let i = 0; i < born.count; i++) {
      const t = (now - born.t0[i]) / BIRTH;
      born.sz[i] = -1;
      if (t < 0) continue;
      const k = i * 3;
      let [x, y, z] = [xyz[k], xyz[k + 1], xyz[k + 2]];
      if (t < 1) {
        const e = 1 - (1 - t) ** 3;
        x = from[k] + (x - from[k]) * e;
        y = from[k + 1] + (y - from[k + 1]) * e;
        z = from[k + 2] + (z - from[k + 2]) * e;
      }
      const [sx, sy, d] = toScreen(x, y, z);
      if (d < 50) continue;
      born.sx[i] = sx;
      born.sy[i] = sy;
      born.sz[i] = d;
      if (sx < -4 || sy < -4 || sx > width + 4 || sy > height + 4) continue;
      if (t < 1) {
        const r = (1.2 + 2.4 * (1 - t)) * grow;
        flash.moveTo(sx + r, sy);
        flash.arc(sx, sy, r, 0, Math.PI * 2);
        const [ox, oy, od] = toScreen(from[k], from[k + 1], from[k + 2]);
        if (od > 50) {
          trails.moveTo(ox, oy);
          trails.lineTo(sx, sy);
        }
        continue;
      }
      // Like the topic stars, some born stars are brighter than others.
      const level = Math.min(3, Math.max(0, Math.floor((cam.dist / d) * 1.6 - 0.6 + ((i * 0.618) % 1) ** 3 * 1.4 + boost)));
      const size = LEVELS[level].size * grow;
      if (grow < 1.5) paths[level].rect(sx - size / 2, sy - size / 2, size, size);
      else {
        paths[level].moveTo(sx + size / 2, sy);
        paths[level].arc(sx, sy, size / 2, 0, Math.PI * 2);
      }
    }
    LEVELS.forEach((lv, l) => {
      ctx.fillStyle = rgba(BORN, lv.alpha * dim);
      ctx.fill(paths[l]);
    });
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(LIT, 0.16);
    ctx.stroke(trails);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill(flash);
  }

  // Constellations lit before: their stars and lines kept, softly.
  function drawPast(project) {
    if (!past.length) return;
    const lines = new Path2D();
    const dots = new Path2D();
    for (const c of past) {
      for (const n of c.nodes) n.p = project(n.pos);
      for (const n of c.nodes) {
        if (n.p.z < 50) continue;
        dots.moveTo(n.p.x + 1.6, n.p.y);
        dots.arc(n.p.x, n.p.y, 1.6, 0, Math.PI * 2);
        const from = n.hop === 1 ? c.center : n.parent;
        if (n === c.center || from.p.z < 50) continue;
        lines.moveTo(from.p.x, from.p.y);
        lines.lineTo(n.p.x, n.p.y);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(LIT, 0.07);
    ctx.stroke(lines);
    ctx.fillStyle = rgba(BORN, 0.55);
    ctx.fill(dots);
  }

  function drawLit(project, f, taken) {
    const { center, nodes } = lit;
    for (const n of nodes) n.p = project(n.pos);
    const focus = hovered?.node ?? null;
    const linked = focus ? lit.links.get(focus.id) : null;

    // Lines from the article to each linked article, and from each article a step further to the linked
    // article it is reached through; a hovered star's own links are drawn over them.
    const near = new Path2D();
    const far = new Path2D();
    for (const n of nodes) {
      if (n === center) continue;
      const from = n.hop === 1 ? center : n.parent;
      if (from.p.z < 50 || n.p.z < 50) continue;
      const path = n.hop === 1 ? near : far;
      path.moveTo(from.p.x, from.p.y);
      path.lineTo(n.p.x, n.p.y);
    }
    const quiet = focus ? 0.45 : 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(LIT, 0.3 * litFade * quiet);
    ctx.stroke(near);
    ctx.strokeStyle = rgba(LIT, 0.13 * litFade * quiet);
    ctx.stroke(far);
    if (focus && linked) {
      const own = new Path2D();
      for (const n of nodes) {
        if (!linked.has(n.id) || n.p.z < 50 || focus.p.z < 50) continue;
        own.moveTo(focus.p.x, focus.p.y);
        own.lineTo(n.p.x, n.p.y);
      }
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = rgba(LIT, 0.75 * litFade);
      ctx.stroke(own);
    }

    // The lit stars, far to near, each with a small halo; the article has the biggest.
    const order = [...nodes].sort((a, b) => b.p.z - a.p.z);
    for (const n of order) {
      if (n.p.z < 50) continue;
      const near = Math.min(1.6, Math.max(0.7, Math.sqrt(cam.dist / n.p.z)));
      const on = !focus || n === focus || linked?.has(n.id) || n === center;
      const a = litFade * (on ? 1 : 0.4);
      const halo = (n === center ? 46 : 9 + n.r * 2.2) * near;
      ctx.globalAlpha = a * (n === center ? 0.9 : 0.55);
      ctx.drawImage(sky.litSprite, n.p.x - halo, n.p.y - halo, halo * 2, halo * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(n.p.x, n.p.y, (n === center ? 4 : 1 + n.r * 0.45) * near, 0, Math.PI * 2);
      ctx.fill();
    }
    if (center.p.z > 50) {
      ctx.strokeStyle = rgba(LIT, 0.5 * litFade);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(center.p.x, center.p.y, 13, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Labels: the article's own first, then the others nearest first, near the camera only; a label
    // that would land on a nearer one is left out.
    // From far out only the article and the closest few are named.
    const cap = Math.round(MAX_LABELS * (1 - 0.8 * smoothstep(10000, 16000, cam.dist)));
    let shown = 0;
    for (const n of [center, ...[...order].reverse().filter((n) => n !== center)]) {
      const el = n.el;
      if (n.p.z < 50) {
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        continue;
      }
      if (n === center) {
        const box = { x: n.p.x - n.w / 2, y: n.p.y + 20, w: n.w, h: n.h };
        el.style.transform = `translate(${box.x}px, ${box.y}px)`;
        el.style.opacity = litFade.toFixed(3);
        el.style.pointerEvents = litFade > 0.5 ? "auto" : "none";
        taken.push(box, { x: n.p.x - 16, y: n.p.y - 16, w: 32, h: 32 });
        continue;
      }
      const isLinked = n === focus || linked?.has(n.id);
      const box = { x: n.p.x + 8, y: n.p.y - 8, w: n.w, h: 16 };
      const nearCam = 1 - smoothstep(cam.dist * 0.9, cam.dist * 1.6, n.p.z);
      const onScreen = box.x > -box.w && box.x < width && box.y > -16 && box.y < height;
      const room = onScreen && (n === focus || (shown < cap && nearCam > 0.15)) && free(taken, box);
      const a = room ? litFade * Math.max(nearCam, n === focus ? 1 : 0) * (n.hop === 1 ? 1 : 0.8) * (focus && !isLinked ? 0.35 : 1) : 0;
      el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      el.style.opacity = a.toFixed(3);
      el.style.pointerEvents = a > 0.2 ? "auto" : "none";
      if (a > 0.05) {
        taken.push(box);
        shown++;
      }
    }
  }

  // Topic names float at the middle of their clouds, each with a short line on what the topic is and
  // its size: every topic from far out, the topics the neighborhood reaches a little closer, and again
  // every topic once the camera is in among the clouds. A hovered topic is named first, then the reached
  // ones, then the biggest; a name that would land on another label is left out.
  function drawTopicLabels(taken) {
    const reached = smoothstep(4500, 8000, cam.dist) * litFade;
    const far = smoothstep(10000, 15000, cam.dist);
    const close = 1 - smoothstep(2500, 4500, cam.dist);
    const shownAs = (c) => (c === hovered?.cloud ? 1 : Math.max(far, c.count >= 3 ? close : 0, c.lit ? reached : 0));
    const order = sky.clouds
      .filter((c) => shownAs(c) > 0.02 && c.p.z > 50 && c.px > 8 && c.p.x > 0 && c.p.x < width && c.p.y > 70 && c.p.y < height)
      .sort((a, b) => (b === hovered?.cloud) - (a === hovered?.cloud) || (b.lit - a.lit) * litFade || b.count - a.count);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let shown = 0;
    for (const c of order) {
      if (shown >= MAX_TOPIC_LABELS) break;
      const out = shownAs(c);
      const strong = c === hovered?.cloud || (c.lit && litFade > 0.5);
      const line = shortLine(c);
      ctx.letterSpacing = "0.6px";
      ctx.font = "500 10px Inter, system-ui, sans-serif";
      c.caps ??= c.name.toUpperCase();
      c.w ??= ctx.measureText(c.caps).width;
      ctx.letterSpacing = "0px";
      ctx.font = "italic 400 11.5px 'Source Serif 4', Georgia, serif";
      if (c.lineFor !== line) [c.lineFor, c.lineW] = [line, ctx.measureText(line).width];
      const w = Math.max(c.w, c.lineW);
      // Just above the cloud's middle, so the name doesn't sit on its brightest stars.
      const y = c.p.y - Math.min(c.px * 0.35, 22);
      const box = { x: c.p.x - w / 2 - 4, y: y - 9, w: w + 8, h: 33 };
      if (!free(taken, box)) continue;
      taken.push(box);
      shown++;
      ctx.fillStyle = `rgba(214,220,236,${(strong ? 0.5 : 0.32) * out})`;
      ctx.fillText(line, c.p.x, y + 15);
      ctx.letterSpacing = "0.6px";
      ctx.font = "500 10px Inter, system-ui, sans-serif";
      ctx.fillStyle = strong ? `rgba(255,255,255,${0.75 * out})` : `rgba(214,220,236,${0.42 * out})`;
      ctx.fillText(c.caps, c.p.x, y);
    }
    ctx.letterSpacing = "0px";
  }

  // What a topic is, in a few words, and its size. Topics are often articles' titles too, so the line
  // is the start of that article; it is asked for the first time the topic is named.
  function shortLine(c) {
    const size = `${fmt(c.count)} ${c.count === 1 ? "article" : "articles"}`;
    describe(c);
    return c.sentence ? `${clip(c.sentence, 64)} · ${size}` : size;
  }

  function describe(c) {
    c.described ??= getPreview(c.name)
      .then((p) => (c.sentence = firstSentence(p?.extract)))
      .catch(() => (c.sentence = ""));
    return c.described;
  }

  // --- Hover ---------------------------------------------------------------------------------

  function hoverAt(x, y, target) {
    const el = target.closest?.("[data-node]");
    if (el && lit) return setHover({ node: lit.byId.get(Number(el.dataset.node)) }, x, y);
    // A lit star near the pointer wins over a faint one under it.
    if (lit && litFade > 0.5) {
      let best = null;
      let bestD = 14;
      for (const n of lit.nodes) {
        if (n.p.z < 50) continue;
        const d = Math.hypot(n.p.x - x, n.p.y - y);
        if (d < bestD) [best, bestD] = [n, d];
      }
      if (best) return setHover({ node: best }, x, y);
    }
    // A star right under the pointer; else the topic whose cloud it is over, while that cloud is still
    // small or dense on screen; else the nearest star within reach.
    let best = null;
    let bestD = 14;
    for (let i = 0; i < sky.count; i++) {
      if (sky.sz[i] < 50) continue;
      const d = Math.hypot(sky.sx[i] - x, sky.sy[i] - y);
      if (d < bestD) [best, bestD] = [{ star: i }, d];
    }
    for (let i = 0; i < born.count; i++) {
      if (born.sz[i] < 50) continue;
      const d = Math.hypot(born.sx[i] - x, born.sy[i] - y);
      if (d < bestD) [best, bestD] = [{ born: i }, d];
    }
    if (best && bestD <= 6) return setHover(best, x, y);
    const f = height * FOCAL;
    let cloud = null;
    let closest = 1;
    for (const c of sky.clouds) {
      if (c.p.z < 50) continue;
      const reach = (c.extent * f) / c.p.z;
      if (reach < 3 || (reach > 160 && c.count / (Math.PI * reach * reach) < 1 / 300)) continue;
      const d = Math.hypot(c.p.x - x, c.p.y - y) / (reach + 6);
      if (d < closest) [cloud, closest] = [c, d];
    }
    if (cloud) return setHover({ cloud }, x, y);
    setHover(best, x, y);
  }

  async function setHover(h, x, y) {
    const key = h?.node ? `n${h.node.id}` : h?.cloud ? `c${h.cloud.name}` : h?.born != null ? `b${h.born}` : h ? `s${h.star}` : "";
    if (key !== hoverKey) {
      hoverKey = key;
      hovered?.node?.el.classList.remove("is-hovered");
      hovered = h;
      h?.node?.el.classList.add("is-hovered");
      stage.classList.toggle("is-pointing", !!h && h.node !== lit?.center);
    }
    if (!h || h.node === lit?.center) {
      tip.classList.remove("is-shown");
      tip.dataset.key = "";
      return;
    }
    tip.style.transform = `translate(${Math.min(x + 18, width - 290)}px, ${Math.min(y + 18, height - 200)}px)`;
    tip.classList.add("is-shown");
    if (tip.dataset.key === key) return;
    tip.dataset.key = key;
    if (h.cloud) {
      tip.innerHTML = cloudTipHtml(h.cloud);
      if (h.cloud.sentence === undefined) {
        await describe(h.cloud);
        if (tip.dataset.key === key) tip.innerHTML = cloudTipHtml(h.cloud);
      }
    } else if (h.born != null) {
      const title = born.title[h.born];
      const how = `Linked from ${esc(born.parent[h.born])}`;
      tip.innerHTML = `<b>${esc(title)}</b><span>${how}</span>`;
      const p = await getPreview(title).catch(() => null);
      if (tip.dataset.key !== key) return;
      const extract = p?.extract ? clip(p.extract.replace(/<[^>]+>/g, ""), 150) : "";
      tip.innerHTML = `${p?.thumbnail ? `<img src="${p.thumbnail.url}" alt="" />` : ""}
        <b>${esc(title)}</b><span>${how} · ${p ? "click to light its neighborhood" : "not in the library"}</span>
        ${extract ? `<p>${extract}</p>` : ""}`;
    } else if (h.node) {
      const n = h.node;
      tip.innerHTML = litTipHtml(n, null);
      const p = await lit.preview(n.title);
      if (tip.dataset.key === key) tip.innerHTML = litTipHtml(n, p);
    } else {
      const topic = sky.clouds[sky.cloudOf[h.star]].name;
      tip.innerHTML = `<b class="is-pending">…</b><span>${esc(topic)}</span>`;
      const [article] = (await getArticles(sky.ids[h.star]).catch(() => null)) ?? [];
      if (tip.dataset.key === key) tip.innerHTML = `<b>${esc(article?.title ?? "Untitled")}</b><span>${esc(topic)} · click to light its neighborhood</span>`;
    }
  }

  function cloudTipHtml(c) {
    const here = lit ? lit.nodes.filter((n) => n.topic === c.name) : [];
    const names = here.slice(0, 4).map((n) => esc(n.title)).join(", ");
    return `<b>${esc(c.name)}</b>
      <span>${fmt(c.count)} ${c.count === 1 ? "article" : "articles"}${lit ? ` · ${here.length} in ${esc(lit.center.title)}’s neighborhood` : ""}</span>
      ${c.sentence ? `<p>${esc(c.sentence)}</p>` : ""}
      ${names ? `<p class="gx-tip-lit">${names}${here.length > 4 ? "…" : ""}</p>` : ""}
      <span class="gx-tip-act">Click to fly in</span>`;
  }

  function litTipHtml(n, p) {
    const how = n.hop === 1 ? `Linked from ${esc(lit.center.title)}` : `A step further, through ${esc(n.parent.title)}`;
    const extract = p?.extract ? clip(p.extract.replace(/<[^>]+>/g, ""), 150) : "";
    return `${p?.thumbnail ? `<img src="${p.thumbnail.url}" alt="" />` : ""}
      <b>${esc(n.title)}</b><span>${esc(n.topic ?? "No topic")} · ${how}</span>
      ${extract ? `<p>${extract}</p>` : ""}`;
  }

  // --- Layout --------------------------------------------------------------------------------

  // The library as stars. Topics are laid out biggest first from the core outwards, along the arms of a
  // spiral; each topic's articles are a soft, flattened cloud around its place. Everything is seeded, so
  // the galaxy is the same on every visit.
  function buildSky(topicOf) {
    const byTopic = new Map();
    for (const [page, topic] of Object.entries(topicOf)) {
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic).push(Number(page));
    }
    // The biggest topic is the core; the rest take turns along the arms in a seeded order, each placed
    // by how many stars lie inward of it, so the disc thins out evenly towards the rim.
    const bySize = [...byTopic.keys()].sort((a, b) => byTopic.get(b).length - byTopic.get(a).length || a.localeCompare(b));
    const names = [bySize[0], ...bySize.slice(1).sort((a, b) => hash(a) - hash(b) || a.localeCompare(b))];
    const count = Object.keys(topicOf).length;
    const outer = count - byTopic.get(names[0]).length;
    const xyz = new Float32Array(count * 3);
    const ids = new Int32Array(count);
    const cloudOf = new Uint16Array(count);
    const tint = new Uint8Array(count);
    const mag = new Float32Array(count);
    const byId = new Map();
    const clouds = [];
    let inward = 0;
    names.forEach((name, k) => {
      const members = byTopic.get(name).sort((a, b) => a - b);
      const rand = seeded(hash(name));
      const radius = 25 + 16 * Math.sqrt(members.length);
      let center = [0, 0, 0];
      if (k > 0) {
        const s = (0.03 + (0.97 * (inward + members.length / 2)) / outer) ** 0.62;
        inward += members.length;
        const r = RADIUS * s * (0.94 + rand() * 0.12);
        const a = ((k % ARMS) / ARMS) * Math.PI * 2 + s * WIND + (rand() - 0.5) * 0.38;
        center = [Math.cos(a) * r, (rand() - 0.5) * 360 * (1 - s), Math.sin(a) * r];
      }
      // extent: how far out most of its stars lie, which is what hovering and framing go by.
      clouds.push({ name, members, count: members.length, center, radius, extent: radius * 0.75, tint: hash(name) % TINTS.length, lit: false });
    });
    separate(clouds);
    let i = 0;
    clouds.forEach((cloud, k) => {
      const { center, radius } = cloud;
      for (const page of cloud.members) {
        const pr = seeded(page * 7 + 3);
        const g = () => (pr() + pr() + pr() - 1.5) * 1.2;
        xyz[i * 3] = center[0] + g() * radius * 0.55;
        xyz[i * 3 + 1] = center[1] + g() * radius * 0.22;
        xyz[i * 3 + 2] = center[2] + g() * radius * 0.55;
        ids[i] = page;
        cloudOf[i] = k;
        tint[i] = cloud.tint;
        mag[i] = pr() ** 3;
        byId.set(page, i);
        i++;
      }
    });
    const cloudByName = new Map(clouds.map((c) => [c.name, c]));
    return {
      count,
      xyz,
      ids,
      cloudOf,
      tint,
      mag,
      byId,
      clouds,
      cloudByName,
      sx: new Float32Array(count),
      sy: new Float32Array(count),
      sz: new Float32Array(count),
      pos: (k) => [xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 2]],
      sprites: TINTS.map((t) => glowSprite(t)),
      litSprite: glowSprite(LIT),
    };
  }

  // Clouds that overlap are pushed apart across the disc, the core staying put, so that each can be
  // pointed at on its own.
  function separate(clouds) {
    for (let round = 0; round < 30; round++) {
      let moved = false;
      for (let a = 0; a < clouds.length; a++) {
        const A = clouds[a];
        for (let b = a + 1; b < clouds.length; b++) {
          const B = clouds[b];
          const dx = B.center[0] - A.center[0];
          const dz = B.center[2] - A.center[2];
          const need = A.extent + B.extent + 50;
          if (Math.abs(dx) >= need || Math.abs(dz) >= need) continue;
          const d = Math.hypot(dx, dz) || 1;
          if (d >= need) continue;
          const push = (need - d) / 2;
          const ux = dx / d;
          const uz = dz / d;
          if (a > 0) {
            A.center[0] -= ux * push;
            A.center[2] -= uz * push;
          }
          B.center[0] += ux * push * (a ? 1 : 2);
          B.center[2] += uz * push * (a ? 1 : 2);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // The article's neighborhood, each article at its own star. One without a topic sits near the article.
  async function buildLit(centerId) {
    const [graph, article] = await Promise.all([
      getGraph(currentTime(), centerId).catch(() => null),
      getArticle(centerId, currentTime()).catch(() => null),
    ]);
    const self = graph?.nodes.find((n) => n.id === centerId);
    if (!self) return null;
    const links = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    for (const e of graph.edges) {
      links.get(e.source)?.add(e.target);
      links.get(e.target)?.add(e.source);
    }
    const linked = links.get(centerId);
    const maxChars = Math.log10(1 + Math.max(...graph.nodes.map((n) => n.chars ?? 0)));
    const at = (n) => {
      const k = sky.byId.get(n.id);
      if (k != null) return sky.pos(k);
      // An article without a topic that was born as a star earlier keeps that star.
      if (placed.has(n.title)) return placed.get(n.title);
      const rand = seeded(n.id * 31);
      const base = n.id === centerId ? sky.cloudByName.get(n.topic)?.center ?? [0, 0, 0] : centerPos;
      return [base[0] + (rand() - 0.5) * 600, base[1] + (rand() - 0.5) * 200, base[2] + (rand() - 0.5) * 600];
    };
    const centerPos = at(self);
    const nodes = graph.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      topic: n.topic,
      hop: n.id === centerId ? 0 : linked.has(n.id) ? 1 : 2,
      r: 1 + 4 * (Math.log10(1 + (n.chars ?? 0)) / maxChars),
      pos: n.id === centerId ? centerPos : at(n),
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const center = byId.get(centerId);
    const degree = (n) => links.get(n.id).size;
    for (const n of nodes) {
      if (n.hop !== 2) continue;
      const via = [...links.get(n.id)].map((m) => byId.get(m)).filter((m) => m?.hop === 1);
      n.parent = via.sort((a, b) => degree(b) - degree(a))[0] ?? center;
    }
    for (const c of sky.clouds) c.lit = false;
    const reached = new Set(nodes.map((n) => n.topic).filter(Boolean));
    for (const t of reached) {
      const c = sky.cloudByName.get(t);
      if (c) c.lit = true;
    }

    const previews = new Map();
    const preview = (title) => {
      if (!previews.has(title)) previews.set(title, getPreview(title).catch(() => null));
      return previews.get(title);
    };
    for (const n of nodes) {
      n.el = makeLabel(n, linked.size, nodes.length - 1 - linked.size);
      layer.append(n.el);
      n.w = n.el.offsetWidth;
      n.h = n.el.offsetHeight;
    }
    // Framed so that most of the neighborhood is in view; the farthest few may run off the edge.
    const spread = nodes.map((n) => Math.hypot(...sub(n.pos, centerPos))).sort((a, b) => a - b);
    const frame = clamp(spread[Math.floor(spread.length * 0.5)] * 1.1, 4000, 9000);
    const inGraph = new Set(nodes.map((n) => n.title));
    const linkTitles = linkedTitles(article?.version?.text ?? "").filter((t) => !inGraph.has(t));
    return { center, nodes, byId, links, preview, frame, topicCount: reached.size, linkTitles };
  }

  function makeLabel(n, linkCount, farCount) {
    const el = document.createElement("span");
    el.dataset.node = String(n.id);
    if (n.hop === 0) {
      el.className = "gx-center";
      el.innerHTML = `<b>${esc(n.title)}</b>
        <span>${n.topic && n.topic !== n.title ? `${esc(n.topic)} · ` : ""}${linkCount} linked · ${farCount} a step further</span>
        <span class="gx-read" data-read="${n.id}">Read article →</span>`;
    } else {
      el.className = `gx-label${n.hop === 2 ? " is-far" : ""}`;
      el.textContent = n.title;
    }
    return el;
  }
}

// A soft round glow in one color, drawn once and stamped wherever a cloud or lit star needs one.
function glowSprite([r, g, b]) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.25, `rgba(${r},${g},${b},0.45)`);
  grad.addColorStop(0.6, `rgba(${r},${g},${b},0.1)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grad;
  x.fillRect(0, 0, 64, 64);
  return c;
}

// The angle equal to `angle` (mod 2π) that is closest to `from`, so turning takes the short way round.
function nearestAngle(angle, from) {
  return angle + Math.round((from - angle) / (Math.PI * 2)) * Math.PI * 2;
}

function cameraBasis(yaw, pitch) {
  const f = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch) * -1, Math.cos(pitch) * Math.cos(yaw)];
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return [f, r, u];
}

const free = (taken, box) => !taken.some((t) => box.x < t.x + t.w && box.x + box.w > t.x && box.y < t.y + t.h && box.y + box.h > t.y);
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmt = (n) => n.toLocaleString("en-US");

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
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

// The articles a wikitext links to, by title: [[Target]] and [[Target|text]], without sections and
// without links into other namespaces or languages such as [[Tiedosto:…]] or [[de:…]].
function linkedTitles(text) {
  const titles = new Set();
  for (const [, target] of text.matchAll(/\[\[([^\[\]|#]+)/g)) {
    const title = target.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    if (!title || /^[^ :]+:/.test(title)) continue;
    titles.add(title[0].toUpperCase() + title.slice(1));
  }
  return [...titles];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The first sentence of a preview's extract, as plain text. A full stop after a number or a short
// abbreviation doesn't end it, and neither does one that isn't followed by a capital.
const decoder = document.createElement("div");
function firstSentence(extract) {
  if (!extract) return "";
  decoder.innerHTML = extract;
  // Asides in brackets (other languages' names, dates) are left out of so short a line.
  const text = decoder.textContent.replace(/\s*\([^)]*\)/g, "").trim();
  return text.match(/^.+?[^\s.\d]{4}[.!?](?=\s+[A-ZÅÄÖ0-9]|$)/u)?.[0] ?? clip(text, 160);
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
