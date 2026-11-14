import { createGlobe } from "./globe.js";
import { createBackdrop } from "./backdrop.js";
import { askWikipedia } from "./fake/api.js";

createBackdrop(document.getElementById("backdrop"));
const globe = createGlobe(document.getElementById("globe"));

const form = document.getElementById("composer");
const q = document.getElementById("q");
const send = document.getElementById("send");
const langBtn = document.getElementById("lang");
const langMenu = document.getElementById("lang-menu");
const answer = document.getElementById("answer");
const answerQ = document.getElementById("answer-q");
const answerText = document.getElementById("answer-text");
const answerSources = document.getElementById("answer-sources");

// ── language pill
const LANGS = [
  { code: "en", name: "English", hint: "Ask anything about how Wikipedia changed…" },
  { code: "simple", short: "s", name: "Simple English", hint: "Ask a question about any page…" },
  { code: "fi", name: "Suomi", hint: "Kysy mitä tahansa Wikipedian historiasta…" },
  { code: "de", name: "Deutsch", hint: "Frag etwas über die Geschichte von Wikipedia…" },
  { code: "ja", name: "日本語", hint: "ウィキペディアの歴史について聞いてみよう…" },
  { code: "es", name: "Español", hint: "Pregunta lo que quieras sobre Wikipedia…" },
];
let lang = LANGS[0];

langMenu.innerHTML = LANGS.map((l) => `<li role="option" tabindex="0" data-code="${l.code}">${l.name}<span>${l.code}</span></li>`).join("");
function renderLang() {
  langBtn.textContent = lang.short ?? lang.code;
  langBtn.setAttribute("aria-label", `Language: ${lang.name}`);
  q.placeholder = lang.hint;
  langMenu.querySelectorAll("li").forEach((li) => li.setAttribute("aria-selected", li.dataset.code === lang.code));
}
function toggleMenu(open = langMenu.hidden) {
  langMenu.hidden = !open;
  langBtn.setAttribute("aria-expanded", open);
  if (open) langMenu.querySelector('[aria-selected="true"]')?.focus();
}
langBtn.addEventListener("click", () => toggleMenu());
langMenu.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  lang = LANGS.find((l) => l.code === li.dataset.code);
  renderLang();
  toggleMenu(false);
  q.focus();
});
langMenu.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.click(); }
  if (e.key === "Escape") { toggleMenu(false); langBtn.focus(); }
  if (e.key === "ArrowDown") e.target.nextElementSibling?.focus();
  if (e.key === "ArrowUp") e.target.previousElementSibling?.focus();
});
document.addEventListener("click", (e) => { if (!e.target.closest(".lang-wrap")) toggleMenu(false); });
renderLang();

// ── textarea
function sync() {
  send.disabled = !q.value.trim();
  q.style.height = "auto";
  q.style.height = `${q.scrollHeight}px`;
}
q.addEventListener("input", sync);
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});

document.getElementById("suggestions").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  q.value = b.textContent;
  sync();
  q.focus();
});

// ── send → fake streamed answer
let busy = false;
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = q.value.trim();
  if (!question || busy) return;
  busy = true;
  globe.burst();
  q.value = "";
  sync();

  answer.hidden = false;
  answer.style.animation = "none"; void answer.offsetWidth; answer.style.animation = "";
  answerQ.textContent = question;
  answerText.textContent = "";
  answerSources.innerHTML = "";
  answerText.className = "answer-text thinking";
  answer.scrollIntoView({ behavior: "smooth", block: "nearest" });

  for await (const chunk of askWikipedia(question, lang.code)) {
    if (chunk.token) {
      answerText.className = "answer-text streaming";
      answerText.textContent += chunk.token;
    }
    if (chunk.sources) {
      answerSources.innerHTML = chunk.sources.map((a, i) => {
        const year = new Date(a.first * 1000).getUTCFullYear();
        return `<a class="source" href="#" style="animation-delay:${i * 70}ms">${a.title}<small>${a.versions.toLocaleString("en")} edits since ${year}</small></a>`;
      }).join("");
    }
  }
  answerText.className = "answer-text";
  busy = false;
});
