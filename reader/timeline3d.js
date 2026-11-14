// The 3D timeline: scrolling flies the camera forward along a path on the floor. Every edit is a dot on
// the path, notable edits and edit wars float beside it as cards, and the path bends toward each card.
// Everything is projected by hand each frame, so the canvas path and the HTML cards stay in step.

const SPACING = 1000; // world units between cards
const WAR_LENGTH = 1600; // stretch of path a war's braid takes up
const SIDE = 360; // card distance from the path
const BEND = 90; // how far the path leans toward a card
const CARD_HEIGHT = 170; // card center above the floor
const EYE = 230; // camera height
const VIEW = 1050; // distance at which a card is shown at its natural size
const FAR = 7000;
const CARD_FAR = 4800; // cards appear later than the path, so the horizon stays quiet
const SCROLL_PER_UNIT = 0.6;

export const FIGHTER_COLORS = ["#3366cc", "#d73333"];

export function createTimeline({ stage, canvas, layer, spacer, edits, stops, renderCard, onMove }) {
  const ctx = canvas.getContext("2d");

  // Lay the stops out along z; a war gets a stretch of path rather than a point.
  let z = SPACING;
  const anchors = [{ time: edits[0].time - 1, z: 0 }];
  for (const [i, stop] of stops.entries()) {
    stop.side = i % 2 ? 1 : -1;
    stop.z = z;
    if (stop.type === "war") {
      const n = stop.war.edits.length;
      stop.war.edits.forEach((e, k) => anchors.push({ time: e.time, z: z + (WAR_LENGTH * k) / Math.max(1, n - 1) }));
      stop.zEnd = z + WAR_LENGTH;
    } else {
      anchors.push({ time: stop.edit.time, z });
      stop.zEnd = z;
    }
    z = stop.zEnd + SPACING;
  }
  anchors.push({ time: edits.at(-1).time + 1, z });
  const totalZ = z;
  const editZ = edits.map((e) => timeToZ(e.time));

  for (const stop of stops) {
    stop.el = document.createElement("div");
    stop.el.className = "tl-slot";
    stop.el.innerHTML = renderCard(stop);
    stop.el.addEventListener("click", () => goToZ(stop.z));
    layer.append(stop.el);
  }

  const years = [];
  for (let y = new Date(edits[0].time).getUTCFullYear() + 1; y <= new Date(edits.at(-1).time).getUTCFullYear(); y++) {
    years.push({ year: y, z: timeToZ(Date.UTC(y, 0, 1)) });
  }

  let width = 0;
  let height = 0;
  let camZ = 0;
  let camX = 0;
  let targetZ = 0;
  let focused = null;

  const resize = () => {
    const dpr = devicePixelRatio || 1;
    width = stage.clientWidth;
    height = stage.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    spacer.style.height = `${totalZ * SCROLL_PER_UNIT + innerHeight}px`;
  };
  resize();
  addEventListener("resize", resize);
  addEventListener("scroll", () => (targetZ = scrollY / SCROLL_PER_UNIT), { passive: true });
  targetZ = scrollY / SCROLL_PER_UNIT;
  camZ = targetZ;

  requestAnimationFrame(function frame(now) {
    camZ += (targetZ - camZ) * 0.1;
    camX += (pathX(camZ + 900) * 0.8 - camX) * 0.08;
    draw(now);
    requestAnimationFrame(frame);
  });

  function draw(now) {
    const f = height * 1.05;
    const horizon = height * 0.3;
    const project = (x, y, wz) => {
      const dz = wz - camZ;
      return { x: width / 2 + ((x - camX) * f) / dz, y: horizon + ((EYE - y) * f) / dz, s: f / dz, dz };
    };
    const fog = (dz) => 1 - smoothstep(FAR * 0.45, FAR, dz);

    ctx.clearRect(0, 0, width, height);

    for (const { year, z: yz } of years) {
      const dz = yz - camZ;
      if (dz < 80 || dz > FAR) continue;
      const a = fog(dz) * smoothstep(80, 500, dz);
      const left = project(pathX(yz) - 1400, 0, yz);
      const right = project(pathX(yz) + 1400, 0, yz);
      ctx.strokeStyle = `rgba(32,33,34,${0.12 * a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
      const label = project(pathX(yz) - 700, 0, yz);
      ctx.fillStyle = `rgba(32,33,34,${0.32 * a})`;
      ctx.font = `400 ${Math.min(140, 90 * label.s)}px "Source Serif 4", Georgia, serif`;
      ctx.textAlign = "right";
      ctx.fillText(String(year), label.x, label.y - 6 * label.s);
    }

    const start = camZ + 60;
    const end = camZ + FAR;
    let prev = null;
    for (let wz = start; wz <= end; wz += Math.max(12, (wz - camZ) * 0.04)) {
      const p = project(pathX(wz), 0, wz);
      const war = warAt(wz);
      if (prev) {
        ctx.strokeStyle = `rgba(32,33,34,${(war ? 0.1 : 0.32) * fog(p.dz)})`;
        ctx.lineWidth = Math.min(3, Math.max(0.6, 3.2 * p.s));
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      prev = p;
    }

    for (const stop of stops) {
      if (stop.type !== "war" || stop.zEnd < start || stop.z > end) continue;
      drawBraid(stop, project, fog, now, start, end);
    }

    let i = lowerBound(editZ, start);
    for (; i < editZ.length && editZ[i] <= end; i++) {
      const e = edits[i];
      const p = project(pathX(editZ[i]) + braidOffset(editZ[i], e), 0, editZ[i]);
      const r = Math.max(0.7, Math.min(4.5, (1.5 + Math.log10(1 + Math.abs(e.delta))) * 1.6 * p.s));
      ctx.fillStyle = dotColor(e, editZ[i], fog(p.dz));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    let best = null;
    for (const stop of stops) {
      const dz = stop.z - camZ;
      if (dz < 120 || dz > CARD_FAR) {
        stop.el.style.visibility = "hidden";
        continue;
      }
      const cardX = pathX(stop.z) + stop.side * SIDE;
      const p = project(cardX, CARD_HEIGHT, stop.z);
      const foot = project(pathX(stop.z), 0, stop.z);
      const opacity = (1 - smoothstep(CARD_FAR * 0.55, CARD_FAR, dz)) * smoothstep(250, 650, dz);
      const scale = VIEW / dz;
      stop.el.style.visibility = opacity > 0.01 ? "visible" : "hidden";
      stop.el.style.opacity = opacity.toFixed(3);
      stop.el.style.zIndex = String(Math.round(FAR - dz));
      stop.el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${scale})`;

      const edge = project(cardX - stop.side * 150, CARD_HEIGHT, stop.z);
      ctx.strokeStyle = `rgba(32,33,34,${0.18 * opacity})`;
      ctx.lineWidth = Math.max(0.5, 1.2 * p.s);
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(edge.x, edge.y);
      ctx.lineTo(foot.x, foot.y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (dz > 500 && (!best || Math.abs(dz - VIEW) < Math.abs(best.z - camZ - VIEW))) best = stop;
    }
    if (best !== focused) {
      focused?.el.classList.remove("is-focus");
      best?.el.classList.add("is-focus");
      focused = best;
    }
    onMove(zToTime(camZ + VIEW));
  }

  // Two strands, one per main fighter, that cross each time the article is reverted.
  function drawBraid(stop, project, fog, now, start, end) {
    const { war } = stop;
    const turns = Math.max(2, war.reverts);
    const amp = war.kind === "dispute" ? 46 : 30;
    const wobble = stop === focused ? Math.sin(now / 260) * 0.25 : 0;
    for (const [k, color] of FIGHTER_COLORS.entries()) {
      let prev = null;
      for (let wz = Math.max(stop.z, start); wz <= Math.min(stop.zEnd, end); wz += 14) {
        const t = (wz - stop.z) / WAR_LENGTH;
        const envelope = Math.sin(Math.PI * t);
        const offset = amp * envelope * Math.sin(Math.PI * turns * t + wobble) * (k ? -1 : 1);
        const p = project(pathX(wz) + offset, 0, wz);
        if (prev) {
          ctx.strokeStyle = hexAlpha(color, (war.kind === "dispute" ? 0.85 : 0.5) * fog(p.dz));
          ctx.lineWidth = Math.min(4, Math.max(0.8, 3.6 * p.s));
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        prev = p;
      }
    }
  }

  // Inside a war, each fighter's edits sit on their own strand.
  function braidOffset(wz, edit) {
    const stop = warAt(wz);
    if (!stop) return 0;
    const fighter = stop.war.fighters.indexOf(edit.user);
    if (fighter < 0 || fighter > 1) return 0;
    const t = (wz - stop.z) / WAR_LENGTH;
    const amp = stop.war.kind === "dispute" ? 46 : 30;
    return amp * Math.sin(Math.PI * t) * Math.sin(Math.PI * Math.max(2, stop.war.reverts) * t) * (fighter ? -1 : 1);
  }

  // Inside a war each fighter's edits take their strand's color; elsewhere reverts are only a faint red.
  function dotColor(edit, wz, alpha) {
    const fighter = warAt(wz)?.war.fighters.indexOf(edit.user) ?? -1;
    if (fighter === 0 || fighter === 1) return hexAlpha(FIGHTER_COLORS[fighter], alpha);
    if (edit.revertsTo !== null) return `rgba(215,51,51,${0.4 * alpha})`;
    if (edit.undoneBy !== null) return `rgba(162,169,177,${0.5 * alpha})`;
    return `rgba(84,89,93,${0.55 * alpha})`;
  }

  function warAt(wz) {
    return stops.find((s) => s.type === "war" && wz >= s.z && wz <= s.zEnd) ?? null;
  }

  // The path leans toward the side of each card and eases back between them.
  function pathX(wz) {
    if (wz <= stops[0].z) return stops[0].side * BEND * smoothstep(0, stops[0].z, wz);
    for (let i = 0; i < stops.length; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (wz <= a.zEnd) return a.side * BEND;
      if (!b) return a.side * BEND;
      if (wz < b.z) {
        const t = (wz - a.zEnd) / (b.z - a.zEnd);
        return a.side * BEND + (b.side - a.side) * BEND * (0.5 - Math.cos(Math.PI * t) / 2);
      }
    }
    return 0;
  }

  function timeToZ(time) {
    const i = Math.max(1, Math.min(anchors.length - 1, lowerBound(anchors, time, (a) => a.time)));
    const a = anchors[i - 1];
    const b = anchors[i];
    return a.z + ((b.z - a.z) * (time - a.time)) / Math.max(1, b.time - a.time);
  }

  function zToTime(wz) {
    const i = Math.max(1, Math.min(anchors.length - 1, lowerBound(anchors, wz, (a) => a.z)));
    const a = anchors[i - 1];
    const b = anchors[i];
    return a.time + ((b.time - a.time) * (wz - a.z)) / Math.max(1, b.z - a.z);
  }

  function goToZ(wz) {
    scrollTo({ top: Math.max(0, (wz - VIEW) * SCROLL_PER_UNIT), behavior: "smooth" });
  }

  return {
    goToTime: (time) => goToZ(timeToZ(time)),
    next: (dir) => {
      const here = camZ + VIEW;
      const target = dir > 0 ? stops.find((s) => s.z > here + 40) : stops.findLast((s) => s.z < here - 40);
      if (target) goToZ(target.z);
    },
  };
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
