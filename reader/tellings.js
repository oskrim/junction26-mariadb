// Other tellings: the same article in Finnish, Swedish and English Wikipedia.
//
// - Beside the title: a languages button, like Wikipedia's ("文A 3 languages"), listing each language with its
//   length; choosing one opens that version here (?id=<its page id>&lang=sv|en; Finnish has no lang).
// - Under the title, in a Finnish article: when another language is much longer, how much.
// - In a section's heading: a chip when another language says much more about that section ("EN 5× more in
//   English"), next to the edit-war marks. Pressing it opens those paragraphs in a card under the section.
//
// It reads /api/tellings (server/tellings.py): each language's length and page id, and per Finnish section the
// Swedish and English paragraphs that bge-m3 placed closest to it. Without that data (or on a server without the
// endpoint) it adds nothing.

import { getTellings } from "./api.js";

const MUCH_LONGER = 2; // ratio at which a language "has more", for the article and for a section
const MIN_WORDS = 150; // a section note needs at least this much from the other language
const MIN_PARAGRAPHS = 2;

const ORDER = ["fi", "sv", "en"];
export const NATIVE = { fi: "Suomi", sv: "Svenska", en: "English" };

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const times = (ratio) => `${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}×`.replace(".0×", "×");
const count = (n) => n.toLocaleString("en-US");

// The reader's address for a language's version of the article.
export const languageHref = (l) => (l.lang === "fi" ? `./?id=${l.page_id}` : `./?id=${l.page_id}&lang=${l.lang}`);

export async function addTellings({ head, body, id, lang = "fi" }) {
  const data = await getTellings(id, lang).catch(() => null);
  const languages = data?.languages ?? [];
  if (languages.length < 2) return; // only in Finnish: nothing to switch to

  css();
  head.querySelector(".head-title")?.append(languagePicker(languages, lang));
  if (lang !== "fi") return; // the notes compare with the Finnish text
  const [fi, ...others] = languages;
  if (fi.lang !== "fi") return;
  const notes = sectionNotes(body, data.sections, others);
  const line = titleLine(fi, others, notes);
  if (line) head.querySelector(".meta")?.after(line);
}

// "文A 3 languages", opening a list of the languages with their lengths, the one shown marked.
function languagePicker(languages, current) {
  const sorted = [...languages].sort((a, b) => ORDER.indexOf(a.lang) - ORDER.indexOf(b.lang));
  const picker = document.createElement("div");
  picker.className = "lang-picker";
  picker.innerHTML = `
    <button type="button" class="lang-button" aria-haspopup="true" aria-expanded="false">
      <span class="lang-icon" aria-hidden="true">文A</span>
      <span>${sorted.length} languages</span>
      <svg class="lang-chevron" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
    </button>
    <div class="lang-menu" hidden>
      <p class="lang-menu-label">Read this article in</p>
      <ul>
        ${sorted
          .map(
            (l) => `<li><a class="lang-item${l.lang === current ? " is-current" : ""}" href="${languageHref(l)}" hreflang="${l.lang}"${l.lang === current ? ' aria-current="page"' : ""}>
              <span class="lang-native" lang="${l.lang}">${NATIVE[l.lang]}</span>
              <span class="lang-words">${count(l.words)} words</span>
              ${l.lang === current ? '<svg class="lang-check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.6" /></svg>' : ""}
            </a></li>`,
          )
          .join("")}
      </ul>
      <p class="lang-menu-foot">Finnish comes with its whole edit history; Swedish and English are their current versions.</p>
    </div>`;
  const button = picker.querySelector(".lang-button");
  const menu = picker.querySelector(".lang-menu");
  const setOpen = (open) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => setOpen(menu.hidden));
  document.addEventListener("click", (event) => !picker.contains(event.target) && setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    setOpen(false);
    button.focus();
  });
  return picker;
}

// With a much longer language: "Swedish Wikipedia has 5× more on this …"; else, when some sections are told at
// more length elsewhere, how many. Nothing otherwise: the languages button names the languages.
function titleLine(fi, others, notes) {
  const line = document.createElement("p");
  line.className = "ot-line";
  const longest = others[0]; // the API sorts the others longest first
  const ratio = longest.words / Math.max(fi.words, 1);
  if (ratio >= MUCH_LONGER) {
    line.classList.add("is-more");
    line.innerHTML =
      `<span class="ot-badge">${times(ratio)}</span>` +
      `<span><a class="ot-lang" href="${languageHref(longest)}">${longest.name} Wikipedia</a> ` +
      `has ${times(ratio)} more on this: ${count(longest.words)} words to ${count(fi.words)} here.</span>` +
      (notes.length ? `<button type="button" class="ot-where">See where</button>` : "");
    line.querySelector(".ot-where")?.addEventListener("click", () => {
      notes[0].closest("h2, h3").scrollIntoView({ behavior: "smooth", block: "center" });
      notes[0].classList.add("is-flash");
      setTimeout(() => notes[0].classList.remove("is-flash"), 1400);
    });
    return line;
  }
  if (!notes.length) return null;
  line.innerHTML = `<span>${notes.length} section${notes.length > 1 ? "s are" : " is"} told at more length in ${others.map((o) => o.name).join(" or ")}</span>`;
  return line;
}

// A chip in the heading of every section that another language tells at much more length.
function sectionNotes(body, sections, others) {
  const names = Object.fromEntries(others.map((o) => [o.lang, o]));
  const headings = [...body.querySelectorAll("h2, h3")];
  const notes = [];
  for (const s of sections) {
    if (!s.section) continue; // the introduction: the line under the title speaks for it
    const best = Object.entries(s.others)
      .map(([lang, o]) => ({ lang, ...o, ratio: o.words / Math.max(s.fi_words, 1) }))
      .filter((o) => o.ratio >= MUCH_LONGER && o.words >= MIN_WORDS && o.paragraphs.length >= MIN_PARAGRAPHS)
      .sort((a, b) => b.ratio - a.ratio)[0];
    const heading = best && matchHeading(s.section, headings);
    if (!heading) continue;
    const language = names[best.lang];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ot-mark";
    chip.title = `${language.name} Wikipedia: ${count(best.words)} words on this, to ${count(s.fi_words)} here`;
    chip.innerHTML = `<span class="ot-code">${best.lang.toUpperCase()}</span>${times(best.ratio)} more in ${language.name}`;
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(chip, heading, s, best, language);
    });
    // Before the edit-war marks, when they are there already; they are added to the end otherwise.
    heading.insertBefore(chip, heading.querySelector(".war-marks"));
    notes.push(chip);
  }
  return notes;
}

// The rendered heading for a section name from the S text: the same words, else most of the same word starts.
function matchHeading(section, headings) {
  const words = (s) => s.toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  const text = (el) =>
    [...el.childNodes].filter((n) => !n.classList?.contains("war-marks") && !n.classList?.contains("ot-mark")).map((n) => n.textContent).join("");
  const want = words(section).join(" ");
  const exact = headings.find((h) => words(text(h)).join(" ") === want);
  if (exact) return exact;
  const stems = new Set(words(section).map((w) => w.slice(0, 5)));
  let best = null;
  let bestScore = 0;
  for (const h of headings) {
    const have = words(text(h)).map((w) => w.slice(0, 5));
    const score = have.filter((w) => stems.has(w)).length / Math.max(have.length, stems.size);
    if (score > bestScore) [best, bestScore] = [h, score];
  }
  return bestScore >= 0.6 ? best : null;
}

let open = null;

const SHOWN = 2; // paragraphs the card shows before "Show all"

// The other language's paragraphs in a card under the section's own text, until closed.
function toggle(chip, heading, section, other, language) {
  const same = open?.chip === chip;
  open?.close();
  if (same) return;
  const card = document.createElement("section");
  card.className = "ot-card";
  card.setAttribute("aria-label", `${language.name} Wikipedia on ${section.section}`);
  let last = null;
  const paragraphs = other.paragraphs
    .map((p, i) => {
      const sub = p.section && p.section !== last ? `<p class="ot-card-sub">${escape(p.section)}</p>` : "";
      last = p.section;
      return `<div class="ot-card-p${i >= SHOWN ? " is-more" : ""}">${sub}<p lang="${other.lang}">${escape(p.text.replace(/\*\*?/g, ""))}</p></div>`;
    })
    .join("");
  const rest = other.paragraphs.length - SHOWN;
  card.innerHTML = `
    <header class="ot-card-head">
      <span class="ot-code">${other.lang.toUpperCase()}</span>
      <a class="ot-card-source" href="${escape(language.url)}" target="_blank" rel="noopener">${language.name} Wikipedia · ${escape(language.title)} ↗</a>
      <button type="button" class="ot-card-close" aria-label="Close">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </header>
    <h4 class="ot-card-title">${times(other.ratio)} more on “${escape(section.section)}”</h4>
    <p class="ot-card-stats">${count(other.words)} words in ${other.paragraphs.length} paragraphs, to ${count(section.fi_words)} here</p>
    <div class="ot-card-text${rest > 0 ? " is-collapsed" : ""}">${paragraphs}</div>
    ${rest > 0 ? `<button type="button" class="ot-card-all">Show all ${other.paragraphs.length} paragraphs</button>` : ""}
    <p class="ot-card-how">Paragraphs matched to this section by meaning, across languages, with MariaDB vector search.</p>`;
  card.querySelector(".ot-card-all")?.addEventListener("click", (event) => {
    card.querySelector(".ot-card-text").classList.remove("is-collapsed");
    event.currentTarget.remove();
  });
  // Right under the heading whose chip opened it; the Finnish text follows.
  heading.after(card);
  chip.classList.add("is-open");
  chip.setAttribute("aria-expanded", "true");
  const onKey = (e) => e.key === "Escape" && close();
  const close = () => {
    card.remove();
    chip.classList.remove("is-open");
    chip.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey);
    open = null;
  };
  card.querySelector(".ot-card-close").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  open = { chip, close };
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function css() {
  if (document.querySelector("link[data-tellings]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("tellings.css", import.meta.url).href;
  link.dataset.tellings = "";
  document.head.append(link);
}
