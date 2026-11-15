// Find: a command palette over the page, with articles for the request from GET /api/search, whose hybrid
// ranking finds articles by their words and by their meaning. Quick actions come first (ask about it, learn
// about it), then the articles in sections, five each with the rest a row away: the ones the request names,
// the ones close in meaning, and the neighbours of the painted passage and of the article being read, and the
// articles the passage links to. A request can be a name ("kvanttitietokone"), an idea ("why cats purr") or
// "something related to this". Each row shows the article's picture (Wikipedia's page image), what tells it
// apart from pages of the same name (the "joki" of "Test (joki)"), and whether the article being read links to
// it. Arrows move through the rows, Enter opens the one marked, and the list follows the box as you type.

import { getPreview, searchArticles } from "./api.js";
import { escape, highlight } from "./search.js";
import { loadPictures, paint, thumbHtml } from "./pictures.js";

const W = 680;
const EDGE = 16;
const LIMIT = 20;
const SHOWN = 5; // articles a section shows before its "Show all" row
const QUERY_WORDS = 30;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const SECTIONS = ["title", "meaning", "passage", "page", "links"];

const ICONS = {
  ask: `<path d="M2.5 7.5C2.5 5 5 3 8 3s5.5 2 5.5 4.5S11 12 8 12a6.4 6.4 0 0 1-2-.3L3 13l.8-2.4a4.1 4.1 0 0 1-1.3-3.1Z" />`,
  learn: `<path d="M1.5 6 8 3l6.5 3L8 9Z" /><path d="M4 7.3v3.4c0 1 1.8 2 4 2s4-1 4-2V7.3" />`,
  more: `<path d="M4 6.5 8 10.5l4-4" />`,
};

// actions: { ask(request), learn(request) } open a chat or a lesson, with a request shaped like the cursor menu's.
export function findView({ article, actions = {} }) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("find-view.css", import.meta.url).href;
  document.head.append(css);

  const el = build();
  document.body.append(el.scrim, el.sheet);

  let groups = blank();
  let want = null;
  let expanded = new Set();
  let entries = []; // what each row does, by its data-i
  let rows = [];
  let active = -1;
  let request = 0;
  let timer = 0;
  let passage = null; // the painted passage the request came with

  el.scrim.addEventListener("click", close);
  el.chip.addEventListener("click", dropPassage);
  el.list.addEventListener("click", (e) => {
    const row = e.target.closest(".fv-row");
    if (!row) return;
    const entry = entries[Number(row.dataset.i)];
    if (entry.kind === "article") return; // a link: the browser opens it
    e.preventDefault();
    act(entry);
  });
  el.list.addEventListener("pointermove", (e) => {
    const row = e.target.closest(".fv-row");
    if (row && rows.indexOf(row) !== active) mark(rows.indexOf(row), false);
  });
  el.input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(el.input.value.trim()), 200);
  });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      mark((active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length, true);
    } else if (e.key === "Enter" && !e.isComposing) {
      if (timer && el.input.value.trim() !== want?.input) {
        // Enter before the list caught up with the box: search now, then open nothing.
        clearTimeout(timer);
        run(el.input.value.trim());
      } else if (rows[active]) rows[active].click();
    } else if (e.key === "Backspace" && passage && !el.input.value && el.input.selectionStart === 0) dropPassage();
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  });
  addEventListener("keydown", (e) => {
    // The cursor menu, while open, takes Escape for itself.
    if (e.key === "Escape" && !el.sheet.hidden && document.querySelector(".qm")?.hidden !== false) close();
  });
  addEventListener("resize", () => !el.sheet.hidden && layout());

  return { open };

  // A request from the menu or the top bar: what was typed, or else what is related to the painted passage or
  // the article.
  function open({ typed, context, from }) {
    passage = context || null;
    showChip();
    // With a painted passage the chip says what is searched, and the box stays free for words of your own.
    const query = typed || (passage ? "" : "related articles");
    const wasHidden = el.sheet.hidden;
    el.sheet.hidden = el.scrim.hidden = false;
    document.documentElement.classList.add("find-open");
    layout();
    el.input.value = query;
    el.input.focus({ preventScroll: true });
    el.input.select();
    run(query);
    if (from) growFrom(from);
    else if (wasHidden) {
      el.sheet.animate([{ opacity: 0, transform: "translateY(-6px) scale(0.99)" }, { opacity: 1, transform: "none" }], { duration: reduceMotion() ? 1 : 200, easing: EASE });
      el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduceMotion() ? 1 : 200 });
    }
  }

  // The painted passage rides in the search box as a chip; without it the search is a plain one.
  function showChip() {
    el.chip.hidden = !passage;
    el.chipText.textContent = passage ? `“${shorten(passage, 48)}”` : "";
    el.input.placeholder = passage ? "Related to this passage, or type to search…" : "Search articles, or ask for something related…";
    el.chip.title = passage ?? "";
  }

  function dropPassage() {
    passage = null;
    showChip();
    const words = el.input.value.trim();
    // A request that only pointed at the passage has nothing left to ask; it becomes an empty search box.
    const asked = understand(words, { article, passage: "the passage" });
    if (asked.about && !asked.query) el.input.value = "";
    el.input.focus({ preventScroll: true });
    run(el.input.value.trim());
  }

  function close() {
    if (el.sheet.hidden) return;
    request++;
    el.sheet.hidden = el.scrim.hidden = true;
    document.documentElement.classList.remove("find-open");
  }

  async function run(input) {
    const token = ++request;
    timer = 0;
    expanded = new Set();
    if (!input && passage) input = "related";
    want = input ? { ...understand(input, { article, passage }), input: el.input.value.trim() } : { input: "" };
    groups = blank();
    render(true);
    if (!input) return;
    const page = target({ article, passage: null });
    const painted = passage ? target({ article, passage }) : null;
    let found = [];
    let nearPassage = [];
    let nearPage = [];
    let inPassage = [];
    try {
      [found, nearPassage, nearPage, inPassage] = await Promise.all([
        want.query ? searchArticles(want.query, LIMIT) : [],
        painted ? searchArticles(painted.text, LIMIT) : [],
        searchArticles(page.text, LIMIT),
        passage ? passageLinks(passage) : [],
      ]);
    } catch {
      if (token === request) render(false, "Search is not answering right now.");
      return;
    }
    if (token !== request) return;
    const others = (list) => list.filter((r) => r.page_id !== article?.page_id);
    const linked = linkedTitles();
    // Neighbours by meaning: the ones the article links to first.
    const near = (list) => others(list).sort((a, b) => linked.has(b.title) - linked.has(a.title));
    found = others(found);
    // One list in the search's own order: its hybrid ranking already weighs names and meaning together.
    groups = {
      title: found,
      meaning: [],
      passage: near(nearPassage),
      page: near(nearPage),
      links: others(inPassage),
    };
    pictures(Object.values(groups).flat().map((r) => r.title), token);
    render(false);
  }

  // The quick actions, then each section with articles. While searching, the actions show with grey rows below.
  function render(loading, problem = null) {
    entries = [];
    const linked = linkedTitles();
    const subject = want?.query ? `“${shorten(want.query, 40)}”` : passage ? "the painted passage" : article?.title ? article.title : null;
    let html = "";
    if (subject && (actions.ask || actions.learn)) {
      html += section("Quick actions", [
        actions.ask && row({ kind: "ask", key: "ask" }, iconTile("ask"), `Ask about ${subject}`, "A chat that reads this article and answers", "Ask"),
        actions.learn && row({ kind: "learn", key: "learn" }, iconTile("learn"), `Learn about ${subject}`, "A short lesson built from the linked articles", "Learn"),
      ]);
    }
    if (loading && want?.input) html += `<div class="fv-loading" aria-label="Searching">${'<span class="fv-ghost"><i></i><i></i></span>'.repeat(4)}</div>`;
    else if (problem) html += `<p class="fv-empty">${escape(problem)}</p>`;
    else if (!want?.input) html += `<p class="fv-empty">Type a name, a word or an idea. Paint a passage first to find what is related to it.</p>`;
    else {
      const names = {
        title: "Articles",
        meaning: want.query && groups.title.length ? "Close in meaning" : `Close to “${shorten(want.query ?? "", 40)}”`,
        passage: "Related to the passage",
        page: `Related to ${article?.title ?? "this article"}`,
        links: "Linked in the passage",
      };
      // A request about the page puts its neighbours first; a search puts what it found first.
      const order = want.about ? ["passage", "page", "links", "title", "meaning"] : SECTIONS;
      for (const key of order) {
        const list = groups[key];
        if (!list.length) continue;
        const shown = expanded.has(key) ? list : list.slice(0, SHOWN);
        // Neighbours were searched with a whole passage, so the matched word means little there.
        const plain = key !== "title" && key !== "meaning";
        const items = shown.map((r) => {
          const { name, qualifier } = splitTitle(r.title);
          const tags = [qualifier && `<span class="fv-tag">${escape(qualifier)}</span>`, linked.has(r.title) && `<span class="fv-tag is-linked">Linked here</span>`].filter(Boolean).join("");
          return row({ kind: "article", href: articleUrl(r.page_id) }, thumbTile(r.title, name), `${escape(name)}${tags}`, highlight(r.snippet, plain ? null : r.match), "Open", true);
        });
        if (list.length > shown.length) items.push(row({ kind: "more", key }, iconTile("more"), `Show all ${list.length}`, null, "Show"));
        html += section(names[key], items);
      }
      if (!SECTIONS.some((k) => groups[k].length)) html += `<p class="fv-empty">No articles found for “${escape(want.query ?? want.input)}”.</p>`;
    }
    el.list.innerHTML = html;
    rows = [...el.list.querySelectorAll(".fv-row")];
    paint(el.list);
    // The first article is marked, so Enter opens it; with no articles, the first action.
    const firstArticle = entries.findIndex((e) => e.kind === "article");
    mark(firstArticle >= 0 ? firstArticle : rows.length ? 0 : -1, false);
    el.body.scrollTop = 0;
  }

  function row(entry, tile, title, sub, hint, html = false) {
    const i = entries.push(entry) - 1;
    const tag = entry.href ? `a href="${escape(entry.href)}"` : `button type="button"`;
    return `<li><${tag} class="fv-row" data-i="${i}">
        ${tile}
        <span class="fv-text">
          <span class="fv-line">${html ? title : escape(title)}</span>
          ${sub ? `<span class="fv-sub">${html ? sub : escape(sub)}</span>` : ""}
        </span>
        <span class="fv-hint" aria-hidden="true">${hint}<kbd>↵</kbd></span>
      </${entry.href ? "a" : "button"}></li>`;
  }

  function act(entry) {
    if (entry.kind === "more") {
      expanded.add(entry.key);
      const at = active;
      render(false);
      mark(Math.min(at, rows.length - 1), true);
      return;
    }
    const prompt = want?.query ?? (passage ? "What is related to this passage?" : `What is related to ${article?.title ?? "this article"}?`);
    const request = { mode: entry.kind, label: entry.kind === "ask" ? "Ask" : "Learn", prompt, typed: want?.query ?? "", context: passage, from: null };
    close();
    actions[entry.kind]?.(request);
  }

  async function pictures(titles, token) {
    await loadPictures(titles);
    if (token === request) paint(el.list);
  }

  function mark(index, scroll) {
    active = index;
    rows.forEach((r, i) => r.classList.toggle("is-active", i === active));
    if (scroll) rows[active]?.scrollIntoView({ block: "nearest" });
  }

  // Centred under the top bar, as tall as its rows need, up to the bottom of the window.
  function layout() {
    const top = Math.max(document.querySelector(".bar")?.getBoundingClientRect().bottom ?? 0, 0) + Math.min(48, innerHeight * 0.06);
    const w = Math.min(W, innerWidth - EDGE * 2);
    Object.assign(el.sheet.style, { left: `${(innerWidth - w) / 2}px`, top: `${top}px`, width: `${w}px`, maxHeight: `${innerHeight - top - EDGE * 2}px` });
  }

  // The palette swells out of the prompt bar it replaces.
  function growFrom(from) {
    const box = el.sheet.getBoundingClientRect();
    el.sheet.animate(
      [
        { transform: `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${from.width / box.width}, ${from.height / box.height})`, opacity: 0.4 },
        { transform: "none", opacity: 1 },
      ],
      { duration: reduceMotion() ? 1 : 380, easing: EASE },
    );
    el.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduceMotion() ? 1 : 260 });
  }
}

const section = (title, items) => {
  const list = items.filter(Boolean);
  return list.length ? `<section class="fv-section"><h3>${escape(title)}</h3><ul role="listbox">${list.join("")}</ul></section>` : "";
};
const iconTile = (name) => `<span class="fv-tile fv-icon-tile"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg></span>`;
const thumbTile = (title, name) => thumbHtml(title, name, "fv-tile fv-thumb");

function articleUrl(pageId) {
  const url = new URL(location.href);
  url.searchParams.set("id", pageId);
  url.searchParams.delete("at");
  url.searchParams.delete("lang"); // Find's results are Finnish articles
  return url.href;
}

function build() {
  const scrim = document.createElement("div");
  scrim.className = "fv-scrim";
  scrim.hidden = true;

  const sheet = document.createElement("section");
  sheet.className = "fv";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Find articles");
  sheet.innerHTML = `
    <header class="fv-head">
      <svg class="fv-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3.5 3.5" /></svg>
      <button type="button" class="fv-chip" hidden aria-label="Remove the painted passage">
        <span class="fv-chip-text"></span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" /></svg>
      </button>
      <input type="text" aria-label="Find articles" autocomplete="off" spellcheck="false" />
      <kbd class="fv-esc">esc</kbd>
    </header>
    <div class="fv-body"><div class="fv-list"></div></div>`;
  return {
    scrim,
    sheet,
    input: sheet.querySelector("input"),
    chip: sheet.querySelector(".fv-chip"),
    chipText: sheet.querySelector(".fv-chip-text"),
    body: sheet.querySelector(".fv-body"),
    list: sheet.querySelector(".fv-list"),
  };
}

// What a request asks for, read with word rules (no model): the instruction words are set aside, typos and all,
// and what is left is the topic. "find related articles", "mitä tähän liittyy" or "something interesting related
// to these" ask about the painted passage, or else the article being read: that text is searched, so its meaning
// finds the neighbours. "find articles about cats" asks for "cats"; "articles related to cats" for both.
// Anything else is searched as it is: a name, words or an idea.
const ASKING = (
  "find search show give list get tell me us please what which where who are is there any some more other others " +
  "something anything everything interesting interested cool fun new good best " +
  "related relating relevant similar like linked connected article articles page pages wiki wikipedia read " +
  "about on of for to in with this that these those it its here the a an and or topic topics thing things stuff " +
  "etsi hae näytä löydä anna kerro listaa mitä mikä mitkä missä onko on ole muita muuta lisää jotain jotakin " +
  "kiinnostava kiinnostavaa kiinnostavia hyviä uusia " +
  "liittyy liittyvä liittyvät liittyviä liittyvää liittyen samankaltaisia samanlaisia vastaavia " +
  "artikkeli artikkelit artikkeleita artikkeleja sivu sivut sivuja aihe aiheesta aiheeseen aiheita " +
  "tämä tähän tästä tätä tämän näitä nämä näihin näistä se siihen siitä ja tai kanssa"
).split(" ");
const ASKING_SET = new Set(ASKING);
const ABOUT = /(relat|similar|like th|linked|connected|liittyv|liittyy|samankaltai|samanlai|vastaav|tähän|tästä|näihin|näistä)/iu;

function understand(input, { article, passage }) {
  const words = input.split(/\s+/).filter(Boolean);
  const rest = words.filter((w) => !isAsking(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
  const about = ABOUT.test(input) ? target({ article, passage }) : null;
  if (about) return { about, query: rest.length ? rest.join(" ") : null };
  return { about: null, query: rest.length ? rest.join(" ") : input };
}

// What "related" points at: the painted passage, or else the article (its title and first paragraph).
function target({ article, passage }) {
  if (passage) return { label: "the painted passage", text: firstWords(passage) };
  const lead = document.querySelector(".body p")?.textContent ?? "";
  return { label: article?.title ?? "this article", text: firstWords(`${article?.title ?? ""}. ${lead}`) };
}

// An instruction word, or a near miss of a longer one ("soemthing", "artciles").
function isAsking(word) {
  if (!word || ASKING_SET.has(word)) return true;
  return word.length >= 5 && ASKING.some((a) => a.length >= 5 && Math.abs(a.length - word.length) <= 1 && typos(a, word) <= 1);
}

// Edits between two words, a swap of neighbouring letters counting as one (optimal string alignment).
function typos(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

const blank = () => ({ title: [], meaning: [], passage: [], page: [], links: [] });

// The articles the painted passage links to: the article's links whose text is in the passage, as rows with
// each one's lead. Links to articles that are not in the reader are left out.
async function passageLinks(passage) {
  const text = passage.toLowerCase();
  const titles = [
    ...new Set(
      [...document.querySelectorAll(".body a.wl[data-title]")]
        .filter((a) => a.textContent.trim().length >= 3 && text.includes(a.textContent.trim().toLowerCase()))
        .map((a) => a.dataset.title),
    ),
  ].slice(0, 16);
  const previews = await Promise.all(titles.map((t) => getPreview(t).catch(() => null)));
  return previews
    .filter((p) => p?.id)
    .map((p) => ({ page_id: p.id, title: p.title, snippet: plainText(p.extract), match: null, by: "link" }));
}

const plainText = (html) => {
  const box = document.createElement("div");
  box.innerHTML = html ?? "";
  return box.textContent.replace(/\s+/g, " ").trim();
};

// The titles the article being read links to.
function linkedTitles() {
  return new Set([...document.querySelectorAll(".layout a.wl[data-title]")].map((a) => a.dataset.title));
}

// "Test (joki)" → "Test" and "joki": the part that tells pages of the same name apart.
function splitTitle(title) {
  const m = title.match(/^(.+?)\s*\(([^()]+)\)$/);
  return m ? { name: m[1], qualifier: m[2] } : { name: title, qualifier: null };
}

const ghosts = () => `<div class="fv-loading" aria-label="Searching">${'<span class="fv-ghost"></span>'.repeat(6)}</div>`;
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const firstWords = (text) => text.split(/\s+/).slice(0, QUERY_WORDS).join(" ");
