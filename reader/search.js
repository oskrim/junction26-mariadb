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
export function setUpSearch(box, { onFind = null } = {}) {
  const input = box.querySelector("input");
  const list = document.createElement("ul");
  list.className = "search-results";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  box.append(list);
  let results = [];
  let active = -1;
  let timer = 0;
  let request = 0;

  function render() {
    const query = input.value.trim();
    // Results that arrive after the box was left (Enter opened Find, or Escape) stay hidden.
    list.hidden = !query || document.activeElement !== input;
    list.innerHTML =
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
        : `<li class="search-none">No titles match</li>`) +
      // With Find there, Enter (nothing chosen) searches everything: by meaning, related, ask, learn.
      (onFind && query ? `<li class="search-all" data-all aria-selected="false"><span>Search all for “${escape(query)}”</span><kbd>↵</kbd></li>` : "");
    paint(list);
  }

  async function run() {
    const q = input.value.trim();
    const token = ++request;
    if (!q) {
      results = [];
      return render();
    }
    const found = await searchArticles(q, 8, pageLang()).catch(() => []);
    if (token !== request) return;
    results = found;
    active = -1;
    render();
    // The pictures come a moment later, from Wikipedia.
    loadPictures(found.map((r) => r.title)).then(() => token === request && paint(list));
  }

  // Enter or the arrow: the chosen title, or with none chosen everything for the words (Find), or else the
  // first title.
  function submit() {
    const query = input.value.trim();
    if (active < 0 && onFind && query) {
      clearTimeout(timer);
      request++;
      list.hidden = true;
      input.blur();
      onFind(query);
    } else {
      const result = results[Math.max(active, 0)];
      if (result) open(result);
    }
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
  input.addEventListener("focus", () => input.value.trim() && (list.hidden = false));
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
    if (event.target.closest("[data-all]")) {
      event.preventDefault();
      list.hidden = true;
      input.blur();
      return onFind(input.value.trim());
    }
    const item = event.target.closest("[data-index]");
    if (!item) return;
    event.preventDefault();
    open(results[Number(item.dataset.index)]);
  });
  input.addEventListener("blur", () => (list.hidden = true));
}
