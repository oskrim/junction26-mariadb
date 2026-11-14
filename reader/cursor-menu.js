// A small liquid menu that rides on the pointer. Press Q to open it; the pointer becomes a text
// cursor you can paint a passage with. Press A, F or V (or click a blob once it settles) and that
// blob stretches into a prompt bar; Enter hands the request to onSubmit.
//
// States: closed → follow (rides the pointer) → pinned (stays put, blobs clickable) → bar (typing).
// Painting or clicking while following pins the menu where the pointer is.

export const OPEN_KEY = "q";

const MODES = [
  {
    id: "ask",
    label: "Ask",
    key: "a",
    placeholder: "Ask about this…",
    fallback: "What changed here over time?",
    icon: `<path d="M2.5 7.5C2.5 5 5 3 8 3s5.5 2 5.5 4.5S11 12 8 12a6.4 6.4 0 0 1-2-.3L3 13l.8-2.4a4.1 4.1 0 0 1-1.3-3.1Z" />`,
  },
  {
    id: "find",
    label: "Find",
    key: "f",
    placeholder: "Find in this article's history…",
    fallback: "Where else does this appear?",
    icon: `<circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" />`,
  },
  {
    id: "visualise",
    label: "Visualise",
    key: "v",
    placeholder: "What should I chart?",
    fallback: "Show how this grew over time",
    icon: `<path d="M3 13V8.5M8 13V3.5M13 13V6.5" />`,
  },
];

const CARET_GAP = 20;
const BLOB = 36;
const REACH = 58;
const BAR_W = 400;
const BAR_H = 48;
const EDGE = 16;

// Spring settings: stiffness and damping. "open" overshoots a little, like the reference menu.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FEEL = reduceMotion
  ? { open: [900, 60], close: [900, 60], follow: [2000, 90], bar: [900, 60] }
  : { open: [380, 20], close: [520, 46], follow: [620, 36], bar: [300, 25] };
const STAGGER = reduceMotion ? 0 : 40;

export function cursorMenu({ root, onSubmit }) {
  const el = build();
  document.body.append(el.root);

  let state = "closed";
  let mouse = null;
  let pin = null; // page coordinates while pinned
  let side = "right";
  let paint = null;
  let chosen = null;
  let timers = [];
  let frame = 0;
  let last = 0;

  const presence = new Spring(0); // 0 hidden, 1 shown: scales the caret in and out
  const blobs = MODES.map(() => ({ x: new Spring(0), y: new Spring(0), w: new Spring(0), h: new Spring(0), phase: "home" }));

  addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }), { passive: true });

  addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.target === el.input) {
        if (key === "escape") {
          e.preventDefault();
          backToBlobs();
        }
        return;
      }
      if (isTyping(e.target)) return;
      if (state === "closed" || state === "closing") {
        if (key === OPEN_KEY && !e.repeat) {
          e.preventDefault();
          open();
        }
        return;
      }
      if (key === "escape" || key === OPEN_KEY) {
        e.preventDefault();
        close();
        return;
      }
      const mode = MODES.find((m) => m.key === key);
      if (mode && (state === "follow" || state === "pinned")) {
        e.preventDefault();
        choose(mode);
      }
    },
    true,
  );

  addEventListener("mousedown", (e) => {
    if (e.button !== 0 || el.root.contains(e.target) || e.target.closest(".chat, .chat-dock")) return;
    if (state === "pinned" || state === "bar") follow();
    if (state !== "follow") return;
    // While the button is held the blobs tuck away, so the passage being painted stays clear.
    reset();
    for (const b of blobs) b.phase = "home";
  });

  addEventListener("mouseup", (e) => {
    if (e.button !== 0 || state !== "follow") return;
    takeSelection();
    pinAt(e.clientX, e.clientY);
    blobs.forEach((b, i) => later(i * STAGGER, () => (b.phase = "out")));
  });

  for (const button of el.buttons) {
    button.addEventListener("click", () => choose(MODES.find((m) => m.id === button.dataset.mode)));
  }

  el.bar.addEventListener("submit", (e) => {
    e.preventDefault();
    const mode = chosen;
    const from = el.bar.getBoundingClientRect();
    onSubmit({ mode: mode.id, label: mode.label, prompt: el.input.value.trim() || mode.fallback, context: paint?.text ?? null, from, avoid: paint?.range.getBoundingClientRect() ?? null });
    close({ keepPaint: true });
  });

  return { clearPaint };

  function open() {
    reset();
    takeSelection();
    side = mouse && mouse.x > innerWidth - 240 ? "left" : "right";
    if (mouse) setState("follow");
    else pinAt(innerWidth / 2, innerHeight / 2);
    const { x, y } = center();
    presence.snap(0);
    presence.to = 1;
    blobs.forEach((b, i) => {
      b.phase = "home";
      for (const [s, v] of [[b.x, x], [b.y, y], [b.w, 0], [b.h, 0]]) s.snap(v);
      later(60 + i * STAGGER, () => (b.phase = "out"));
    });
    el.input.value = "";
    el.root.hidden = false;
    run();
  }

  function close({ keepPaint = false } = {}) {
    reset();
    setState("closing");
    if (!keepPaint) clearPaint();
    for (const b of blobs) b.phase = "gone";
    later(90, () => (presence.to = 0));
    el.input.blur();
  }

  function follow() {
    if (state === "bar") backToBlobs();
    setState("follow");
  }

  function pinAt(x, y) {
    pin = { x: x + scrollX, y: y + scrollY };
    setState("pinned");
  }

  function choose(mode) {
    if (!mode) return;
    if (state === "follow") pinAt(mouse.x, mouse.y);
    reset();
    chosen = mode;
    setState("bar");
    blobs.forEach((b, i) => (b.phase = MODES[i] === mode ? "bar" : "home"));
    el.input.placeholder = mode.placeholder;
    el.input.value = "";
    el.chip.textContent = paint ? `“${shorten(paint.text, 26)}”` : "Whole article";
    el.chip.classList.toggle("is-whole", !paint);
    el.bar.dataset.mode = mode.id;
    later(reduceMotion ? 0 : 150, () => {
      el.bar.classList.add("is-visible");
      el.input.focus({ preventScroll: true });
    });
  }

  function backToBlobs() {
    reset();
    setState("pinned");
    el.bar.classList.remove("is-visible");
    el.input.blur();
    blobs.forEach((b, i) => later(i * STAGGER, () => (b.phase = "out")));
  }

  function setState(next) {
    state = next;
    el.root.dataset.state = next;
    el.root.dataset.side = side;
    document.documentElement.classList.toggle("qm-following", next === "follow");
    if (next !== "bar") el.bar.classList.remove("is-visible");
  }

  // Uses whatever is selected in the article as the painted passage, then clears the native
  // selection so typing in the bar can't wipe it out.
  function takeSelection() {
    const selection = getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const text = range.toString().replace(/\s+/g, " ").trim();
    if (!text || !root.contains(range.commonAncestorContainer)) return;
    paint = { range: range.cloneRange(), text };
    CSS.highlights?.set("qm-paint", new Highlight(paint.range));
    selection.removeAllRanges();
  }

  function clearPaint() {
    paint = null;
    CSS.highlights?.delete("qm-paint");
  }

  function center() {
    if (state === "follow" && mouse) return mouse;
    if (pin) return { x: pin.x - scrollX, y: pin.y - scrollY };
    return mouse ?? { x: innerWidth / 2, y: innerHeight / 2 };
  }

  // Blobs fan out to the right, or to the left near the right edge, and tilt away from the top
  // and bottom edges so every blob and label stays on screen.
  function spots({ x, y }) {
    if (side === "right" && x > innerWidth - 240) side = "left";
    else if (side === "left" && x < innerWidth - 290) side = "right";
    el.root.dataset.side = side;
    const tilt = y < 96 ? 42 : y > innerHeight - 96 ? -42 : 0;
    return [-48, 0, 48].map((deg) => {
      const a = ((deg + tilt) * Math.PI) / 180;
      return { x: x + (side === "right" ? 1 : -1) * REACH * Math.cos(a), y: y + REACH * Math.sin(a) };
    });
  }

  // The bar grows beside the caret, on whichever side has room; on narrow screens it sits below or above.
  function barRect({ x, y }) {
    const w = Math.min(BAR_W, innerWidth - EDGE * 2);
    const gap = CARET_GAP;
    if (x + gap + w <= innerWidth - EDGE) return { x: x + gap, y: clamp(y - BAR_H / 2, EDGE, innerHeight - EDGE - BAR_H), w, h: BAR_H };
    if (x - gap - w >= EDGE) return { x: x - gap - w, y: clamp(y - BAR_H / 2, EDGE, innerHeight - EDGE - BAR_H), w, h: BAR_H };
    const below = y + gap + BAR_H <= innerHeight - EDGE;
    return { x: clamp(x - w / 2, EDGE, innerWidth - EDGE - w), y: below ? y + gap : y - gap - BAR_H, w, h: BAR_H };
  }

  function run() {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const c = center();
    const targets = spots(c);
    const bar = barRect(c);
    presence.step(dt, ...(presence.to > 0 ? FEEL.open : FEEL.close));

    blobs.forEach((b, i) => {
      let to;
      let feel = FEEL.close;
      if (b.phase === "out") {
        to = { ...targets[i], w: BLOB, h: BLOB };
        feel = state === "follow" && b.w.settled ? FEEL.follow : FEEL.open;
      } else if (b.phase === "bar") {
        to = { x: bar.x + bar.w / 2, y: bar.y + bar.h / 2, w: bar.w, h: bar.h };
        feel = FEEL.bar;
      } else {
        to = { ...c, w: 0, h: 0 };
      }
      b.x.to = to.x;
      b.y.to = to.y;
      b.w.to = to.w;
      b.h.to = to.h;
      for (const s of [b.x, b.y, b.w, b.h]) s.step(dt, ...feel);
    });

    draw(c, bar);

    const done = state === "closing" && presence.v < 0.02 && blobs.every((b) => b.w.v < 0.5);
    if (done) {
      setState("closed");
      el.root.hidden = true;
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function draw(c, bar) {
    el.caret.style.transform = `translate(${c.x}px, ${c.y}px) scale(${clamp(presence.v, 0, 1.15)})`;

    blobs.forEach((b, i) => {
      const w = Math.max(b.w.v, 0);
      const h = Math.max(b.h.v, 0);
      const rect = el.rects[i];
      rect.setAttribute("x", b.x.v - w / 2);
      rect.setAttribute("y", b.y.v - h / 2);
      rect.setAttribute("width", w);
      rect.setAttribute("height", h);
      rect.setAttribute("rx", Math.min(w, h) / 2);
      el.buttons[i].style.transform = `translate(${b.x.v}px, ${b.y.v}px)`;
      el.buttons[i].classList.toggle("is-out", b.phase === "out");
    });

    el.bar.style.transform = `translate(${bar.x}px, ${bar.y}px)`;
    el.bar.style.width = `${bar.w}px`;
  }

  function later(ms, fn) {
    timers.push(setTimeout(fn, ms));
  }

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
  }
}

function build() {
  const root = document.createElement("div");
  root.className = "qm";
  root.hidden = true;
  root.innerHTML = `
    <svg class="qm-goo" aria-hidden="true">
      <defs>
        <filter id="qm-goo" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" result="shape" />
          <feColorMatrix in="shape" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 60 -29.5" result="solid" />
          <feMorphology in="solid" operator="dilate" radius="1" result="ring-a" />
          <feFlood flood-color="#000" flood-opacity="0.07" />
          <feComposite in2="ring-a" operator="in" result="ring" />
          <feGaussianBlur in="shape" stdDeviation="3" />
          <feOffset dy="2" result="s2-o" />
          <feFlood flood-color="#000" flood-opacity="0.06" />
          <feComposite in2="s2-o" operator="in" result="s2" />
          <feGaussianBlur in="shape" stdDeviation="16" />
          <feOffset dy="6" result="s3-o" />
          <feFlood flood-color="#000" flood-opacity="0.09" />
          <feComposite in2="s3-o" operator="in" result="s3" />
          <feMerge>
            <feMergeNode in="s3" />
            <feMergeNode in="s2" />
            <feMergeNode in="ring" />
            <feMergeNode in="shape" />
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#qm-goo)">
        ${MODES.map(() => `<rect class="qm-blob" />`).join("")}
      </g>
    </svg>
    <span class="qm-caret" aria-hidden="true">
      <svg viewBox="0 0 20 30">
        <defs>
          <linearGradient id="qm-caret-fill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#3d7bff" />
            <stop offset="1" stop-color="#21c6d4" />
          </linearGradient>
          <linearGradient id="qm-caret-shine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#fff" stop-opacity="0.55" />
            <stop offset="1" stop-color="#fff" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path class="qm-caret-body" d="M4 3h12a2 2 0 0 1 0 4h-4v16h4a2 2 0 0 1 0 4H4a2 2 0 0 1 0-4h4V7H4a2 2 0 0 1 0-4Z" />
        <path class="qm-caret-shine" d="M8.9 7.6h1.2v14.8H8.9z" />
      </svg>
    </span>
    ${MODES.map(
      (m, i) => `
      <button type="button" class="qm-btn" data-mode="${m.id}" style="--i: ${i}" tabindex="-1">
        <svg class="qm-icon" viewBox="0 0 16 16" aria-hidden="true">${m.icon}</svg>
        <span class="qm-label">${m.label}<kbd>${m.key.toUpperCase()}</kbd></span>
      </button>`,
    ).join("")}
    <form class="qm-bar" autocomplete="off">
      <span class="qm-chip"></span>
      <input type="text" aria-label="Prompt" />
      <kbd class="qm-enter" aria-hidden="true">↵</kbd>
    </form>`;
  return {
    root,
    rects: [...root.querySelectorAll(".qm-blob")],
    caret: root.querySelector(".qm-caret"),
    buttons: [...root.querySelectorAll(".qm-btn")],
    bar: root.querySelector(".qm-bar"),
    chip: root.querySelector(".qm-chip"),
    input: root.querySelector(".qm-bar input"),
  };
}

class Spring {
  constructor(value) {
    this.snap(value);
  }
  snap(value) {
    this.v = this.to = value;
    this.vel = 0;
  }
  step(dt, stiffness, damping) {
    // Two half steps keep stiff springs steady when a frame runs long.
    for (let i = 0; i < 2; i++) {
      this.vel += (stiffness * (this.to - this.v) - damping * this.vel) * (dt / 2);
      this.v += this.vel * (dt / 2);
    }
  }
  get settled() {
    return Math.abs(this.to - this.v) < 0.5 && Math.abs(this.vel) < 5;
  }
}

const isTyping = (target) => target.closest?.("input, textarea, select, [contenteditable='true']");
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
