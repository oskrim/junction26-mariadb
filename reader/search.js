import { pageLang, searchArticles } from "./api.js";
import { loadPictures, paint, thumbHtml } from "./pictures.js";

export const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The snippet with the matched query in bold; match is [start, end) in code points, or null.
export function highlight(snippet, match) {
  if (!match) return escape(snippet);
  const chars = Array.from(snippet);
  const part = (from, to) => escape(chars.slice(from, to).join(""));
  return `${part(0, match[0])}<b>${part(match[0], match[1])}</b>${part(match[1])}`;
}

// The top bar's search box: matching titles in a list under it. Choosing one opens it in the current view;
// Enter with none chosen hands the words to onFind (the Find palette), when there is one.
// What an empty box offers, as on the home page (lander/index.html): four articles and a question.
// An empty box lists Finnish Wikipedia's most-read articles of 2025 (Wikimedia pageviews, monthly tops summed),
// keeping those whose full edit history we hold, most read first
const SUGGESTIONS = [
  { page_id: 11396, title: "Alexander Stubb", snippet: "Suomalainen kokoomustaustainen poliitikko ja Suomen tasavallan presidentti" },
  { page_id: 1275, title: "Urho Kekkonen", snippet: "Suomalainen poliitikko ja Suomen tasavallan presidentti 1956–1982" },
  { page_id: 1256, title: "Talvisota", snippet: "Suomen ja Neuvostoliiton sota 30. marraskuuta 1939 – 13. maaliskuuta 1940" },
  { page_id: 1394958, title: "Eemeli Peltonen", snippet: "Suomalainen sosiaalidemokraattinen poliitikko ja kansanedustaja" },
  { page_id: 440, title: "Jatkosota", snippet: "Suomen ja Neuvostoliiton sota 25. kesäkuuta 1941 – 19. syyskuuta 1944" },
  { page_id: 1069, title: "Suomen tasavallan presidentti", snippet: "Suomen kansan valitsema valtionpäämies" },
  { page_id: 15295, title: "Eppu Normaali", snippet: "Suomalainen rockyhtye, aloitti uuden aallon punk-yhtyeenä vuonna 1976" },
  { page_id: 1150, title: "Suomen sisällissota", snippet: "Senaatin ja kansanvaltuuskunnan joukkojen sota 27. tammikuuta – 15. toukokuuta 1918" },
].map((r) => ({ ...r, match: null }));

export function setUpSearch(box) {
  const input = box.querySelector("input");
  const list = document.createElement("ul");
  list.className = "search-results";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  box.append(list);
  let results = [];
  let shownFor = null; // the words the results answer; null before any have come
  let failed = false;
  let openFirst = false; // Enter came before the results: the top one opens when they do
  let active = -1;
  let timer = 0;
  let request = 0;

  function render() {
    const query = input.value.trim();
    // Results that arrive after the box was left (Enter opened Find, or Escape) stay hidden. An empty box shows
    // the home page's suggestions.
    list.hidden = (!query && !results.length) || document.activeElement !== input;
    list.innerHTML =
      (!query && results.length ? `<li class="search-head">Most read</li>` : "") +
      (results.length
        ? results
            .map(
              (r, i) => `<li role="option" data-index="${i}" aria-selected="${i === active}">
              ${thumbHtml(r.title, r.title, "search-pic")}
              <span class="search-text">
                <span class="search-title">${escape(r.title)}</span>
                <span class="search-snippet">${highlight(r.snippet, r.match)}</span>
              </span></li>`,
            )
            .join("")
        : `<li class="search-none">${failed ? "Search is not answering right now" : shownFor === null ? "Searching…" : "No articles match"}</li>`);
    paint(list);
  }

  async function run() {
    const q = input.value.trim();
    const token = ++request;
    if (!q) {
      results = pageLang() === "fi" ? SUGGESTIONS : [];
      shownFor = null;
      failed = openFirst = false;
      return render();
    }
    if (shownFor === null) {
      failed = false;
      render(); // "Searching…" until the first results come
    }
    const found = await searchArticles(q, 8, pageLang()).catch(() => null);
    if (token !== request) return;
    failed = !found;
    results = found ?? [];
    shownFor = found ? q : null; // after a failure, Enter asks again
    active = -1;
    if (openFirst && results.length) return open(results[0]);
    openFirst = false;
    render();
    // The pictures come a moment later, from Wikipedia.
    loadPictures(results.map((r) => r.title)).then(() => token === request && paint(list));
  }

  // Enter or the arrow: the chosen article, else the top one.
  // Enter before the list caught up with the box searches for what the box says and opens its top article, not
  // the top of the list for the first letters.
  function submit() {
    const q = input.value.trim();
    if (active < 0 && q && shownFor !== q) {
      openFirst = true;
      clearTimeout(timer);
      return run();
    }
    const result = results[Math.max(active, 0)];
    if (result) open(result);
  }

  // A result is a Finnish article unless it says otherwise (a Swedish or English search's results carry lang).
  function open(result) {
    const url = new URL(location.href);
    url.searchParams.set("id", result.page_id);
    if (result.lang && result.lang !== "fi") url.searchParams.set("lang", result.lang);
    else url.searchParams.delete("lang");
    location.href = url;
  }

  const go = box.querySelector(".search-go");
  const showGo = () => box.classList.toggle("has-text", Boolean(input.value.trim()));
  // mousedown, not click, like the list: the input's blur would hide the list first.
  go?.addEventListener("mousedown", (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener("input", showGo);
  input.addEventListener("input", () => {
    openFirst = false;
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!results.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = (active + step + results.length) % results.length;
      render();
    } else if (event.key === "Enter") {
      submit();
    } else if (event.key === "Escape") {
      list.hidden = true;
      input.blur();
    } else return;
    event.preventDefault();
  });
  input.addEventListener("focus", () => (input.value.trim() ? (list.hidden = false) : run()));
  // "/" anywhere else on the page goes to the box, as in many search boxes.
  addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
  // mousedown, not click: the input's blur would hide the list before a click lands.
  list.addEventListener("mousedown", (event) => {
    const item = event.target.closest("[data-index]");
    if (!item) return;
    event.preventDefault();
    open(results[Number(item.dataset.index)]);
  });
  input.addEventListener("blur", () => (list.hidden = true));

  // Find (the Q menu's F): the box, focused, with the words to search for, if any, and their results.
  return {
    focus(query = "") {
      if (query) input.value = query;
      showGo();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      clearTimeout(timer);
      if (input.value.trim()) run();
    },
  };
}
