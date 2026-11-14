import { respond } from "./fake/assistant.js";

// A floating chat window. It opens beside where the request came from, stays fully on screen,
// can be dragged by its header, minimised to a pill, expanded, or closed.

const W = 400;
const H = 560;
const EDGE = 16;
const GAP = 12;

export function chatPanel({ article, onClose }) {
  const el = build();
  document.body.append(el.panel, el.dock);

  let turn = 0;
  let place = null;
  let busy = false;

  el.close.addEventListener("click", close);
  el.minimise.addEventListener("click", minimise);
  el.dock.addEventListener("click", restore);
  el.expand.addEventListener("click", () => {
    el.panel.classList.add("is-resizing");
    el.panel.classList.toggle("is-expanded");
    el.expand.setAttribute("aria-label", el.panel.classList.contains("is-expanded") ? "Shrink" : "Expand");
    layout();
    setTimeout(() => el.panel.classList.remove("is-resizing"), 320);
  });
  el.compose.addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = el.textarea.value.trim();
    if (!prompt || busy) return;
    el.textarea.value = "";
    grow();
    send({ mode: "ask", label: "Ask", prompt, context: null });
  });
  el.textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.compose.requestSubmit();
    }
  });
  el.textarea.addEventListener("input", grow);
  addEventListener("resize", () => !el.panel.hidden && layout());
  dragByHeader();

  return { ask };

  // Opens the window (or reuses it) and sends the first message of a request from the menu.
  function ask({ mode, label, prompt, context, from, avoid }) {
    if (el.panel.hidden && el.dock.hidden) {
      turn = 0;
      el.log.innerHTML = "";
      el.title.textContent = "New chat";
      el.panel.classList.remove("is-expanded");
      place = spotNear(from, avoid);
      el.panel.hidden = false;
      layout();
      growFrom(from);
    } else restore();
    send({ mode, label, prompt, context });
  }

  async function send({ mode, label, prompt, context }) {
    busy = true;
    if (turn === 0) el.title.textContent = shorten(prompt, 38);
    el.log.insertAdjacentHTML(
      "beforeend",
      `<div class="msg msg-user">
        ${context ? `<blockquote class="msg-quote">${escape(shorten(context, 180))}</blockquote>` : ""}
        <p class="msg-bubble">${turn === 0 ? `<span class="msg-mode">${label}</span>` : ""}${escape(prompt)}</p>
      </div>`,
    );
    const reply = document.createElement("div");
    reply.className = "msg msg-ai is-thinking";
    reply.innerHTML = `<div class="msg-text"><span class="dots"><i></i><i></i><i></i></span></div>`;
    el.log.append(reply);
    scrollDown(true);

    const { stream, attachment } = respond({ mode, prompt, context, article, turn });
    turn++;
    let text = "";
    for await (const piece of stream) {
      text += piece;
      reply.classList.remove("is-thinking");
      reply.firstElementChild.innerHTML = paragraphs(text);
      scrollDown();
    }
    reply.classList.add("is-done");
    if (attachment) {
      reply.insertAdjacentHTML("beforeend", renderAttachment(attachment));
      scrollDown();
    }
    busy = false;
  }

  // Tries below, above, right and left of the source, then the window's sides, preferring a spot
  // that leaves the painted passage visible; if nothing fits, keeps it inside the window.
  function spotNear(from, avoid) {
    const w = Math.min(W, innerWidth - EDGE * 2);
    const h = Math.min(H, innerHeight - EDGE * 2);
    const x = clamp(from.left, EDGE, innerWidth - EDGE - w);
    const y = clamp(from.top + from.height / 2 - h / 2, EDGE, innerHeight - EDGE - h);
    const options = [
      { x, y: from.bottom + GAP },
      { x, y: from.top - GAP - h },
      { x: from.right + GAP, y },
      { x: from.left - GAP - w, y },
      { x: innerWidth - EDGE - w, y },
      { x: EDGE, y },
    ];
    const fits = (o) => o.x >= EDGE && o.y >= EDGE && o.x + w <= innerWidth - EDGE && o.y + h <= innerHeight - EDGE;
    const clear = (o) => !avoid || o.x > avoid.right || o.x + w < avoid.left || o.y > avoid.bottom || o.y + h < avoid.top;
    return (
      options.find((o) => fits(o) && clear(o)) ??
      options.find(fits) ?? { x, y: clamp(from.bottom + GAP, EDGE, innerHeight - EDGE - h) }
    );
  }

  function layout() {
    const expanded = el.panel.classList.contains("is-expanded");
    const w = Math.min(expanded ? 760 : W, innerWidth - EDGE * 2);
    const h = Math.min(expanded ? innerHeight * 0.86 : H, innerHeight - EDGE * 2);
    const x = expanded ? (innerWidth - w) / 2 : clamp(place.x, EDGE, innerWidth - EDGE - w);
    const y = expanded ? (innerHeight - h) / 2 : clamp(place.y, EDGE, innerHeight - EDGE - h);
    Object.assign(el.panel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }

  // The window swells out of the prompt bar it replaces.
  function growFrom(from) {
    const box = el.panel.getBoundingClientRect();
    el.panel.animate(
      [
        {
          transform: `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${from.width / box.width}, ${from.height / box.height})`,
          borderRadius: "24px",
          opacity: 0.4,
        },
        { transform: "none", borderRadius: "20px", opacity: 1 },
      ],
      { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    el.textarea.focus({ preventScroll: true });
  }

  function minimise() {
    el.panel.hidden = true;
    el.dock.querySelector(".chat-dock-title").textContent = el.title.textContent;
    el.dock.hidden = false;
  }

  function restore() {
    el.dock.hidden = true;
    el.panel.hidden = false;
    layout();
  }

  function close() {
    el.panel.hidden = true;
    el.dock.hidden = true;
    onClose?.();
  }

  function dragByHeader() {
    el.head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button") || el.panel.classList.contains("is-expanded")) return;
      const start = { x: e.clientX - place.x, y: e.clientY - place.y };
      el.head.setPointerCapture(e.pointerId);
      const move = (m) => {
        place = { x: m.clientX - start.x, y: m.clientY - start.y };
        layout();
      };
      el.head.addEventListener("pointermove", move);
      el.head.addEventListener("pointerup", () => el.head.removeEventListener("pointermove", move), { once: true });
    });
  }

  function grow() {
    el.textarea.style.height = "auto";
    el.textarea.style.height = `${Math.min(el.textarea.scrollHeight, 120)}px`;
  }

  function scrollDown(force) {
    const near = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
    if (force || near) el.log.scrollTop = el.log.scrollHeight;
  }
}

function renderAttachment(a) {
  if (a.type === "results") {
    return `<div class="attach attach-results">${a.groups
      .map(
        (g) => `
        <p class="res-label">${g.label}</p>
        <ul>${g.items
          .map(
            (it) => `
            <li><button type="button" class="res-item">
              <span class="res-title">${it.title}</span>
              <span class="res-meta">${it.meta}</span>
              <span class="res-note">${it.note}</span>
            </button></li>`,
          )
          .join("")}</ul>`,
      )
      .join("")}</div>`;
  }
  if (a.type === "chart") return `<figure class="attach attach-chart">${lineChart(a)}<figcaption>${a.title}</figcaption></figure>`;
  return "";
}

function lineChart({ series, marker, title }) {
  const w = 340;
  const h = 150;
  const pad = { l: 30, r: 8, t: 12, b: 22 };
  const years = series.map(([y]) => y);
  const max = 30000;
  const x = (y) => pad.l + ((y - years[0]) / (years.at(-1) - years[0])) * (w - pad.l - pad.r);
  const y = (v) => h - pad.b - (v / max) * (h - pad.t - pad.b);
  const line = series.map(([yr, v], i) => `${i ? "L" : "M"}${x(yr).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(years.at(-1))},${y(0)}L${x(years[0])},${y(0)}Z`;
  const grid = [10000, 20000, 30000]
    .map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" /><text x="${pad.l - 6}" y="${y(v) + 3}" text-anchor="end">${v / 1000}k</text>`)
    .join("");
  const ticks = [2005, 2010, 2015, 2020, 2025].map((yr) => `<text x="${x(yr)}" y="${h - 6}" text-anchor="middle">${yr}</text>`).join("");
  let mark = "";
  if (marker) {
    const i = years.findIndex((yr) => yr > marker.at);
    const [y0, v0] = series[i - 1];
    const [y1, v1] = series[i];
    const v = v0 + ((marker.at - y0) / (y1 - y0)) * (v1 - v0);
    const mx = x(marker.at);
    mark = `<line class="mark-line" x1="${mx}" x2="${mx}" y1="${pad.t}" y2="${y(0)}" />
      <circle class="mark-dot" cx="${mx}" cy="${y(v)}" r="4" />
      <text class="mark-label" x="${mx - 6}" y="${pad.t + 8}" text-anchor="end">${marker.label}</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">
    <g class="grid">${grid}</g><g class="ticks">${ticks}</g>
    <path class="area" d="${area}" /><path class="line" d="${line}" />${mark}
  </svg>`;
}

function build() {
  const panel = document.createElement("section");
  panel.className = "chat";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat");
  panel.innerHTML = `
    <header class="chat-head">
      <h2 class="chat-title">New chat</h2>
      <div class="chat-tools">
        <button type="button" class="chat-tool" data-act="minimise" aria-label="Minimise"><svg viewBox="0 0 16 16"><path d="M4 8.5h8" /></svg></button>
        <button type="button" class="chat-tool" data-act="expand" aria-label="Expand"><svg viewBox="0 0 16 16"><path d="M9.5 3H13v3.5M13 3 9 7M6.5 13H3V9.5M3 13l4-4" /></svg></button>
        <button type="button" class="chat-tool" data-act="close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </div>
    </header>
    <div class="chat-log" aria-live="polite"></div>
    <form class="chat-compose">
      <textarea rows="1" placeholder="Ask a follow-up…" aria-label="Message"></textarea>
      <div class="chat-compose-row">
        <button type="button" class="chat-tool" aria-label="Add"><svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></svg></button>
        <button type="submit" class="chat-send" aria-label="Send"><svg viewBox="0 0 16 16"><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg></button>
      </div>
    </form>`;
  const dock = document.createElement("button");
  dock.type = "button";
  dock.className = "chat-dock";
  dock.hidden = true;
  dock.innerHTML = `<span class="chat-dock-dot"></span><span class="chat-dock-title"></span>`;
  return {
    panel,
    dock,
    head: panel.querySelector(".chat-head"),
    title: panel.querySelector(".chat-title"),
    close: panel.querySelector('[data-act="close"]'),
    minimise: panel.querySelector('[data-act="minimise"]'),
    expand: panel.querySelector('[data-act="expand"]'),
    log: panel.querySelector(".chat-log"),
    compose: panel.querySelector(".chat-compose"),
    textarea: panel.querySelector("textarea"),
  };
}

const paragraphs = (text) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p)}</p>`)
    .join("");
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
