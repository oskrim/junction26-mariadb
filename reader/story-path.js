import { censor } from "./censor.js";
import { FIGHTER_COLORS } from "./timeline3d.js";

// The narrow 3D road beside "Watch it being written": the article's life laid out ahead of you, with the
// camera moving along it as the article is rewritten. The article is a lane down the middle, as wide as
// the article is long. Every version the text plays is a detour off it: a path that swings out toward
// its editor's side, as far as the change was big, and joins the lane again at the version's stop. The
// editor walks their detour while their version is typed, then stays at its far point. Years lie across
// the road, and each edit war is a braid with a swords sign; during a war everything else fades and the
// two fighters trade blows on the road. What is still to come is faint until it has been written.

const EYE = 360; // camera height
const BACK = 760; // camera distance behind the moment shown
const NEAR = 280; // nothing closer than this is drawn
const FAR = 4200; // a short view keeps the road calm; the timeline is stretched out instead
const NAMED = 2600; // editors are shown on blocks nearer than this
const ROAD = 30; // half the road's width once the article is at its longest
const STEP_Z = 520; // road between two stops; a little more inside a war, so the fight has room
const SWORD = 150; // swords sign height above the road
const GRID = 340; // floor grid spacing

export function createStoryPath({ canvas, edits, wars, stops, onPick, onTime = () => {} }) {
  const ctx = canvas.getContext("2d");

  // Distance along the road: the stops (edit indexes, oldest first) are evenly spaced, and the edits
  // between two stops are spread evenly between them.
  const inWar = new Map();
  for (const war of wars) for (const e of war.edits) inWar.set(e.index, war);
  const stopZ = [0];
  for (let k = 1; k < stops.length; k++) stopZ.push(stopZ[k - 1] + (inWar.has(stops[k]) ? 1.3 : 1) * STEP_Z);
  const z = new Float64Array(edits.length);
  for (let k = 0; k < stops.length; k++) {
    const from = k ? stops[k - 1] : 0;
    const to = stops[k];
    for (let i = from; i <= to; i++) z[i] = k ? stopZ[k - 1] + ((stopZ[k] - stopZ[k - 1]) * (i - from)) / Math.max(1, to - from) : 0;
  }
  const maxChars = Math.max(...edits.map((e) => e.chars));
  const years = [];
  for (let y = new Date(edits[0].time).getUTCFullYear() + 1; y <= new Date(edits.at(-1).time).getUTCFullYear(); y++) {
    years.push({ year: y, z: zAt(Date.UTC(y, 0, 1)) });
  }
  const signs = wars.map((war) => ({ war, z: z[war.edits[0].index], hit: null }));

  // A block per stop, for the edits since the stop before.
  const blocks = stops.map((to, k) => {
    const from = k ? stops[k - 1] + 1 : 0;
    const span = edits.slice(from, to + 1);
    const e = edits[to];
    const changed = k ? span.reduce((n, x) => n + Math.abs(x.delta), 0) : e.chars;
    const net = k ? span.reduce((n, x) => n + x.delta, 0) : e.chars;
    const reverts = e.revertsTo !== null;
    return {
      k,
      user: e.user,
      kind: e.kind,
      from: to,
      // In a war each fighter keeps to their own side of the road.
      side: [-1, 1][inWar.get(to)?.fighters.indexOf(e.user)] ?? (k % 2 ? 1 : -1),
      changed,
      reach: Math.min(110, 36 + 0.9 * Math.sqrt(changed)),
      color: reverts ? [0, 62, 58] : net < -100 ? [0, 45, 78] : userColor(e.user, e.kind),
    };
  });

  let width = 0;
  let height = 0;
  let camZ = -BACK;
  let targetZ = -BACK;
  // The camera's target travels from `from` to `to` over `ms`: evenly during playback, eased after a jump.
  let trip = null;
  let nowZ = 0;
  let current = null;
  // The war being fought, with the round on screen: { war, by, revert, final, t0, winner }. The last one
  // stays shown while the fighters fade out.
  let fight = null;
  let shownFight = null;
  let focus = 0;
  // The stop whose version is on screen; its block rises as the camera drives up to it.
  let stopNow = 0;
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
    // During a war everything but the fight fades back; the fighters fade out after it.
    focus += ((fight ? 1 : 0) - focus) * 0.06;
    if (fight) shownFight = fight;
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
    const horizon = height * 0.1;
    // The view stays on the lane while the detour being walked goes off to the side.
    const nowBlock = blocks[stopNow];
    const nowOffset = nowBlock?.k ? branchOffset(nowBlock, nowZ) : 0;
    const camX = roadX(camZ + BACK) * 0.9;
    const project = (x, y, wz) => {
      const dz = wz - camZ;
      return { x: width / 2 + ((x - camX) * f) / dz, y: horizon + ((EYE - y) * f) / dz, s: f / dz, dz };
    };
    const calm = 1 - 0.94 * focus;
    const fog = (dz) => (1 - smoothstep(FAR * 0.45, FAR, dz)) * smoothstep(NEAR, NEAR + 380, dz);
    // Written: what lies up to the moment shown. Ahead: faint.
    const written = (wz) => wz <= nowZ + 1;
    const ink = (wz, a) => (written(wz) ? a : a * 0.3);

    ctx.clearRect(0, 0, width, height);

    // A floor grid that bends with the road, for depth.
    const zStart = Math.ceil((camZ + NEAR) / GRID) * GRID;
    ctx.lineWidth = 1;
    for (let gz = zStart; gz < camZ + FAR; gz += GRID) {
      const a = 0.06 * fog(gz - camZ) * calm;
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
      ctx.strokeStyle = `rgba(32,33,34,${0.045 * calm})`;
      ctx.stroke();
    }

    // Years: a faint line across the floor; the year itself is shown under the road.
    let lastLabelY = Infinity;
    for (const { year, z: yz } of years) {
      const dz = yz - camZ;
      if (dz < NEAR || dz > FAR) continue;
      const a = fog(dz) * calm;
      const left = project(roadX(yz) - 900, 0, yz);
      const right = project(roadX(yz) + 900, 0, yz);
      ctx.strokeStyle = `rgba(32,33,34,${0.14 * a})`;
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }

    // The article's own lane: an outline as wide as the article is long at each point, with dashes down
    // the middle.
    const lane = [-1, 1].map((side) => {
      const pts = [];
      for (let wz = camZ + NEAR; wz < camZ + FAR; wz += 40) {
        pts.push(project(roadX(wz) + side * roadHalf(Math.min(edits.length - 1, lowerBound(z, wz))), 0, wz));
      }
      return pts;
    });
    if (lane[0].length > 1) {
      ctx.beginPath();
      lane[0].forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      for (let k = lane[1].length - 1; k >= 0; k--) ctx.lineTo(lane[1][k].x, lane[1][k].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(32,33,34,0.025)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(32,33,34,0.2)";
      for (const edge of lane) {
        ctx.beginPath();
        edge.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
      }
      ctx.setLineDash([4, 7]);
      ctx.strokeStyle = "rgba(32,33,34,0.22)";
      ctx.beginPath();
      for (let wz = camZ + NEAR, k = 0; wz < camZ + FAR; wz += 60, k++) {
        const q = project(roadX(wz), 0, wz);
        if (k) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Each version is a detour: a path that leaves the lane toward its editor's side, swinging out as
    // far as the change was big, and joins it again at the version's stop. Detours walked are tinted
    // in the editor's color, the one being walked fills in up to the camera, and those to come are faint.
    for (const b of blocks) {
      if (!b.k || stopZ[b.k] < camZ + NEAR || stopZ[b.k - 1] > camZ + FAR) continue;
      const [h, sat, light] = b.color;
      const a = calm * fog(Math.max(stopZ[b.k - 1], camZ + NEAR) - camZ);
      if (a < 0.01) continue;
      const done = b.k < stopNow;
      const walking = b.k === stopNow;
      const ribbon = (from, to, alpha) => {
        const l = [];
        const r = [];
        if (to <= from) return;
        for (let wz = Math.max(from, camZ + NEAR); wz <= to + 0.1; wz += Math.max(1, (to - from) / 24)) {
          const x = roadX(wz) + branchOffset(b, wz);
          l.push(project(x - 7, 0, wz));
          r.push(project(x + 7, 0, wz));
        }
        if (l.length < 2) return;
        ctx.beginPath();
        l.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        for (let k = r.length - 1; k >= 0; k--) ctx.lineTo(r[k].x, r[k].y);
        ctx.closePath();
        ctx.fillStyle = `hsla(${h},${sat}%,${light - 10}%,${alpha * a})`;
        ctx.fill();
      };
      ribbon(stopZ[b.k - 1], stopZ[b.k], done ? 0.3 : walking ? 0.18 : 0.08);
      if (walking) ribbon(stopZ[b.k - 1], Math.min(stopZ[b.k], nowZ), 0.75);
    }

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

    // Editors and swords signs stand up from the floor, so they are drawn far to near. An editor stands
    // at the far point of their detour, or walks it while their version is being written.
    const standing = [];
    for (const b of blocks) {
      if (!b.k || b.k > stopNow) continue;
      const walking = b.k === stopNow;
      const wz = walking ? Math.min(stopZ[b.k], Math.max(stopZ[b.k - 1], nowZ)) : (stopZ[b.k - 1] + stopZ[b.k]) / 2;
      if (wz < camZ + NEAR || wz > camZ + NAMED) continue;
      standing.push({ z: wz, draw: () => drawEditor(b, wz, walking) });
    }
    for (const sign of signs) {
      sign.hit = null;
      if (sign.z < camZ + NEAR || sign.z > camZ + FAR) continue;
      standing.push({ z: sign.z, draw: () => drawSign(sign) });
    }
    standing.sort((a, b) => b.z - a.z);
    const labels = [];
    for (const s of standing) s.draw();

    // The moment shown: a dot on the road, out on the detour being walked.
    const p = project(roadX(nowZ) + nowOffset, 0, nowZ);
    ctx.fillStyle = "#202122";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(32,33,34,${0.25 + 0.15 * Math.sin(now / 300)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 + 2 * Math.sin(now / 300), 0, Math.PI * 2);
    ctx.stroke();

    if (focus > 0.02 && shownFight) drawFight(shownFight, now, project);

    // An editor: a disc in their color with their initials, and their name when there is room.
    function drawEditor(b, wz, walking) {
      const a = (walking ? 1 : fog(wz - camZ) * (1 - smoothstep(NAMED * 0.75, NAMED, wz - camZ))) * calm;
      if (a < 0.01) return;
      const [h, sat, light] = b.color;
      const foot = project(roadX(wz) + branchOffset(b, wz), 0, wz);
      const r = Math.max(3, Math.min(walking ? 14 : 10, 30 * foot.s));
      const cy = foot.y - r - (walking ? 4 : 2);
      ctx.fillStyle = `hsla(${h},${Math.max(sat, 10)}%,${Math.max(18, light - 30)}%,${a})`;
      ctx.beginPath();
      ctx.arc(foot.x, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (walking) {
        ctx.strokeStyle = `rgba(32,33,34,${0.4 + 0.3 * Math.sin(now / 220)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(foot.x, cy, r + 3 + Math.sin(now / 220), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (r >= 7) {
        ctx.fillStyle = `rgba(255,255,255,${0.95 * a})`;
        ctx.font = `600 ${Math.round(r * 0.85)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(initials(b.user, b.kind), foot.x, cy + 0.5);
        ctx.textBaseline = "alphabetic";
      }
      if (!walking && (r < 8 || b.changed < 1500)) return;
      const name = shorten(censor(b.user));
      ctx.font = `${walking ? 600 : 500} 11px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(name).width;
      // Labels sit on the outer side of the disc, kept inside the canvas.
      const lx = Math.max(4, Math.min(width - w - 4, b.side > 0 ? foot.x + r + 5 : foot.x - r - 5 - w));
      const box = { x: lx - 3, y: cy - 8, w: w + 6, h: 16 };
      if (!walking && labels.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) return;
      labels.push(box);
      ctx.fillStyle = `rgba(255,255,255,${0.85 * a})`;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, 4);
      ctx.fill();
      ctx.fillStyle = `rgba(32,33,34,${(walking ? 0.95 : 0.7) * a})`;
      ctx.textAlign = "left";
      ctx.fillText(name, lx, cy + 4);
    }

    function drawSign(sign) {
      const dz = sign.z - camZ;
      const foot = project(roadX(sign.z), 0, sign.z);
      const head = project(roadX(sign.z), SWORD, sign.z);
      const a = fog(dz) * calm;
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

  // The two fighters as little characters on the road just ahead: a round body in their color with their
  // initials, two arms and two feet. They bob facing each other; in each round the one who edited lunges
  // with a punch and the other is knocked back. When the war ends, whoever had the last edit hops with
  // both arms up, and the other slumps.
  function drawFight(f, now, project) {
    const wz = nowZ + 420;
    const base = project(roadX(wz), 0, wz);
    const R = Math.max(16, Math.min(28, width / 14));
    const gap = R * 2.1;
    const u = Math.min(1, (now - f.t0) / 650);
    const strike = f.by === 0 || f.by === 1 ? f.by : -1;
    const ended = f.winner !== null;
    const lunge = Math.sin(Math.PI * Math.min(1, u * 1.4)) * gap * 0.45;
    const hit = u > 0.35 && u < 0.85 ? Math.sin(((u - 0.35) / 0.5) * Math.PI) : 0;
    ctx.save();
    for (const k of [0, 1]) {
      const face = k ? -1 : 1;
      const color = FIGHTER_COLORS[k];
      const user = f.war.fighters[k];
      const won = f.winner === k;
      const lost = ended && !won;
      const t = now / 1000 + k * 0.5;
      let x = base.x - face * gap;
      let y = base.y;
      let tilt = 0;
      let arm = Math.sin(t * 5) * 0.25;
      let punch = 0;
      if (!ended) {
        y -= Math.abs(Math.sin(t * 4)) * R * 0.12;
        if (strike === k) {
          x += face * lunge;
          punch = Math.sin(Math.PI * Math.min(1, u * 1.4));
        } else if (strike >= 0) {
          x -= face * hit * R * 0.5;
          tilt = -face * hit * 0.35;
        }
      }
      if (won) {
        y -= Math.abs(Math.sin(t * 6)) * R * 0.6;
        arm = -1.3;
      }
      if (lost) {
        tilt = -face * 0.5 * Math.min(1, u * 2);
        y += R * 0.15;
      }
      ctx.globalAlpha = focus * (lost ? 0.45 : 1);
      character(x, y, R, color, face, tilt, arm, punch, initials(user, /^[\d.:a-f]+$/i.test(user) ? "anonymous" : "person"));
      // The name above, and who won.
      const label = shorten(censor(user)) + (won ? " wins" : "");
      ctx.font = `600 ${won ? 12 : 11}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      ctx.fillText(label, Math.max(50, Math.min(width - 50, x)), y - R * 2.6);
    }
    // The blow lands: a little burst between them, with "undo" on a revert.
    if (strike >= 0 && hit > 0 && !ended) {
      const face = strike ? -1 : 1;
      const bx = base.x + face * gap * 0.2;
      const by = base.y - R * 1.3;
      ctx.globalAlpha = focus * hit;
      ctx.strokeStyle = FIGHTER_COLORS[strike];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        ctx.moveTo(bx + Math.cos(ang) * R * 0.25, by + Math.sin(ang) * R * 0.25);
        ctx.lineTo(bx + Math.cos(ang) * R * (0.45 + 0.25 * hit), by + Math.sin(ang) * R * (0.45 + 0.25 * hit));
      }
      ctx.stroke();
      if (f.revert) {
        ctx.font = "700 11px Inter, system-ui, sans-serif";
        ctx.fillStyle = FIGHTER_COLORS[strike];
        ctx.textAlign = "center";
        ctx.fillText("undo", bx, by - R * 0.85);
      }
    }
    ctx.restore();
  }

  // One fighter: feet at (x, y), a body of radius R above them, facing right (1) or left (-1). Lit from
  // the top left: a shaded ball of a body with a highlight, darker arms and feet, a shadow on the ground.
  function character(x, y, R, color, face, tilt, arm, punch, letters) {
    const cy = y - R * 1.3;
    const dark = mix(color, "#000000", 0.3);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.13)";
    ctx.beginPath();
    ctx.ellipse(x, y + R * 0.06, R * 0.95, R * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.translate(-x, -y);
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      const fx = x + side * R * 0.35;
      const g = ctx.createLinearGradient(fx - R * 0.15, y - R * 0.35, fx + R * 0.15, y);
      g.addColorStop(0, color);
      g.addColorStop(1, dark);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(fx, y - R * 0.12, R * 0.15, R * 0.25, side * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    // Arms: short curves either side; the one toward the other fighter reaches out to punch.
    ctx.lineWidth = R * 0.22;
    ctx.strokeStyle = dark;
    for (const side of [-1, 1]) {
      const reach = side === face ? punch * R * 0.7 : 0;
      const sx = x + side * R * 1.02;
      const swing = side * arm;
      ctx.beginPath();
      ctx.moveTo(sx, cy - R * 0.15);
      ctx.quadraticCurveTo(sx + side * (R * 0.35 + reach), cy - R * 0.25 + swing * R * 0.6, sx + side * (R * 0.2 + reach * 1.4), cy + R * 0.3 + swing * R * 0.8);
      ctx.stroke();
    }
    const body = ctx.createRadialGradient(x - R * 0.35, cy - R * 0.4, R * 0.1, x, cy, R * 1.05);
    body.addColorStop(0, mix(color, "#ffffff", 0.35));
    body.addColorStop(0.55, color);
    body.addColorStop(1, dark);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.ellipse(x - R * 0.38, cy - R * 0.48, R * 0.24, R * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${Math.round(R * 0.7)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letters, x, cy + 1);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  // How far a version's detour is from the lane at `wz`: like a side road, it turns off through a rounded
  // corner, runs alongside the lane as far out as the change was big, and turns back in the same way.
  function branchOffset(b, wz) {
    if (!b.k) return 0;
    const t = Math.min(1, Math.max(0, (wz - stopZ[b.k - 1]) / (stopZ[b.k] - stopZ[b.k - 1])));
    return b.side * b.reach * smoothstep(0.04, 0.22, t) * (1 - smoothstep(0.78, 0.96, t));
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
    setStop(k) {
      stopNow = k;
    },
    // A round of `war`: fighter `by` (0 or 1, or -1 for someone else) strikes; `final` ends the war.
    setFight(round) {
      fight = round && { ...round, t0: performance.now(), winner: round.final ? winnerOf(round.war) : null };
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
    },
  };
}

// Each named editor keeps one soft color; anonymous editors are grey and bots a cool grey.
// The editor's color as CSS, as their disc on the road shows it: for the text cursor that types for them.
export function editorColor(user, kind) {
  const [h, sat, light] = userColor(user, kind);
  return `hsl(${h} ${Math.max(sat, 10)}% ${Math.max(18, light - 30)}%)`;
}

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

// Whoever made the war's last edit among its two fighters: the one whose text stood when it ended.
function winnerOf(war) {
  for (let k = war.edits.length - 1; k >= 0; k--) {
    const f = war.fighters.indexOf(war.edits[k].user);
    if (f === 0 || f === 1) return f;
  }
  return null;
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

// `hex` moved toward `to` by `amount` (0–1), as an rgb() color.
function mix(hex, to, amount) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (n, shift) => Math.round(((n >> shift) & 255) * (1 - amount) + ((b >> shift) & 255) * amount);
  return `rgb(${ch(a, 16)},${ch(a, 8)},${ch(a, 0)})`;
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}
