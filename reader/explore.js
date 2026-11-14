import { getArticle, getGraph, getPreview } from "./api.js";

// Related articles as a slowly turning 3D cloud: the article in the middle, the articles it links
// with around it, grouped by topic, and a fainter ring of articles one step further out.
// Dots and lines are drawn on a canvas; the picture cards and topic labels are regular elements.

const FIRST_YEAR = 2003;
const LAST_YEAR = 2026;
const MAX_CARDS = 12;
const MAX_NEAR = 60;
const FOCAL = 900;
const DIST = 1060;
const CARD_SPACING = 150;
const RING = 260;
const MAX_GROWN = 24;
const GROWN_CARDS = 3;

export async function mountExplore(root, { id }) {
  root.innerHTML = `
    <div class="ex-stage">
      <canvas class="ex-canvas"></canvas>
      <div class="ex-layer"></div>
    </div>
    <div class="ex-tip" role="tooltip"></div>
    <aside class="ex-panel" aria-live="polite"></aside>
    <div class="ex-time">
      <button class="ex-play" type="button" aria-label="Play the history">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path class="ex-icon-play" d="M5 3.5v9l7.5-4.5z" /><path class="ex-icon-pause" d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" /></svg>
      </button>
      <input class="ex-range" type="range" min="${FIRST_YEAR}" max="${LAST_YEAR}" step="1" value="${LAST_YEAR}" aria-label="Year" />
      <output class="ex-year">${LAST_YEAR}</output>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const stage = $(".ex-stage");
  const canvas = $(".ex-canvas");
  const ctx = canvas.getContext("2d");
  const layer = $(".ex-layer");
  const panel = $(".ex-panel");
  const tip = $(".ex-tip");
  const range = $(".ex-range");
  const yearOut = $(".ex-year");
  const playButton = $(".ex-play");

  const now = Math.floor(Date.now() / 1000);
  // The part of the link graph loaded so far: each article the map centers on or grows from brings
  // its own neighborhood.
  const nodes = new Map();
  const links = new Map();
  const linksOut = new Set();
  const graphEdges = [];
  const topics = {};
  const loaded = new Map();
  const load = (n) => {
    if (!loaded.has(n)) loaded.set(n, getGraph(now, n).then(merge));
    return loaded.get(n);
  };
  function merge(g) {
    for (const node of g.nodes) {
      if (nodes.has(node.id)) continue;
      nodes.set(node.id, node);
      links.set(node.id, new Set());
      topics[node.id] = node.topic;
    }
    for (const e of g.edges) {
      if (linksOut.has(`${e.source}>${e.target}`)) continue;
      linksOut.add(`${e.source}>${e.target}`);
      graphEdges.push(e);
      links.get(e.source).add(e.target);
      links.get(e.target).add(e.source);
    }
  }
  await load(id);
  if (!nodes.has(id)) await load(1150);

  // Topics always go round the ring in the same order, and each article keeps its spot within its
  // topic, so moving to another article slides the map instead of reshuffling it.
  const topicOrder = () => [...new Set(Object.values(topics))].sort();

  const previews = new Map();
  const preview = (title) => {
    if (!previews.has(title)) previews.set(title, getPreview(title));
    return previews.get(title);
  };

  // What is on the map, where everything is heading, and where it is right now.
  // An article that isn't in the link graph falls back to the default one, then to the best-connected.
  let centerId =
    [id, 1150].find((n) => nodes.has(n)) ?? [...links].sort((a, b) => b[1].size - a[1].size)[0][0];
  let hop = new Map();
  let target = new Map();
  let edges = [];
  const pos = new Map();
  const cards = new Map();
  let pills = [];

  // The path of articles opened while the center stays put, in order. Only the last one has its links
  // spread out around it; earlier ones keep just the step that was taken, so the map stays readable.
  // grownFrom remembers which opened article brought each added one in.
  let trail = [];
  let grownFrom = new Map();
  let branchSize = 0;
  let moving = false;
  let settleUntil = 0;
  let fitDist = DIST;
  const away = new Map();
  let summary = "";
  let shownId = null;

  // Which articles and links existed in the chosen year. null means "all of them, today".
  let alive = null;
  let aliveLinks = null;

  const cam = { yaw: 0, home: 0, turn: 1, pitch: -0.12, dist: DIST, distTo: DIST, focus: { x: 0, y: 0, z: 0 }, focusTo: { x: 0, y: 0, z: 0 } };
  let width = 0;
  let height = 0;
  let hoverId = null;
  let selectedId = null;
  let drag = null;
  let idleSince = 0;
  let projected = new Map();

  new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    width = stage.clientWidth;
    height = stage.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (hop.size) fitView();
  }).observe(stage);

  await center(centerId, null);
  openPanel(centerId);
  requestAnimationFrame(frame);

  // --- Layout -------------------------------------------------------------------------------

  async function center(nextId, from) {
    await load(nextId);
    centerId = nextId;
    trail = [];
    grownFrom = new Map();
    // Only the article and the articles it links with. A big article shows its best-connected links,
    // so the map stays readable; the panel says how many there are in all.
    const all = [...links.get(nextId)];
    const allSet = new Set(all);
    const score = (n) => nodes.get(n).chars + 4000 * [...links.get(n)].filter((m) => allSet.has(m)).length;
    const near = all.sort((a, b) => score(b) - score(a)).slice(0, MAX_NEAR);
    const further = [];
    hop = new Map([[nextId, 0], ...near.map((n) => [n, 1])]);

    const chosen = await chooseCards(near);
    // Articles that don't belong to the new map drift outward as they fade, like flying past them.
    for (const [n, p] of pos) {
      if (!hop.has(n)) away.set(n, { x: p.x * 1.7, y: p.y * 1.7, z: p.z * 1.7 });
    }
    // A small article gets a tight cluster and the view moves in; a big one spreads out.
    fitView();
    target = placeInSpace(nextId, near, further, new Set(chosen.map(({ n }) => n)));
    const start = from ? { ...pos.get(from) } : { x: 0, y: 0, z: 0 };
    for (const [n, t] of target) {
      if (pos.has(n)) continue;
      // After a move, new articles wait a moment and then bloom out from the middle, nearest first.
      const arrive = from ? performance.now() + 250 + (hop.get(n) === 2 ? 450 : 0) + Math.random() * 500 : 0;
      pos.set(n, { ...(from ? start : t), a: 0, arrive });
    }
    edges = graphEdges.filter((e) => hop.has(e.source) && hop.has(e.target) && e.source !== e.target);

    buildCards(nextId, chosen, await preview(nodes.get(nextId).title));
    buildPills();
    setTitle();
  }

  // Adds an opened article's links that aren't on the map yet, in a small cloud just beyond it,
  // pointing away from the middle so the branch reads as "further out".
  async function grow(n) {
    if (n === centerId) return;
    if (n === trail.at(-1)) return branchSize;
    const at = trail.indexOf(n);
    if (at >= 0) trail = trail.slice(0, at + 1);
    else if (hop.get(n) === 3 && grownFrom.get(n) === trail.at(-1)) trail.push(n);
    else trail = [n];
    prune();
    await load(n);

    const added = [...links.get(n)]
      .filter((m) => !hop.has(m))
      .sort((a, b) => nodes.get(b).chars - nodes.get(a).chars)
      .slice(0, MAX_GROWN);
    branchSize = added.length;
    // The new links fan out evenly from the opened article, pointing away from the middle.
    const from = target.get(n);
    const outward = Math.atan2(from.y, from.x);
    const span = Math.min(Math.PI * 1.3, 0.32 * added.length);
    const rand = seeded(n);
    added.forEach((m, i) => {
      hop.set(m, 3);
      grownFrom.set(m, n);
      const a = outward + (added.length > 1 ? i / (added.length - 1) - 0.5 : 0) * span;
      const r = 150 * (0.8 + rand() * 0.45);
      target.set(m, { x: from.x + Math.cos(a) * r, y: from.y + Math.sin(a) * r * 0.9, z: from.z + (rand() - 0.5) * 90 });
      pos.set(m, { ...pos.get(n), a: 0 });
    });
    for (let round = 0; round < 30; round++) {
      for (const m of added) {
        const a = target.get(m);
        for (const [other, b] of target) {
          if (other === m) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          const d = Math.hypot(dx, dy, dz);
          if (d === 0 || d > 30) continue;
          const push = (30 - d) / d;
          Object.assign(a, { x: a.x + dx * push, y: a.y + dy * push, z: a.z + dz * push });
        }
      }
    }
    edges = graphEdges.filter((e) => hop.has(e.source) && hop.has(e.target) && e.source !== e.target);

    // The biggest new articles get a card: with their picture if they have one, or just the title.
    const biggest = added.slice(0, GROWN_CARDS);
    const withCards = await Promise.all(biggest.map(async (m) => ({ m, p: await preview(nodes.get(m).title) })));
    for (const { m, p } of withCards) {
      const el = addCard(m, p);
      Object.assign(el, { w: el.offsetWidth, h: el.offsetHeight });
    }
    setTitle();
    return added.length;
  }

  // Drops added articles that are no longer on the path, along with their cards.
  function prune() {
    for (const [m, h] of hop) {
      if (h !== 3 || trail.includes(m)) continue;
      hop.delete(m);
      grownFrom.delete(m);
    }
    for (const [m, el] of cards) if (!hop.has(m)) dropCard(m, el);
    edges = graphEdges.filter((e) => hop.has(e.source) && hop.has(e.target) && e.source !== e.target);
  }

  function dropCard(n, el) {
    cards.delete(n);
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 300);
  }
  // Each topic gets its own patch of a sphere. Linked articles sit closer to the middle than the ones
  // a step further away, and a few rounds of nudging keep dots from landing on top of each other
  // and give picture cards room so they rarely cover one another.
  // The linked articles sit in a ring around the middle card, facing you, so none hide behind it.
  // Each topic gets a slice of the ring, in a fixed order, sized by how many articles it has.
  function placeInSpace(cid, near, further, withCards) {
    const placed = new Map([[cid, { x: 0, y: 0, z: 0 }]]);
    const groups = Map.groupBy(near, (n) => topics[n]);
    let angle = -Math.PI / 2;
    for (const topic of topicOrder().filter((t) => groups.has(t))) {
      const members = groups.get(topic).sort((a, b) => a - b);
      const span = (members.length / near.length) * Math.PI * 2;
      members.forEach((n, i) => {
        const rand = seeded(n);
        const a = angle + (span * (i + 0.2 + rand() * 0.6)) / members.length;
        const r = RING * (0.72 + rand() * 0.6);
        placed.set(n, { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.82, z: (rand() - 0.5) * 140 });
      });
      angle += span;
    }
    const list = [...placed.entries()];
    const room = (a, b) =>
      (withCards.has(a) || a === cid) && (withCards.has(b) || b === cid) ? CARD_SPACING : 30;
    for (let round = 0; round < 60; round++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [ia, a] = list[i];
          const [ib, b] = list[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          const min = room(ia, ib);
          if (d2 > min * min || d2 === 0) continue;
          const push = (min - Math.sqrt(d2)) / Math.sqrt(d2) / 2;
          if (ia !== cid) Object.assign(a, { x: a.x - dx * push, y: a.y - dy * push, z: a.z - dz * push });
          if (ib !== cid) Object.assign(b, { x: b.x + dx * push, y: b.y + dy * push, z: b.z + dz * push });
        }
      }
    }
    return placed;
  }

  // A picture card for the best-connected linked articles that have a picture, two per topic first
  // so every group has a face, then the rest by size.
  async function chooseCards(near) {
    const nearSet = new Set(near);
    const withPictures = (
      await Promise.all(near.map(async (n) => ({ n, p: await preview(nodes.get(n).title) })))
    ).filter(({ p }) => p?.thumbnail);
    const score = (n) => nodes.get(n).chars + 4000 * [...links.get(n)].filter((m) => nearSet.has(m)).length;
    withPictures.sort((a, b) => score(b.n) - score(a.n));
    const chosen = [];
    for (const group of Map.groupBy(withPictures, ({ n }) => topics[n]).values()) chosen.push(...group.slice(0, 2));
    for (const item of withPictures) if (chosen.length < MAX_CARDS && !chosen.includes(item)) chosen.push(item);
    chosen.length = Math.min(chosen.length, MAX_CARDS);
    return chosen;
  }

  // Cards that are still wanted stay where they are; the rest fade out and new ones fade in.
  // The middle card is always made fresh, since it looks different.
  function buildCards(cid, chosen, centerPreview) {
    const wanted = new Set(chosen.map(({ n }) => n));
    for (const [n, el] of cards) {
      if (!wanted.has(n) || el.classList.contains("is-center")) dropCard(n, el);
    }
    const fresh = [addCard(cid, centerPreview)];
    for (const { n, p } of chosen) if (!cards.has(n)) fresh.push(addCard(n, p));
    for (const el of fresh) Object.assign(el, { w: el.offsetWidth, h: el.offsetHeight });
  }

  function addCard(n, p) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ex-card";
    el.dataset.id = n;
    const title = nodes.get(n).title;
    if (n === centerId) {
      el.classList.add("is-center");
      el.classList.toggle("has-media", Boolean(p?.thumbnail));
      el.innerHTML = `${p?.thumbnail ? `<span class="ex-card-media"><img src="${p.thumbnail.url}" alt="" draggable="false"></span>` : ""}
        <span class="ex-card-title">${title}</span>
        <span class="ex-card-meta">${links.get(n).size} linked articles</span>`;
    } else if (!p?.thumbnail) {
      el.classList.add("is-text");
      el.innerHTML = `<span class="ex-card-title">${title}</span>`;
    } else {
      const diagram = /\.svg\b/i.test(p.thumbnail.url);
      el.innerHTML = `<span class="ex-card-media${diagram ? " is-diagram" : ""}"><img src="${p.thumbnail.url}" alt="" draggable="false"></span>
        <span class="ex-card-title">${title}</span>`;
      el.querySelector("img").addEventListener("error", (e) => e.target.parentElement.classList.add("is-empty"));
    }
    layer.append(el);
    cards.set(n, el);
    return el;
  }

  function buildPills() {
    for (const p of pills) p.el.remove();
    const groups = Map.groupBy(
      [...hop.keys()].filter((n) => hop.get(n) > 0),
      (n) => topics[n],
    );
    pills = [...groups].map(([topic, members]) => {
      const el = document.createElement("span");
      el.className = "ex-pill";
      el.style.opacity = 0;
      el.textContent = topic;
      layer.append(el);
      return { el, members, w: el.offsetWidth, h: el.offsetHeight };
    });
  }

  function setTitle() {
    const title = nodes.get(centerId).title;
    const near = [...hop].filter(([n, h]) => h === 1 && isAlive(n)).length;
    const total = [...links.get(centerId)].filter(isAlive).length;
    const added = [...hop].filter(([n, h]) => h === 3 && isAlive(n)).length;
    const year = Number(range.value);
    const meta = cards.get(centerId)?.querySelector(".ex-card-meta");
    if (meta) meta.textContent = `${total} linked articles`;
    const shown = near < total ? `${near} of ${total} linked articles` : `${total} linked articles`;
    summary = isAlive(centerId)
      ? `${shown}${year < LAST_YEAR ? ` · in ${year}` : ""}`
      : `Not written yet in ${year}`;
    const line = panel.querySelector(".ex-sub");
    if (line) line.textContent = summary;
  }

  // --- Drawing ------------------------------------------------------------------------------

  let last = 0;
  function frame(t) {
    const dt = Math.min(64, t - (last || t));
    last = t;
    const ease = 1 - Math.exp(-dt / (t < settleUntil ? 520 : 160));

    // When idle the map rocks gently around where you left it, instead of spinning all the way round.
    if (!drag && selectedId === null && hoverId === null && t - idleSince > 2200) {
      if (Math.abs(cam.yaw - cam.home) > 0.32) cam.turn = -Math.sign(cam.yaw - cam.home);
      cam.yaw += dt * 0.00005 * cam.turn;
    }
    cam.dist += (cam.distTo - cam.dist) * ease;
    for (const k of ["x", "y", "z"]) cam.focus[k] += (cam.focusTo[k] - cam.focus[k]) * ease;

    for (const [n, p] of pos) {
      const t2 = target.get(n) ?? away.get(n);
      const waiting = t < (p.arrive ?? 0);
      if (t2 && !waiting) for (const k of ["x", "y", "z"]) p[k] += (t2[k] - p[k]) * ease;
      const wanted = hop.has(n) && isAlive(n) && !waiting ? 1 : 0;
      p.a += (wanted - p.a) * ease;
      if (!hop.has(n) && p.a < 0.01) {
        pos.delete(n);
        away.delete(n);
      }
    }

    projected = new Map([...pos].map(([n, p]) => [n, project(p)]));
    const focusSet = focusOn();
    const placedCards = placeCards(focusSet);
    draw(focusSet, placedCards);
    placePills(placedCards);
    requestAnimationFrame(frame);
  }

  function project(p) {
    const x = p.x - cam.focus.x;
    const y = p.y - cam.focus.y;
    const z = p.z - cam.focus.z;
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const s = FOCAL / Math.max(80, cam.dist - z2);
    return { x: middleX() + x1 * s, y: height / 2 - 16 + y2 * s, s, near: clamp((z2 + 380) / 760, 0, 1) };
  }

  // Smart zoom: the ring always fills the free space beside the panel, whatever the article's size.
  function fitView() {
    fitDist = (FOCAL * (RING * 1.15 + 40)) / freeRadius();
    cam.distTo = fitDist;
  }

  // Half the size of the space beside the panel, in pixels.
  function freeRadius() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    return Math.max(Math.min((w > 900 ? w - 380 : w) - 80, h - 190) / 2, 160);
  }

  // Zooms onto an opened article and the links it brought in, so the branch you're on gets the room.
  function focusBranch(n) {
    const points = [n, ...[...hop].filter(([m, h]) => h === 3 && grownFrom.get(m) === n).map(([m]) => m)].map(
      (m) => target.get(m),
    );
    const middle = average(points);
    const reach = Math.max(120, ...points.map((p) => Math.hypot(p.x - middle.x, p.y - middle.y)));
    cam.focusTo = middle;
    cam.distTo = (FOCAL * (reach + 60)) / freeRadius();
  }

  // The panel covers the right side on wide screens, so the map centers in the space beside it.
  function middleX() {
    return width > 900 ? (width - 360) / 2 : width / 2;
  }

  // Hovering or opening an article lights up the articles it links with and fades the rest.
  // Opening the middle article fades nothing, and an opened article on the path keeps the path in view.
  function focusOn() {
    const n = hoverId ?? selectedId;
    if (n === null || n === centerId || !hop.has(n)) return null;
    if (hoverId === null && trail.includes(n)) {
      return new Set([centerId, ...trail, ...[...hop].filter(([, h]) => h === 3).map(([m]) => m)]);
    }
    return new Set([n, ...[...links.get(n)].filter((m) => hop.has(m))]);
  }

  function draw(focusSet, placedCards) {
    ctx.clearRect(0, 0, width, height);
    const lit = hoverId ?? selectedId;

    // The path you took is one strong blue line; the newest article's links are thin blue ones.
    const pathKeys = new Set(trail.map((m, i) => linkKey(i ? trail[i - 1] : centerId, m)));
    const tip = trail.at(-1);
    // Lines from the middle article are clear when it has a few links and faint when it has hundreds.
    const spokeAlpha = clamp(4 / links.get(centerId).size ** 0.75, 0.05, 0.42);
    for (const { source, target: to } of edges) {
      const a = pos.get(source);
      const b = pos.get(to);
      if (!a || !b) continue;
      let alpha = Math.min(a.a, b.a);
      if (aliveLinks && !aliveLinks.has(linkKey(source, to))) alpha = 0;
      if (alpha < 0.02) continue;
      const pa = projected.get(source);
      const pb = projected.get(to);
      const touchesLit = hoverId !== null && hoverId !== centerId && (source === hoverId || to === hoverId);
      const fromCenter = source === centerId || to === centerId;
      const onPath = pathKeys.has(linkKey(source, to));
      const onBranch = (source === tip && hop.get(to) === 3) || (to === tip && hop.get(source) === 3);
      // Lines between the surrounding articles only show while you hover one of them.
      if (!fromCenter && !onPath && !onBranch && !touchesLit) continue;
      ctx.lineWidth = onPath ? 2.2 : fromCenter && spokeAlpha > 0.2 ? 1.4 : 1;
      if (onPath) {
        ctx.strokeStyle = "rgb(51 102 204)";
        ctx.globalAlpha = 0.85 * alpha;
      } else if (touchesLit) {
        ctx.strokeStyle = "rgb(51 102 204)";
        ctx.globalAlpha = 0.6 * alpha;
      } else if (onBranch) {
        ctx.strokeStyle = "rgb(51 102 204)";
        ctx.globalAlpha = 0.3 * alpha;
      } else {
        ctx.strokeStyle = "rgb(32 33 34)";
        ctx.globalAlpha = alpha * (fromCenter ? spokeAlpha : 0.09) * (0.5 + 0.5 * (pa.near + pb.near) / 2) * (focusSet ? 0.4 : 1);
      }
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    const order = [...projected].sort((a, b) => a[1].near - b[1].near);
    for (const [n, p] of order) {
      const point = pos.get(n);
      if (point.a < 0.02 || placedCards.has(n)) continue;
      const h = hop.get(n) ?? 2;
      const size = (2 + Math.sqrt(nodes.get(n).chars) / 90) * (p.s / (FOCAL / fitDist)) * (h === 2 ? 0.85 : 1.1);
      const shade = Math.round(36 + (1 - p.near) * 150 + (h === 2 ? 40 : 0));
      const dimmed = focusSet && !focusSet.has(n);
      ctx.globalAlpha = point.a * (dimmed ? 0.25 : 1);
      ctx.fillStyle = focusSet?.has(n) && n !== lit ? "rgb(51 102 204)" : `rgb(${shade} ${shade + 2} ${shade + 5})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n === lit ? size + 2 : size, 0, Math.PI * 2);
      ctx.fill();
      // Opened articles keep a ring, so the path you took stays visible.
      if (trail.includes(n)) {
        ctx.strokeStyle = "rgb(51 102 204)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Nearer cards win; a card that would cover a nearer one steps back and shows as a dot instead.
  function placeCards(focusSet) {
    const priority = (n) =>
      n === centerId ? 3 : n === selectedId ? 2 : n === hoverId ? 1 : 0;
    const list = [...cards].sort(
      ([a], [b]) => priority(b) - priority(a) || projected.get(b).near - projected.get(a).near,
    );
    const placed = new Map();
    for (const [n, el] of list) {
      const p = projected.get(n);
      const point = pos.get(n);
      const scale = clamp(p.s / (FOCAL / fitDist), 0.7, 1.15) * (n === centerId ? 1 : 0.92 + 0.08 * p.near);
      const rect = { x: p.x - (el.w * scale) / 2, y: p.y - (el.h * scale) / 2, w: el.w * scale, h: el.h * scale };
      const covered = [...placed.values()].some((r) => overlaps(r, rect, -14));
      const visible = point.a > 0.3 && (!covered || priority(n) > 0);
      if (visible) placed.set(n, rect);
      const dimmed = focusSet && !focusSet.has(n);
      el.style.transform = `translate(${rect.x}px, ${rect.y}px) scale(${scale})`;
      const depthFade = n === centerId ? 1 : 0.62 + 0.38 * p.near;
      el.style.opacity = visible ? point.a * (dimmed ? 0.3 : depthFade) : 0;
      el.style.zIndex = String(100 + priority(n) * 1000 + Math.round(p.near * 500));
      el.classList.toggle("is-hidden", !visible);
      el.classList.toggle("is-selected", n === selectedId);
      el.classList.toggle("is-grown", trail.includes(n));
    }
    return placed;
  }

  // Each topic is labeled in the middle of its patch, shifted a little if a card or another label
  // is in the way. If there's no free spot nearby, the label waits until the map turns.
  function placePills(placedCards) {
    const rects = [...placedCards.values()];
    for (const pill of pills) {
      const shown = pill.members.filter((n) => pos.get(n)?.a > 0.3);
      if (shown.length < 3) {
        pill.el.style.opacity = 0;
        continue;
      }
      const mid = average(shown.map((n) => pos.get(n)));
      const p = project(hop.get(pill.members[0]) === 1 ? { x: mid.x * 1.45, y: mid.y * 1.45, z: mid.z } : mid);
      const base = { x: p.x - pill.w / 2, y: p.y - pill.h / 2, w: pill.w, h: pill.h };
      const rect = PILL_OFFSETS.map(([dx, dy]) => ({ ...base, x: base.x + dx, y: base.y + dy })).find(
        (r) => !rects.some((c) => overlaps(c, r, 6)),
      );
      if (!rect) {
        pill.el.style.opacity = 0;
        continue;
      }
      rects.push(rect);
      pill.el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
      pill.el.style.opacity = focusOn() ? 0.35 : 0.75 + 0.25 * p.near;
    }
  }

  // --- Interaction --------------------------------------------------------------------------

  stage.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, yaw: cam.yaw, pitch: cam.pitch, moved: false };
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener("pointermove", (event) => {
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        cam.yaw = drag.yaw + dx * 0.006;
        cam.pitch = clamp(drag.pitch - dy * 0.005, -1.3, 1.3);
        stage.classList.add("is-dragging");
        hideTip();
        return;
      }
    }
    pointAt(event);
  });

  stage.addEventListener("pointerup", (event) => {
    const clicked = drag && !drag.moved;
    drag = null;
    cam.home = cam.yaw;
    idleSince = performance.now();
    stage.classList.remove("is-dragging");
    if (!clicked) return;
    pointAt(event);
    if (hoverId !== null) select(hoverId);
    else deselect();
  });

  stage.addEventListener("pointerleave", () => {
    if (!drag) setHover(null);
    hideTip();
  });

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      cam.distTo = clamp(cam.distTo * Math.exp(event.deltaY * 0.0012), fitDist * 0.45, fitDist * 2);
      idleSince = performance.now();
    },
    { passive: false },
  );

  // Cards are buttons, so keyboard users can tab to them and press Enter.
  layer.addEventListener("click", (event) => {
    const card = event.target.closest(".ex-card");
    if (card && event.detail === 0) select(Number(card.dataset.id));
  });

  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) deselect();
  });

  function pointAt(event) {
    const box = stage.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".ex-card");
    if (card && !card.classList.contains("is-hidden")) {
      setHover(Number(card.dataset.id));
      hideTip();
      return;
    }
    let best = null;
    let bestDistance = 10;
    for (const [n, p] of projected) {
      if (!hop.has(n) || pos.get(n).a < 0.5) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDistance) [best, bestDistance] = [n, d];
    }
    if (best === null) {
      setHover(null);
      return hideTip();
    }
    if (best !== hoverId) showTip(best);
    setHover(best);
    const left = x + 16 + tip.offsetWidth > width - 12 ? x - 16 - tip.offsetWidth : x + 16;
    tip.style.transform = `translate(${left}px, ${clamp(y - tip.offsetHeight / 2, 12, height - tip.offsetHeight - 12)}px)`;
  }

  // Hovering a dot shows a small card for it: picture when there is one, title and topic.
  // Every hover card has the same shape: the picture when there is one, otherwise a soft tile in the
  // topic's tint with the article's first letter, so the card never jumps when a picture arrives.
  async function showTip(n) {
    const title = nodes.get(n).title;
    tip.innerHTML = `<span class="ex-card-media is-placeholder" style="--tint: ${TOPIC_TINTS[topics[n]] ?? "#eceef1"}">${title[0]}</span>
      <span class="ex-tip-title">${title}</span><span class="ex-tip-topic">${topics[n]}</span>`;
    tip.classList.add("is-visible");
    const p = await preview(title);
    if (hoverId !== n || !p?.thumbnail) return;
    const media = tip.querySelector(".ex-card-media");
    media.classList.remove("is-placeholder");
    media.classList.toggle("is-diagram", /\.svg\b/i.test(p.thumbnail.url));
    media.innerHTML = `<img src="${p.thumbnail.url}" alt="">`;
  }

  function setHover(n) {
    hoverId = n;
    stage.classList.toggle("is-pointing", n !== null);
  }

  function hideTip() {
    tip.classList.remove("is-visible");
  }

  // Opening an article grows the map from it; the middle article stays put.
  async function select(n) {
    selectedId = n;
    const count = await grow(n);
    if (selectedId !== n) return;
    if (n === centerId) {
      cam.focusTo = { x: 0, y: 0, z: 0 };
      cam.distTo = fitDist;
    } else {
      focusBranch(n);
    }
    openPanel(n, count);
  }

  function deselect() {
    if (selectedId === null) return;
    selectedId = null;
    cam.focusTo = { x: 0, y: 0, z: 0 };
    cam.distTo = fitDist;
    openPanel(centerId);
  }

  // The panel on the left always shows something: the article in the middle with the map's counts,
  // or the article you opened, with × to go back to the middle one.
  async function openPanel(n, added) {
    shownId = n;
    const node = nodes.get(n);
    const p = await preview(node.title);
    if (shownId !== n) return;
    const isCenter = n === centerId;
    const picture = p?.thumbnail
      ? `<div class="ex-panel-media${/\.svg\b/i.test(p.thumbnail.url) ? " is-diagram" : ""}"><img src="${p.thumbnail.url}" alt=""></div>`
      : "";
    panel.innerHTML = `
      ${isCenter ? "" : `<button class="ex-close" type="button" aria-label="Back to ${nodes.get(centerId).title}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>`}
      ${picture}
      <div class="ex-panel-body">
        <p class="ex-kicker">${isCenter ? "Related articles" : topics[n]}</p>
        <h3>${node.title}</h3>
        ${isCenter ? `<p class="ex-sub">${summary}</p>` : ""}
        ${p?.extract ? `<p class="ex-extract is-clamped">${p.extract}</p><button class="ex-more" type="button" hidden>Show more</button>` : ""}
        <dl class="ex-stats">
          <div><dt>Versions</dt><dd>${node.versions.toLocaleString("en-US")}</dd></div>
          <div><dt>Written</dt><dd>${new Date(node.first * 1000).getUTCFullYear()}</dd></div>
          <div><dt>Links</dt><dd>${links.get(n).size}</dd></div>
        </dl>
        <div class="ex-actions">
          <a class="ex-btn is-primary" href="?id=${n}" hidden>Read article</a>
          ${n === centerId ? "" : `<button class="ex-btn" type="button" data-act="center">Explore from here</button>`}
        </div>
      </div>`;
    panel.classList.add("is-open");
    const close = panel.querySelector(".ex-close");
    if (close) close.onclick = deselect;
    // Long summaries start at four lines, so the numbers and buttons stay in view.
    const extract = panel.querySelector(".ex-extract");
    const more = panel.querySelector(".ex-more");
    if (extract && extract.scrollHeight > extract.clientHeight + 2) {
      more.hidden = false;
      more.onclick = () => {
        const open = extract.classList.toggle("is-clamped") === false;
        more.textContent = open ? "Show less" : "Show more";
        separateActions();
      };
    }
    separateActions();
    const recenter = panel.querySelector("[data-act=center]");
    if (recenter) recenter.onclick = () => exploreFrom(n);
    const { version } = await getArticle(n, now);
    if (version && shownId === n) panel.querySelector(".ex-btn.is-primary").hidden = false;
  }

  // The buttons get their own bar only while panel text is hidden below them; otherwise they sit in the
  // panel like any other row.
  function separateActions() {
    const actions = panel.querySelector(".ex-actions");
    const below = panel.scrollHeight - panel.clientHeight - panel.scrollTop;
    actions?.classList.toggle("is-stuck", below > 2);
  }
  panel.addEventListener("scroll", separateActions, { passive: true });
  addEventListener("resize", separateActions);


  // Moving to another article happens in three steps you can follow: it lights up, the view
  // glides over until it sits in the middle, and then its own links bloom out around it.
  async function exploreFrom(n) {
    if (moving) return;
    moving = true;
    selectedId = n;
    cam.focusTo = { ...target.get(n) };
    await wait(700);

    // Re-anchor everything on the new article, so the next layout starts from where things are now.
    const shift = { ...pos.get(n) };
    const move = (p) => Object.assign(p, { x: p.x - shift.x, y: p.y - shift.y, z: p.z - shift.z });
    for (const p of pos.values()) move(p);
    for (const p of target.values()) move(p);
    move(cam.focus);
    cam.focusTo = { x: 0, y: 0, z: 0 };

    const url = new URL(location.href);
    url.searchParams.set("id", n);
    history.replaceState(null, "", url);
    selectedId = null;
    settleUntil = performance.now() + 2200;
    await center(n, n);
    openPanel(n);
    moving = false;
  }


  // --- History ------------------------------------------------------------------------------

  let request = 0;
  async function showYear(year) {
    range.value = year;
    yearOut.textContent = year;
    range.style.setProperty("--fill", `${((year - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR)) * 100}%`);
    const token = ++request;
    if (year >= LAST_YEAR) {
      alive = null;
      aliveLinks = null;
    } else {
      const g = await getGraph(Date.UTC(year, 11, 31, 23, 59) / 1000, centerId);
      if (token !== request) return;
      alive = new Set(g.nodes.map((n) => n.id));
      aliveLinks = new Set(g.edges.map((e) => linkKey(e.source, e.target)));
    }
    setTitle();
  }

  range.addEventListener("input", () => {
    stopPlaying();
    showYear(Number(range.value));
  });

  let playing = 0;
  playButton.addEventListener("click", () => {
    if (playing) return stopPlaying();
    if (Number(range.value) >= LAST_YEAR) showYear(FIRST_YEAR);
    playButton.classList.add("is-playing");
    playing = setInterval(() => {
      const next = Number(range.value) + 1;
      showYear(next);
      if (next >= LAST_YEAR) stopPlaying();
    }, 650);
  });

  function stopPlaying() {
    clearInterval(playing);
    playing = 0;
    playButton.classList.remove("is-playing");
  }

  function isAlive(n) {
    return !alive || alive.has(n);
  }

  showYear(LAST_YEAR);
}

const PILL_OFFSETS = [[0, 0]].concat(
  ...[40, 80].map((r) =>
    Array.from({ length: 8 }, (_, i) => [Math.round(Math.cos((i * Math.PI) / 4) * r * 1.6), Math.round(Math.sin((i * Math.PI) / 4) * r)]),
  ),
);

// Soft backgrounds for hover cards of articles without a picture, one per topic.
const TOPIC_TINTS = {
  "AI & applications": "#efe9f7",
  "Algorithms & complexity": "#e8eef8",
  "Cryptography & networks": "#e6f2f0",
  Hardware: "#f3ece4",
  Mathematics: "#eef3e6",
  Organizations: "#ececee",
  People: "#f6ebe9",
  Physics: "#e7f0f6",
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function linkKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function average(points) {
  const sum = points.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
}

function overlaps(a, b, gap) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()) * 0.6;
}

function seeded(seed) {
  let h = 2166136261 ^ seed;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
