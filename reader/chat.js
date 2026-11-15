import { PAST_CHATS, respond } from "./assistant.js";
import { citeLinks, learn, sourcesHtml } from "./learn.js";
import { modelHtml, mountModel } from "./model3d.js";
import { stepsView } from "./steps.js";
import { formatAnswer } from "./format.js";
import "./cite-tip.js";

// Chats. Every request from the menu starts a new chat. Open chats are tabs in the tray at the
// bottom right; closed ones move to History. One window shows the active chat, either floating
// beside where the request came from (drag it by the header) or, dragged to the right edge, docked there
// as a side panel.

const W = 360; // the same as Explore's article panel
const EDGE = 16;
const TRAY = 60;
const SIDE_W = 520;

// A new chat opens on the left beside the chat tray in the article and in Explore (whose details panel
// is on the right), and on the right elsewhere.
function newChatX() {
  const left = ["article", "explore"].includes(document.body.dataset.view);
  return left ? 20 : innerWidth - 20 - Math.min(W, innerWidth - EDGE * 2);
}

// Panels start 20px below the top bar, like Explore's details panel. The bar scrolls away with the article, so
// once it is gone they start 20px below the top of the window.
function topLine() {
  return Math.max(document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0, 0) + 21;
}

export function chatPanel({ article, onClose }) {
  const el = build();
  document.body.append(el.panel, el.tray, el.history);

  const chats = [];
  const past = PAST_CHATS.map((p) => ({ ...p, log: null }));
  let active = null;
  let docked = false;
  let place = null;

  el.close.addEventListener("click", () => closeChat(active));
  el.minimise.addEventListener("click", hide);
  // An empty chat is reused rather than stacking up more blank tabs.
  el.newChat.addEventListener("click", newChat);
  el.historyButton.addEventListener("click", () => toggleHistory());
  el.tabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".chat-tab");
    if (!tab) return;
    const chat = chats.find((c) => c.id === tab.dataset.id);
    if (e.target.closest(".chat-tab-close")) closeChat(chat);
    else if (chat === active && !el.panel.hidden) hide();
    else show(chat);
  });
  el.history.addEventListener("click", (e) => {
    const item = e.target.closest("[data-index]");
    if (!item) return;
    const [chat] = past.splice(Number(item.dataset.index), 1);
    toggleHistory(false);
    chats.push(chat);
    show(chat);
  });
  addEventListener("mousedown", (e) => {
    if (!el.history.hidden && !e.target.closest(".chat-history, .tray-history")) toggleHistory(false);
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || el.history.hidden) return;
    e.preventDefault(); // this Esc closes only the History list
    toggleHistory(false);
  });

  // N opens a new chat; Esc closes the chat window to its tab while you're working in it (typing there, or
  // the last thing you clicked), so Esc elsewhere still belongs to the rest of the page.
  let inChat = false;
  let lastKey = 0; // N is a shortcut only on its own, not in the middle of typing that landed on the page
  addEventListener("pointerdown", (e) => (inChat = !!e.target.closest?.(".chat")), true);
  addEventListener("keydown", (e) => {
    const typedJustNow = performance.now() - lastKey < 1000;
    if (e.key.length === 1) lastKey = performance.now();
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented || menuOpen()) return;
    const typing = e.target.closest?.("input, textarea, select, [contenteditable='true']");
    if (e.key === "Escape" && !el.panel.hidden && (inChat || e.target === el.textarea)) {
      e.preventDefault();
      el.textarea.blur();
      inChat = false;
      hide();
    } else if (e.key.toLowerCase() === "n" && !e.repeat && !typing && !typedJustNow) {
      e.preventDefault();
      newChat();
    }
  });
  el.compose.addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = el.textarea.value.trim();
    if (!prompt || !active || active.busy) return;
    el.textarea.value = "";
    grow();
    send(active, { mode: "ask", label: "Ask", prompt, context: null });
  });
  el.textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.compose.requestSubmit();
    }
  });
  el.textarea.addEventListener("input", grow);
  addEventListener("resize", () => !el.panel.hidden && layout());
  // The top bar slides in and out of view while scrolling near the top; the panel stays clear of it.
  let topSeen = topLine();
  addEventListener(
    "scroll",
    () => {
      if (el.panel.hidden || topLine() === topSeen) return;
      topSeen = topLine();
      layout();
    },
    { passive: true },
  );
  dragByHeader();
  renderTray();

  return { ask, hide };

  // An empty chat is reused rather than stacking up more blank tabs.
  function newChat() {
    show(chats.find((c) => c.turn === 0 && !c.busy) ?? create({ title: "New chat" }));
  }

  // A request from the menu: a new chat, opened beside where it came from.
  function ask({ mode, label, prompt, context, from }) {
    const chat = create({ title: shorten(prompt, 38) });
    show(chat, { from });
    send(chat, { mode, label, prompt, context });
  }

  function create({ title }) {
    const chat = { id: String(Date.now() + Math.random()), title, turn: 0, busy: false, log: null };
    chats.push(chat);
    return chat;
  }

  function show(chat, { from } = {}) {
    active = chat;
    if (!chat.log) chat.log = makeLog(chat);
    for (const c of chats) if (c.log) c.log.hidden = c !== chat;
    if (!chat.log.isConnected) el.logs.append(chat.log);
    el.title.textContent = chat.title;
    const wasHidden = el.panel.hidden;
    el.panel.hidden = false;
    inChat = true;
    if (!docked && (from || !place)) place = { x: newChatX(), y: topLine() };
    layout();
    if (!docked && from) growFrom(from);
    else if (wasHidden) popIn();
    renderTray();
    // Chats from the menu leave the keyboard alone, so Q keeps opening the menu right away.
    if (!from) el.textarea.focus({ preventScroll: true });
    chat.log.scrollTop = chat.log.scrollHeight;
  }

  function hide() {
    el.panel.hidden = true;
    sync();
    renderTray();
  }

  function closeChat(chat) {
    if (!chat) return;
    chats.splice(chats.indexOf(chat), 1);
    chat.log?.remove();
    if (chat.turn > 0 || chat.messages) past.unshift({ ...chat, label: chat.label ?? "Ask", when: chat.when ?? "Just now" });
    if (chat === active) {
      active = null;
      hide();
    } else renderTray();
    onClose?.();
  }

  async function send(chat, { mode, label, prompt, context }) {
    chat.busy = true;
    chat.label ??= label;
    if (chat.turn === 0) {
      chat.title = shorten(prompt, 38);
      if (chat === active) el.title.textContent = chat.title;
    }
    renderTray();
    chat.log.insertAdjacentHTML("beforeend", userMessage({ prompt, context, label: chat.turn === 0 ? label : null }));
    const reply = document.createElement("div");
    reply.className = "msg msg-ai is-thinking";
    reply.innerHTML = `<div class="msg-text"><span class="dots"><i></i><i></i><i></i></span></div>`;
    chat.log.append(reply);
    scrollDown(chat.log, true);
    const body = reply.querySelector(".msg-text");
    const steps = stepsView(reply);
    const onStep = (name, data) => {
      steps.update(name, data);
      scrollDown(chat.log);
    };

    let text = "";
    // However the answer ends, the chat takes the next message: a broken stream must not leave it busy for good.
    try {
      const { stream, attachment } = (mode === "learn" ? learn : respond)({ mode, prompt, context, article, turn: chat.turn, history: (chat.history ??= []), onStep });
      chat.turn++;
      for await (const piece of stream) {
        text += piece;
        steps.fold();
        reply.classList.remove("is-thinking");
        body.innerHTML = paragraphs(text);
        scrollDown(chat.log);
      }
      reply.classList.add("is-done");
      const shown = await attachment;
      if (shown?.type === "sources" || shown?.type === "quotes") body.innerHTML = citeLinks(body.innerHTML, shown);
      if (shown) {
        reply.insertAdjacentHTML("beforeend", renderAttachment(shown));
        reply.querySelectorAll("[data-model]").forEach(mountModel);
        scrollDown(chat.log);
      }
    } catch (error) {
      console.error("chat answer failed", error);
      reply.classList.remove("is-thinking");
      reply.classList.add("is-done");
      body.innerHTML = paragraphs(`${text}${text ? "\n\n" : ""}Sorry, the answer stopped. Try asking again.`);
    } finally {
      chat.busy = false;
      renderTray();
    }
  }

  // Past chats arrive as plain messages; their log is built the first time they're opened.
  function makeLog(chat) {
    const log = document.createElement("div");
    log.className = "chat-log";
    log.setAttribute("aria-live", "polite");
    for (const m of chat.messages ?? []) {
      log.insertAdjacentHTML(
        "beforeend",
        m.role === "user"
          ? userMessage({ prompt: m.text, label: chat.label })
          : `<div class="msg msg-ai is-done"><div class="msg-text">${paragraphs(m.text)}</div></div>`,
      );
    }
    chat.turn ||= chat.messages ? 1 : 0;
    return log;
  }

  function renderTray() {
    const open = !el.panel.hidden;
    // While an answer is still coming, the send button rests: the chat takes the next message after it.
    el.panel.classList.toggle("is-busy", Boolean(active?.busy));
    el.tabs.innerHTML = chats
      .map(
        (c) => `
        <span class="chat-tab${c === active && open ? " is-active" : ""}" data-id="${c.id}">
          <button type="button" class="chat-tab-open" title="${escape(c.title)}">
            <span class="chat-tab-dot${c.busy ? " is-busy" : ""}"></span><span class="chat-tab-title">${escape(c.title)}</span>
          </button>
          <button type="button" class="chat-tab-close" aria-label="Close ${escape(c.title)}">
            <svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" /></svg>
          </button>
        </span>`,
      )
      .join("");
    el.historyButton.classList.toggle("has-items", past.length > 0);
  }

  function toggleHistory(force) {
    const open = force ?? el.history.hidden;
    if (open) {
      el.history.innerHTML = past.length
        ? `<p class="chat-history-label">Earlier chats</p><ul>${past
            .map(
              (p, i) => `
              <li><button type="button" data-index="${i}">
                <span class="chat-history-title">${escape(p.title)}</span>
                <span class="chat-history-meta">${p.label} · ${p.when}</span>
              </button></li>`,
            )
            .join("")}</ul>`
        : `<p class="chat-history-empty">No earlier chats yet.</p>`;
    }
    el.history.hidden = !open;
    el.historyButton.setAttribute("aria-expanded", String(open));
  }

  function setDocked(next) {
    docked = next;
    el.panel.classList.add("is-resizing");
    layout();
    setTimeout(() => el.panel.classList.remove("is-resizing"), 340);
  }

  function floatSize() {
    return { w: Math.min(W, innerWidth - EDGE * 2), h: innerHeight - topLine() - TRAY };
  }

  function layout() {
    el.panel.classList.toggle("is-docked", docked);
    if (docked) {
      const w = Math.min(SIDE_W, innerWidth - 24);
      const top = topLine();
      Object.assign(el.panel.style, { left: `${innerWidth - 20 - w}px`, top: `${top}px`, width: `${w}px`, height: `${innerHeight - top - TRAY}px` });
    } else {
      const { w, h } = floatSize();
      const x = clamp(place.x, EDGE, innerWidth - EDGE - w);
      // Full height, from under the top bar down to the tray; moving it only moves it sideways.
      Object.assign(el.panel.style, { left: `${x}px`, top: `${topLine()}px`, width: `${w}px`, height: `${h}px` });
    }
    sync();
  }

  // The article makes room for the side panel while it's showing.
  function sync() {
    document.documentElement.classList.toggle("chat-docked", docked && !el.panel.hidden);
    document.documentElement.style.setProperty("--chat-side", `${SIDE_W + 24}px`);
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
      { duration: reduceMotion() ? 1 : 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }

  // Reopening from the tray rises up out of it.
  function popIn() {
    el.panel.animate(
      [
        { transform: "translateY(12px) scale(0.98)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: reduceMotion() ? 1 : 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }

  // Dragging floats the window; letting go near the right edge docks it.
  function dragByHeader() {
    el.head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      if (docked) {
        const box = el.panel.getBoundingClientRect();
        docked = false;
        place = { x: e.clientX - floatSize().w / 2, y: box.top };
        layout();
      }
      const start = { x: e.clientX - place.x, y: e.clientY - place.y };
      el.head.setPointerCapture(e.pointerId);
      const move = (m) => {
        place = { x: m.clientX - start.x, y: m.clientY - start.y };
        layout();
        el.panel.classList.toggle("is-snapping", m.clientX > innerWidth - 32);
      };
      el.head.addEventListener("pointermove", move);
      el.head.addEventListener(
        "pointerup",
        (u) => {
          el.head.removeEventListener("pointermove", move);
          el.panel.classList.remove("is-snapping");
          if (u.clientX > innerWidth - 32) setDocked(true);
        },
        { once: true },
      );
    });
  }

  function grow() {
    el.textarea.style.height = "auto";
    el.textarea.style.height = `${Math.min(el.textarea.scrollHeight, 120)}px`;
  }
}

function userMessage({ prompt, context, label }) {
  return `<div class="msg msg-user">
    ${context ? `<blockquote class="msg-quote">${escape(shorten(context, 180))}</blockquote>` : ""}
    <p class="msg-bubble">${label ? `<span class="msg-mode">${label}</span>` : ""}${escape(prompt)}</p>
  </div>`;
}

function scrollDown(log, force) {
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (force || near) log.scrollTop = log.scrollHeight;
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
  if (a.type === "model") return modelHtml(a);
  if (a.type === "sources") return sourcesHtml(a);
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
        <button type="button" class="chat-tool" data-act="close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </div>
    </header>
    <div class="chat-logs"></div>
    <form class="chat-compose">
      <textarea rows="1" placeholder="Ask a follow-up…" aria-label="Message"></textarea>
      <div class="chat-compose-row">
        <button type="submit" class="chat-send" aria-label="Send"><svg viewBox="0 0 16 16"><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg></button>
      </div>
    </form>`;

  const tray = document.createElement("nav");
  tray.className = "chat-tray";
  tray.setAttribute("aria-label", "Chats");
  tray.innerHTML = `
    <div class="chat-tabs"></div>
    <button type="button" class="tray-btn tray-new" title="New chat (N)" aria-keyshortcuts="N">
      <svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></svg>New chat
    </button>
    <button type="button" class="tray-btn tray-history" aria-label="History" aria-expanded="false">
      <svg viewBox="0 0 16 16"><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.5 2.5v2.3h2.3M8 5.5V8l1.8 1.3" /></svg>
    </button>`;

  const history = document.createElement("div");
  history.className = "chat-history";
  history.hidden = true;

  return {
    panel,
    tray,
    history,
    head: panel.querySelector(".chat-head"),
    title: panel.querySelector(".chat-title"),
    close: panel.querySelector('[data-act="close"]'),
    minimise: panel.querySelector('[data-act="minimise"]'),
    logs: panel.querySelector(".chat-logs"),
    compose: panel.querySelector(".chat-compose"),
    textarea: panel.querySelector("textarea"),
    tabs: tray.querySelector(".chat-tabs"),
    newChat: tray.querySelector(".tray-new"),
    historyButton: tray.querySelector(".tray-history"),
  };
}

const paragraphs = formatAnswer;
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// The Q menu is open: its own keys (A, F, L, Esc) come first.
const menuOpen = () => document.querySelector(".qm")?.hidden === false;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
