import { censor } from "./censor.js";
import { FIGHTER_COLORS } from "./timeline3d.js";

// The narrow 3D road beside "Watch it being written": the article's life laid out ahead of you, with the
// camera moving along it as the article is rewritten. Along the road stand blocks, one per sitting (an
// editor's edits in a row, less than a day apart): as tall as the text they changed, in the editor's own
// color, with the editor standing on top. Cuts are pale red and reverts red. The road widens as the
// article grows, years lie across it, and each edit war is a braid with a swords sign that can be clicked.
// What is still to come is faint glass until it has been written.

const EYE = 360; // camera height
const BACK = 760; // camera distance behind the moment shown
const NEAR = 280; // nothing closer than this is drawn
const FAR = 4200; // a short view keeps the road calm; the timeline is stretched out instead
const NAMED = 2600; // editors are shown on blocks nearer than this
const ROAD = 30; // half the road's width once the article is at its longest
const KERB = 26; // gap between the road's edge and the blocks
const BLOCK_W = 46;
const MIN_DEPTH = 26;
const MIN_BLOCK = 120; // characters a sitting must change to get a block; smaller ones are dots on the road
const WAR_STRETCH = 40; // extra road per edit inside a war, so a fight gets room for its braid
const SWORD = 150; // swords sign height above the road
const GRID = 340; // floor grid spacing

export function createStoryPath({ canvas, edits, wars, onPick, onTime = () => {} }) {
  const ctx = canvas.getContext("2d");

  // Distance along the road: a step per edit plus the time between edits, so busy years and quiet years
  // both read. Edits inside a war are spaced out further.
  const inWar = new Map();
  for (const war of wars) for (const e of war.edits) inWar.set(e.index, war);
  const z = new Float64Array(edits.length);
  for (let i = 1; i < edits.length; i++) {
    const days = (edits[i].time - edits[i - 1].time) / 86_400_000;
    z[i] = z[i - 1] + 16 + Math.min(520, Math.sqrt(days) * 44) + (inWar.has(i) ? WAR_STRETCH : 0);
  }
  const maxChars = Math.max(...edits.map((e) => e.chars));
  const years = [];
  for (let y = new Date(edits[0].time).getUTCFullYear() + 1; y <= new Date(edits.at(-1).time).getUTCFullYear(); y++) {
    years.push({ year: y, z: zAt(Date.UTC(y, 0, 1)) });
  }
  const signs = wars.map((war) => ({ war, z: z[war.edits[0].index], hit: null }));

  // Sittings: an editor's consecutive edits less than a day apart.
  const sittings = [];
  for (const e of edits) {
    const last = sittings.at(-1);
    if (last && last.user === e.user && e.time - edits[last.to].time < 86_400_000) {
      last.to = e.index;
      last.net += e.delta;
      last.changed += Math.abs(e.delta);
      last.reverts += e.revertsTo !== null ? 1 : 0;
    } else {
      sittings.push({
        user: e.user,
        kind: e.kind,
        from: e.index,
        to: e.index,
        net: e.delta,
        changed: Math.abs(e.delta),
        reverts: e.revertsTo !== null ? 1 : 0,
      });
    }
  }
  const blocks = sittings.filter((s) => s.changed >= MIN_BLOCK || s.from === 0);
  blocks.forEach((b, k) => {
    b.k = k;
    b.z0 = z[b.from];
    b.z1 = Math.max(z[b.to], b.z0 + MIN_DEPTH);
    b.side = k % 2 ? 1 : -1;
    b.h = Math.min(260, 14 + 1.5 * Math.sqrt(b.changed));
    b.color = b.reverts ? [0, 62, 58] : b.net < -100 ? [0, 45, 78] : userColor(b.user, b.kind);
  });
  const blockOf = new Int32Array(edits.length).fill(-1);
  for (const b of blocks) for (let i = b.from; i <= b.to; i++) blockOf[i] = b.k;

  let width = 0;
  let height = 0;
  let camZ = -BACK;
  let targetZ = -BACK;
  // The camera's target travels from `from` to `to` over `ms`: evenly during playback, eased after a jump.
  let trip = null;
  let nowZ = 0;
  let current = null;
  let frame = 0;
  let stopped = false;

  function resize() {
    const dpr = devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tick(now) {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    if (!canvas.getClientRects().length) return;
    if (canvas.clientWidth !== width || canvas.clientHeight !== height) resize();
    if (trip) {
      const t = Math.min(1, (now - trip.t0) / trip.ms);
      targetZ = trip.from + (trip.to - trip.from) * (trip.eased ? t * t * (3 - 2 * t) : t);
      if (t === 1) trip = null;
    }
    camZ += (targetZ - camZ) * 0.15;
    nowZ = camZ + BACK;
    draw(now);
    onTime(timeAtZ(nowZ));
  }
  frame = requestAnimationFrame(tick);

  // The road bends gently from side to side, so it reads as a road going away rather than a line.
  const roadX = (wz) => Math.sin(wz / 2400) * 90 + Math.sin(wz / 830) * 22;
  const roadHalf = (i) => 3 + ROAD * Math.sqrt(edits[Math.max(0, Math.min(edits.length - 1, i))].chars / maxChars);

  function draw(now) {
    const f = height * 0.95;
    const horizon = height * 0.2; // below the year shown above the road
    const camX = roadX(camZ + BACK) * 0.9;
    const project = (x, y, wz) => {
      const dz = wz - camZ;
      return { x: width / 2 + ((x - camX) * f) / dz, y: horizon + ((EYE - y) * f) / dz, s: f / dz, dz };
    };
    const fog = (dz) => (1 - smoothstep(FAR * 0.45, FAR, dz)) * smoothstep(NEAR, NEAR + 380, dz);
    // Written: what lies up to the moment shown. Ahead: faint.
    const written = (wz) => wz <= nowZ + 1;
    const ink = (wz, a) => (written(wz) ? a : a * 0.3);

    ctx.clearRect(0, 0, width, height);
    const first = Math.max(0, lowerBound(z, camZ + NEAR));
    const last = Math.min(edits.length - 1, lowerBound(z, camZ + FAR));
    const nowIndex = Math.min(edits.length - 1, Math.max(0, lowerBound(z, nowZ + 1) - 1));

    // A floor grid that bends with the road, for depth.
    const zStart = Math.ceil((camZ + NEAR) / GRID) * GRID;
    ctx.lineWidth = 1;
    for (let gz = zStart; gz < camZ + FAR; gz += GRID) {
      const a = 0.06 * fog(gz - camZ);
      const l = project(roadX(gz) - 900, 0, gz);
      const r = project(roadX(gz) + 900, 0, gz);
      ctx.strokeStyle = `rgba(32,33,34,${a})`;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
    }
    for (const offset of [-600, -300, 300, 600]) {
      ctx.beginPath();
      for (let gz = camZ + NEAR, k = 0; gz < camZ + FAR; gz += 120, k++) {
        const p = project(roadX(gz) + offset, 0, gz);
        if (k) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(32,33,34,0.045)";
      ctx.stroke();
    }

    // Years: a line across the floor and the year set large on it.
    let lastLabelY = Infinity;
    for (const { year, z: yz } of years) {
      const dz = yz - camZ;
      if (dz < NEAR || dz > FAR) continue;
      const a = fog(dz);
      const left = project(roadX(yz) - 900, 0, yz);
      const right = project(roadX(yz) + 900, 0, yz);
      ctx.strokeStyle = `rgba(32,33,34,${0.14 * a})`;
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
      const size = Math.min(64, 130 * project(0, 0, yz).s);
      const label = project(roadX(yz) - 90, 0, yz);
      if (lastLabelY - label.y < size * 0.8) continue;
      lastLabelY = label.y;
      ctx.fillStyle = `rgba(32,33,34,${ink(yz, 0.4) * a})`;
      ctx.font = `400 ${size}px "Source Serif 4", Georgia, serif`;
      ctx.textAlign = "right";
      ctx.fillText(String(year), Math.max(size * 2.2, label.x), label.y - 4);
    }

    // The road, as wide as the article is long at each point, darker where it has been written.
    const step = Math.max(1, Math.floor((last - first) / 300));
    const strip = (from, to, alpha) => {
      const l = [];
      const r = [];
      for (let i = from; i <= to; i += step) {
        l.push(project(roadX(z[i]) - roadHalf(i), 0, z[i]));
        r.push(project(roadX(z[i]) + roadHalf(i), 0, z[i]));
      }
      if (l.length < 2) return;
      ctx.beginPath();
      l.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      for (let k = r.length - 1; k >= 0; k--) ctx.lineTo(r[k].x, r[k].y);
      ctx.closePath();
      ctx.fillStyle = `rgba(32,33,34,${alpha})`;
      ctx.fill();
    };
    strip(first, last, 0.04);
    if (nowIndex > first) strip(first, nowIndex, 0.07);

    // War braids: two strands, one per fighter, crossing at every revert.
    for (const war of wars) {
      const z0 = z[war.edits[0].index];
      const z1 = z[war.edits.at(-1).index];
      if (z1 < camZ + NEAR || z0 > camZ + FAR) continue;
      const turns = Math.max(2, war.reverts);
      const amp = war.kind === "dispute" ? 22 : 14;
      // While the moment shown is inside the war, its braid is bolder.
      const inside = nowZ >= z0 - 40 && nowZ <= z1 + 120;
      for (const [k, color] of FIGHTER_COLORS.entries()) {
        let prev = null;
        for (let wz = Math.max(z0, camZ + NEAR); wz <= z1; wz += 6) {
          const t = (wz - z0) / Math.max(1, z1 - z0);
          const off = amp * Math.sin(Math.PI * t) * Math.sin(Math.PI * turns * t) * (k ? -1 : 1);
          const p = project(roadX(wz) + off, 0, wz);
          if (prev) {
            ctx.strokeStyle = hexAlpha(color, ink(wz, inside ? 0.95 : war.kind === "dispute" ? 0.8 : 0.45) * fog(p.dz));
            ctx.lineWidth = Math.min(inside ? 4 : 2.5, Math.max(0.6, (inside ? 4 : 2.4) * p.s));
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          prev = p;
        }
      }
      // Each revert leaps across the road from the reverter's side, in their color.
      for (const e of war.edits) {
        if (e.revertsTo === null) continue;
        const f = war.fighters.indexOf(e.user);
        const wz = z[e.index];
        if (wz < camZ + NEAR || wz > camZ + FAR) continue;
        const from = f === 1 ? 1 : -1;
        const color = f === 0 || f === 1 ? FIGHTER_COLORS[f] : "#8a8f94";
        const a = ink(wz, inside ? 0.9 : 0.6) * fog(wz - camZ) * smoothstep(NEAR, NEAR + 900, wz - camZ);
        ctx.strokeStyle = hexAlpha(color, a);
        ctx.lineWidth = Math.max(0.8, Math.min(2.5, 2.6 * project(0, 0, wz).s));
        ctx.beginPath();
        for (let u = 0; u <= 1.001; u += 0.1) {
          const q = project(roadX(wz) + from * amp * 1.6 * (1 - 2 * u), Math.sin(Math.PI * u) * (inside ? 60 : 40), wz);
          if (u) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        }
        ctx.stroke();
      }
    }

    // Small edits are dots on the road.
    for (let i = first; i <= last; i++) {
      if (blockOf[i] >= 0) continue;
      const wz = z[i];
      const p = project(roadX(wz), 0, wz);
      ctx.fillStyle = `rgba(${rgb(edits[i].revertsTo !== null ? [0, 62, 58] : [210, 4, 52])},${ink(wz, 0.7) * fog(p.dz)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, Math.min(3, 3.5 * p.s)), 0, Math.PI * 2);
      ctx.fill();
    }

    // Blocks and swords signs stand up from the floor, so they are drawn far to near.
    const standing = [];
    const nowBlock = blockOf[nowIndex] >= 0 ? blocks[blockOf[nowIndex]] : null;
    for (const b of blocks) {
      if (b.z1 < camZ + NEAR || b.z0 > camZ + FAR) continue;
      standing.push({ z: b.z0, draw: () => drawBlock(b, b === nowBlock) });
    }
    for (const sign of signs) {
      sign.hit = null;
      if (sign.z < camZ + NEAR || sign.z > camZ + FAR) continue;
      standing.push({ z: sign.z, draw: () => drawSign(sign) });
    }
    // The fighters stand a little ahead of the camera all through their war, so they go along with it.
    for (const war of wars) {
      const z0 = z[war.edits[0].index];
      const z1 = z[war.edits.at(-1).index];
      const zm = Math.min(z1 + 200, Math.max(z0 + 300, nowZ + 500));
      if (zm < camZ + NEAR || zm > camZ + NAMED) continue;
      standing.push({ z: zm, draw: () => drawFighters(war, zm) });
    }
    standing.sort((a, b) => b.z - a.z);
    const labels = [];
    for (const s of standing) s.draw();

    // The moment shown: a dot on the road.
    const p = project(roadX(nowZ), 0, nowZ);
    ctx.fillStyle = "#202122";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(32,33,34,${0.25 + 0.15 * Math.sin(now / 300)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 + 2 * Math.sin(now / 300), 0, Math.PI * 2);
    ctx.stroke();

    function drawBlock(b, isNow) {
      const z0 = Math.max(b.z0, camZ + NEAR);
      const zm = (b.z0 + b.z1) / 2;
      const inner = roadX(zm) + b.side * (roadHalf(b.from) + KERB);
      const x0 = b.side > 0 ? inner : inner - BLOCK_W;
      const x1 = x0 + BLOCK_W;
      // Blocks fade as they come close, so a tall one never fills the view.
      const a = fog(z0 - camZ) * (0.25 + 0.75 * smoothstep(NEAR, NEAR + 900, z0 - camZ));
      if (a < 0.01) return;
      const done = written(b.z0);
      // Blocks still to come are only outlines.
      const alpha = (done ? 1 : 0.07) * a;
      const [h, sat, light] = b.color;
      const shade = (dl) => `hsla(${h},${sat}%,${Math.max(0, Math.min(100, light + dl))}%,${alpha})`;
      const P = (x, y, wz) => project(x, y, wz);
      const quad = (pts, fill) => {
        ctx.beginPath();
        pts.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = `rgba(32,33,34,${(isNow ? 0.5 : done ? 0.1 : 0.2) * a})`;
        ctx.lineWidth = isNow ? 1.4 : 0.6;
        ctx.stroke();
      };
      // A soft shadow on the floor, then the faces the camera can see: the side toward the road, the
      // front, and the top.
      const sh = [P(x0 + 10 * b.side, 0, z0 + 8), P(x1 + 10 * b.side, 0, z0 + 8), P(x1 + 10 * b.side, 0, b.z1 + 8), P(x0 + 10 * b.side, 0, b.z1 + 8)];
      quad(sh, `rgba(32,33,34,${0.05 * alpha})`);
      if (camX < x0) quad([P(x0, 0, z0), P(x0, b.h, z0), P(x0, b.h, b.z1), P(x0, 0, b.z1)], shade(-14));
      if (camX > x1) quad([P(x1, 0, z0), P(x1, b.h, z0), P(x1, b.h, b.z1), P(x1, 0, b.z1)], shade(-14));
      quad([P(x0, 0, z0), P(x1, 0, z0), P(x1, b.h, z0), P(x0, b.h, z0)], shade(-4));
      quad([P(x0, b.h, z0), P(x1, b.h, z0), P(x1, b.h, b.z1), P(x0, b.h, b.z1)], shade(12));

      // The editor standing on top: a disc with their initials, and their name when there is room. Only
      // near blocks that have been written get one, so the distance stays quiet.
      const near = 1 - smoothstep(NAMED * 0.75, NAMED, z0 - camZ);
      if (!done || near < 0.02) return;
      const top = P((x0 + x1) / 2, b.h, (z0 + b.z1) / 2);
      const r = Math.max(2.5, Math.min(isNow ? 14 : 11, 22 * top.s));
      const stand = P((x0 + x1) / 2, b.h, (z0 + b.z1) / 2);
      const cy = stand.y - r - 2;
      ctx.fillStyle = `hsla(${h},${Math.max(sat, 10)}%,${Math.max(18, light - 30)}%,${near * a})`;
      ctx.beginPath();
      ctx.arc(stand.x, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (isNow) {
        ctx.strokeStyle = `rgba(32,33,34,${0.4 + 0.3 * Math.sin(now / 220)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(stand.x, cy, r + 3 + Math.sin(now / 220), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (r >= 7) {
        ctx.fillStyle = `rgba(255,255,255,${0.95 * near * a})`;
        ctx.font = `600 ${Math.round(r * 0.85)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(initials(b.user, b.kind), stand.x, cy + 0.5);
        ctx.textBaseline = "alphabetic";
      }
      const named = isNow || (done && r >= 9 && b.changed >= 1500);
      if (!named) return;
      const name = shorten(censor(b.user));
      ctx.font = `${isNow ? 600 : 500} 11px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(name).width;
      // Labels sit on the road's far side of the disc, kept inside the canvas.
      const lx = Math.max(4, Math.min(width - w - 4, b.side > 0 ? stand.x + r + 5 : stand.x - r - 5 - w));
      const box = { x: lx - 3, y: cy - 8, w: w + 6, h: 16 };
      if (!isNow && labels.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) return;
      labels.push(box);
      ctx.fillStyle = `rgba(255,255,255,${0.85 * a})`;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, 4);
      ctx.fill();
      ctx.fillStyle = `rgba(32,33,34,${(isNow ? 0.95 : 0.7) * a})`;
      ctx.textAlign = "left";
      ctx.fillText(name, lx, cy + 4);
    }

    // The war's two main fighters face each other across the road, each on a post in their color.
    function drawFighters(war, zm) {
      const z0 = z[war.edits[0].index];
      const a = fog(zm - camZ) * (1 - smoothstep(NAMED * 0.75, NAMED, zm - camZ));
      const reached = written(z0);
      const inside = nowZ >= z0 - 40 && nowZ <= z[war.edits.at(-1).index] + 120;
      war.fighters.slice(0, 2).forEach((user, k) => {
        const sideSign = k ? 1 : -1;
        const x = roadX(zm) + sideSign * (roadHalf(war.edits[0].index) + 70);
        const foot = project(x, 0, zm);
        const head = project(x, 90, zm);
        const alpha = (reached ? 1 : 0.3) * a;
        ctx.strokeStyle = hexAlpha(FIGHTER_COLORS[k], 0.6 * alpha);
        ctx.lineWidth = Math.max(1, 2 * foot.s);
        ctx.beginPath();
        ctx.moveTo(foot.x, foot.y);
        ctx.lineTo(head.x, head.y);
        ctx.stroke();
        const r = Math.max(4, Math.min(inside ? 15 : 12, 26 * head.s));
        const cy = head.y - r;
        ctx.fillStyle = hexAlpha(FIGHTER_COLORS[k], alpha);
        ctx.beginPath();
        ctx.arc(head.x, cy, r, 0, Math.PI * 2);
        ctx.fill();
        if (inside) {
          ctx.strokeStyle = hexAlpha(FIGHTER_COLORS[k], 0.35 + 0.25 * Math.sin(now / 200 + k * Math.PI));
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(head.x, cy, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (r >= 7) {
          ctx.fillStyle = `rgba(255,255,255,${alpha})`;
          ctx.font = `600 ${Math.round(r * 0.8)}px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(initials(user, /^[\d.:a-f]+$/i.test(user) ? "anonymous" : "person"), head.x, cy + 0.5);
          ctx.textBaseline = "alphabetic";
        }
        if (!reached || r < 8) return;
        const name = shorten(censor(user));
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        const w = ctx.measureText(name).width;
        const lx = Math.max(4, Math.min(width - w - 4, head.x - w / 2));
        ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
        ctx.beginPath();
        ctx.roundRect(lx - 3, cy - r - 20, w + 6, 16, 4);
        ctx.fill();
        ctx.fillStyle = hexAlpha(FIGHTER_COLORS[k], alpha);
        ctx.textAlign = "left";
        ctx.fillText(name, lx, cy - r - 8);
      });
    }

    function drawSign(sign) {
      const dz = sign.z - camZ;
      const foot = project(roadX(sign.z), 0, sign.z);
      const head = project(roadX(sign.z), SWORD, sign.z);
      const a = fog(dz);
      const reached = written(sign.z);
      const red = sign.war.kind === "dispute" ? "215,51,51" : "228,143,143";
      ctx.strokeStyle = `rgba(${red},${0.6 * a})`;
      ctx.lineWidth = Math.max(1, 2.5 * foot.s);
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      const r = Math.max(5, Math.min(13, 34 * head.s));
      const pulse = current === sign.war ? 1 + 0.12 * Math.sin(now / 180) : 1;
      ctx.save();
      ctx.translate(head.x, head.y - r);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = reached ? `rgba(${red},${a})` : `rgba(255,255,255,${a})`;
      ctx.strokeStyle = `rgba(${red},${a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawSwords(r * 0.62, reached ? `rgba(255,255,255,${a})` : `rgba(${red},${a})`);
      ctx.restore();
      sign.hit = { x: head.x, y: head.y - r, r: r + 4 };
    }
  }

  function drawSwords(r, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-r, -r);
    ctx.lineTo(r * 0.6, r * 0.6);
    ctx.moveTo(r, -r);
    ctx.lineTo(-r * 0.6, r * 0.6);
    ctx.moveTo(-r * 0.15, r * 0.95);
    ctx.lineTo(r * 0.95, -r * 0.15);
    ctx.moveTo(r * 0.15, r * 0.95);
    ctx.lineTo(-r * 0.95, -r * 0.15);
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  function timeAtZ(wz) {
    const i = lowerBound(z, wz);
    if (i <= 0) return edits[0].time;
    if (i >= edits.length) return edits.at(-1).time;
    return edits[i - 1].time + ((edits[i].time - edits[i - 1].time) * (wz - z[i - 1])) / Math.max(1, z[i] - z[i - 1]);
  }

  function zAt(time) {
    const i = lowerBound(edits, time, (e) => e.time);
    if (i <= 0) return 0;
    if (i >= edits.length) return z.at(-1);
    const a = edits[i - 1];
    const b = edits[i];
    return z[i - 1] + ((z[i] - z[i - 1]) * (time - a.time)) / Math.max(1, b.time - a.time);
  }

  const signAt = (event) => {
    const r = canvas.getBoundingClientRect();
    const x = event.clientX - r.left;
    const y = event.clientY - r.top;
    return signs.find((s) => s.hit && Math.hypot(s.hit.x - x, s.hit.y - y) <= s.hit.r);
  };
  canvas.addEventListener("click", (event) => {
    const sign = signAt(event);
    if (sign) onPick(sign.war);
  });
  canvas.addEventListener("mousemove", (event) => (canvas.style.cursor = signAt(event) ? "pointer" : ""));

  return {
    // Moves the camera so `time` is just ahead of it, easing there (or at once).
    setTime(time, { instant = false } = {}) {
      if (instant) {
        trip = null;
        targetZ = camZ = zAt(time) - BACK;
      } else trip = { from: targetZ, to: zAt(time) - BACK, t0: performance.now(), ms: 700, eased: true };
    },
    // Travels to `time` at an even pace, arriving in `ms`.
    glide(time, ms) {
      trip = { from: targetZ, to: zAt(time) - BACK, t0: performance.now(), ms: Math.max(1, ms), eased: false };
    },
    // Stops where it is, mid-trip.
    freeze() {
      trip = null;
    },
    setWar(war) {
      current = war;
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
    },
  };
}

// Each named editor keeps one soft color; anonymous editors are grey and bots a cool grey.
function userColor(user, kind) {
  if (kind === "anonymous") return [210, 4, 70];
  if (kind === "bot") return [210, 14, 64];
  let hash = 0;
  for (const c of user) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return [(hash % 12) * 30 + 15, 38, 66];
}

function initials(user, kind) {
  if (kind === "anonymous") return "IP";
  const parts = user.replace(/~.*$/, "").split(/[\s_.-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function shorten(name) {
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

function rgb([h, s, l]) {
  // HSL to "r,g,b" for the few colors set as HSL above.
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `${f(0)},${f(8)},${f(4)}`;
}

function lowerBound(list, value, key = (v) => v) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}
