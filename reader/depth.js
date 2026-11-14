import { getGraph, getPreview, now as currentTime } from "./api.js";

// Depth: Explore's map of an article's neighborhood built as a cone you can turn. The article is at the
// tip; behind it stand rings, each wider and further back: the closest links, the rest of the linked
// articles, and the articles a step further. Each topic keeps its direction around the cone, so it runs
// as a slice through every ring. Seen from the front it reads like Explore; turned, the rings show how
// close each article is. Dragging turns the cone, scrolling zooms, and clicking an article flies into
// its own cone. Labels are placed nearest first and a label that would land on a card or a nearer label
// is left out. Lines, rings and dots are drawn on a canvas; cards and labels are elements moved each frame.

const MAX_NEAR = 60;
const MAX_FURTHER = 70;
const MAX_CARDS = 10;
const CLOSEST = 12; // linked articles in the first ring
const FOCAL = 0.9; // of the stage height
const REF_H = 900; // stage height the card sizes are designed for
const CARD_AT = 2000; // distance at which a card shows at its natural size
// The rings: their depth behind the article, their radius, and their name.
const RINGS = [
  { key: 1, z: 700, r: 980, name: "Closest" },
  { key: 2, z: 1500, r: 1380, name: "Linked" },
  { key: 3, z: 2600, r: 1780, name: "A step further" },
];
const PIVOT = [0, 0, 1300]; // the cone turns around its middle
// Views: turned for yaw, tilted for pitch, from dist away.
const VIEWS = {
  front: { yaw: 0, pitch: 0, dist: 3300 },
  angle: { yaw: -0.62, pitch: 0.3, dist: 3500 },
  side: { yaw: -1.45, pitch: 0.12, dist: 3700 },
};

export async function mountDepth(root, { id }) {
  root.innerHTML = `
    <div class="dp-stage">
      <canvas class="dp-canvas"></canvas>
      <div class="dp-layer"></div>
    </div>
    <div class="dp-views" role="radiogroup" aria-label="View">
      <button type="button" role="radio" data-view-angle="front" aria-checked="false">Front</button>
      <button type="button" role="radio" data-view-angle="angle" aria-checked="true">Angle</button>
      <button type="button" role="radio" data-view-angle="side" aria-checked="false">Side</button>
    </div>
    <nav class="dp-trail" aria-label="Articles visited"></nav>
    <button class="dp-back" type="button" title="Back (Ctrl+Z / ⌘Z)" hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>Back<kbd aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl Z"}</kbd>
    </button>
    <div class="dp-tip" role="tooltip"></div>
    <p class="dp-hint">Closer rings are more connected · drag to turn · scroll to zoom · click an article to fly into it</p>`;

  const $ = (s) => root.querySelector(s);
  const stage = $(".dp-stage");
  const canvas = $(".dp-canvas");
  const ctx = canvas.getContext("2d");
  const layer = $(".dp-layer");
  const trailEl = $(".dp-trail");
  const tip = $(".dp-tip");
  const viewButtons = $(".dp-views");
  const backButton = $(".dp-back");

  let width = 0;
  let height = 0;
  let scene = null;
  const trail = [];
  // The camera orbits `pivot` at `dist`; `to` holds where each is heading.
  const cam = { pivot: [...PIVOT], yaw: VIEWS.angle.yaw, pitch: VIEWS.angle.pitch, dist: VIEWS.angle.dist };
  const to = { pivot: [...PIVOT], yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist };
  let view = "angle";
  let idleSince = performance.now();
  let drag = null;
  let fade = 0; // the whole view fades in once, on opening
  let hovered = null;
  let busy = false;
  let leaving = []; // articles of the previous cone that aren't in this one, fading out

  new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    width = stage.clientWidth;
    height = stage.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }).observe(stage);

  await go(id, { from: "start" });

  viewButtons.addEventListener("click", (event) => {
    const b = event.target.closest("[data-view-angle]");
    if (b) setView(b.dataset.viewAngle);
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      to.dist = Math.max(1200, Math.min(6500, to.dist * Math.exp(event.deltaY * 0.0012)));
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
    to.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + dy * 0.004));
    idleSince = performance.now();
    markView(null);
  });
  stage.addEventListener("pointermove", (event) => {
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
    // An earlier article on the path is a step back; any other flies on into it.
    if (hovered && hovered !== scene.center) go(hovered.id, { from: hovered.step ? "back" : hovered });
  });
  trailEl.addEventListener("click", (event) => {
    const step = event.target.closest("[data-step]");
    if (!step || busy) return;
    go(trail[Number(step.dataset.step)].id, { from: "back" });
  });
  // Back to the previous article: the button, ⌘Z or Ctrl Z as in Explore, Backspace or Escape.
  backButton.addEventListener("click", back);
  addEventListener("keydown", (event) => {
    if (root.hidden || event.target.closest("input, textarea, [contenteditable]")) return;
    const undo = event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
    if (!undo && event.key !== "Backspace" && event.key !== "Escape") return;
    if (trail.length < 2) return;
    event.preventDefault();
    back();
  });

  function back() {
    if (trail.length > 1 && !busy) go(trail.at(-2).id, { from: "back" });
  }

  function setView(name) {
    view = name;
    Object.assign(to, { yaw: nearestAngle(VIEWS[name].yaw, cam.yaw), pitch: VIEWS[name].pitch, dist: VIEWS[name].dist });
    idleSince = performance.now();
    markView(name);
  }

  function markView(name) {
    if (name === null && view === null) return;
    view = name;
    for (const b of viewButtons.querySelectorAll("[data-view-angle]")) b.setAttribute("aria-checked", String(b.dataset.viewAngle === name));
  }

  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (root.hidden || !width || !scene) return;
    const ease = (rate) => 1 - Math.pow(rate, dt);
    // Left alone in the angled view, the cone sways gently so its rings keep showing their depth.
    if (view === "angle" && !drag?.moved && !hovered && !busy && now - idleSince > 2500) {
      to.yaw = VIEWS.angle.yaw + Math.sin((now - idleSince - 2500) / 6000) * 0.35;
    }
    const rate = busy ? 0.0008 : 0.012;
    cam.pivot = lerp3(cam.pivot, to.pivot, ease(rate));
    cam.yaw += (to.yaw - cam.yaw) * ease(rate);
    cam.pitch += (to.pitch - cam.pitch) * ease(rate);
    cam.dist += (to.dist - cam.dist) * ease(rate);
    fade += (1 - fade) * ease(0.004);
    scene.rings += (1 - scene.rings) * ease(0.08);
    for (const n of scene.nodes) {
      n.pos = lerp3(n.pos, n.target, ease(0.02 + n.delay));
      n.show += (1 - n.show) * ease(0.03 + n.delay);
    }
    // Articles that aren't in the new neighborhood drift outward as they fade.
    for (const n of leaving) {
      n.pos = scale(n.pos, 1 + dt * 0.5);
      n.show -= dt * 2;
    }
    leaving = leaving.filter((n) => n.show > 0 || (n.el.remove(), false));
    draw();
  });

  // Opens an article's cone. The camera heads for the article while its neighborhood loads; then the old
  // cone is shifted so that article sits where the new middle is, and the two hand over in place: articles
  // in both glide to their new spots, the article's small card turns into the middle card, and the rest
  // fade out while the new ones open out from the middle. Going back works the same way.
  async function go(nextId, { from }) {
    busy = true;
    setHover(null);
    const anchor = scene?.byId.get(nextId)?.pos ?? [0, 0, 0];
    if (scene) Object.assign(to, { pivot: anchor, dist: Math.max(900, cam.dist * 0.6) });
    const built = await build(nextId);
    if (!built) {
      busy = false;
      Object.assign(to, { pivot: [...PIVOT], dist: VIEWS[view ?? "angle"].dist });
      return;
    }
    if (from === "back") {
      while (trail.length && trail.at(-1).id !== nextId) trail.pop();
      trail.pop();
    }
    trail.push({ id: nextId, title: built.center.title });
    addPath(built, trail.slice(0, -1));
    if (scene) handOver(scene, built, anchor);
    scene = built;
    renderTrail();
    const v = VIEWS[view ?? "angle"];
    Object.assign(to, { pivot: [...PIVOT], dist: v.dist });
    if (view) Object.assign(to, { yaw: nearestAngle(v.yaw, cam.yaw), pitch: v.pitch });
    busy = false;
    idleSince = performance.now();
    const url = new URL(location.href);
    url.searchParams.set("id", nextId);
    history.replaceState(null, "", url);
  }

  function handOver(old, next, anchor) {
    const shift = (p) => sub(p, anchor);
    cam.pivot = shift(cam.pivot);
    for (const n of leaving) n.pos = shift(n.pos);
    const before = new Map(old.nodes.map((n) => [n.id, n]));
    for (const n of next.nodes) {
      const was = before.get(n.id);
      if (!was) continue;
      before.delete(n.id);
      n.pos = shift(was.pos);
      // The same kind of element simply carries on; a card that changes role crossfades.
      if (was.card === n.card && was !== old.center && n !== next.center) {
        n.show = was.show;
        was.el.remove();
      } else {
        was.pos = n.pos;
        leaving.push(was);
      }
    }
    for (const n of before.values()) {
      n.pos = shift(n.pos);
      leaving.push(n);
    }
    next.rings = 0;
  }

  // The articles walked through to get here stay in view, joined to the middle by the path taken, as in
  // Explore. One that is in this neighborhood is marked where it stands; one that isn't stands beside the
  // tip of the cone, older steps further out.
  function addPath(next, past) {
    next.path = [];
    past
      .slice()
      .reverse()
      .forEach((s, i) => {
        let n = next.byId.get(s.id);
        if (!n) {
          n = { id: s.id, title: s.title, r: 4.5, hop: 2, card: false, target: [-620 - 320 * i, -300 - 110 * i, -420 - 300 * i] };
          n.el = makeEl(n, null, 0);
          layer.append(n.el);
          n.w = n.el.offsetWidth;
          n.h = n.el.offsetHeight;
          n.el.style.opacity = "0";
          n.pos = scale(n.target, 0.3);
          n.show = 0;
          n.delay = 0;
          next.nodes.push(n);
          next.byId.set(n.id, n);
        }
        n.step = i + 1;
        n.el.classList.add("is-path");
        next.path.push(n);
      });
  }

  function renderTrail() {
    backButton.hidden = trail.length < 2;
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
    const project = (p) => {
      const d = sub(p, eye);
      const z = dot(d, fw);
      return { x: width / 2 + (dot(d, rt) * f) / z, y: height / 2 - (dot(d, up) * f) / z, z, s: (height / REF_H) * (CARD_AT / z) };
    };
    // Things fade very close to the camera and far from it.
    const seen = (z) => Math.min(1, Math.max(0, (z - 80) / 300)) * (1 - 0.65 * smoothstep(cam.dist, cam.dist + 2600, z));
    const line = (a, b, style, lineWidth = 1) => {
      if (a.z < 60 || b.z < 60) return;
      ctx.strokeStyle = style;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };

    const shown = [...scene.nodes, ...leaving];
    for (const n of shown) {
      n.p = project(n.pos);
      n.alpha = n.p.z > 40 ? seen(n.p.z) * fade * Math.max(0, n.show) : 0;
    }
    const center = scene.center;
    const focus = hovered;
    const linked = focus ? scene.links.get(focus.id) : null;

    ctx.clearRect(0, 0, width, height);

    // The rings, each with its name and count where it is nearest the top left.
    ctx.textAlign = "left";
    for (const ring of RINGS) {
      const count = scene.counts[ring.key];
      if (!count) continue;
      const pts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(project([Math.cos(a) * ring.r, Math.sin(a) * ring.r, ring.z]));
      }
      if (pts.some((p) => p.z < 60)) continue;
      ctx.strokeStyle = `rgba(32,33,34,${0.14 * fade * scene.rings})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
      // The name sits above the ring's highest point on screen.
      const top = pts.reduce((a, b) => (b.y < a.y ? b : a));
      ctx.font = `600 11px Inter, system-ui, sans-serif`;
      const text = `${ring.name.toUpperCase()} · ${count}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = `rgba(246,246,247,${0.85 * fade * scene.rings})`;
      ctx.fillRect(top.x - tw / 2 - 6, top.y - 24, tw + 12, 16);
      ctx.fillStyle = `rgba(32,33,34,${0.55 * fade * scene.rings})`;
      ctx.textAlign = "center";
      ctx.fillText(text, top.x, top.y - 12);
      ctx.textAlign = "left";
    }
    // The cone's axis, from the article back through the rings.
    line(center.p, project([0, 0, RINGS.at(-1).z]), `rgba(32,33,34,${0.12 * fade * scene.rings})`);

    // Lines from the article to each linked article, and from each article a step further to the
    // linked article it is reached through.
    for (const n of scene.nodes) {
      if (n === center || n.alpha < 0.01) continue;
      const from = n.hop === 1 ? center : n.parent;
      if (!from) continue;
      const lit = focus && (n === focus || from === focus);
      const a = Math.min(n.alpha, from.alpha || n.alpha) * (lit ? 0.7 : n.hop === 1 ? 0.15 : 0.08) * (focus && !lit ? 0.5 : 1);
      line(from.p, n.p, lit ? `rgba(51,102,204,${a})` : `rgba(32,33,34,${a})`, lit ? 1.4 : 1);
    }
    // The path walked to get here, from the middle back through each earlier article.
    let prev = center;
    for (const n of scene.path) {
      line(prev.p, n.p, `rgba(32,33,34,${0.6 * Math.min(prev.alpha || 1, n.alpha)})`, 2);
      prev = n;
    }
    // A hovered article's links to the others in the cone, across the rings.
    if (focus && linked) {
      for (const n of scene.nodes) {
        if (n === focus || n === center || !linked.has(n.id) || n.alpha < 0.01) continue;
        line(focus.p, n.p, `rgba(51,102,204,${0.3 * Math.min(n.alpha, focus.alpha)})`);
      }
    }

    // Dots, far to near.
    const order = shown.sort((a, b) => b.p.z - a.p.z);
    for (const n of order) {
      if (n.card || n.alpha < 0.01) continue;
      const lit = focus && (n === focus || linked?.has(n.id));
      const r = Math.max(1.5, Math.min(7, n.r * n.p.s));
      const ink = n.step ? "32,33,34" : n.hop === 1 ? "84,89,93" : "162,169,177";
      ctx.fillStyle = lit ? `rgba(51,102,204,${n.alpha})` : `rgba(${ink},${n.alpha * (focus && !lit ? 0.5 : 1)})`;
      ctx.beginPath();
      ctx.arc(n.p.x, n.p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cards take their room on screen first, then labels nearest first; a label that would land on a
    // card or on a nearer label is left out.
    const taken = [];
    const free = (box) => !taken.some((t) => box.x < t.x + t.w && box.x + box.w > t.x && box.y < t.y + t.h && box.y + box.h > t.y);
    const nearFirst = [...order].reverse();
    for (const n of [...nearFirst.filter((n) => n.card), ...nearFirst.filter((n) => !n.card)]) {
      if (n.card) {
        const s = Math.max(0.35, Math.min(1.3, n.p.s)) * (n === focus ? 1.08 : 1);
        const w = n.w * s;
        const h = n.h * s;
        const box = { x: n.p.x - w / 2, y: n.p.y - h / 2, w, h };
        n.el.style.transform = `translate(${box.x}px, ${box.y}px) scale(${s})`;
        const shown = n.alpha * (focus && n !== focus && !linked?.has(n.id) && n !== center ? 0.55 : 1);
        n.el.style.opacity = shown.toFixed(3);
        n.el.style.zIndex = String(100000 - Math.round(n.p.z));
        n.el.style.pointerEvents = shown > 0.2 ? "auto" : "none";
        if (shown > 0.2) taken.push(box);
        continue;
      }
      const lit = n === focus || (focus && linked?.has(n.id));
      const s = Math.max(0.75, Math.min(1.1, n.p.s));
      const w = n.w * s;
      const h = 16 * s;
      const right = n.p.x > center.p.x - 20;
      const box = { x: right ? n.p.x + 8 : n.p.x - 8 - w, y: n.p.y - h / 2, w, h };
      const room = n.alpha > 0.15 && (lit || n.step || free(box));
      const a = room ? n.alpha * (n.hop === 1 ? 1 : 0.75) * (focus && !lit ? 0.4 : 1) : 0;
      n.el.style.transform = `translate(${box.x}px, ${box.y}px) scale(${s})`;
      n.el.style.opacity = a.toFixed(3);
      n.el.style.zIndex = String(100000 - Math.round(n.p.z) + (lit ? 50000 : 0));
      n.el.style.pointerEvents = a > 0.2 ? "auto" : "none";
      if (room && a > 0.05) taken.push(box);
    }
  }

  // --- Hover ---------------------------------------------------------------------------------

  function hoverAt(x, y, target) {
    const el = target.closest?.("[data-node]");
    if (el) return setHover(scene.byId.get(Number(el.dataset.node)) ?? null, x, y);
    // Dots without a label: the nearest one under the pointer.
    let best = null;
    let bestD = 12;
    for (const n of scene.nodes) {
      if (n.card || n.alpha < 0.2) continue;
      const d = Math.hypot(n.p.x - x, n.p.y - y);
      if (d < bestD) [best, bestD] = [n, d];
    }
    setHover(best, x, y);
  }

  async function setHover(n, x, y) {
    if (n !== hovered) {
      hovered?.el?.classList.remove("is-hovered");
      hovered = n;
      n?.el?.classList.add("is-hovered");
      stage.classList.toggle("is-pointing", !!n && n !== scene?.center);
    }
    if (!n || n === scene.center || n.card) {
      tip.classList.remove("is-shown");
      return;
    }
    tip.style.transform = `translate(${Math.min(x + 18, width - 300)}px, ${Math.min(y + 18, height - 160)}px)`;
    if (tip.dataset.node !== String(n.id)) {
      tip.dataset.node = String(n.id);
      tip.innerHTML = tipHtml(n, null);
      const p = await scene.preview(n.title);
      if (hovered === n) tip.innerHTML = tipHtml(n, p);
    }
    tip.classList.add("is-shown");
  }

  function tipHtml(n, p) {
    const how = n.step
      ? `On your path · ${n.step === 1 ? "where you came from" : `${n.step} steps back`}`
      : n.hop === 1
        ? `${n.ring === 1 ? "Closest" : "Linked"} · shares ${n.shared} ${n.shared === 1 ? "link" : "links"}`
        : `A step further, through ${esc(n.parent?.title ?? "")}`;
    return `${p?.thumbnail ? `<img src="${p.thumbnail.url}" alt="" />` : ""}
      <b>${esc(n.title)}</b><span>${how}</span>
      ${p?.extract ? `<p>${esc(clip(p.extract, 150))}</p>` : ""}`;
  }

  // --- Layout --------------------------------------------------------------------------------

  // Explore's choice of articles and its topic slices around the ring; the rings are closeness.
  async function build(centerId) {
    const graph = await getGraph(currentTime(), centerId).catch(() => null);
    if (!graph) return null;
    const info = new Map(graph.nodes.map((n) => [n.id, n]));
    const self = info.get(centerId);
    if (!self) return null;
    const links = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    for (const e of graph.edges) {
      links.get(e.source)?.add(e.target);
      links.get(e.target)?.add(e.source);
    }
    const all = [...links.get(centerId)].filter((n) => n !== centerId);
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

    const previews = new Map();
    const preview = (title) => {
      if (!previews.has(title)) previews.set(title, getPreview(title).catch(() => null));
      return previews.get(title);
    };
    // Picture cards for the best-connected linked articles that have a picture, as Explore picks them.
    const pics = (await Promise.all(near.slice(0, 30).map(async (n) => ({ n, p: await preview(info.get(n).title) })))).filter(({ p }) => p?.thumbnail);
    const chosen = [];
    for (const group of Map.groupBy(pics, ({ n }) => info.get(n).topic).values()) chosen.push(...group.slice(0, 1));
    for (const item of pics) if (chosen.length < MAX_CARDS && !chosen.includes(item)) chosen.push(item);
    chosen.length = Math.min(chosen.length, MAX_CARDS);
    const cardOf = new Map(chosen.map(({ n, p }) => [n, p]));
    const centerPreview = await preview(self.title);

    const maxChars = Math.log10(1 + Math.max(...graph.nodes.map((n) => n.chars ?? 0)));
    const node = (n, extra) => ({
      id: n,
      title: info.get(n).title,
      r: 2 + 4.5 * (Math.log10(1 + (info.get(n).chars ?? 0)) / maxChars),
      ...extra,
    });
    const center = node(centerId, { hop: 0, ring: 0, target: [0, 0, 0], card: true });
    const nodes = [center];
    const byId = new Map([[centerId, center]]);

    // A slice of the cone per topic, in a fixed order, sized by how many linked articles it has.
    const groups = Map.groupBy(near, (n) => info.get(n).topic ?? "Other");
    const angleOf = new Map();
    let angle = Math.PI / 2;
    for (const topic of [...groups.keys()].sort()) {
      const members = groups.get(topic);
      const span = (members.length / near.length) * Math.PI * 2;
      members.forEach((n, i) => angleOf.set(n, angle + (span * (i + 0.5)) / members.length));
      angle += span;
    }
    const place = (a, ring, rand) => {
      const r = ring.r * (0.9 + rand() * 0.2);
      return [Math.cos(a) * r, Math.sin(a) * r, ring.z + (rand() - 0.5) * 120];
    };
    near.forEach((n, rank) => {
      const ring = rank < CLOSEST ? RINGS[0] : RINGS[1];
      const it = node(n, { hop: 1, ring: ring.key, shared: shared(n), card: cardOf.has(n), angle: angleOf.get(n) });
      it.target = place(it.angle, ring, seeded(n));
      nodes.push(it);
      byId.set(n, it);
    });
    further.forEach(({ n, via }) => {
      const parent = byId.get(via.sort((a, b) => score(b) - score(a))[0]);
      const rand = seeded(n * 13);
      // Behind the linked article it is reached through, a little to either side.
      const it = node(n, { hop: 2, ring: 3, parent, card: false });
      it.target = place(parent.angle + (rand() - 0.5) * 0.35, RINGS[2], rand);
      nodes.push(it);
      byId.set(n, it);
    });
    spreadCards(nodes.filter((n) => n.card && n !== center));

    for (const n of nodes) {
      n.el = makeEl(n, n === center ? centerPreview : cardOf.get(n.id), n === center ? all.length : 0);
      layer.append(n.el);
      n.w = n.el.offsetWidth;
      n.h = n.el.offsetHeight;
      // Everything starts near the article and opens out to its ring, the far ring a little later.
      n.el.style.opacity = "0";
      n.pos = n === center ? [0, 0, 0] : [n.target[0] * 0.15, n.target[1] * 0.15, n.target[2] * 0.3];
      n.show = 0;
      n.delay = n.hop === 2 ? 0.12 : 0;
    }
    const counts = { 1: near.filter((n) => byId.get(n).ring === 1).length, 2: near.filter((n) => byId.get(n).ring === 2).length, 3: further.length };
    return { center, nodes, byId, links, preview, counts, rings: 0 };
  }

  // Cards in the same ring are turned apart around it so that, seen from the front, they don't cover
  // each other.
  function spreadCards(cards) {
    for (const ring of [1, 2]) {
      const list = cards.filter((n) => n.ring === ring).sort((a, b) => a.angle - b.angle);
      const R = RINGS[ring - 1].r;
      const gap = 230 / R; // angle a card needs, from its width at that ring
      for (let round = 0; round < 40; round++) {
        for (let i = 0; i < list.length; i++) {
          const a = list[i];
          const b = list[(i + 1) % list.length];
          if (a === b) continue;
          let d = b.angle - a.angle;
          if (i === list.length - 1) d += Math.PI * 2;
          if (d >= gap) continue;
          const push = (gap - d) / 2;
          a.angle -= push;
          b.angle += push;
        }
      }
      for (const n of list) {
        const r = Math.hypot(n.target[0], n.target[1]);
        n.target = [Math.cos(n.angle) * r, Math.sin(n.angle) * r, n.target[2]];
      }
    }
  }

  function makeEl(n, p, linkCount) {
    const el = document.createElement(n.card ? "button" : "span");
    el.dataset.node = String(n.id);
    if (n.hop === 0) {
      el.className = "dp-card is-center";
      el.innerHTML = `${p?.thumbnail ? `<span class="dp-card-media"><img src="${p.thumbnail.url}" alt="" draggable="false"></span>` : ""}
        <span class="dp-card-title">${esc(n.title)}</span>
        <span class="dp-card-meta">${linkCount} linked articles</span>
        <span class="dp-read" data-read="${n.id}">Read article →</span>`;
    } else if (n.card) {
      el.type = "button";
      el.className = "dp-card";
      el.innerHTML = `<span class="dp-card-media"><img src="${p.thumbnail.url}" alt="" draggable="false"></span>
        <span class="dp-card-title">${esc(n.title)}</span>`;
    } else {
      el.className = `dp-label${n.hop === 2 ? " is-far" : ""}`;
      el.textContent = n.title;
    }
    return el;
  }
}

function cameraBasis(yaw, pitch) {
  const f = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch) * -1, Math.cos(pitch) * Math.cos(yaw)];
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return [f, r, u];
}

// The angle equal to `angle` (mod 2π) that is closest to `from`, so turning takes the short way round.
function nearestAngle(angle, from) {
  return angle + Math.round((from - angle) / (Math.PI * 2)) * Math.PI * 2;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
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
