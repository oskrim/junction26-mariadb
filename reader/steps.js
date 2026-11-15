// What the server is doing for one answer, as a live list above it. Server events: "step" {id, text, done}
// (a later event with the same id updates that step), "thinking" (a piece of Gemini's thought summary) and
// "error" (the running step failed). When the answer starts, the list folds into one line such as "5 steps · 3.2 s".

export function stepsView(reply) {
  const started = performance.now();
  const box = document.createElement("div");
  box.className = "steps";
  box.hidden = true;
  box.innerHTML = `
    <button type="button" class="steps-sum" aria-expanded="false" hidden></button>
    <ol class="steps-list"></ol>
    <details class="steps-thinking" hidden><summary>Thinking</summary><p></p></details>`;
  reply.prepend(box);
  const sum = box.querySelector(".steps-sum");
  const list = box.querySelector(".steps-list");
  const thinking = box.querySelector(".steps-thinking");
  const items = new Map();
  sum.addEventListener("click", () => {
    const open = !box.classList.contains("is-open");
    box.classList.toggle("is-open", open);
    sum.setAttribute("aria-expanded", String(open));
  });
  return { update, fold };

  function update(name, data) {
    if (name === "step") {
      const li = items.get(data.id) ?? add(data.id);
      li.className = `step ${data.done ? "is-done" : "is-running"}`;
      showStep(li, data.text);
    } else if (name === "thinking") {
      thinking.hidden = false;
      thinking.querySelector("p").textContent += data;
    } else if (name === "error") {
      const li = [...items.values()].findLast((s) => s.classList.contains("is-running")) ?? add(`error-${items.size}`);
      li.className = "step is-failed";
      if (!li.querySelector(".step-text").textContent) li.querySelector(".step-text").textContent = "Could not finish";
      li.insertAdjacentHTML("beforeend", `<span class="step-error"></span>`);
      li.lastElementChild.textContent = data;
      box.classList.remove("is-folded");
      sum.hidden = true;
    } else return;
    box.hidden = false;
    reply.classList.add("has-steps");
  }

  function add(id) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="step-mark" aria-hidden="true"></span><span class="step-text"></span>`;
    items.set(id, li);
    list.append(li);
    return li;
  }

  // Called when the answer text starts; a failed request stays unfolded.
  function fold() {
    if (box.hidden || box.classList.contains("is-folded") || list.querySelector(".is-failed")) return;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    sum.textContent = `${items.size} step${items.size === 1 ? "" : "s"} · ${seconds} s`;
    sum.hidden = false;
    box.classList.add("is-folded");
  }
}

// One line per step, the whole text on hover, with an icon for what the step does instead of a check mark (a
// spinner while it runs). A search reads "⌕ query  8": the articles it found are in the tooltip; "Searching
// Finnish Wikipedia N ways, round 2" is just "Searching Finnish Wikipedia".
const SEARCHED = /^Searched “(.+?)” → (\d+) articles?(?: \(\d+ new\))?:?\s*(.*)$/s;
const SEARCHING_ONE = /^Searching “(.+)”$/s;
const SEARCHING = /^(Searching \S+ Wikipedia)\b.*$/;
const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>',
  web: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.6 5.9 5.6 8s.8 3.9 2.4 5.5"/>',
  read: '<path d="M2.5 3.5h4A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z"/>',
  history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  gemini: '<path d="M8 2.5l1.3 3.7 3.7 1.3-3.7 1.3L8 12.5l-1.3-3.7L3 7.5l3.7-1.3z"/>',
  dot: '<circle cx="8" cy="8" r="1.6"/>',
};

function kindOf(text) {
  if (SEARCHED.test(text) || SEARCHING_ONE.test(text)) return "search";
  if (SEARCHING.test(text)) return "web";
  if (/^reading|^read /i.test(text)) return "read";
  if (/edit history|versions? |version of|compar|first appeared|when the|then and now/i.test(text)) return "history";
  if (/gemini|writing|choosing|thinking|answer/i.test(text)) return "gemini";
  return "dot";
}

function showStep(li, text) {
  const out = li.querySelector(".step-text");
  const kind = kindOf(text);
  if (li.dataset.kind !== kind) {
    li.dataset.kind = kind;
    li.querySelector(".step-mark").innerHTML = `<svg class="step-icon" viewBox="0 0 16 16">${ICONS[kind]}</svg>`;
  }
  li.title = text;
  const searched = text.match(SEARCHED) ?? text.match(SEARCHING_ONE);
  if (searched) {
    const [, query, count, titles] = searched;
    li.classList.add("is-search");
    out.innerHTML = `<span class="step-query"></span>${count ? `<span class="step-count">${count}</span>` : ""}`;
    out.querySelector(".step-query").textContent = query;
    li.title = titles ? `${query}: ${titles}` : query;
    return;
  }
  li.classList.remove("is-search");
  // "Asking Gemini…" / "Asked Gemini: first words after 2.0 s" is the answer being written: "Answering", shown
  // once — not again after a step that already says so ("Answering from what was read").
  const asked = /^ask(ed|ing) gemini/i.test(text);
  const said = [...(li.parentElement?.children ?? [])].some((o) => o !== li && /^answering/i.test(o.textContent.trim()));
  li.hidden = asked && said;
  out.textContent = asked ? "Answering" : text.replace(SEARCHING, "$1");
}
