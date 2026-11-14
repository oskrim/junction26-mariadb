import { censor } from "./censor.js";
import { diff, words } from "./diff.js";
import { getArticle } from "./api.js";
import { cleanComment } from "./history-cards.js";
import { FIGHTER_COLORS } from "./timeline3d.js";
import { plainText } from "./wikitext.js";

const SHOWN_PARAGRAPHS = 3;

// Replays an edit war between its two main fighters on the passage they fought over most, inside `mount`.
// Each has a named cursor that waits in the corner, then selects, deletes and types their real edit.
// Edits by anyone else are applied silently between turns. `onTurn` hears each fighter edit as it starts.
// `inline` plays it inside the article itself: no header, and the controls float at the bottom.
export async function openWarReplay({ mount, articleId, war, before, onTurn = () => {}, onClose, inline = false }) {
  const fighters = war.fighters.slice(0, 2);
  const edits = [before, ...war.edits];
  const texts = await Promise.all(edits.map(async (e) => (await getArticle(articleId, Math.floor(e.time / 1000))).version?.text ?? ""));
  const model = buildModel(texts.map(paragraphsOf), edits, fighters);
  const turns = model.steps.flatMap((s, i) => (s.silent ? [] : [i]));
  const colorOf = (user) => FIGHTER_COLORS[fighters.indexOf(user)];

  const root = mount;
  root.innerHTML = inline
    ? `
      <div class="replay-page">
        <p class="replay-tab"></p>
        <div class="replay-doc"></div>
      </div>
      <footer class="replay-foot">
        <button type="button" class="replay-play" aria-label="Pause">❚❚</button>
        <p class="replay-caption"></p>
        <span class="replay-count"></span>
        <button type="button" class="replay-close" aria-label="Leave the replay">×</button>
      </footer>`
    : `
      <header class="replay-head">
        <div>
          <p class="replay-kicker">${war.kind === "dispute" ? "Edit war" : "Vandalism fought off"} · replay</p>
          <h2>${escape(war.section ?? "Across the article")}</h2>
        </div>
        <div class="replay-fighters">${fighters
          .map((u, k) => `<span style="--c:${FIGHTER_COLORS[k]}"><i></i>${escape(censor(u))}</span>`)
          .join(`<em>vs</em>`)}</div>
        <button type="button" class="replay-close" aria-label="Back to the article">×</button>
      </header>
      <div class="replay-page">
        <p class="replay-tab"></p>
        <div class="replay-doc"></div>
      </div>
      <footer class="replay-foot">
        <button type="button" class="replay-play" aria-label="Pause">❚❚</button>
        <p class="replay-caption"></p>
        <span class="replay-count"></span>
      </footer>`;
  document.body.classList.add("has-replay");

  const doc = root.querySelector(".replay-doc");
  const tab = root.querySelector(".replay-tab");
  const caption = root.querySelector(".replay-caption");
  const playButton = root.querySelector(".replay-play");
  const cursors = new Map(
    fighters.map((user, k) => {
      const el = document.createElement("div");
      el.className = "replay-cursor is-idle";
      el.style.setProperty("--c", FIGHTER_COLORS[k]);
      el.style.setProperty("--delay", `${-k * 1.1}s`);
      el.innerHTML = `<div class="replay-cursor-body"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5 14 7l-5.4 1.6L6.4 14z"/></svg><span>${escape(censor(user))}</span></div>`;
      return [user, el];
    }),
  );
  let turn = 0;
  let playing = true;
  let run = 0;

  // Both fighters wait side by side in the page's top-right corner.
  function park() {
    fighters.forEach((user, k) => {
      const el = cursors.get(user);
      el.classList.remove("is-typing", "is-undo");
      el.classList.add("is-idle");
      el.style.transform = `translate(${doc.clientWidth - 250 + k * 130}px, -42px)`;
    });
  }

  // The shown paragraphs as they are after step `index`, without animating.
  function renderState(index) {
    const state = model.states[index + 1];
    doc.querySelectorAll(".replay-p, .replay-gap").forEach((n) => n.remove());
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

  function describe(t) {
    const { edit } = model.steps[turns[t]];
    const comment = cleanComment(edit.comment);
    tab.textContent = new Date(edit.time).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    caption.innerHTML = `<b style="--c:${colorOf(edit.user)}">${escape(censor(edit.user))}</b>${
      edit.revertsTo !== null ? `<span class="replay-undo">undo</span>` : ""
    }${comment ? `<span class="replay-comment">${escape(comment)}</span>` : ""}`;
    caption.title = comment;
    root.querySelector(".replay-count").textContent = `${t + 1} / ${turns.length}`;
    onTurn(edit);
  }

  async function animate(index, token) {
    const s = model.steps[index];
    const wait = (ms) =>
      new Promise((resolve, reject) => {
        const tick = () => (token !== run ? reject(new Error("stopped")) : playing ? resolve() : setTimeout(tick, 120));
        setTimeout(tick, ms);
      });
    const cursor = cursors.get(s.edit.user);
    cursor.classList.remove("is-idle");
    cursor.classList.toggle("is-undo", s.edit.revertsTo !== null);

    if (!s.changes.length) await wait(1200);
    for (const change of s.changes) {
      const p = doc.querySelector(`.replay-p[data-id="${change.id}"]`);
      p.classList.remove("is-empty");
      p.style.setProperty("--c", colorOf(s.edit.user));
      if (s.edit.revertsTo !== null) flash(p, colorOf(s.edit.user));
      const runs = diff(words(change.from), words(change.to ?? ""));
      const typed = runs.reduce((n, r) => n + (r.type === "change" ? r.b.join("").length : 0), 0);
      const perChar = Math.min(32, Math.max(3, 2600 / Math.max(1, typed)));

      setTokens(p, change.from);
      const spans = [...p.children];
      let at = 0;
      for (const r of runs) {
        if (r.type === "equal") {
          at += r.a.length;
          continue;
        }
        pointAt(cursor, spans[at] ?? p.lastElementChild ?? p, false);
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
        const typing = document.createElement("span");
        typing.className = "is-new";
        p.insertBefore(typing, anchor);
        const text = r.b.join("");
        for (let c = 0; c < text.length; c += Math.max(1, Math.round(6 / perChar))) {
          typing.textContent = text.slice(0, c + 1);
          pointAt(cursor, typing, true);
          await wait(perChar);
        }
        cursor.classList.remove("is-typing");
        const fresh = words(text).map(tokenSpan("is-new"));
        typing.replaceWith(...fresh);
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
      for (let t = from; t < turns.length; t++) {
        turn = t;
        renderState(turns[t] - 1);
        describe(t);
        await animate(turns[t], token);
        renderState(turns[t]);
        park();
      }
      setPlaying(false, "↻");
    } catch {
      // A newer play run replaced this one.
    }
  }

  function setPlaying(on, label = on ? "❚❚" : "▶") {
    playing = on;
    playButton.textContent = label;
    playButton.setAttribute("aria-label", label === "↻" ? "Play again" : on ? "Pause" : "Play");
  }

  function jump(t) {
    run++;
    renderState(turns[t] - 1);
    park();
    describe(t);
    play(t);
  }

  const onClick = (event) => {
    if (event.target.closest(".replay-close")) return close();
    if (event.target.closest(".replay-play")) {
      if (playButton.textContent === "↻") {
        setPlaying(true);
        jump(0);
      } else setPlaying(!playing);
    }
  };
  root.addEventListener("click", onClick);
  const onKey = (event) => {
    if (event.key === "Escape") close();
    else if (event.key === " ") {
      event.preventDefault();
      setPlaying(!playing);
    } else if (event.key === "ArrowLeft" && turn > 0) jump(turn - 1);
    else if (event.key === "ArrowRight" && turn < turns.length - 1) jump(turn + 1);
    event.stopPropagation();
  };
  addEventListener("keydown", onKey, true);

  function close() {
    run++;
    removeEventListener("keydown", onKey, true);
    root.removeEventListener("click", onClick);
    document.body.classList.remove("has-replay");
    root.replaceChildren();
    onClose();
  }


  renderState(turns[0] - 1);
  park();
  describe(0);
  setTimeout(() => play(turn), 900);
  return { close };
}

// Paragraphs keep an identity from version to version, so a rewritten paragraph is still "the same one".
// The passage shown is the few paragraphs the fighters themselves edited most.
function buildModel(versions, edits, fighters) {
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
    const silent = !fighters.includes(edits[k].user);
    if (!silent) for (const c of changes) touched.set(c.id, (touched.get(c.id) ?? 0) + 1);
    rawSteps.push({ changes, silent });
    current = next;
  }

  const shown = [...touched]
    .sort((a, b) => b[1] - a[1] || order.get(a[0]) - order.get(b[0]))
    .slice(0, SHOWN_PARAGRAPHS)
    .map(([id]) => id)
    .sort((a, b) => order.get(a) - order.get(b));
  const shownSet = new Set(shown);

  const state = new Map();
  versions[0].forEach((text, id) => shownSet.has(id) && state.set(id, text));
  const states = [new Map(state)];
  const steps = rawSteps.map(({ changes, silent }, k) => {
    const visible = changes.filter((c) => shownSet.has(c.id));
    for (const c of visible) {
      if (c.to === null) state.delete(c.id);
      else state.set(c.id, c.to);
    }
    states.push(new Map(state));
    return { edit: edits[k + 1], changes: visible, silent };
  });
  return { shown, steps, states };
}

// Prose only: image lines and other markup-only lines are left out.
function paragraphsOf(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\[\[(file|image):/i.test(line))
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
  const scrolls = page.scrollHeight > page.clientHeight + 1;
  const view = scrolls ? page.getBoundingClientRect() : { top: 0, bottom: innerHeight, height: innerHeight };
  const spot = target.getBoundingClientRect();
  if (spot.top < view.top + 60 || spot.bottom > view.bottom - 60) {
    const by = spot.top - view.top - view.height / 3;
    const behavior = atEnd ? "auto" : "smooth";
    if (scrolls) page.scrollTo({ top: page.scrollTop + by, behavior });
    else scrollBy({ top: by, behavior });
  }
  const box = doc.getBoundingClientRect();
  const rects = target.getClientRects();
  const r = (atEnd ? rects[rects.length - 1] : rects[0]) ?? target.getBoundingClientRect();
  cursor.style.transform = `translate(${(atEnd ? r.right : r.left) - box.left}px, ${r.top - box.top + r.height * 0.55}px)`;
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
