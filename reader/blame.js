import { censor } from "./censor.js";
import { escape } from "./format.js";

// "Who wrote this": tints each paragraph of today's article by the edit that last wrote it, from a replay of
// every version in m_article FOR SYSTEM_TIME ALL. A paragraph unchanged since the version before keeps its
// origin; a new or changed one belongs to that version's edit. Hover a tinted block for who, when and why.
// A second mode shades by age instead: the older the words, the lighter the tint.

// The one place the data comes from. Fixture for Kalevala (page 498) until /api/blame is served; then:
//   return getJson(`/api/blame?id=${id}`)
function loadBlame(id) {
  if (id !== 498) return Promise.resolve(null);
  return fetch(new URL("fake/blame.json", import.meta.url)).then((r) => (r.ok ? r.json() : null));
}

const PERSON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.2" r="2.6"/><path d="M2.8 14c.6-3 2.7-4.6 5.2-4.6s4.6 1.6 5.2 4.6"/></svg>`;
// Paragraph-level elements of the reading column; the infobox, figures and tables are left alone.
const BLOCKS = "p, li, dd, blockquote, h2, h3, h4";
const SKIP = ".infobox, figure, table, .references, .fill-block, .fill-in, .blame-legend, .tellings, nav";
const DAY = 86400000;

export async function addBlame({ head, body, id }) {
  const data = await loadBlame(id).catch(() => null);
  if (!data?.paragraphs?.length) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "blame-toggle";
  button.setAttribute("aria-pressed", "false");
  button.innerHTML = `${PERSON}Who wrote this`;
  const anchor = head.querySelector(".hp-start");
  anchor ? anchor.after(button) : head.append(button);

  let view = null;
  button.addEventListener("click", () => {
    if (view) {
      view.close();
      view = null;
    } else {
      view = openBlame({ body, data });
    }
    button.setAttribute("aria-pressed", String(!!view));
  });
}

function openBlame({ body, data }) {
  const root = document.documentElement;
  root.classList.add("blame-on");
  const now = Date.now();
  const painted = [];
  const card = Object.assign(document.createElement("div"), { className: "blame-card", role: "tooltip" });
  document.body.append(card);

  // Match each rendered block to a paragraph of the blame by its text.
  const index = indexParagraphs(data.paragraphs);
  const blocks = [...body.querySelectorAll(BLOCKS)].filter((el) => !el.closest(SKIP) && !el.querySelector("p, li"));
  for (const el of blocks) {
    const para = match(index, normalize(textOf(el)));
    if (para) painted.push({ el, origin: para.origin, time: Date.parse(para.origin.at.replace(" ", "T") + "Z") });
  }

  // Runs of neighbouring blocks from one edit share a tint; the next run gets a hue far from it.
  let previous = null;
  let hue = null;
  for (const block of painted) {
    const same = previous && previous.origin.rev_id === block.origin.rev_id && adjacent(previous.el, block.el, blocks);
    if (!same) hue = distinctHue(block.origin.rev_id, hue);
    block.hue = hue;
    block.continues = same;
    block.joins = same && block.el.previousElementSibling === previous.el; // fill the margin between them
    previous = block;
  }

  const times = painted.map((b) => b.time);
  const oldest = Math.min(...times);
  const edits = new Set(painted.map((b) => b.origin.rev_id)).size;

  const legend = document.createElement("div");
  legend.className = "blame-legend";
  legend.innerHTML = `
    <p class="blame-note">Colours show which edit last wrote each paragraph — <strong>${edits.toLocaleString("en-US")} edits</strong>
      of ${data.versions.toLocaleString("en-US")} versions shape today's text. The oldest surviving words date from ${new Date(oldest).getUTCFullYear()}.</p>
    <div class="blame-controls">
      <div class="blame-modes" role="group" aria-label="Colour by">
        <button type="button" data-mode="edit" aria-pressed="true">By edit</button>
        <button type="button" data-mode="age" aria-pressed="false">By age</button>
      </div>
      <span class="blame-age-scale" aria-hidden="true"><span>${new Date(oldest).getUTCFullYear()}</span><i></i><span>now</span></span>
      <span class="blame-fill-key" hidden></span>
    </div>`;
  body.prepend(legend);

  let mode = "edit";
  const paint = () => {
    for (const b of painted) {
      b.el.classList.add("blame-block");
      b.el.classList.toggle("blame-continues", b.continues);
      if (!b.el.hasAttribute("tabindex")) {
        b.el.tabIndex = 0; // reachable by keyboard; removed again on close
        b.addedTab = true;
      }
      if (mode === "edit") {
        b.el.style.setProperty("--blame-bg", `hsl(${b.hue} 75% 95.5%)`);
        b.el.style.setProperty("--blame-rule", `hsl(${b.hue} 45% 72%)`);
      } else {
        // Newer is stronger: the share of the article's lifetime since this paragraph was written, eased.
        const fresh = Math.pow((b.time - oldest) / Math.max(1, now - oldest), 1.6);
        b.el.style.setProperty("--blame-bg", `rgb(51 102 204 / ${(0.03 + 0.17 * fresh).toFixed(3)})`);
        b.el.style.setProperty("--blame-rule", `rgb(51 102 204 / ${(0.15 + 0.6 * fresh).toFixed(3)})`);
      }
    }
    // A continuing block also fills the gap above it, so a run reads as one patch.
    for (const b of painted) {
      const prev = b.joins && b.el.previousElementSibling;
      const gap = prev ? Math.max(0, b.el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : 0;
      b.el.style.setProperty("--blame-gap", `${gap}px`);
    }
    legend.dataset.mode = mode;
    for (const m of legend.querySelectorAll("[data-mode]")) m.setAttribute("aria-pressed", String(m.dataset.mode === mode));
  };
  paint();
  legend.querySelector(".blame-modes").addEventListener("click", (event) => {
    const m = event.target.closest("[data-mode]")?.dataset.mode;
    if (m && m !== mode) {
      mode = m;
      paint();
    }
  });

  // Paragraphs written in from other languages (fill-in.js) are their own source, named in the legend.
  const fillKey = legend.querySelector(".blame-fill-key");
  const showFillIns = () => {
    const langs = [...new Set([...body.querySelectorAll(".fill-in")].map((el) => el.dataset.lang))];
    fillKey.hidden = !langs.length;
    const names = langs.map((l) => ({ en: "English", sv: "Swedish" })[l] ?? l).join(" and ");
    const html = `<i></i>From ${escape(names)} Wikipedia (translated)`;
    if (fillKey.innerHTML !== html) fillKey.innerHTML = html; // a change here would wake the observer again
  };
  showFillIns();
  const observer = new MutationObserver((records) => {
    if (records.some((r) => !legend.contains(r.target))) showFillIns();
  });
  observer.observe(body, { childList: true, subtree: true });

  const byEl = new Map(painted.map((b) => [b.el, b]));
  const show = (event) => {
    const el = event.target.closest?.(".blame-block");
    const b = el && byEl.get(el);
    if (!b) return;
    card.innerHTML = cardHtml(b.origin, b.time, now);
    const rect = el.getBoundingClientRect();
    card.classList.add("is-open");
    const top = rect.top + window.scrollY - card.offsetHeight - 8;
    card.style.top = `${top < window.scrollY + 64 ? rect.bottom + window.scrollY + 8 : top}px`;
    card.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - card.offsetWidth - 16)}px`;
    for (const other of painted) other.el.classList.toggle("is-lit", other.origin.rev_id === b.origin.rev_id);
  };
  const hide = (event) => {
    if (event.relatedTarget?.closest?.(".blame-block") === event.target.closest?.(".blame-block")) return;
    card.classList.remove("is-open");
    for (const b of painted) b.el.classList.remove("is-lit");
  };
  body.addEventListener("mouseover", show);
  body.addEventListener("mouseout", hide);
  body.addEventListener("focusin", show);
  body.addEventListener("focusout", hide);
  const away = () => card.classList.remove("is-open");
  window.addEventListener("scroll", away, { passive: true });

  return {
    close() {
      observer.disconnect();
      body.removeEventListener("mouseover", show);
      body.removeEventListener("mouseout", hide);
      body.removeEventListener("focusin", show);
      body.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", away);
      for (const b of painted) {
        b.el.classList.remove("blame-block", "blame-continues", "is-lit");
        for (const p of ["--blame-bg", "--blame-rule", "--blame-gap"]) b.el.style.removeProperty(p);
        if (!b.el.getAttribute("style")) b.el.removeAttribute("style");
        if (!b.el.getAttribute("class")) b.el.removeAttribute("class");
        if (b.addedTab) b.el.removeAttribute("tabindex");
      }
      legend.remove();
      card.remove();
      root.classList.remove("blame-on");
    },
  };
}

function cardHtml(origin, time, now) {
  const date = new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const user = /^[\d.:a-f]+$/i.test(origin.user) && /[.:]/.test(origin.user) ? "an anonymous editor" : censor(origin.user || "unknown");
  const { section, summary } = parseComment(origin.comment);
  return `
    <div class="blame-card-head"><strong>Written ${date}</strong><span>${age(now - time)}</span></div>
    <div class="blame-card-who">by ${escape(user)}${section ? ` <span class="blame-card-sec">in § ${escape(section)}</span>` : ""}</div>
    ${summary ? `<div class="blame-card-why">“${escape(censor(summary))}”</div>` : `<div class="blame-card-why is-empty">No edit summary</div>`}`;
}

// "/* Historia */ korjaus" -> section "Historia", summary "korjaus".
function parseComment(comment = "") {
  const m = comment.match(/\/\*\s*(.*?)\s*\*\//);
  const summary = comment.replace(/\/\*.*?\*\//, "").replace(/^[\s:*-]+|\s+$/g, "");
  return { section: m?.[1] ?? "", summary: summary.length > 140 ? summary.slice(0, 139) + "…" : summary };
}

function age(ms) {
  const days = Math.floor(ms / DAY);
  if (days < 1) return "today";
  if (days < 45) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} months ago`;
  return `${Math.round(days / 365.25)} years ago`;
}

// Text of a block as the reader shows it, without reference marks or buttons (edit-war marks, chips).
function textOf(el) {
  const clone = el.cloneNode(true);
  for (const x of clone.querySelectorAll("sup, button, .war-mark, .math, style")) x.remove();
  return clone.textContent;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function indexParagraphs(paragraphs) {
  const entries = paragraphs.map((p) => {
    const norm = normalize(p.text);
    return { para: p, norm, words: new Set(norm.split(" ")) };
  });
  const byPrefix = new Map();
  for (const e of entries) if (e.norm.length >= 12 && !byPrefix.has(e.norm.slice(0, 80))) byPrefix.set(e.norm.slice(0, 80), e);
  return { entries, byPrefix };
}

// Same first 80 characters, else the paragraph sharing the most words (at least 60% of the shorter one's).
function match({ entries, byPrefix }, norm) {
  if (!norm) return null;
  const exact = byPrefix.get(norm.slice(0, 80)) ?? entries.find((e) => e.norm === norm);
  if (exact) return exact.para;
  const words = new Set(norm.split(" "));
  if (words.size < 3) return null;
  let best = null;
  let bestScore = 0.6;
  for (const e of entries) {
    let shared = 0;
    for (const w of words) if (e.words.has(w)) shared++;
    const score = shared / Math.min(words.size, e.words.size);
    if (score > bestScore || (score === bestScore && best && e.words.size < best.words.size)) {
      best = e;
      bestScore = score;
    }
  }
  return best?.para ?? null;
}

// Two painted blocks are one run when no other paragraph-level block lies between them.
function adjacent(a, b, blocks) {
  return blocks.indexOf(b) - blocks.indexOf(a) === 1;
}

// A hue of its own for each edit (golden-angle spread of rev_id), pushed away from the run before.
function distinctHue(revId, previous) {
  let hue = Math.round((revId * 137.508) % 360);
  if (previous != null) {
    const gap = Math.abs(((hue - previous + 540) % 360) - 180);
    if (gap < 60) hue = (hue + 150) % 360;
  }
  return hue;
}
