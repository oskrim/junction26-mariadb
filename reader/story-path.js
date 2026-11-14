import { FIGHTER_COLORS } from "./timeline3d.js";

// The narrow 3D road beside "Watch it being written": the article's life laid out ahead of you, with the
// camera moving along it as the article is rewritten. The road widens as the article grows and every edit
// is a dot on it. Beside the road each edit also stands as a bar, as tall as the change it made: grey when
// it added, pale red when it cut, red when it reverted. Years lie across the road, and each edit war is a
// braid with a swords sign at its start that can be clicked. What is still to come is faint until written.

const EYE = 340; // camera height
const BACK = 700; // camera distance behind the moment shown
const NEAR = 260; // nothing closer than this is drawn
const FAR = 9000;
const ROAD = 30; // half the road's width once the article is at its longest
const WALL = 22; // the bars' distance from the road's edge
const WAR_STRETCH = 26; // extra road per edit inside a war, so a fight gets room for its braid
const SWORD = 110; // swords sign height above the road

export function createStoryPath({ canvas, edits, wars, onPick }) {
  const ctx = canvas.getContext("2d");

  // Distance along the road: a step per edit plus the time between edits, so busy years and quiet years
  // both read. Edits inside a war are spaced out further.
  const inWar = new Map();
  for (const war of wars) for (const e of war.edits) inWar.set(e.index, war);
  const z = new Float64Array(edits.length);
  for (let i = 1; i < edits.length; i++) {
    const days = (edits[i].time - edits[i - 1].time) / 86_400_000;
    z[i] = z[i - 1] + 7 + Math.min(260, Math.sqrt(days) * 22) + (inWar.has(i) ? WAR_STRETCH : 0);
  }
  const maxChars = Math.max(...edits.map((e) => e.chars));
  const years = [];
  for (let y = new Date(edits[0].time).getUTCFullYear() + 1; y <= new Date(edits.at(-1).time).getUTCFullYear(); y++) {
    years.push({ year: y, z: zAt(Date.UTC(y, 0, 1)) });
  }
  const signs = wars.map((war) => ({ war, z: z[war.edits[0].index], hit: null }));


  let width = 0;
  let height = 0;
  let camZ = -BACK;
  let targetZ = -BACK;
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
    camZ += (targetZ - camZ) * 0.06;
    nowZ = camZ + BACK;
    draw(now);
  }
  frame = requestAnimationFrame(tick);

  // The road bends gently from side to side, so it reads as a road going away rather than a line.
  const roadX = (wz) => Math.sin(wz / 2400) * 90 + Math.sin(wz / 830) * 22;
  const roadHalf = (i) => 3 + ROAD * Math.sqrt(edits[i].chars / maxChars);

  function draw(now) {
    const f = height * 0.95;
    const horizon = height * 0.1;
    const camX = roadX(camZ + BACK) * 0.9;
    const project = (x, y, wz) => {
      const dz = wz - camZ;
      return { x: width / 2 + ((x - camX) * f) / dz, y: horizon + ((EYE - y) * f) / dz, s: f / dz, dz };
    };
    const fog = (dz) => 1 - smoothstep(FAR * 0.4, FAR, dz);
    // Written: what lies up to the moment shown. Ahead: faint.
    const ink = (wz, a) => (wz <= nowZ + 1 ? a : a * 0.28);

    ctx.clearRect(0, 0, width, height);
    const first = Math.max(0, lowerBound(z, camZ + NEAR));
    const last = Math.min(edits.length - 1, lowerBound(z, camZ + FAR));

    // Years: a line across the road and the year set large on it.
    let lastLabelY = Infinity;
    for (const { year, z: yz } of years) {
      const dz = yz - camZ;
      if (dz < NEAR || dz > FAR) continue;
      const a = fog(dz) * smoothstep(NEAR, 700, dz);
      const left = project(roadX(yz) - 700, 0, yz);
      const right = project(roadX(yz) + 700, 0, yz);
      ctx.strokeStyle = `rgba(32,33,34,${0.1 * a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
      const size = Math.min(64, 120 * project(0, 0, yz).s);
      const label = project(roadX(yz) - 60, 0, yz);
      if (lastLabelY - label.y < size * 0.8) continue;
      lastLabelY = label.y;
      ctx.fillStyle = `rgba(32,33,34,${ink(yz, 0.4) * a})`;
      ctx.font = `400 ${size}px "Source Serif 4", Georgia, serif`;
      ctx.textAlign = "right";
      ctx.fillText(String(year), Math.max(size * 2.2, label.x), label.y - 4);
    }

    // The road, as wide as the article is long at each point, with its edges drawn.
    const step = Math.max(1, Math.floor((last - first) / 300));
    const edge = (sideSign) => {
      const pts = [];
      for (let i = first; i <= last; i += step) pts.push(project(roadX(z[i]) + sideSign * roadHalf(i), 0, z[i]));
      return pts;
    };
    const left = edge(-1);
    const right = edge(1);
    if (left.length > 1) {
      ctx.beginPath();
      left.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      for (let k = right.length - 1; k >= 0; k--) ctx.lineTo(right[k].x, right[k].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(32,33,34,0.05)";
      ctx.fill();
      for (const line of [left, right]) {
        ctx.beginPath();
        line.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = "rgba(32,33,34,0.16)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }

    // The bars beside the road, drawn far to near so nearer bars stand in front.
    for (let i = last; i >= first; i--) {
      const e = edits[i];
      const wz = z[i];
      const dz = wz - camZ;
      const x = roadX(wz) + roadHalf(i) + WALL;
      const h = 3 + 24 * Math.log10(1 + Math.abs(e.delta));
      const foot = project(x, 0, wz);
      const top = project(x, h, wz);
      const a = fog(dz) * smoothstep(NEAR, 600, dz);
      ctx.strokeStyle = `rgba(${colorOf(e)},${ink(wz, 0.6) * a})`;
      ctx.lineWidth = Math.max(0.7, Math.min(4, 5 * foot.s));
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
    }

    // War braids: two strands, one per fighter, crossing at every revert.
    for (const war of wars) {
      const z0 = z[war.edits[0].index];
      const z1 = z[war.edits.at(-1).index];
      if (z1 < camZ + 40 || z0 > camZ + FAR) continue;
      const turns = Math.max(2, war.reverts);
      const amp = war.kind === "dispute" ? 22 : 14;
      for (const [k, color] of FIGHTER_COLORS.entries()) {
        let prev = null;
        for (let wz = Math.max(z0, camZ + NEAR); wz <= z1; wz += 6) {
          const t = (wz - z0) / Math.max(1, z1 - z0);
          const off = amp * Math.sin(Math.PI * t) * Math.sin(Math.PI * turns * t) * (k ? -1 : 1);
          const p = project(roadX(wz) + off, 0, wz);
          if (prev) {
            ctx.strokeStyle = hexAlpha(color, ink(wz, war.kind === "dispute" ? 0.8 : 0.45) * fog(p.dz));
            ctx.lineWidth = Math.min(2.5, Math.max(0.6, 2.4 * p.s));
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          prev = p;
        }
      }
    }

    // Each edit: a dot on the road.
    for (let i = first; i <= last; i++) {
      const wz = z[i];
      const e = edits[i];
      const p = project(roadX(wz), 0, wz);
      const a = fog(p.dz) * smoothstep(NEAR, 600, p.dz);
      const r = Math.max(0.6, Math.min(3.5, 4 * p.s));
      ctx.fillStyle = `rgba(${colorOf(e)},${ink(wz, 0.7) * a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Swords signs at the start of each war.
    for (const sign of signs) {
      const dz = sign.z - camZ;
      sign.hit = null;
      if (dz < NEAR || dz > FAR) continue;
      const foot = project(roadX(sign.z), 0, sign.z);
      const head = project(roadX(sign.z), SWORD, sign.z);
      const a = fog(dz) * smoothstep(NEAR, 500, dz);
      const reached = sign.z <= nowZ + 1;
      const red = sign.war.kind === "dispute" ? "215,51,51" : "228,143,143";
      ctx.strokeStyle = `rgba(${red},${0.5 * a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      const r = Math.max(5, Math.min(12, 30 * head.s));
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

    // The moment shown: a dot on the road.
    const i = Math.min(edits.length - 1, Math.max(0, lowerBound(z, nowZ)));
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
    ctx.fillStyle = "rgba(32,33,34,0.55)";
    ctx.font = `500 11px Inter, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(`${edits[i].chars.toLocaleString("en-US")} characters`, p.x + 14, p.y + 4);
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
  }

  function zAt(time) {
    const i = lowerBound(edits, time, (e) => e.time);
    if (i <= 0) return 0;
    if (i >= edits.length) return z.at(-1);
    const a = edits[i - 1];
    const b = edits[i];
    return z[i - 1] + ((z[i] - z[i - 1]) * (time - a.time)) / Math.max(1, b.time - a.time);
  }

  canvas.addEventListener("click", (event) => {
    const r = canvas.getBoundingClientRect();
    const x = event.clientX - r.left;
    const y = event.clientY - r.top;
    const sign = signs.find((s) => s.hit && Math.hypot(s.hit.x - x, s.hit.y - y) <= s.hit.r);
    if (sign) onPick(sign.war);
  });
  canvas.addEventListener("mousemove", (event) => {
    const r = canvas.getBoundingClientRect();
    const over = signs.some((s) => s.hit && Math.hypot(s.hit.x - event.clientX + r.left, s.hit.y - event.clientY + r.top) <= s.hit.r);
    canvas.style.cursor = over ? "pointer" : "";
  });

  return {
    // Moves the camera so `time` is just ahead of it; it glides there.
    setTime(time, { instant = false } = {}) {
      targetZ = zAt(time) - BACK;
      if (instant) camZ = targetZ;
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

function colorOf(edit) {
  return edit.revertsTo !== null ? "215,51,51" : edit.delta < 0 ? "214,140,140" : "120,125,130";
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
