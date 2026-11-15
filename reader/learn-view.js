// Learn: a wide sheet at the top of the page that turns one question into a short lesson. The server reads the
// article's links (POST /api/learn with shape "lesson") and writes a title, a one-line goal, 3 or 4 sections and the
// terms a newcomer would not know. A term opens in place with what it means here, and can become a lesson of its
// own; the lessons dived into form a trail at the top. Read shows the lesson as text, with a chat beside the sheet
// that changes it: each message rewrites the lesson in place (shape "revise"), with a note of what changed and Undo.
// Listen (learn-audio.js) reads it aloud; there the chat takes questions, typed (answered aloud, then the lesson goes
// on) or spoken with Talk, a live ElevenLabs voice chat about the lesson (voice.js) while the lesson waits.

import { emphasis } from "./format.js";
import { citeLinks, learn } from "./learn.js";
import { stepsView } from "./steps.js";
import { listenView } from "./learn-audio.js";
import { startTalk } from "./voice.js";

const W = 920;
const EDGE = 16;
const TRAY = 60;
const SIDE_W = 296; // the chat beside the sheet
const SIDE_GAP = 14;
const SIDE_MIN = 900; // narrower windows keep the question box under the lesson
const SUGGESTIONS = ["Be more specific", "Make it simpler", "Add a concrete example"];

export function learnView({ article }) {
  const el = build();
  document.body.append(el.scrim, el.sheet, el.edit);

  const trail = [];
  let current = null;
  let mode = "read";
  let listen = null;
  let talk = null; // the voice chat while it runs: { lesson, status, session }
  let talkError = "";
  let talkFrame = 0;

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
    const request = el.textarea.value.trim();
    if (!request || !current?.done || current.asking) return;
    if (mode === "listen" && !listen?.ask(request)) return;
    el.textarea.value = "";
    grow();
    if (mode === "read") revise(current, request);
  });
  el.edit.addEventListener("click", (e) => {
    const suggestion = e.target.closest("[data-suggest]");
    const undo = e.target.closest("[data-undo]");
    if (suggestion && current?.done && !current.asking) revise(current, suggestion.dataset.suggest);
    else if (undo) undoEdit(current, current.edits[Number(undo.dataset.undo)]);
    else if (e.target.closest(".lesson-talk")) toggleTalk();
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
    if (el.player.querySelector(".player-voices")) return; // Escape closes the voice menu first
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
    endTalk();
    listen?.destroy();
    listen = null;
    el.sheet.hidden = el.scrim.hidden = el.edit.hidden = true;
    document.documentElement.classList.remove("lesson-open");
  }

  function create({ prompt, context, from = null }) {
    const lesson = { prompt, context, from, text: "", parsed: parse("", prompt), sources: null, done: false, history: [], followups: [], edits: [], openTerm: null, asking: false };
    lesson.page = document.createElement("div");
    lesson.page.className = "lesson-page";
    lesson.page.innerHTML = `<div class="lesson-top"></div><div class="lesson-progress"></div><div class="lesson-content"></div>`;
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
      renderSide();
      listen?.update();
    }
  }

  // A message in the chat beside the sheet: the lesson is written again as asked. The old text stays, dimmed,
  // until the new one starts, then the new one streams over it; the chat says what changed and offers Undo.
  async function revise(lesson, request) {
    const edit = { request, note: "", done: false, failed: false, undone: false, before: { text: lesson.text, sources: lesson.sources } };
    lesson.edits.push(edit);
    lesson.asking = true;
    lesson.page.classList.add("is-rewriting");
    renderSide();
    renderChrome();
    const { stream, attachment } = learn({ prompt: request, context: lesson.context, article, history: lesson.history, shape: "revise", built: lesson.sources });
    let raw = "";
    let started = false;
    for await (const piece of stream) {
      raw += piece;
      const { note, body } = splitNote(raw);
      if (note !== null && note !== edit.note) {
        edit.note = note;
        renderSide();
      }
      if (!body.trim() || /Sorry, the answer stopped/.test(body)) continue;
      if (!started) {
        started = true;
        lesson.sources = null; // the new text's citation numbers are for the new sources
        lesson.page.classList.remove("is-rewriting");
        el.read.scrollTo({ top: 0, behavior: "smooth" });
      }
      lesson.text = body;
      render(lesson);
    }
    const sources = await attachment;
    const { body } = splitNote(raw);
    if (!started || !parse(body, lesson.prompt).sections.length) {
      Object.assign(lesson, edit.before); // nothing usable came back: keep the lesson as it was
      edit.failed = true;
    } else lesson.sources = sources ?? edit.before.sources;
    edit.done = true;
    lesson.asking = false;
    lesson.page.classList.remove("is-rewriting");
    render(lesson);
    renderSide();
    renderChrome();
    if (lesson === current) listen?.update();
  }

  function undoEdit(lesson, edit) {
    if (!edit?.done || edit.undone || lesson.asking) return;
    Object.assign(lesson, edit.before);
    edit.undone = true;
    // The next change starts from this version, so the history says so.
    lesson.history.push({ role: "user", text: `Undo that change: "${edit.request}".` }, { role: "ai", text: edit.before.text });
    render(lesson);
    renderSide();
    if (lesson === current) listen?.update();
  }

  // The chat beside the sheet: the changes in Read, the questions and the voice chat in Listen.
  function renderSide() {
    if (!current) return;
    el.edit.dataset.mode = mode;
    el.editHead.textContent = mode === "read" ? "Change this lesson" : "Ask while you listen";
    if (mode === "listen") return renderThread();
    const lesson = current;
    const turns = lesson.edits
      .map((edit, i) => {
        const last = i === lesson.edits.length - 1;
        const status = !edit.done
          ? `<p class="lesson-edit-note is-working"><span class="dots"><i></i><i></i><i></i></span>${edit.note ? escape(edit.note) : "Rewriting the lesson…"}</p>`
          : edit.failed
            ? `<p class="lesson-edit-note is-failed">Couldn't change the lesson this time. It is as it was.</p>`
            : `<p class="lesson-edit-note"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg><span>${escape(edit.note || "Rewrote the lesson")}</span></p>
               ${edit.undone ? `<p class="lesson-edit-undone">Undone</p>` : last ? `<button type="button" class="lesson-edit-undo" data-undo="${i}">Undo</button>` : ""}`;
        return `<div class="lesson-edit-turn"><p class="lesson-edit-q">${escape(edit.request)}</p>${status}</div>`;
      })
      .join("");
    el.editLog.innerHTML = lesson.edits.length
      ? turns
      : `<p class="lesson-edit-hint">Ask a question or for a change, and the lesson rewrites itself.</p>
         <div class="lesson-edit-suggest">${SUGGESTIONS.map((t) => `<button type="button" data-suggest="${escape(t)}" ${lesson.done ? "" : "disabled"}>${escape(t)}</button>`).join("")}</div>`;
    el.editLog.scrollTop = el.editLog.scrollHeight;
  }

  function renderThread() {
    const lesson = current;
    el.editLog.innerHTML = lesson.followups.length
      ? lesson.followups.map((t) => turnHtml(t, lesson)).join("")
      : `<p class="lesson-edit-hint">Type a question, or press Talk and ask out loud. The lesson waits while you ask, then goes on.</p>`;
    el.editLog.scrollTop = el.editLog.scrollHeight;
    renderTalk();
  }

  // Talk: a live voice chat with the ElevenLabs agent about this lesson. The lesson pauses until it ends.
  async function toggleTalk() {
    if (talk) return endTalk();
    const lesson = current;
    if (!lesson?.done) return;
    talk = { lesson, status: "connecting", session: null };
    talkError = "";
    listen?.hold();
    renderTalk();
    const me = talk;
    try {
      const session = await startTalk({
        context: {
          page_id: article.page_id,
          title: lesson.parsed.title ?? article.title,
          article: document.querySelector(".body")?.innerText.slice(0, 6000) ?? "",
          answer: lesson.text.replace(/^Terms:[\s\S]*$/m, "").replace(CITES, "").replace(/[{}#>]/g, ""),
          sources: (lesson.sources?.items ?? []).map((s) => ({ title: s.title, why: s.why, text: s.text })),
        },
        onStatus: (status, detail) => {
          if (talk !== me) return;
          if (status === "ended") finishTalk(detail);
          else {
            // what the microphone heard while the agent spoke is its own voice: not shown as yours
            if (status === "listening" && me.status === "speaking") me.heardFrom = me.heard;
            me.status = status;
            me.step = status === "connecting" ? detail : "";
            renderTalk();
          }
        },
        onMessage: (role, text) => talkTurn(lesson, role, text),
      });
      if (talk !== me) return session.stop();
      me.session = session;
      hearLive(me, lesson);
      meter();
    } catch (error) {
      if (talk === me) finishTalk(error.message);
    }
  }

  function endTalk() {
    if (talk) finishTalk();
  }

  function finishTalk(error = "") {
    const was = talk;
    talk = null;
    if (was?.recognition) {
      was.recognition.onend = null;
      was.recognition.abort();
    }
    talkError = error;
    cancelAnimationFrame(talkFrame);
    was?.session?.stop();
    renderTalk();
    listen?.release();
  }

  // What is said in the voice chat goes into the thread: your words as the question, the agent's as the answer.
  function talkTurn(lesson, role, text) {
    const last = lesson.followups.at(-1);
    if (role === "user" && last?.draft) {
      // ElevenLabs' own transcript replaces the live words (unless it heard nothing, "...")
      if (!/^[.…\s]*$/.test(text)) last.question = text;
      delete last.draft;
      if (talk) talk.heardFrom = talk.heard;
    } else if (role === "user") lesson.followups.push({ question: text, text: "", sources: null, done: false, at: null, voice: true });
    else if (last?.voice && !last.done) Object.assign(last, { text, done: true });
    else lesson.followups.push({ question: null, text, sources: null, done: true, at: null, voice: true });
    if (lesson === current && mode === "listen") renderThread();
  }

  // Your words in the thread as you say them: Chrome's speech recognition listens beside the ElevenLabs session,
  // because ElevenLabs sends what you said only once you have finished. Not while the agent speaks.
  function hearLive(me, lesson) {
    const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    if (!Recognition) return;
    const rec = (me.recognition = new Recognition());
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    me.heard = me.heardFrom = 0;
    rec.onresult = (e) => {
      me.heard = e.results.length;
      if (talk !== me || me.status === "speaking") return;
      const words = [...e.results].slice(me.heardFrom).map((r) => r[0].transcript).join(" ").replace(/\s+/g, " ").trim();
      if (!words) return;
      const last = lesson.followups.at(-1);
      if (last?.draft) last.question = words;
      else lesson.followups.push({ question: words, text: "", sources: null, done: false, at: null, voice: true, draft: true });
      if (lesson === current && mode === "listen") renderThread();
    };
    rec.onerror = (e) => console.info("[voice] live words:", e.error);
    // Chrome ends recognition after a pause: start again while the talk goes on
    rec.onend = () => {
      if (talk !== me) return;
      me.heard = me.heardFrom = 0;
      try { rec.start(); } catch {}
    };
    try { rec.start(); } catch (error) { console.info("[voice] live words unavailable", error); }
  }

  function renderTalk() {
    const on = !!talk;
    const label = !on ? "Talk" : talk.status === "connecting" ? "Connecting…" : "End";
    const status = !on
      ? talkError
        ? `Voice chat stopped: ${talkError}`
        : ""
      : talk.status === "speaking"
        ? "Speaking. Talk to interrupt."
        : talk.status === "listening"
          ? "Listening. Just talk."
          : (talk.step ?? "");
    el.talk.setAttribute("aria-pressed", String(on));
    el.talk.classList.toggle("is-live", on && talk.status !== "connecting");
    el.talk.classList.toggle("is-speaking", on && talk.status === "speaking");
    el.talk.disabled = !current?.done;
    el.talk.querySelector("span").textContent = label;
    el.talkStatus.textContent = status;
    el.talkStatus.classList.toggle("is-error", !on && !!talkError);
  }

  // The Talk button's ring follows the voice: the agent's while it speaks, yours while it listens.
  function meter() {
    cancelAnimationFrame(talkFrame);
    const tick = () => {
      if (!talk?.session) return;
      el.talk.style.setProperty("--level", Math.min(1, talk.session.volume() * 2.5).toFixed(3));
      talkFrame = requestAnimationFrame(tick);
    };
    talkFrame = requestAnimationFrame(tick);
  }

  // A question during the lesson, typed under it in Read or asked in the middle of Listen (at: the sentence it
  // interrupted). Answers short, with the lesson as history.
  async function ask(lesson, question, at = null) {
    const turn = { question, text: "", sources: null, done: false, at };
    lesson.followups.push(turn);
    lesson.asking = true;
    const { stream, attachment } = learn({ prompt: question, context: lesson.context, article, history: lesson.history, shape: "reply", built: lesson.sources });
    if (lesson === current) renderSide();
    for await (const piece of stream) {
      turn.text += piece;
      if (lesson === current) {
        listen?.update();
        renderSide();
      }
    }
    turn.sources = await attachment;
    turn.done = true;
    lesson.asking = false;
    if (lesson === current) {
      listen?.update();
      renderSide();
    }
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
    renderSide();
    if (mode === "listen") startListen();
    el.read.scrollTop = 0;
  }

  function setMode(next) {
    mode = next;
    el.sheet.dataset.mode = next;
    for (const b of el.modes.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === next));
    if (next !== "listen") endTalk();
    if (!el.sheet.hidden) layout();
    if (next === "listen") startListen();
    else {
      listen?.destroy();
      listen = null;
    }
    renderSide();
    renderChrome();
  }

  function startListen() {
    listen?.destroy();
    listen = listenView({
      root: el.listen,
      bar: el.player,
      lesson: current,
      ask: (question, at) => ask(current, question, at),
      askBox: () => (el.sheet.classList.contains("has-side") ? el.textarea : null),
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
    el.textarea.placeholder = !current.done
      ? "The lesson is being written…"
      : mode === "listen"
        ? "Ask a question…"
        : current.asking
          ? "Rewriting the lesson…"
          : "Ask, or ask for a change…";
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
      }
      ${lesson.done ? sourcesHtml(lesson) : ""}`;
  }

  // The sheet is centred; the chat sits just left of it and the two are centred together.
  // A narrow window keeps the question box under the lesson instead.
  function layout() {
    // The top bar scrolls away with the article; once it is gone the sheet starts at the top of the window.
    const top = Math.max(document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0, 0) + EDGE;
    const height = innerHeight - top - TRAY - 4;
    const side = innerWidth >= SIDE_MIN;
    const extra = side ? SIDE_W + SIDE_GAP : 0;
    const w = Math.min(W, innerWidth - EDGE * 2 - extra);
    const left = (innerWidth - w - extra) / 2 + extra;
    Object.assign(el.sheet.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${height}px` });
    el.sheet.classList.toggle("has-side", side);
    el.edit.hidden = !side || el.sheet.hidden;
    if (side) {
      Object.assign(el.edit.style, { left: `${left - SIDE_GAP - SIDE_W}px`, top: `${top}px`, width: `${SIDE_W}px`, height: `${height}px` });
      if (el.compose.parentElement !== el.edit) el.edit.append(el.compose);
    } else if (el.compose.parentElement !== el.foot) el.foot.prepend(el.compose);
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
  // A term is often marked inflected in the text ("{Punakaartiin}") and explained in its base form ("Punakaarti"):
  // such an explanation goes under the marked form, so the term in the text opens it.
  const marked = [...body.matchAll(/\{([^{}]+)\}/g)].map((m) => key(m[1]));
  const loose = marked.filter((k) => !lesson.terms.has(k));
  if (loose.length) {
    const terms = new Map();
    for (const [k, term] of lesson.terms) {
      const as = marked.includes(k) ? null : loose.filter((l) => !terms.has(l) && sameWord(l, k)).sort((x, y) => shared(y, k) - shared(x, k))[0];
      terms.set(as ?? k, term);
    }
    lesson.terms = terms;
  }
  return lesson;
}

// Two forms of one word or phrase: word for word, most of the shorter form is their common start ("sortokautta" and
// "sortokaudet", "lavastetun hyökkäyksen" and "lavastettu hyökkäys").
const shared = (a, b) => [...a].findIndex((c, i) => c !== b[i]) >>> 0;
const sameStem = (a, b) => Math.min(shared(a, b), a.length, b.length) >= Math.max(4, 0.6 * Math.min(a.length, b.length));
const sameWord = (a, b, x = a.split(/\s+/), y = b.split(/\s+/)) => x.length === y.length && x.every((w, i) => w === y[i] || sameStem(w, y[i]));

// Escaped text with its citation markers linked (or hidden until the sources arrive) and its terms as buttons.
export function prose(text, lesson, sources = lesson.sources) {
  let html = emphasis(escape(text)).replace(/\s*\[[\d,\s]*$/, "");
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

// References: the articles the lesson was built from, numbered as its citations, each with why it was read.
function sourcesHtml(lesson) {
  const items = lesson.sources?.items ?? [];
  if (!items.length) return "";
  return `<section class="lesson-refs"><h2>References</h2>
    <ol>${items
      .map(
        (s) => `<li><span class="lesson-ref-n">${s.n}</span><span><a href="${escape(s.page_id ? `./?id=${s.page_id}` : s.url)}" target="_blank" rel="noopener">${escape(s.title)}</a>${s.why ? `<span class="lesson-ref-why"> — ${escape(s.why)}</span>` : ""}</span></li>`,
      )
      .join("")}</ol>
    <p class="lesson-refs-note">Chosen from ${lesson.sources.explored.toLocaleString("en-US")} linked and searched articles</p>
  </section>`;
}

export function turnHtml(turn, lesson) {
  return `<div class="lesson-turn${turn.done ? "" : " is-thinking"}${turn.voice ? " is-voice" : ""}${turn.draft ? " is-draft" : ""}">
    ${turn.question ? `<p class="lesson-turn-q">${escape(turn.question)}</p>` : ""}
    ${turn.draft ? "" : `<div class="lesson-turn-a">${turn.text ? `<p>${prose(turn.text.trim(), lesson, turn.sources)}</p>` : `<span class="dots"><i></i><i></i><i></i></span>`}</div>`}
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
  const edit = document.createElement("aside");
  edit.className = "lesson-edit";
  edit.hidden = true;
  edit.setAttribute("aria-label", "Change this lesson");
  edit.innerHTML = `<p class="lesson-edit-head">Change this lesson</p><div class="lesson-edit-log" aria-live="polite"></div>
    <div class="lesson-talk-row">
      <button type="button" class="lesson-talk" aria-pressed="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="2" width="5" height="8" rx="2.5" /><path d="M3 8a5 5 0 0 0 10 0M8 13v1.5" /></svg><span>Talk</span>
      </button>
      <span class="lesson-talk-status" role="status"></span>
    </div>`;

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
    edit,
    editLog: edit.querySelector(".lesson-edit-log"),
    editHead: edit.querySelector(".lesson-edit-head"),
    talk: edit.querySelector(".lesson-talk"),
    talkStatus: edit.querySelector(".lesson-talk-status"),
    foot: sheet.querySelector(".lesson-foot"),
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

// A revised lesson starts with "Changed: what changed" on its own line; the note is null until that line is
// complete (or the text turns out not to start with it).
function splitNote(raw) {
  const text = raw.replace(/^\s+/, "");
  const m = text.match(/^Changed:[ \t]*([^\n]*)\n/);
  if (m) return { note: m[1].trim(), body: text.slice(m[0].length) };
  if ("Changed:".startsWith(text.slice(0, 8)) || (text.startsWith("Changed:") && !text.includes("\n"))) return { note: null, body: "" };
  return { note: null, body: text };
}
