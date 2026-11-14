// A 3D qubit you can turn and play with: the Bloch sphere, drawn on a canvas with no libraries.
// The arrow is the qubit's state. Top is 0, bottom is 1, anywhere else is a mix of both.
// Drag to turn the sphere; the buttons set the state or measure it.

const TILT = 0.38;
const SPIN = 0.18; // radians per second while nobody is dragging
const LINE = "51, 102, 204";

export function mountModel(figure) {
  const canvas = figure.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const readout = figure.querySelector(".model-readout");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const view = { yaw: -0.6, pitch: TILT };
  const state = { theta: 0.9, phi: 0.7, toTheta: 0.9, toPhi: 0.7, precess: false };
  let dragging = null;
  let flash = null;
  let last = performance.now();

  figure.addEventListener("click", (e) => {
    const act = e.target.closest("[data-set]")?.dataset.set;
    if (!act) return;
    state.precess = act === "both";
    if (act === "zero") aim(0, state.phi);
    if (act === "one") aim(Math.PI, state.phi);
    if (act === "both") aim(Math.PI / 2, state.phi);
    if (act === "measure") {
      const zero = Math.random() < Math.cos(state.theta / 2) ** 2;
      aim(zero ? 0 : Math.PI, state.phi);
      flash = { text: `Measured ${zero ? "0" : "1"}`, until: performance.now() + 1600 };
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    dragging = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    view.yaw = dragging.yaw + (e.clientX - dragging.x) * 0.012;
    view.pitch = clamp(dragging.pitch + (e.clientY - dragging.y) * 0.01, -1.2, 1.2);
  });
  canvas.addEventListener("pointerup", () => (dragging = null));

  requestAnimationFrame(frame);

  function aim(theta, phi) {
    state.toTheta = theta;
    state.toPhi = phi;
  }

  function frame(now) {
    if (!figure.isConnected) return;
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (!dragging && !reduceMotion) view.yaw += SPIN * dt;
    if (state.precess) state.toPhi += 1.4 * dt;
    const ease = reduceMotion ? 1 : 1 - Math.exp(-dt * 7);
    state.theta += (state.toTheta - state.theta) * ease;
    state.phi += (state.toPhi - state.phi) * ease;
    draw(now);
    const p0 = Math.round(Math.cos(state.theta / 2) ** 2 * 100);
    readout.textContent = flash && now < flash.until ? flash.text : `Chance of 0: ${p0}% · Chance of 1: ${100 - p0}%`;
    readout.classList.toggle("is-flash", Boolean(flash && now < flash.until));
    requestAnimationFrame(frame);
  }

  function draw() {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const r = Math.min(w, h) * 0.36;
    const c = { x: w / 2, y: h / 2 + 4 };

    // World: z points up. Turn around z (yaw), then tip toward the viewer (pitch).
    const project = ([x, y, z]) => {
      const x1 = x * Math.cos(view.yaw) - y * Math.sin(view.yaw);
      const y1 = x * Math.sin(view.yaw) + y * Math.cos(view.yaw);
      const up = z * Math.cos(view.pitch) + y1 * Math.sin(view.pitch);
      const depth = -z * Math.sin(view.pitch) + y1 * Math.cos(view.pitch);
      return { x: c.x + x1 * r, y: c.y - up * r, front: depth < 0.001 };
    };

    // Glass ball
    const glass = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.4, r * 0.1, c.x, c.y, r);
    glass.addColorStop(0, "rgba(255,255,255,1)");
    glass.addColorStop(1, "rgba(226,234,250,0.9)");
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Equator and two meridians, faint where they pass behind the ball
    const rings = [
      (t) => [Math.cos(t), Math.sin(t), 0],
      (t) => [Math.cos(t), 0, Math.sin(t)],
      (t) => [0, Math.cos(t), Math.sin(t)],
    ];
    rings.forEach((ring, i) => curve(ring, i === 0 ? 1.3 : 1));

    // Axes
    axis([0, 0, 1.18], [0, 0, -1.18]);
    axis([1.18, 0, 0], [-1.18, 0, 0]);
    axis([0, 1.18, 0], [0, -1.18, 0]);
    ctx.strokeStyle = "rgba(32,33,34,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();

    label([0, 0, 1.32], "0");
    label([0, 0, -1.32], "1");

    // The state arrow, its shadow on the equator, and a glowing tip
    const s = [Math.sin(state.theta) * Math.cos(state.phi), Math.sin(state.theta) * Math.sin(state.phi), Math.cos(state.theta)];
    const tip = project(s);
    const foot = project([s[0], s[1], 0]);
    const o = project([0, 0, 0]);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = `rgba(${LINE}, 0.45)`;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(foot.x, foot.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const shaft = ctx.createLinearGradient(o.x, o.y, tip.x, tip.y);
    shaft.addColorStop(0, "#3d7bff");
    shaft.addColorStop(1, "#21c6d4");
    ctx.strokeStyle = shaft;
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    ctx.fillStyle = "rgba(33, 198, 212, 0.18)";
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shaft;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#202122";
    ctx.beginPath();
    ctx.arc(o.x, o.y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    function curve(fn, width) {
      const steps = 96;
      for (let i = 0; i < steps; i++) {
        const a = project(fn((i / steps) * Math.PI * 2));
        const b = project(fn(((i + 1) / steps) * Math.PI * 2));
        ctx.strokeStyle = `rgba(${LINE}, ${a.front ? 0.38 : 0.12})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    function axis(from, to) {
      const a = project(from);
      const b = project(to);
      ctx.strokeStyle = "rgba(32,33,34,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    function label(at, text) {
      const p = project(at);
      ctx.font = "500 12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#54595d";
      ctx.fillText(`|${text}⟩`, p.x, p.y);
    }
  }
}

export function modelHtml({ title }) {
  return `<figure class="attach attach-model" data-model="bloch">
    <canvas aria-label="${title}. Drag to turn it."></canvas>
    <p class="model-readout" aria-live="polite"></p>
    <div class="model-controls">
      <button type="button" data-set="zero">0</button>
      <button type="button" data-set="one">1</button>
      <button type="button" data-set="both">Both at once</button>
      <button type="button" data-set="measure" class="is-primary">Measure</button>
    </div>
    <figcaption>${title} · drag to turn</figcaption>
  </figure>`;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
