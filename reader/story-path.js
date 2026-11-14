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
const LANE_H = 10; // how high the lane and its side roads stand off the floor
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
      // Versions that mostly added text turn off to the right, ones that mostly cut to the left. In a war
      // each fighter keeps to their own side of the road.
      side: [-1, 1][inWar.get(to)?.fighters.indexOf(e.user)] ?? (net >= 0 ? 1 : -1),
      changed,
      color: reverts ? [0, 62, 58] : net < -100 ? [0, 45, 78] : userColor(e.user, e.kind),
    };
  });

  // How big a change was, on a log scale from the smallest to the biggest: how far out its side road runs
  // and how wide it is.
  const biggest = Math.log10(1 + Math.max(...blocks.map((b) => b.changed)));
  for (const b of blocks) {
    const size = Math.log10(1 + b.changed) / biggest;
    b.reach = 26 + 96 * size;
    b.half = 2.5 + 12 * size * size;
  }
  // An editor's versions in a row, on the same side, are one road: it stays out between them and only
  // turns back in after the last.
  blocks.forEach((b, k) => {
    const prev = blocks[k - 1];
    if (k > 1 && prev.user === b.user && prev.side === b.side && !inWar.has(stops[k]) && !inWar.has(stops[k - 1])) {
      b.joinPrev = prev;
      prev.joinNext = true;
    }
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
    camZ += (targetZ - camZ) * 0.07;
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

    // Raised paths: a slab H high along `centerX(wz)`, `half(wz)` either side, from `from` to `to`, with a
    // soft shadow on the floor, darker side walls and a light top.
    const slab = (from, to, centerX, half, H, top, wall, edge = null) => {
      from = Math.max(from, camZ + NEAR);
      to = Math.min(to, camZ + FAR);
      if (to <= from) return;
      const stepLen = Math.max(8, (to - from) / 60);
      const l0 = [], l1 = [], r0 = [], r1 = [], sh = [];
      for (let wz = from; wz <= to + 0.1; wz += stepLen) {
        const cx = centerX(wz);
        const hw = half(wz);
        l0.push(project(cx - hw, 0, wz));
        l1.push(project(cx - hw, H, wz));
        r0.push(project(cx + hw, 0, wz));
        r1.push(project(cx + hw, H, wz));
        sh.push(project(cx + hw + 14, 0, wz));
      }
      if (l0.length < 2) return;
      const poly = (a, b, fill) => {
        ctx.beginPath();
        a.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        for (let k = b.length - 1; k >= 0; k--) ctx.lineTo(b[k].x, b[k].y);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      };
      poly(r0, sh, "rgba(32,33,34,0.035)");
      poly(l1, l0, wall);
      poly(r1, r0, wall);
      poly(l1, r1, top);
      if (!edge) return;
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      for (const line of [l1, r1]) {
        ctx.beginPath();
        line.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
      }
    };

    // The floor darkens a little toward the viewer, for depth.
    const floor = ctx.createLinearGradient(0, horizon, 0, height);
    floor.addColorStop(0, "rgba(32,33,34,0)");
    floor.addColorStop(1, "rgba(32,33,34,0.045)");
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, width, height - horizon);

    // The article's own lane, raised, as wide as the article is long at each point, dashed down the middle.
    const laneHalf = (wz) => roadHalf(Math.min(edits.length - 1, lowerBound(z, wz)));
    slab(camZ + NEAR, camZ + FAR, roadX, laneHalf, LANE_H, "rgb(251,251,252)", "rgb(222,225,229)", "rgba(32,33,34,0.16)");
    ctx.setLineDash([4, 7]);
    ctx.strokeStyle = "rgba(32,33,34,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let wz = camZ + NEAR, k = 0; wz < camZ + FAR; wz += 60, k++) {
      const q = project(roadX(wz), LANE_H, wz);
      if (k) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Each version is a side road: it turns off the lane toward its editor's side, runs alongside as far
    // out as the change was big, and turns back in at the version's stop. Roads walked are tinted in the
    // editor's color, the one being walked fills in up to the camera, and those to come are faint. Rounds of
    // an edit war have no side road of their own: the war's two branches stand for them.
    for (const b of blocks) {
      if (!b.k || inWar.has(stops[b.k]) || stopZ[b.k] < camZ + NEAR || stopZ[b.k - 1] > camZ + FAR) continue;
      const [h, sat, light] = b.color;
      // Only the far fog: the near fade would blank a whole road as soon as its start passed the camera.
      const a = calm * (1 - smoothstep(FAR * 0.45, FAR, stopZ[b.k - 1] - camZ));
      if (a < 0.01) continue;
      const done = b.k < stopNow;
      const walking = b.k === stopNow;
      const road = (to, alpha) =>
        slab(stopZ[b.k - 1], to, (wz) => roadX(wz) + branchOffset(b, wz), (wz) => branchHalf(b, wz), LANE_H,
          `hsla(${h},${sat}%,${light}%,${alpha * a})`, `hsla(${h},${sat}%,${light - 22}%,${alpha * a})`);
      // A road stays as strong once walked as while it was being walked.
      road(stopZ[b.k], done ? 0.9 : walking ? 0.25 : 0.1);
      if (walking) road(Math.min(stopZ[b.k], nowZ), 0.9);
      if (done || walking) twigs(b, a);
    }

    // Every edit along a side road grows a short bar as it is walked, standing on the road: up for text
    // added, down for text cut, as long as the change was big.
    function twigs(b, a) {
      const [h, sat, light] = b.color;
      for (let i = stops[b.k - 1] + 1; i <= stops[b.k]; i++) {
        const wz = z[i];
        if (wz > nowZ || wz < camZ + NEAR || wz > camZ + FAR) continue;
        const e = edits[i];
        if (Math.abs(e.delta) < 20) continue;
        const grow = Math.min(1, (nowZ - wz) / 260);
        const len = (8 + 9 * Math.log10(1 + Math.abs(e.delta))) * grow;
        // Standing on the road: up for text added, down through it for text cut.
        const up = e.delta > 0 ? 1 : -1;
        const cx = roadX(wz) + branchOffset(b, wz);
        const p0 = project(cx, LANE_H, wz);
        const p1 = project(cx, LANE_H + up * len * 1.4, wz);
        const w = Math.max(1.5, Math.min(5, 7 * p0.s));
        ctx.lineCap = "round";
        // A darker edge beside it, then its face.
        ctx.lineWidth = w;
        ctx.strokeStyle = e.delta > 0 ? `hsla(${h},${sat}%,${light - 25}%,${0.8 * a})` : `rgba(170,60,60,${0.6 * a})`;
        ctx.beginPath();
        ctx.moveTo(p0.x + w * 0.45, p0.y);
        ctx.lineTo(p1.x + w * 0.45, p1.y);
        ctx.stroke();
        ctx.strokeStyle = e.delta > 0 ? `hsla(${h},${sat}%,${light - 5}%,${0.95 * a})` : `rgba(226,140,140,${0.85 * a})`;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.lineCap = "butt";
      }
    }

    // Editors and swords signs stand up from the floor, so they are drawn far to near. An editor stands
    // at the far point of their detour, or walks it while their version is being written.
    const standing = [];
    // The next two editors already wait, faintly, on the roads ahead. On a road carried on over several
    // versions the editor is shown once.
    for (const b of blocks) {
      if (!b.k || b.k > stopNow + 2 || inWar.has(stops[b.k])) continue;
      const walking = b.k === stopNow;
      const ahead = b.k > stopNow;
      if (!walking && b.joinPrev && b.joinPrev.k !== stopNow) continue;
      // A walker walks their whole road, back to where it joins the lane, and the next editor sets off
      // from there; editors done stand at their road's far point.
      const wz = walking ? Math.min(stopZ[b.k], Math.max(stopZ[b.k - 1], nowZ)) : (stopZ[b.k - 1] + stopZ[b.k]) / 2;
      if (wz < camZ + NEAR || wz > camZ + NAMED) continue;
      standing.push({ z: wz, draw: () => drawEditor(b, wz, walking, ahead) });
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
    const p = project(roadX(nowZ) + nowOffset, LANE_H, nowZ);
    ctx.fillStyle = "#202122";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(32,33,34,${0.25 + 0.15 * Math.sin(now / 300)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 + 2 * Math.sin(now / 300), 0, Math.PI * 2);
    ctx.stroke();

    if (focus > 0.02 && shownFight) drawFight(shownFight, now);

    // An editor: a disc in their color with their initials, and their name when there is room.
    function drawEditor(b, wz, walking, ahead = false) {
      const a = (walking ? 1 : fog(wz - camZ) * (1 - smoothstep(NAMED * 0.75, NAMED, wz - camZ))) * calm * (ahead ? 0.4 : 1);
      if (a < 0.01) return;
      const [h, sat, light] = b.color;
      const foot = project(roadX(wz) + branchOffset(b, wz), LANE_H, wz);
      const r = Math.max(3, Math.min(walking ? 14 : 10, 30 * foot.s));
      const cy = foot.y - r - (walking ? 4 : 2);
      // A small ball, lit from the top left, with its shadow on the road.
      ctx.fillStyle = `rgba(32,33,34,${0.12 * a})`;
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, r * 0.9, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      const ball = ctx.createRadialGradient(foot.x - r * 0.35, cy - r * 0.4, r * 0.1, foot.x, cy, r * 1.05);
      ball.addColorStop(0, `hsla(${h},${Math.max(sat, 10)}%,${Math.min(85, light - 5)}%,${a})`);
      ball.addColorStop(0.6, `hsla(${h},${Math.max(sat, 10)}%,${Math.max(18, light - 30)}%,${a})`);
      ball.addColorStop(1, `hsla(${h},${Math.max(sat, 10)}%,${Math.max(10, light - 45)}%,${a})`);
      ctx.fillStyle = ball;
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
      if (!walking && !(ahead && b.k === stopNow + 1) && (r < 8 || b.changed < 1500)) return;
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

  // The fight, on a cleared stage: a Wikipedia globe in the middle and everyone in the war around it as a
  // named cursor pointing in. On a turn, that editor's cursor pokes the globe, which wobbles; at the end
  // whoever made the last edit stays, marked as the winner, and the others fade.
  function drawFight(f, now) {
    ctx.save();
    ctx.globalAlpha = focus * 0.97;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    const cx = width / 2;
    const cy = height * 0.42;
    const R = Math.min(width * 0.09, 32);
    const u = Math.min(1, (now - f.t0) / 700);
    const ended = f.winner !== null;
    const people = f.war.fighters.slice(0, 8);
    const poke = ended ? 0 : Math.sin(Math.PI * Math.min(1, u * 1.3));
    const hit = !ended && f.by >= 0 && u > 0.3 && u < 0.85 ? Math.sin(((u - 0.3) / 0.55) * Math.PI) : 0;
    const angleOf = (k) => -Math.PI / 2 + (k / people.length) * Math.PI * 2 + (people.length === 2 ? Math.PI / 2 : 0);

    // The globe, nudged away from the cursor that pokes it.
    const push = f.by >= 0 ? angleOf(f.by) : 0;
    const gx = cx - Math.cos(push) * hit * R * 0.12;
    const gy = cy - Math.sin(push) * hit * R * 0.12;
    ctx.globalAlpha = focus;
    globe(gx, gy, R, hit * 0.25 * Math.sin(now / 40));

    people.forEach((user, k) => {
      const ang = angleOf(k);
      const won = f.winner === k;
      const striking = f.by === k && !ended;
      // Everyone sways a little all the time, each at their own pace.
      const sway = Math.sin(now / 420 + k * 1.7) * 4 + (won ? Math.sin(now / 160) * 3 : 0);
      const dist = R * (striking ? 2.3 - 1.05 * poke : 2.3) + sway;
      const wob = ang + Math.sin(now / 610 + k * 2.3) * 0.06;
      const x = cx + Math.cos(wob) * dist;
      const y = cy + Math.sin(wob) * dist;
      ctx.globalAlpha = focus * (ended && !won ? 0.25 : striking || ended ? 1 : 0.75);
      cursorArrow(x, y, ang + Math.PI + Math.sin(now / 530 + k) * 0.08, colorFor(k), striking ? 1.15 : 1);
      // The name outside the cursor.
      const label = shorten(censor(user)) + (won ? " wins" : "");
      ctx.font = `${striking || won ? 700 : 600} 11px Inter, system-ui, sans-serif`;
      const lx = cx + Math.cos(ang) * (dist + 26);
      const ly = cy + Math.sin(ang) * (dist + 26);
      ctx.textAlign = Math.cos(ang) > 0.3 ? "left" : Math.cos(ang) < -0.3 ? "right" : "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = colorFor(k);
      ctx.fillText(label, Math.max(4, Math.min(width - 4, lx)), ly);
      ctx.textBaseline = "alphabetic";
      if (striking && f.revert && hit > 0) {
        ctx.globalAlpha = focus * hit;
        ctx.font = "700 11px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("undo", cx + Math.cos(ang) * R * 1.25, cy + Math.sin(ang) * R * 1.25 - 12);
      }
    });
    ctx.restore();
  }

  // The Wikipedia globe, as beside the prompt bar: the logo on a round white chip with a soft shadow.
  function globe(x, y, R, tilt) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.shadowColor = "rgba(0,0,0,0.16)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(32,33,34,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (GLOBE.complete && GLOBE.naturalWidth) {
      const w = R * 1.55;
      const h = (w * GLOBE.naturalHeight) / GLOBE.naturalWidth;
      ctx.drawImage(GLOBE, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  // The replay's cursor (a rounded arrowhead) with its tip at (x, y), pointing along `ang`.
  function cursorArrow(x, y, ang, color, scale) {
    ctx.save();
    ctx.translate(x, y);
    // The shape's tip is at (2, 1.5) and it points up and to the left, along -45°.
    ctx.rotate(ang + Math.PI * 0.75);
    ctx.scale(scale * 1.6, scale * 1.6);
    ctx.translate(-2, -1.5);
    ctx.beginPath();
    ctx.moveTo(2, 1.5);
    ctx.lineTo(14, 7);
    ctx.lineTo(8.6, 8.6);
    ctx.lineTo(6.4, 14);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }


  // How far a version's detour is from the lane at `wz`: like a side road, it turns off through a rounded
  // corner, runs alongside the lane as far out as the change was big, and turns back in the same way.
  function branchOffset(b, wz) {
    if (!b.k) return 0;
    const t = Math.min(1, Math.max(0, (wz - stopZ[b.k - 1]) / (stopZ[b.k] - stopZ[b.k - 1])));
    const out = b.joinPrev ? 1 : smoothstep(0.04, 0.22, t);
    const back = b.joinNext ? 1 : 1 - smoothstep(0.78, 0.96, t);
    // A road carried on from the editor's version before eases from that version's reach to its own.
    const reach = b.joinPrev ? b.joinPrev.reach + (b.reach - b.joinPrev.reach) * smoothstep(0.1, 0.5, t) : b.reach;
    return b.side * reach * out * back;
  }

  function branchHalf(b, wz) {
    if (!b.joinPrev) return b.half;
    const t = Math.min(1, Math.max(0, (wz - stopZ[b.k - 1]) / (stopZ[b.k] - stopZ[b.k - 1])));
    return b.joinPrev.half + (b.half - b.joinPrev.half) * smoothstep(0.1, 0.5, t);
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
    // Travels to `time` at an even pace, arriving in `ms`; trips follow on without stopping, and the
    // camera's own easing smooths the changes of pace between them.
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
      fight = round && { ...round, t0: performance.now(), winner: round.final ? lastEditor(round.war) : null };
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

// Whoever of all the war's fighters made its last edit.
function lastEditor(war) {
  for (let k = war.edits.length - 1; k >= 0; k--) {
    const f = war.fighters.indexOf(war.edits[k].user);
    if (f >= 0 && f < 8) return f;
  }
  return null;
}

// The two main fighters keep their blue and red; the others get their own colors.
// The Wikipedia globe the prompt bar shows.
const GLOBE = Object.assign(new Image(), { src: new URL("files/wikipedia-globe.png", import.meta.url).href });

const MORE_COLORS = ["#2a9d6f", "#c97a16", "#7b52c4", "#1f8fa8", "#b0487a", "#6d7a1f"];
export function colorFor(k) {
  return k < 2 ? FIGHTER_COLORS[k] : MORE_COLORS[(k - 2) % MORE_COLORS.length];
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
