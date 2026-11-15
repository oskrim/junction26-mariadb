// Written in from other languages: in a Finnish article, a section where the Swedish or English Wikipedia says
// something the Finnish one doesn't gets a small chip by its heading ("EN · 2 kappaletta, joita täällä ei ole").
// Pressing it types those paragraphs, translated into Finnish, into the article after the section's own text,
// marked as borrowed: a tinted block with a left rule, a label linking to the source article, and the original
// paragraph on hover. Pressing it again ("Piilota") takes them out. Nothing is invented: every paragraph typed
// is a translation of a real paragraph of the other article.
//
// Data: getFill(id) -> { sections: [{ section, lang, source_title, source_url,
//                                     paragraphs: [{ text, translation }] }] }
// `section` is the Finnish heading text as rendered. For now a fixture for Kalevala (498); later GET /api/fill.

const FROM = { en: "Englanninkielisestä Wikipediasta", sv: "Ruotsinkielisestä Wikipediasta" };
const MS_PER_PARAGRAPH = 2600; // how long typing one paragraph takes, whatever its length

// The one line to change when the backend serves it: return fetch(`/api/fill?id=${id}`).then((r) => r.json()).
export async function getFill(id) {
  if (id !== 498) return null;
  return fetch(new URL("fake/fill-in.json", import.meta.url)).then((r) => (r.ok ? r.json() : null));
}

// Every section with a chip, for writing them all in at once (writeInAll, from the "Who wrote this" legend).
const chips = [];
let markReady;
export const fillInsReady = new Promise((resolve) => (markReady = resolve));

// How many borrowed paragraphs are not in the article yet.
export const pendingFillIns = () => chips.filter((c) => !c.isOpen()).reduce((n, c) => n + c.section.paragraphs.length, 0);

// Writes in every section not yet written in, one after another: a gentle scroll to where they go, then the
// paragraphs typed a little faster than by a chip. onSection(i, n) before each. Resolves when all are typed.
let writing = 0; // bumped by closeAllFillIns, so a writeInAll under way stops

export async function writeInAll({ onSection } = {}) {
  await fillInsReady;
  const run = ++writing;
  const todo = chips.filter((c) => !c.isOpen());
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 0 : ms));
  for (const [i, c] of todo.entries()) {
    onSection?.(i, todo.length);
    // Where the paragraphs will go: the end of the section, in the middle of the window.
    sectionEnd(c.heading).scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    await wait(650);
    if (run !== writing) return;
    if (c.isOpen()) continue;
    const { block, done } = c.open(1500);
    // Pictures loading on the way can push the section down: bring the block itself to the middle.
    setTimeout(() => block.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" }), 120);
    await done;
    if (run !== writing) return;
    await wait(350);
  }
}

// Takes every written-in block out again and stops a writeInAll under way: the article as it was. Called when
// "Who wrote this?" is turned off and when "Watch it being written" starts (the "reader:reset" event).
export function closeAllFillIns() {
  writing++;
  for (const c of chips) c.close();
}
addEventListener("reader:reset", closeAllFillIns);

export async function addFillIns({ body, id }) {
  const data = await getFill(id).catch(() => null);
  if (!data?.sections?.length) return markReady();
  const headings = [...body.querySelectorAll("h2, h3")];
  const popover = originalPopover();
  for (const section of data.sections) {
    if (!section.paragraphs?.length || !FROM[section.lang]) continue;
    const heading = matchHeading(section.section, headings);
    if (heading) addChip(heading, section, popover);
  }
  markReady();
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const count = (n) => (n === 1 ? "1 kappale, jota täällä ei ole" : `${n} kappaletta, joita täällä ei ole`);

function addChip(heading, section, popover) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "fill-chip";
  chip.setAttribute("aria-expanded", "false");
  chip.title = `Kirjoita tähän ${section.lang === "sv" ? "ruotsin" : "englannin"}kielisestä Wikipediasta suomennetut kappaleet`;
  const label = () =>
    `<svg class="fill-pen" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z"/></svg>` +
    `<span class="fill-code">${section.lang.toUpperCase()}</span>` +
    `<span class="fill-text">${open ? "Piilota" : count(section.paragraphs.length)}</span>`;
  let open = null; // { block, cancel } while the paragraphs are in the article
  chip.innerHTML = label();
  const toggle = (ms) => {
    if (open) {
      open.cancel();
      const { block } = open;
      block.classList.add("is-leaving");
      setTimeout(() => block.remove(), reducedMotion() ? 0 : 220);
      popover.hide();
      open = null;
    } else {
      open = writeIn(heading, section, popover, ms);
    }
    chip.classList.toggle("is-open", !!open);
    chip.setAttribute("aria-expanded", String(!!open));
    chip.innerHTML = label();
    return open;
  };
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });
  chips.push({ heading, section, isOpen: () => !!open, open: (ms) => toggle(ms), close: () => open && toggle() });
  // Next to the other chips, before the edit-war marks when they are already there.
  heading.insertBefore(chip, heading.querySelector(".war-marks"));
}

// The borrowed paragraphs in a block after the section's last element, typed one after another.
function writeIn(heading, section, popover, msPerParagraph = MS_PER_PARAGRAPH) {
  const block = document.createElement("aside");
  block.className = "fill-block";
  block.dataset.lang = section.lang;
  block.dataset.sourceUrl = section.source_url;
  block.lang = "fi";
  block.setAttribute("aria-label", `${FROM[section.lang]} suomennettu`);
  const source = document.createElement("p");
  source.className = "fill-source";
  source.innerHTML = `<span class="fill-code">${section.lang.toUpperCase()}</span>`;
  const link = document.createElement("a");
  link.href = section.source_url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `${FROM[section.lang]} · ${section.source_title} ↗`;
  source.append(link);
  block.append(source);
  sectionEnd(heading).before(block);

  const paragraphs = section.paragraphs.map((p) => {
    const el = document.createElement("p");
    // "fill-in" + data-lang/data-source-url: the blame view (blame.js) skips these and names them as a source.
    el.className = "fill-in fill-p";
    el.dataset.lang = section.lang;
    el.dataset.sourceUrl = section.source_url;
    el.tabIndex = 0;
    el.addEventListener("mouseenter", () => el.classList.contains("is-done") && popover.show(el, p.text, section.lang));
    el.addEventListener("focus", () => el.classList.contains("is-done") && popover.show(el, p.text, section.lang));
    el.addEventListener("mouseleave", () => popover.hide());
    el.addEventListener("blur", () => popover.hide());
    return { el, text: p.translation };
  });

  let cancelled = false;
  let frame = 0;
  let finish;
  const done = new Promise((resolve) => (finish = resolve)); // typed, or taken out
  if (reducedMotion()) {
    for (const { el, text } of paragraphs) {
      el.textContent = text;
      el.classList.add("is-done");
      block.append(el);
    }
    finish();
  } else {
    const caret = Object.assign(document.createElement("span"), { className: "fill-caret" });
    caret.setAttribute("aria-hidden", "true");
    const typeNext = (i) => {
      if (cancelled) return finish();
      if (i >= paragraphs.length) return caret.remove(), finish();
      const { el, text } = paragraphs[i];
      const typed = document.createTextNode("");
      el.append(typed, caret);
      block.append(el);
      const start = performance.now();
      const step = (t) => {
        if (cancelled) return finish();
        const n = Math.min(text.length, Math.ceil(((t - start) / msPerParagraph) * text.length));
        typed.data = text.slice(0, n);
        if (n < text.length) frame = requestAnimationFrame(step);
        else {
          el.classList.add("is-done");
          setTimeout(() => typeNext(i + 1), 260);
        }
      };
      frame = requestAnimationFrame(step);
    };
    typeNext(0);
  }
  block.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
  return {
    block,
    done,
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      finish();
    },
  };
}

// What follows the section's last element: the next heading of the same or a higher level (or the end).
function sectionEnd(heading) {
  const level = Number(heading.tagName[1]);
  let el = heading.nextElementSibling;
  for (; el; el = el.nextElementSibling) {
    if (/^H[1-6]$/.test(el.tagName) && Number(el.tagName[1]) <= level) return el;
  }
  // No later heading: an empty marker at the end, so .before() still works.
  const end = document.createElement("span");
  heading.parentElement.append(end);
  return end;
}

// One popover for the whole article, showing the original-language paragraph under the hovered one.
function originalPopover() {
  const pop = document.createElement("div");
  pop.className = "fill-original";
  pop.hidden = true;
  pop.setAttribute("role", "tooltip");
  document.body.append(pop);
  return {
    show(el, text, lang) {
      pop.innerHTML = `<p class="fill-original-head">Original</p>`;
      const p = document.createElement("p");
      p.className = "fill-original-text";
      p.lang = lang;
      p.textContent = text;
      pop.append(p);
      pop.hidden = false;
      // In the margin right of the column, level with the paragraph, when it fits; else below or above it.
      const r = el.getBoundingClientRect();
      const column = el.closest(".body").getBoundingClientRect();
      const margin = document.documentElement.clientWidth - column.right - 32;
      if (margin >= 340) {
        pop.style.width = "340px"; // the same as the "Who wrote this?" card (blame.css)
        pop.style.left = `${column.right + 16 + scrollX}px`;
        pop.style.top = `${Math.min(Math.max(r.top, 72), innerHeight - pop.offsetHeight - 16) + scrollY}px`;
      } else {
        const width = Math.min(520, innerWidth - 32);
        pop.style.width = `${width}px`;
        pop.style.left = `${Math.max(16, Math.min(r.left, innerWidth - width - 16)) + scrollX}px`;
        const below = r.bottom + 10 + pop.offsetHeight < innerHeight;
        pop.style.top = `${(below ? r.bottom + 10 : r.top - 10 - pop.offsetHeight) + scrollY}px`;
      }
    },
    hide() {
      pop.hidden = true;
    },
  };
}

// The rendered heading for a section name: the same words (chips aside), else most of the same word starts.
function matchHeading(section, headings) {
  const words = (s) => s.toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  const text = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE || !n.matches("button, .war-marks, .ot-mark, .fill-chip"))
      .map((n) => n.textContent)
      .join("");
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
