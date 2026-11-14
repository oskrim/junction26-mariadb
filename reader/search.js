import { searchArticles } from "./api.js";

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The snippet with the matched query in bold; match is [start, end) in code points, or null.
function highlight(snippet, match) {
  if (!match) return escape(snippet);
  const chars = Array.from(snippet);
  const part = (from, to) => escape(chars.slice(from, to).join(""));
  return `${part(0, match[0])}<b>${part(match[0], match[1])}</b>${part(match[1])}`;
}

// The top bar's search box: matching articles in a list under it. Choosing one opens it in the current view.
export function setUpSearch(box) {
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
    list.hidden = !input.value.trim();
    list.innerHTML = results.length
      ? results
          .map(
            (r, i) => `<li role="option" data-index="${i}" aria-selected="${i === active}">
              <span class="search-title">${escape(r.title)}</span>
              <span class="search-snippet">${highlight(r.snippet, r.match)}</span></li>`,
          )
          .join("")
      : `<li class="search-none">No articles found</li>`;
  }

  async function run() {
    const q = input.value.trim();
    const token = ++request;
    if (!q) {
      results = [];
      return render();
    }
    const found = await searchArticles(q).catch(() => []);
    if (token !== request) return;
    results = found;
    active = -1;
    render();
  }

  function open(result) {
    const url = new URL(location.href);
    url.searchParams.set("id", result.page_id);
    location.href = url;
  }

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
      const result = results[Math.max(active, 0)];
      if (result) open(result);
    } else if (event.key === "Escape") {
      list.hidden = true;
      input.blur();
    } else return;
    event.preventDefault();
  });
  input.addEventListener("focus", () => input.value.trim() && (list.hidden = false));
  // mousedown, not click: the input's blur would hide the list before a click lands.
  list.addEventListener("mousedown", (event) => {
    const item = event.target.closest("[data-index]");
    if (!item) return;
    event.preventDefault();
    open(results[Number(item.dataset.index)]);
  });
  input.addEventListener("blur", () => (list.hidden = true));
}
