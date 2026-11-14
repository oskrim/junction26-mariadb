import { createGlobe } from "./globe-model.js";
import { createBackdrop } from "./backdrop.js";
import { suggestPages, searchPages, looksLikeQuestion, pageUrl, stem, isLive } from "./api.js";

createBackdrop(document.getElementById("backdrop"));
const globe = createGlobe(document.getElementById("globe"));

const $ = (id) => document.getElementById(id);
const form = $("composer"), q = $("q"), send = $("send");
const langBtn = $("lang"), langCode = $("lang-code"), langMenu = $("lang-menu");
const suggest = $("suggest"), results = $("results"), examples = $("examples"), toast = $("toast");

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// edit counts are only known for the fake fallback pages; real search results leave them out
const year = (a) => new Date(a.first * 1000).getUTCFullYear();
const edits = (a) => `${a.versions.toLocaleString("en")} edits`;
const meta = (a) => (a.versions ? `${edits(a)} · since ${year(a)}` : "");
// the page's lead picture, or a quiet letter tile when it has none
const thumb = (a, cls) => a.thumbnail
  ? `<img class="${cls}" src="${a.thumbnail.url}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls}',textContent:'${esc(a.title[0])}'}))">`
  : `<span class="${cls}">${esc(a.title[0])}</span>`;

// ── language
const LANGS = [
  { code: "en", name: "English", hint: "Search Wikipedia or ask a question" },
  { code: "simple", label: "SIMPLE", name: "Simple English", hint: "Search or ask a question" },
  { code: "fi", name: "Suomi", hint: "Hae Wikipediasta tai kysy jotain" },
  { code: "de", name: "Deutsch", hint: "Wikipedia durchsuchen oder etwas fragen" },
  { code: "ja", name: "日本語", hint: "ウィキペディアを検索、または質問" },
  { code: "es", name: "Español", hint: "Busca en Wikipedia o haz una pregunta" },
];
let lang = LANGS[0];
langMenu.innerHTML = LANGS.map((l) => `<li role="option" tabindex="0" data-code="${l.code}">${l.name}<span>${l.code}</span></li>`).join("");
function renderLang() {
  langCode.textContent = lang.label ?? lang.code.toUpperCase();
  langBtn.setAttribute("aria-label", `Language: ${lang.name}`);
  q.placeholder = lang.hint;
  langMenu.querySelectorAll("li").forEach((li) => li.setAttribute("aria-selected", li.dataset.code === lang.code));
}
function toggleLang(open = langMenu.hidden) {
  langMenu.hidden = !open;
  langBtn.setAttribute("aria-expanded", open);
  if (open) { closeSuggest(); langMenu.querySelector('[aria-selected="true"]')?.focus(); }
}
langBtn.addEventListener("click", () => toggleLang());
langMenu.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  lang = LANGS.find((l) => l.code === li.dataset.code);
  renderLang();
  toggleLang(false);
  q.focus();
});
langMenu.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.click(); }
  if (e.key === "Escape") { toggleLang(false); langBtn.focus(); }
  if (e.key === "ArrowDown") { e.preventDefault(); e.target.nextElementSibling?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); e.target.previousElementSibling?.focus(); }
});
renderLang();

// ── box grows only when the text wraps
function grow() {
  q.style.height = "auto";
  q.style.height = `${Math.max(q.scrollHeight, 42)}px`;
  send.disabled = !q.value.trim();
}

// ── dropdown while typing
let options = [], active = -1, typedSeq = 0;
function highlightTitle(title, text) {
  const t = text.trim().toLowerCase(), i = title.toLowerCase().indexOf(t);
  if (!t || i < 0) return esc(title);
  return `${esc(title.slice(0, i))}<b>${esc(title.slice(i, i + t.length))}</b>${esc(title.slice(i + t.length))}`;
}
function renderSuggest(text, pages) {
  const short = text.length > 42 ? `${text.slice(0, 40)}…` : text;
  options = [...pages.map((a) => ({ kind: "page", a })), { kind: "search" }];
  suggest.innerHTML = pages.map((a, i) => `
      <a class="opt" id="opt-${i}" role="option" href="${pageUrl(a)}" data-i="${i}">
        ${thumb(a, "opt-icon")}
        <span class="opt-body"><span class="opt-title">${highlightTitle(a.title, text)}</span><span class="opt-sub">${esc(a.summary)}</span></span>
        ${a.versions ? `<span class="opt-meta">${edits(a)}</span>` : ""}
      </a>`).join("") + `
      <div class="opt opt-search" id="opt-${pages.length}" role="option" data-i="${pages.length}">
        <span class="opt-icon"><svg viewBox="0 0 24 24" width="15" height="15"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m15 15 5 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span>
        <span class="opt-body"><span class="opt-title">${looksLikeQuestion(text) ? "Find pages that answer" : "Search all pages for"} “${esc(short)}”</span></span>
        <span class="kbd">Enter</span>
      </div>`;
  setActive(-1);
  suggest.hidden = false;
  q.setAttribute("aria-expanded", "true");
}
function setActive(i) {
  active = i;
  suggest.querySelectorAll(".opt").forEach((el) => el.setAttribute("aria-selected", Number(el.dataset.i) === i));
  if (i >= 0) q.setAttribute("aria-activedescendant", `opt-${i}`); else q.removeAttribute("aria-activedescendant");
}
function closeSuggest() {
  suggest.hidden = true;
  q.setAttribute("aria-expanded", "false");
  active = -1;
}

q.addEventListener("input", async () => {
  grow();
  const text = q.value.trim();
  const seq = ++typedSeq;
  if (!text) { closeSuggest(); return; }
  const pages = await suggestPages(text);
  if (seq !== typedSeq) return; // a newer keystroke already answered
  // a long question rarely matches a title; still offer the wider search
  renderSuggest(text, pages);
});
q.addEventListener("focus", () => { if (q.value.trim() && results.hidden) q.dispatchEvent(new Event("input")); });

q.addEventListener("keydown", (e) => {
  const open = !suggest.hidden;
  if (open && e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(active + 1, options.length - 1)); }
  else if (open && e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(active - 1, -1)); }
  else if (e.key === "Escape") closeSuggest();
  else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const opt = options[active];
    if (open && opt?.kind === "page") openPage(opt.a);
    else form.requestSubmit();
  }
});
suggest.addEventListener("pointermove", (e) => {
  const el = e.target.closest(".opt");
  if (el) setActive(Number(el.dataset.i));
});
suggest.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
suggest.addEventListener("click", (e) => {
  const el = e.target.closest(".opt");
  if (!el) return;
  e.preventDefault();
  const opt = options[Number(el.dataset.i)];
  if (opt.kind === "page") openPage(opt.a); else form.requestSubmit();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".lang-wrap")) toggleLang(false);
  if (!e.target.closest(".composer-wrap")) closeSuggest();
});

// ── opening a page: real results open in the reader; fake fallback pages only say where they would go
let toastTimer;
function openPage(a) {
  closeSuggest();
  if (isLive()) { location.href = pageUrl(a); return; }
  toast.textContent = `Opening “${a.title}” — the article data can't be reached right now`;
  toast.hidden = false;
  toast.style.animation = "none"; void toast.offsetWidth; toast.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
}

// ── full search on Enter
function markTerms(text, terms) {
  const stems = new Set(terms.map(stem));
  return esc(text).replace(/[A-Za-z0-9'’-]+/g, (w) => (stems.has(stem(w.toLowerCase())) ? `<mark>${w}</mark>` : w));
}
function hitHTML(a, terms, i) {
  return `<a class="hit" href="${pageUrl(a)}" data-id="${a.page_id}" style="animation-delay:${i * 50}ms">
      ${thumb(a, "thumb")}
      <span>
        <span class="hit-title">${esc(a.title)}</span>
        <p class="hit-text">${markTerms(a.summary, terms)}</p>
        ${meta(a) ? `<span class="hit-meta">${meta(a)}</span>` : ""}
      </span>
    </a>`;
}
let found = new Map();
results.addEventListener("click", (e) => {
  const el = e.target.closest(".hit");
  if (!el) return;
  e.preventDefault();
  openPage(found.get(Number(el.dataset.id)));
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  typedSeq++; // drop any dropdown answer still on its way
  closeSuggest();
  globe.burst();
  examples.hidden = true;
  results.hidden = false;
  results.style.animation = "none"; void results.offsetWidth; results.style.animation = "";
  results.innerHTML = `<div class="loading"><i></i><i></i><i></i></div>`;

  const { terms, pages, related } = await searchPages(text);
  found = new Map([...pages, ...related].map((a) => [a.page_id, a]));
  const question = looksLikeQuestion(text);
  let html = "";
  if (pages.length) html += `<h2>Pages</h2>` + pages.map((a, i) => hitHTML(a, terms, i)).join("");
  if (related.length) html += `<h2>${question ? "Might answer your question" : "Pages that mention it"}</h2>` + related.map((a, i) => hitHTML(a, terms, i + pages.length)).join("");
  if (!html) html = `<p class="empty">No pages match “${esc(text)}”.<br>Try one word, like <em>Moon</em>, or ask a question.</p>`;
  results.innerHTML = html;
  results.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

examples.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  q.value = b.textContent;
  grow();
  form.requestSubmit();
});

grow();
