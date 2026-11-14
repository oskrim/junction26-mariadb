// The query bar. Press Q and a bar grows out of a caret at the pointer; type anything and Enter hands it to
// onSubmit, which works out whether it is a question, a search, something to learn or something to show.
// Text selected in the article before pressing Q, or painted while the bar is open, goes along with it.
//
// States: closed → bar (typing) → closing.

export const OPEN_KEY = "q";

// While the prompt bar is open, the caret becomes the Wikipedia globe.
const GLOBE = new URL("files/wikipedia-globe.png", import.meta.url).href;


const PLACEHOLDER = "Ask anything: explain, find, compare, show…";
const FALLBACK = "What is this about?";

const BAR_W = 460;
const BAR_H = 48;
const EDGE = 16;
const CARET_GAP = 20;

// Spring settings: stiffness and damping. "open" overshoots a little.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const FEEL = reduceMotion ? { open: [900, 60], close: [900, 60], bar: [900, 60] } : { open: [380, 20], close: [520, 46], bar: [300, 25] };

export function cursorMenu({ root, onSubmit }) {
  const el = build();
  document.body.append(el.root);

  let state = "closed";
  let mouse = null;
  let pin = null; // page coordinates of the caret
  let paint = null;
  let painting = false;
  let timers = [];
  let frame = 0;
  let last = 0;

  const presence = new Spring(0); // 0 hidden, 1 shown: scales the caret in and out
  const blob = { x: new Spring(0), y: new Spring(0), w: new Spring(0), h: new Spring(0), open: false };

  addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }), { passive: true });

  addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.target === el.input) {
        if (key === "escape") {
          e.preventDefault();
          close();
        }
        return;
      }
      if (isTyping(e.target)) return;
      if (state === "closed" || state === "closing") {
        if (key === OPEN_KEY && !e.repeat) {
          e.preventDefault();
          open();
        }
      } else if (key === "escape" || key === OPEN_KEY) {
        e.preventDefault();
        close();
      }
    },
    true,
  );

  // While the bar is open, a stroke in the article paints the passage the request is about; a click
  // anywhere else closes the bar.
  addEventListener("mousedown", (e) => {
    if (state !== "bar" || e.button !== 0 || el.bar.contains(e.target)) return;
    if (root.contains(e.target)) painting = true;
    else if (!e.target.closest(".chat, .chat-tray, .chat-history")) close();
  });

  addEventListener("mouseup", (e) => {
    if (!painting || e.button !== 0) return;
    painting = false;
    if (state !== "bar") return;
    if (takeSelection()) showChip();
    else if (!el.bar.contains(e.target)) return close();
    el.input.focus({ preventScroll: true });
  });

  el.bar.addEventListener("submit", (e) => {
    e.preventDefault();
    const from = el.bar.getBoundingClientRect();
    onSubmit({ mode: "auto", label: null, prompt: el.input.value.trim() || FALLBACK, context: paint?.text ?? null, from });
    close({ keepPaint: true });
  });

  return { clearPaint };

  function open() {
    reset();
    takeSelection();
    const at = mouse ?? { x: innerWidth / 2, y: innerHeight / 2 };
    pin = { x: at.x + scrollX, y: at.y + scrollY };
    setState("bar");
    presence.snap(0);
    presence.to = 1;
    for (const [s, v] of [[blob.x, at.x], [blob.y, at.y], [blob.w, 0], [blob.h, 0]]) s.snap(v);
    blob.open = true;
    el.input.value = "";
    el.input.placeholder = PLACEHOLDER;
    showChip();
    el.root.hidden = false;
    later(reduceMotion ? 0 : 150, () => {
      el.bar.classList.add("is-visible");
      el.input.focus({ preventScroll: true });
    });
    run();
  }

  function close({ keepPaint = false } = {}) {
    reset();
    setState("closing");
    if (!keepPaint) clearPaint();
    blob.open = false;
    later(90, () => (presence.to = 0));
    el.input.blur();
  }

  function showChip() {
    el.chip.textContent = paint ? `“${shorten(paint.text, 26)}”` : "Whole article";
    el.chip.classList.toggle("is-whole", !paint);
  }

  function setState(next) {
    state = next;
    el.root.dataset.state = next;
    if (next !== "bar") el.bar.classList.remove("is-visible");
  }

  // Uses whatever is selected in the article as the painted passage, then clears the native
  // selection so typing in the bar can't wipe it out.
  function takeSelection() {
    const selection = getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const text = range.toString().replace(/\s+/g, " ").trim();
    if (!text || !root.contains(range.commonAncestorContainer)) return false;
    paint = { range: range.cloneRange(), text };
    CSS.highlights?.set("qm-paint", new Highlight(paint.range));
    selection.removeAllRanges();
    return true;
  }

  function clearPaint() {
    paint = null;
    CSS.highlights?.delete("qm-paint");
  }

  function center() {
    return pin ? { x: pin.x - scrollX, y: pin.y - scrollY } : { x: innerWidth / 2, y: innerHeight / 2 };
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
    const bar = barRect(c);
    presence.step(dt, ...(presence.to > 0 ? FEEL.open : FEEL.close));
    const to = blob.open ? { x: bar.x + bar.w / 2, y: bar.y + bar.h / 2, w: bar.w, h: bar.h } : { ...c, w: 0, h: 0 };
    blob.x.to = to.x;
    blob.y.to = to.y;
    blob.w.to = to.w;
    blob.h.to = to.h;
    for (const s of [blob.x, blob.y, blob.w, blob.h]) s.step(dt, ...(blob.open ? FEEL.bar : FEEL.close));
    draw(c, bar);

    if (state === "closing" && presence.v < 0.02 && blob.w.v < 0.5) {
      setState("closed");
      el.root.hidden = true;
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function draw(c, bar) {
    el.caret.style.transform = `translate(${c.x}px, ${c.y}px) scale(${clamp(presence.v, 0, 1.15)})`;
    const w = Math.max(blob.w.v, 0);
    const h = Math.max(blob.h.v, 0);
    el.rect.setAttribute("x", blob.x.v - w / 2);
    el.rect.setAttribute("y", blob.y.v - h / 2);
    el.rect.setAttribute("width", w);
    el.rect.setAttribute("height", h);
    el.rect.setAttribute("rx", Math.min(w, h) / 2);
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
        <rect class="qm-blob" />
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
      <img class="qm-globe" src="${GLOBE}" alt="" />
    </span>
    <form class="qm-bar" autocomplete="off">
      <span class="qm-chip"></span>
      <input type="text" aria-label="Ask anything" />
      <kbd class="qm-enter" aria-hidden="true">↵</kbd>
    </form>`;
  return {
    root,
    rect: root.querySelector(".qm-blob"),
    caret: root.querySelector(".qm-caret"),
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
}

const isTyping = (target) => target.closest?.("input, textarea, select, [contenteditable='true']");
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
