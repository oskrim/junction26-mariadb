import { BASE } from "./api.js";
import { censor } from "./censor.js";
import { escape } from "./format.js";

// "Who wrote this": tints each paragraph of today's article by the edit that last wrote it, from a replay of
// every version in m_article FOR SYSTEM_TIME ALL (server/blame.py). Neighbouring paragraphs from one edit share
// a tint; hover one for who, when and why. Beside the toggle, "Add from other languages" writes in what the Swedish and
// English Wikipedias say that this one doesn't (fill-in.js), so the article shows every source of its paragraphs.

// The one place the data comes from (reader/fake/blame.json is a saved answer for Kalevala, 498).
function loadBlame(id) {
  return fetch(`${BASE}/api/blame?id=${id}`).then((r) => (r.ok ? r.json() : null));
}

const PERSON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.2" r="2.6"/><path d="M2.8 14c.6-3 2.7-4.6 5.2-4.6s4.6 1.6 5.2 4.6"/></svg>`;
const PEN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.6l2.2 2.2-7.6 7.6-2.9.7.7-2.9z"/></svg>`;
// Paragraph-level elements of the reading column; the infobox, figures and tables are left alone.
const BLOCKS = "p, li, dd, blockquote, h2, h3, h4";
const SKIP = ".infobox, figure, table, .references, .fill-block, .fill-in, .tellings, nav";
const DAY = 86400000;
const SWEEP_MS = 850; // the tints cascade down the window in this long
const LEAVE_MS = 220;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export async function addBlame({ head, body, id }) {
  const data = await loadBlame(id).catch(() => null);
  if (!data?.paragraphs?.length) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "blame-toggle";
  button.setAttribute("aria-pressed", "false");
  button.innerHTML = `${PERSON}Who wrote this?`;
  const anchor = head.querySelector(".hp-start");
  anchor ? anchor.after(button) : head.append(button);

  let view = null;
  button.addEventListener("click", () => {
    if (view) {
      view.close();
      view = null;
      // Ignore clicks until the tints have faded, so a quick on-off-on never meets a half-removed view.
      button.disabled = true;
      setTimeout(() => (button.disabled = false), reducedMotion() ? 0 : LEAVE_MS + 20);
    } else {
      view = openBlame({ body, data, button });
    }
    button.setAttribute("aria-pressed", String(!!view));
  });
}

function openBlame({ body, data, button }) {
  const root = document.documentElement;
  root.classList.remove("blame-shown", "blame-leaving");
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
    block.prev = same ? previous.el : null;
    previous = block;
  }

  // "Fill in from other languages" sits next to "Who wrote this" while the view is on.
  const fillButton = document.createElement("button");
  fillButton.type = "button";
  fillButton.className = "blame-toggle blame-fill";
  fillButton.hidden = true;
  button.after(fillButton);

  // The cascade: each block's tint starts a little after the one above it, over SWEEP_MS for what is in the
  // window; blocks further down start last. Delays are cleared afterwards.
  // Measured from the first tinted block on screen, so the sweep starts at once.
  const tops = painted.map((b) => b.el.getBoundingClientRect().top);
  const start = Math.max(0, Math.min(...tops.filter((t) => t >= 0), innerHeight));
  const span = Math.max(200, innerHeight - start);
  for (const [i, b] of painted.entries()) {
    const share = Math.min(1.15, Math.max(0, (tops[i] - start) / span));
    b.el.style.setProperty("--blame-delay", `${Math.round(share * SWEEP_MS)}ms`);
  }

  const paint = () => {
    for (const b of painted) {
      b.el.classList.add("blame-block");
      b.el.classList.toggle("blame-continues", b.continues);
      if (!b.el.hasAttribute("tabindex")) {
        b.el.tabIndex = 0; // reachable by keyboard; removed again on close
        b.addedTab = true;
      }
      b.el.style.setProperty("--blame-bg", `hsl(${b.hue} 65% 95.5%)`);
      b.el.style.setProperty("--blame-rule", `hsl(${b.hue} 45% 72%)`);
    }
  };
  // A continuing block also covers the margin above it, so a run reads as one patch. Measured again when
  // something is written into the article (fill-in.js) or the window changes width.
  const layout = () => {
    for (const b of painted) {
      const prev = b.prev && b.el.previousElementSibling === b.prev ? b.prev : null;
      const gap = prev ? Math.max(0, b.el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : 0;
      b.el.style.setProperty("--blame-gap", `${gap}px`);
    }
  };
  paint();
  layout();
  let closed = false;
  const sweepTimer = setTimeout(() => {
    for (const b of painted) b.el.style.removeProperty("--blame-delay");
  }, SWEEP_MS * 1.15 + 700);
  // Two frames: the blocks are painted transparent first, then the tints transition in.
  frame().then(frame).then(() => !closed && root.classList.add("blame-shown"));

  // Paragraphs that the Swedish and English Wikipedias have and this one lacks (fill-in.js): one button
  // writes in all of them, translated, where they fit.
  let fill = null; // fill-in.js, once its chips are in place
  let filling = false;
  const showFillIns = () => {
    if (fill && !filling && !fillButton.classList.contains("is-done")) {
      const n = fill.pendingFillIns();
      const label = `${PEN}Add from other languages (${n})`;
      fillButton.title = "Write in, translated, what the English and Swedish Wikipedias have and this article lacks";
      fillButton.hidden = !n;
      if (n && fillButton.innerHTML !== label) fillButton.innerHTML = label;
    }
  };
  import("./fill-in.js").then(async (m) => {
    await m.fillInsReady;
    if (closed) return;
    fill = m;
    showFillIns();
  });
  fillButton.addEventListener("click", async () => {
    if (!fill || filling) return;
    filling = true;
    fillButton.disabled = true;
    fillButton.classList.add("is-busy");
    const step = (i, n) => (fillButton.innerHTML = `${PEN}Adding ${i + 1}/${n}…`);
    await fill.writeInAll({ onSection: (i, n) => !closed && step(i, n) });
    filling = false;
    if (closed) return;
    fillButton.classList.remove("is-busy");
    fillButton.classList.add("is-done");
    fillButton.innerHTML = `✓ Added from other languages`;
  });
  showFillIns();
  let pending = 0;
  const observer = new MutationObserver((records) => {
    showFillIns();
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(layout);
  });
  observer.observe(body, { childList: true, subtree: true });
  addEventListener("resize", layout);

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
      closed = true;
      clearTimeout(sweepTimer);
      cancelAnimationFrame(pending);
      observer.disconnect();
      removeEventListener("resize", layout);
      body.removeEventListener("mouseover", show);
      body.removeEventListener("mouseout", hide);
      body.removeEventListener("focusin", show);
      body.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", away);
      card.remove();
      // The tints fade; then every trace goes.
      root.classList.add("blame-leaving");
      fillButton.remove();
      setTimeout(() => {
        for (const b of painted) {
          b.el.classList.remove("blame-block", "blame-continues", "is-lit");
          for (const p of ["--blame-bg", "--blame-rule", "--blame-gap", "--blame-delay"]) b.el.style.removeProperty(p);
          if (!b.el.getAttribute("style")) b.el.removeAttribute("style");
          if (!b.el.getAttribute("class")) b.el.removeAttribute("class");
          if (b.addedTab) b.el.removeAttribute("tabindex");
        }
        root.classList.remove("blame-on", "blame-shown", "blame-leaving");
      }, reducedMotion() ? 0 : LEAVE_MS);
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
