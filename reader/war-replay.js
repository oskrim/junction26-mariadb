import { diff, words } from "./diff.js";
import { getArticle } from "./fake/api.js";
import { cleanComment } from "./history-cards.js";
import { FIGHTER_COLORS } from "./timeline3d.js";
import { plainText } from "./wikitext.js";

const SHOWN_PARAGRAPHS = 3;
const OTHER_COLOR = "#72777d";
const SPEEDS = [1, 2, 4];

// Replays an edit war on the passage fought over most: each editor has a named cursor that selects,
// deletes and types, version by version, using the real text of every version in the war.
export async function openWarReplay({ articleId, war, before }) {
  const edits = [before, ...war.edits];
  const texts = await Promise.all(edits.map(async (e) => (await getArticle(articleId, Math.floor(e.time / 1000))).version?.text ?? ""));
  const model = buildModel(texts.map(paragraphsOf), edits);

  const root = document.createElement("div");
  root.className = "replay";
  root.innerHTML = `
    <div class="replay-backdrop"></div>
    <section class="replay-window" role="dialog" aria-modal="true" aria-label="Edit war replay">
      <header class="replay-head">
        <div>
          <p class="replay-kicker">${war.kind === "dispute" ? "Edit war" : "Vandalism fought off"} · replay</p>
          <h2>${escape(war.section ?? "Across the article")}</h2>
        </div>
        <div class="replay-fighters">${war.fighters
          .slice(0, 2)
          .map((u, k) => `<span style="--c:${FIGHTER_COLORS[k]}"><i></i>${escape(u)}</span>`)
          .join(`<em>vs</em>`)}</div>
        <button type="button" class="replay-close" aria-label="Close">×</button>
      </header>
      <div class="replay-page">
        <p class="replay-tab"></p>
        <div class="replay-doc"></div>
      </div>
      <footer class="replay-foot">
        <div class="replay-caption"></div>
        <div class="replay-controls">
          <button type="button" data-do="prev" aria-label="Previous edit">‹</button>
          <button type="button" data-do="play" class="replay-play" aria-label="Pause">❚❚</button>
          <button type="button" data-do="next" aria-label="Next edit">›</button>
          <div class="replay-steps">${model.steps
            .map((s, i) => `<button type="button" data-step="${i}" style="--c:${colorOf(s.edit.user)}" title="${escape(s.edit.user)}"${s.edit.revertsTo !== null ? ' class="is-undo"' : ""}></button>`)
            .join("")}</div>
          <button type="button" data-do="speed" class="replay-speed">1×</button>
        </div>
      </footer>
    </section>`;
  document.body.append(root);
  document.body.classList.add("has-replay");

  const doc = root.querySelector(".replay-doc");
  const tab = root.querySelector(".replay-tab");
  const caption = root.querySelector(".replay-caption");
  const playButton = root.querySelector(".replay-play");
  const cursors = new Map();
  let step = -1;
  let playing = true;
  let speed = 1;
  let run = 0;

  function colorOf(user) {
    const k = war.fighters.indexOf(user);
    return k === 0 || k === 1 ? FIGHTER_COLORS[k] : OTHER_COLOR;
  }

  function cursorFor(user) {
    if (!cursors.has(user)) {
      const el = document.createElement("div");
      el.className = "replay-cursor";
      el.style.setProperty("--c", colorOf(user));
      el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5 14 7l-5.4 1.6L6.4 14z"/></svg><span>${escape(user)}</span>`;
      doc.append(el);
      cursors.set(user, el);
    }
    return cursors.get(user);
  }

  // Fighters wait in the margins on their own side; other editors only appear while they edit.
  function park() {
    for (const [user, el] of cursors) {
      const k = war.fighters.indexOf(user);
      el.classList.remove("is-typing", "is-undo");
      if (k === 0 || k === 1) moveCursor(el, k === 0 ? -34 : doc.clientWidth + 14, 40 + k * 40);
      else el.classList.add("is-gone");
      el.classList.add("is-idle");
    }
  }

  function moveCursor(el, x, y) {
    el.classList.remove("is-gone", "is-idle");
    el.style.transform = `translate(${x}px, ${y}px)`;
  }

  // Shows the shown paragraphs as they are after `index` without animating.
  function renderState(index) {
    const state = model.states[index + 1];
    doc.querySelectorAll(".replay-p, .replay-gap").forEach((n) => n.remove());
    // Paragraphs that do not exist yet stay hidden until someone types them.
    let visible = 0;
    for (const id of model.shown) {
      const text = state.get(id) ?? "";
      if (text && visible++) doc.append(gap());
      const p = document.createElement("p");
      p.className = text ? "replay-p" : "replay-p is-empty";
      p.dataset.id = id;
      setTokens(p, text);
      doc.append(p);
    }
    for (const el of cursors.values()) doc.append(el);
  }

  function describe(index) {
    const s = model.steps[index];
    const undo = s.edit.revertsTo !== null;
    const comment = cleanComment(s.edit.comment);
    tab.textContent = new Date(s.edit.time).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    caption.innerHTML = `
      <p><b style="--c:${colorOf(s.edit.user)}">${escape(s.edit.user)}</b>
        ${undo ? `<span class="replay-undo">Undo</span>` : ""}
        <span class="replay-round">Edit ${index + 1} of ${model.steps.length}</span></p>
      <p class="replay-comment">${comment ? `“${escape(comment)}”` : `<span>No edit summary</span>`}
        ${s.hidden ? `<span class="replay-more"> · also changed ${s.hidden} other ${s.hidden === 1 ? "paragraph" : "paragraphs"}</span>` : ""}</p>`;
    root.querySelectorAll(".replay-steps button").forEach((b, i) => {
      b.classList.toggle("is-done", i < index);
      b.classList.toggle("is-current", i === index);
    });
  }

  async function animate(index, token) {
    const s = model.steps[index];
    const wait = (ms) =>
      new Promise((resolve, reject) => {
        const tick = () => (token !== run ? reject(new Error("stopped")) : playing ? resolve() : setTimeout(tick, 120));
        setTimeout(tick, ms / speed);
      });
    describe(index);
    const cursor = cursorFor(s.edit.user);
    cursor.classList.toggle("is-undo", s.edit.revertsTo !== null);

    if (!s.changes.length) {
      moveCursor(cursor, doc.clientWidth / 2, -24);
      await wait(1400);
    }
    for (const change of s.changes) {
      const p = doc.querySelector(`.replay-p[data-id="${change.id}"]`);
      const runs = diff(words(change.from), words(change.to ?? ""));
      const typed = runs.reduce((n, r) => n + (r.type === "change" ? r.b.join("").length : 0), 0);
      const perChar = Math.min(32, Math.max(3, 2600 / Math.max(1, typed)));
      p.classList.remove("is-empty");
      p.style.setProperty("--c", colorOf(s.edit.user));
      if (s.edit.revertsTo !== null) flash(p, colorOf(s.edit.user));

      setTokens(p, change.from);
      let spans = [...p.children];
      let at = 0;
      for (const r of runs) {
        if (r.type === "equal") {
          at += r.a.length;
          continue;
        }
        const target = spans[at] ?? p.lastElementChild ?? p;
        pointAt(cursor, target, false);
        await wait(520);
        const doomed = spans.slice(at, at + r.a.length);
        for (const span of doomed) {
          span.classList.add("is-selected");
          await wait(Math.min(40, 500 / doomed.length));
        }
        if (doomed.length) await wait(260);
        const anchor = spans[at + r.a.length] ?? null;
        doomed.forEach((span) => span.remove());
        spans.splice(at, doomed.length);

        cursor.classList.add("is-typing");
        const typedSpan = document.createElement("span");
        typedSpan.className = "is-new";
        p.insertBefore(typedSpan, anchor);
        const text = r.b.join("");
        for (let c = 0; c < text.length; c += Math.max(1, Math.round(6 / perChar))) {
          typedSpan.textContent = text.slice(0, c + 1);
          pointAt(cursor, typedSpan, true);
          await wait(perChar);
        }
        typedSpan.textContent = text;
        cursor.classList.remove("is-typing");
        const fresh = words(text).map(tokenSpan("is-new"));
        typedSpan.replaceWith(...fresh);
        spans.splice(at, 0, ...fresh);
        at += fresh.length;
      }
      if (change.to === null) p.classList.add("is-gone");
      await wait(500);
    }
    await wait(700);
  }

  async function play(from) {
    const token = ++run;
    try {
      for (let i = from; i < model.steps.length; i++) {
        step = i;
        renderState(i - 1);
        await animate(i, token);
        renderState(i);
        park();
      }
      playing = false;
      playButton.textContent = "↻";
      playButton.setAttribute("aria-label", "Play again");
    } catch {
      // A newer play run replaced this one.
    }
  }

  function jump(index) {
    const i = Math.max(0, Math.min(model.steps.length - 1, index));
    run++;
    step = i;
    renderState(i - 1);
    park();
    describe(i);
    play(i);
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (event.target.closest(".replay-backdrop") || button?.classList.contains("replay-close")) return close();
    if (!button) return;
    if (button.dataset.step) return jump(Number(button.dataset.step));
    const action = button.dataset.do;
    if (action === "prev") jump(step - 1);
    else if (action === "next") jump(step + 1);
    else if (action === "speed") {
      speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
      button.textContent = `${speed}×`;
    } else if (action === "play") {
      if (!playing && step === model.steps.length - 1 && playButton.textContent === "↻") {
        playing = true;
        playButton.textContent = "❚❚";
        return jump(0);
      }
      playing = !playing;
      playButton.textContent = playing ? "❚❚" : "▶";
      playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    }
  });
  const onKey = (event) => {
    if (event.key === "Escape") close();
    event.stopPropagation();
  };
  addEventListener("keydown", onKey, true);

  function close() {
    run++;
    removeEventListener("keydown", onKey, true);
    document.body.classList.remove("has-replay");
    root.classList.add("is-closing");
    setTimeout(() => root.remove(), 220);
  }

  for (const user of war.fighters.slice(0, 2)) cursorFor(user);
  renderState(-1);
  park();
  requestAnimationFrame(() => root.classList.add("is-open"));
  setTimeout(() => play(0), 700);
}

// Paragraphs keep an identity from version to version, so a rewritten paragraph is still "the same one".
// The passage shown is the few paragraphs edited most often during the war.
function buildModel(versions, edits) {
  let nextId = 0;
  let current = versions[0].map((text) => ({ id: nextId++, text }));
  const order = new Map(current.map((p, i) => [p.id, i]));
  const touched = new Map();
  const rawSteps = [];
  for (let k = 1; k < versions.length; k++) {
    const next = [];
    const changes = [];
    for (const r of diff(current, versions[k], (x) => (typeof x === "string" ? x : x.text))) {
      if (r.type === "equal") {
        next.push(...r.a);
        continue;
      }
      r.b.forEach((text, i) => {
        const prev = r.a[i];
        const id = prev ? prev.id : nextId++;
        if (!order.has(id)) order.set(id, (order.get(next.at(-1)?.id) ?? -1) + 0.5);
        next.push({ id, text });
        changes.push({ id, from: prev?.text ?? "", to: text });
      });
      for (const prev of r.a.slice(r.b.length)) changes.push({ id: prev.id, from: prev.text, to: null });
    }
    for (const c of changes) touched.set(c.id, (touched.get(c.id) ?? 0) + 1);
    rawSteps.push(changes);
    current = next;
  }

  const shown = [...touched]
    .sort((a, b) => b[1] - a[1] || order.get(a[0]) - order.get(b[0]))
    .slice(0, SHOWN_PARAGRAPHS)
    .map(([id]) => id)
    .sort((a, b) => order.get(a) - order.get(b));
  const shownSet = new Set(shown);

  const states = [];
  const state = new Map();
  versions[0].forEach((text, id) => shownSet.has(id) && state.set(id, text));
  states.push(new Map(state));
  const steps = rawSteps.map((changes, k) => {
    const visible = changes.filter((c) => shownSet.has(c.id));
    for (const c of visible) {
      if (c.to === null) state.delete(c.id);
      else state.set(c.id, c.to);
    }
    states.push(new Map(state));
    return { edit: edits[k + 1], changes: visible, hidden: new Set(changes.filter((c) => !shownSet.has(c.id)).map((c) => c.id)).size };
  });
  return { shown, steps, states };
}

function paragraphsOf(text) {
  return text
    .split("\n")
    .map(plainText)
    .filter((t) => t.length > 1);
}

function setTokens(p, text) {
  p.replaceChildren(...words(text).map(tokenSpan(null)));
}

function tokenSpan(className) {
  return (word) => {
    const span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = word;
    return span;
  };
}

// The cursor's tip sits at the start of a word, or at the end of the text being typed. The page scrolls
// so the cursor stays in view.
function pointAt(cursor, target, atEnd) {
  const doc = cursor.parentElement;
  const page = doc.parentElement;
  const view = page.getBoundingClientRect();
  const spot = target.getBoundingClientRect();
  if (spot.top < view.top + 60 || spot.bottom > view.bottom - 60) {
    page.scrollTo({ top: page.scrollTop + spot.top - view.top - view.height / 3, behavior: atEnd ? "auto" : "smooth" });
  }
  const box = doc.getBoundingClientRect();
  const rects = target.getClientRects();
  const r = (atEnd ? rects[rects.length - 1] : rects[0]) ?? target.getBoundingClientRect();
  cursor.style.transform = `translate(${(atEnd ? r.right : r.left) - box.left}px, ${r.top - box.top + r.height * 0.55}px)`;
  cursor.classList.remove("is-gone", "is-idle");
}

function flash(p, color) {
  p.style.setProperty("--flash", color);
  p.classList.remove("is-hit");
  void p.offsetWidth;
  p.classList.add("is-hit");
}

function gap() {
  const el = document.createElement("p");
  el.className = "replay-gap";
  el.textContent = "⋯";
  return el;
}

function escape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
