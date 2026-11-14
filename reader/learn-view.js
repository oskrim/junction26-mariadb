// Learn: a wide sheet at the top of the page that turns one question into a short lesson. The server reads the
// article's links (POST /api/learn with shape "lesson") and writes a title, a one-line goal, 3 or 4 sections and the
// terms a newcomer would not know. A term opens in place with what it means here, and can become a lesson of its
// own; the lessons dived into form a trail at the top. Read shows the lesson as text with a box for questions;
// Listen (learn-audio.js) reads it aloud and takes questions in the middle.

import { citeLinks, learn } from "./learn.js";
import { stepsView } from "./steps.js";
import { listenView } from "./learn-audio.js";

const W = 920;
const EDGE = 16;
const TRAY = 60;

export function learnView({ article }) {
  const el = build();
  document.body.append(el.scrim, el.sheet);

  const trail = [];
  let current = null;
  let mode = "read";
  let listen = null;

  el.close.addEventListener("click", close);
  el.modes.addEventListener("click", (e) => {
    const button = e.target.closest("[data-mode]");
    if (button) setMode(button.dataset.mode);
  });
  el.crumbs.addEventListener("click", (e) => {
    const crumb = e.target.closest("[data-crumb]");
    if (crumb) show(trail[Number(crumb.dataset.crumb)]);
  });
  el.read.addEventListener("click", (e) => {
    const term = e.target.closest(".term");
    const dive = e.target.closest("[data-dive]");
    if (term) {
      current.openTerm = current.openTerm === term.dataset.term ? null : term.dataset.term;
      render(current);
    } else if (dive) diveInto(current, dive.dataset.dive);
  });
  el.compose.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = el.textarea.value.trim();
    if (!question || !current?.done || current.asking) return;
    el.textarea.value = "";
    grow();
    ask(current, question).then(() => scrollRead(true));
  });
  el.textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el.textarea.blur();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.compose.requestSubmit();
    }
  });
  el.textarea.addEventListener("input", grow);
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || el.sheet.hidden || isTyping(e.target) || !document.querySelector(".qm")?.hidden) return;
    close();
  });
  addEventListener("resize", () => !el.sheet.hidden && layout());

  return { open };

  // A request from the menu starts a new trail.
  function open({ prompt, context, from }) {
    trail.length = 0;
    el.read.replaceChildren();
    const lesson = create({ prompt, context });
    const wasHidden = el.sheet.hidden;
    el.sheet.hidden = el.scrim.hidden = false;
    document.documentElement.classList.add("lesson-open");
    layout();
    show(lesson);
    setMode("read");
    if (from) growFrom(from);
    else if (wasHidden) el.sheet.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: EASE });
  }

  function close() {
    listen?.destroy();
    listen = null;
    el.sheet.hidden = el.scrim.hidden = true;
    document.documentElement.classList.remove("lesson-open");
  }

  function create({ prompt, context, from = null }) {
    const lesson = { prompt, context, from, text: "", parsed: parse("", prompt), sources: null, done: false, history: [], followups: [], openTerm: null, asking: false };
    lesson.page = document.createElement("div");
    lesson.page.className = "lesson-page";
    lesson.page.innerHTML = `<div class="lesson-top"></div><div class="lesson-progress"></div><div class="lesson-content"></div><div class="lesson-qa"></div>`;
    el.read.append(lesson.page);
    trail.push(lesson);
    render(lesson);
    load(lesson);
    return lesson;
  }

  async function load(lesson) {
    const steps = stepsView(lesson.page.querySelector(".lesson-progress"));
    const { stream, attachment } = learn({
      prompt: lesson.prompt,
      context: lesson.context,
      article,
      history: lesson.history,
      shape: "lesson",
      onStep: (name, data) => steps.update(name, data),
    });
    for await (const piece of stream) {
      lesson.text += piece;
      steps.fold();
      render(lesson);
    }
    lesson.sources = await attachment;
    lesson.done = true;
    lesson.page.classList.toggle("is-failed", !lesson.text.trim());
    render(lesson);
    if (lesson === current) {
      renderChrome();
      listen?.update();
    }
  }

  // A question during the lesson, typed under it in Read or asked in the middle of Listen (at: the sentence it
  // interrupted). Answers short, with the lesson as history.
  async function ask(lesson, question, at = null) {
    const turn = { question, text: "", sources: null, done: false, at };
    lesson.followups.push(turn);
    lesson.asking = true;
    renderQa(lesson);
    const { stream, attachment } = learn({ prompt: question, context: lesson.context, article, history: lesson.history, shape: "reply" });
    for await (const piece of stream) {
      turn.text += piece;
      renderQa(lesson);
      if (lesson === current) listen?.update();
    }
    turn.sources = await attachment;
    turn.done = true;
    lesson.asking = false;
    renderQa(lesson);
    if (lesson === current) listen?.update();
    return turn;
  }

  // A term becomes a lesson of its own, after the one it came from in the trail.
  function diveInto(lesson, key) {
    const term = lesson.parsed.terms.get(key);
    const name = term?.name ?? key;
    const index = trail.indexOf(lesson);
    for (const later of trail.splice(index + 1)) later.page.remove();
    const next = create({
      prompt: `What is ${name}, and why does it matter for ${lesson.parsed.title ?? lesson.prompt}?`,
      context: term?.text.replace(CITES, "") ?? null,
      from: name,
    });
    show(next);
  }

  function show(lesson) {
    current = lesson;
    for (const l of trail) l.page.hidden = l !== lesson;
    renderChrome();
    if (mode === "listen") startListen();
    el.read.scrollTop = 0;
  }

  function setMode(next) {
    mode = next;
    el.sheet.dataset.mode = next;
    for (const b of el.modes.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === next));
    if (next === "listen") startListen();
    else {
      listen?.destroy();
      listen = null;
    }
  }

  function startListen() {
    listen?.destroy();
    listen = listenView({
      root: el.listen,
      bar: el.player,
      lesson: current,
      ask: (question, at) => ask(current, question, at),
    });
  }

  function renderChrome() {
    el.crumbs.innerHTML = trail
      .map(
        (l, i) => `${i ? `<svg class="lesson-crumb-sep" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" /></svg>` : ""}
        <button type="button" class="lesson-crumb${l === current ? " is-current" : ""}" data-crumb="${i}" ${l === current ? 'aria-current="page"' : ""}>${escape(
          shorten(l.from ?? l.parsed.title ?? l.prompt, 34),
        )}</button>`,
      )
      .join("");
    el.textarea.placeholder = current.done ? "Ask about this lesson…" : "The lesson is being written…";
  }

  function render(lesson) {
    lesson.parsed = parse(lesson.text, lesson.prompt);
    const { title, goal, sections, terms } = lesson.parsed;
    const started = lesson.text.trim().length > 0;
    lesson.page.querySelector(".lesson-top").innerHTML = `
      ${lesson.from ? `<p class="lesson-eyebrow">A term from ${escape(trail[trail.indexOf(lesson) - 1]?.parsed.title ?? "the lesson")}</p>` : `<p class="lesson-eyebrow">Learn · ${escape(article.title)}</p>`}
      <h1 class="lesson-title${title ? "" : " is-pending"}">${escape(title ?? shorten(lesson.prompt, 90))}</h1>
      ${goal ? `<p class="lesson-goal">${prose(goal, lesson)}</p>` : ""}
      ${lesson.context && !lesson.from ? `<blockquote class="lesson-quote">${escape(shorten(lesson.context, 220))}</blockquote>` : ""}`;
    lesson.page.querySelector(".lesson-content").innerHTML = `
      ${sourcesHtml(lesson)}
      ${!started && !lesson.done ? `<div class="lesson-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>` : ""}
      ${sections
        .map(
          (s) => `<section class="lesson-section">
            ${s.heading ? `<h2>${escape(s.heading.replace(/[{}]/g, ""))}</h2>` : ""}
            ${s.paras.map((p) => `<p>${prose(p, lesson)}</p>${termCard(p, lesson)}`).join("")}
          </section>`,
        )
        .join("")}
      ${
        lesson.done && terms.size
          ? `<section class="lesson-terms"><h2>Key terms</h2><dl>${[...terms]
              .map(
                ([key, t]) => `<div class="lesson-term-row"><dt><button type="button" data-dive="${escape(key)}">${escape(t.name)}<span aria-hidden="true">→</span></button></dt><dd>${prose(t.text, lesson)}</dd></div>`,
              )
              .join("")}</dl></section>`
          : ""
      }`;
    renderQa(lesson);
  }

  function renderQa(lesson) {
    lesson.page.querySelector(".lesson-qa").innerHTML = lesson.followups.length
      ? `<h2>Your questions</h2>${lesson.followups.map((t) => turnHtml(t, lesson)).join("")}`
      : "";
  }

  function scrollRead(smooth) {
    el.read.scrollTo({ top: el.read.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }

  function layout() {
    const top = (document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0) + EDGE;
    const w = Math.min(W, innerWidth - EDGE * 2);
    Object.assign(el.sheet.style, { left: `${(innerWidth - w) / 2}px`, top: `${top}px`, width: `${w}px`, height: `${innerHeight - top - TRAY - 4}px` });
  }

  // The sheet swells out of the prompt bar it replaces.
  function growFrom(from) {
    const box = el.sheet.getBoundingClientRect();
    el.sheet.animate(
      [
        { transform: `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${from.width / box.width}, ${from.height / box.height})`, borderRadius: "24px", opacity: 0.4 },
        { transform: "none", borderRadius: "22px", opacity: 1 },
      ],
      { duration: reduceMotion() ? 1 : 460, easing: EASE },
    );
    el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduceMotion() ? 1 : 300 });
  }

  function grow() {
    el.textarea.style.height = "auto";
    el.textarea.style.height = `${Math.min(el.textarea.scrollHeight, 120)}px`;
  }
}

// The lesson as the server writes it (LESSON_SHAPE in server/learn.py): "# title", "> goal", "## heading" and
// paragraphs, then "Terms:" and "term :: explanation" lines. Text in any other shape becomes one untitled section.
// A last line that may still be the start of "Terms:" waits for more text.
export function parse(text, prompt) {
  const [body, glossary = ""] = text.split(/^\s*Terms:\s*$/m);
  const lines = body.split("\n");
  if (/^\s*T(e(r(ms?)?)?)?$/.test(lines.at(-1))) lines.pop();
  const lesson = { title: null, goal: null, sections: [], terms: new Map() };
  let section = null;
  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("## ")) lesson.sections.push((section = { heading: line.slice(3), paras: [] }));
    else if (line.startsWith("# ")) lesson.title = line.slice(2).replace(/[{}]/g, "");
    else if (line.startsWith("> ") && !lesson.sections.length) lesson.goal = line.slice(2);
    else {
      if (!section) lesson.sections.push((section = { heading: null, paras: [] }));
      section.paras.push(line.replace(/^#+\s*/, ""));
    }
  }
  for (const line of glossary.split("\n")) {
    const m = line.match(/^\s*[-•]?\s*\{?([^{}]+?)\}?\s*::\s*(.+)$/);
    if (m) lesson.terms.set(key(m[1]), { name: m[1].trim(), text: m[2].trim() });
  }
  return lesson;
}

// Escaped text with its citation markers linked (or hidden until the sources arrive) and its terms as buttons.
export function prose(text, lesson, sources = lesson.sources) {
  let html = escape(text).replace(/\s*\[[\d,\s]*$/, "");
  html = sources ? citeLinks(html, sources) : html.replace(CITES, "");
  return html
    .replace(/\{([^{}]+)\}/g, (_, name) => {
      const k = key(name);
      const open = lesson.openTerm === k;
      const known = lesson.parsed.terms.has(k);
      return `<button type="button" class="term${open ? " is-open" : ""}${known ? "" : " is-unknown"}" data-term="${escape(k)}" aria-expanded="${open}">${name}</button>`;
    })
    .replace(/\{[^}]*$/, "");
}

// The open term's card goes under the paragraph that first mentions it.
function termCard(paragraph, lesson) {
  const k = lesson.openTerm;
  if (!k) return "";
  const first = lesson.parsed.sections.flatMap((s) => s.paras).find((p) => [...p.matchAll(/\{([^{}]+)\}/g)].some((m) => key(m[1]) === k));
  if (first !== paragraph) return "";
  const term = lesson.parsed.terms.get(k);
  const name = term?.name ?? [...paragraph.matchAll(/\{([^{}]+)\}/g)].find((m) => key(m[1]) === k)[1];
  return `<aside class="term-card">
    <p class="term-card-name">${escape(name)}</p>
    ${term ? `<p class="term-card-text">${prose(term.text, lesson)}</p>` : `<p class="term-card-text is-pending">${lesson.done ? "No explanation was written for this term." : "Explained once the lesson is written…"}</p>`}
    ${lesson.done ? `<button type="button" class="term-dive" data-dive="${escape(k)}">Learn about ${escape(name)}<span aria-hidden="true">→</span></button>` : ""}
  </aside>`;
}

// The linked articles the lesson was built from, each with why it was read.
function sourcesHtml(lesson) {
  const items = lesson.sources?.items ?? [];
  if (!items.length) return "";
  return `<div class="lesson-sources">
    <p class="lesson-sources-label">Built from ${items.length} of the ${lesson.sources.explored.toLocaleString("en-US")} linked articles</p>
    <ul>${items
      .map(
        (s) => `<li><a href="${escape(s.page_id ? `./?id=${s.page_id}` : s.url)}" target="_blank" rel="noopener">
          <span class="lesson-source-n">${s.n}</span>
          <span class="lesson-source-title">${escape(s.title)}</span>
          <span class="lesson-source-why">${escape(s.why)}</span>
        </a></li>`,
      )
      .join("")}</ul>
  </div>`;
}

export function turnHtml(turn, lesson) {
  return `<div class="lesson-turn${turn.done ? "" : " is-thinking"}">
    <p class="lesson-turn-q">${escape(turn.question)}</p>
    <div class="lesson-turn-a">${turn.text ? `<p>${prose(turn.text.trim(), lesson, turn.sources)}</p>` : `<span class="dots"><i></i><i></i><i></i></span>`}</div>
  </div>`;
}

function build() {
  const scrim = document.createElement("div");
  scrim.className = "lesson-scrim";
  scrim.hidden = true;

  const sheet = document.createElement("section");
  sheet.className = "lesson";
  sheet.hidden = true;
  sheet.dataset.mode = "read";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Lesson");
  sheet.innerHTML = `
    <header class="lesson-head">
      <nav class="lesson-crumbs" aria-label="Lessons"></nav>
      <div class="lesson-modes" role="group" aria-label="Mode">
        <button type="button" data-mode="read" aria-pressed="true">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5c2.2-.6 4.2-.3 6 1v9c-1.8-1.3-3.8-1.6-6-1zM14 3.5c-2.2-.6-4.2-.3-6 1v9c1.8-1.3 3.8-1.6 6-1z" /></svg>Read
        </button>
        <button type="button" data-mode="listen" aria-pressed="false">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" /><rect x="2.5" y="9" width="3" height="4.5" rx="1.2" /><rect x="10.5" y="9" width="3" height="4.5" rx="1.2" /></svg>Listen
        </button>
      </div>
      <button type="button" class="chat-tool lesson-close" aria-label="Close lesson"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
    </header>
    <div class="lesson-read"></div>
    <div class="lesson-listen"></div>
    <footer class="lesson-foot">
      <form class="lesson-compose">
        <textarea rows="1" aria-label="Question"></textarea>
        <button type="submit" class="chat-send" aria-label="Ask"><svg viewBox="0 0 16 16"><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg></button>
      </form>
      <div class="lesson-player"></div>
    </footer>`;
  return {
    scrim,
    sheet,
    crumbs: sheet.querySelector(".lesson-crumbs"),
    modes: sheet.querySelector(".lesson-modes"),
    close: sheet.querySelector(".lesson-close"),
    read: sheet.querySelector(".lesson-read"),
    listen: sheet.querySelector(".lesson-listen"),
    compose: sheet.querySelector(".lesson-compose"),
    textarea: sheet.querySelector(".lesson-compose textarea"),
    player: sheet.querySelector(".lesson-player"),
  };
}

export const CITES = /\s*\[\d+(?:\s*,\s*\d+)*\](?:\s*,?\s*\[\d+(?:\s*,\s*\d+)*\])*/g;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const key = (name) => name.trim().toLowerCase();
const isTyping = (target) => target.closest?.("input, textarea, select, [contenteditable='true']");
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
export const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
