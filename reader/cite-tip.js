// One tooltip for the citation markers in chat answers (built by citeLinks in learn.js): the source, why it was
// used and the passage the claim rests on. It shows on hover and keyboard focus. On touch, the first tap on a
// marker shows it and a second tap does what the marker does. An Ask marker shows its quote in the article.

import { showQuote } from "./assistant.js";

const MARKER = ".msg-text .cite, .lesson .cite";
const EDGE = 8;
const GAP = 6;

const tip = document.createElement("div");
tip.className = "cite-tip";
tip.id = "cite-tip";
tip.setAttribute("role", "tooltip");
document.body.append(tip);

let current = null;
let hideTimer = 0;
let firstTap = false;

function show(marker) {
  clearTimeout(hideTimer);
  if (marker === current) return;
  current?.removeAttribute("aria-describedby");
  current = marker;
  const { tipTitle, tipMeta, tipQuote } = marker.dataset;
  const head = part("span", "cite-tip-head", "");
  head.append(part("span", "cite-tip-title", tipTitle), action(marker));
  tip.replaceChildren(
    head,
    part("span", "cite-tip-meta", tipMeta),
    ...(tipQuote ? [part("q", "cite-tip-quote", tipQuote)] : []),
  );
  place(marker);
  marker.setAttribute("aria-describedby", tip.id);
  tip.classList.add("is-visible");
}

function hide(delay) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    tip.classList.remove("is-visible");
    current?.removeAttribute("aria-describedby");
    current = null;
  }, delay);
}

// Top right of the card: "Open ↗" goes where the marker's link goes (another article, or another version of
// this one); "Show" finds the quote in the article being read, as clicking the marker does.
function action(marker) {
  if (marker.matches("a[href]")) {
    const open = part("a", "cite-tip-open", "Open ↗");
    open.href = marker.href;
    if (marker.target) open.target = marker.target;
    open.rel = "noopener";
    return open;
  }
  const show = part("button", "cite-tip-open", "Show");
  show.type = "button";
  show.addEventListener("click", () => {
    showQuote(marker.dataset.quote);
    hide(0);
  });
  return show;
}

function part(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

// Centered on the marker, kept inside the window, below it unless only above has room.
function place(marker) {
  const r = marker.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = tip;
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), innerWidth - w - EDGE);
  const below = r.bottom + GAP + h <= innerHeight - EDGE || r.top - GAP - h < EDGE;
  tip.dataset.side = below ? "below" : "above";
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + GAP : r.top - GAP - h}px`;
}

// Decided before the tap focuses the marker, which shows the tooltip too.
addEventListener("pointerdown", (e) => {
  const marker = e.target.closest(MARKER);
  firstTap = e.pointerType === "touch" && marker !== null && marker !== current;
  if (!marker && !e.target.closest(".cite-tip")) hide(0);
});
addEventListener("pointerover", (e) => {
  if (e.pointerType === "touch") return;
  const marker = e.target.closest(MARKER);
  if (marker) show(marker);
  else if (e.target.closest(".cite-tip")) clearTimeout(hideTimer);
});
addEventListener("pointerout", (e) => {
  if (e.pointerType !== "touch" && e.target.closest(`${MARKER}, .cite-tip`)) hide(150);
});
addEventListener("focusin", (e) => e.target.matches?.(MARKER) && show(e.target));
addEventListener("focusout", (e) => e.target.matches?.(MARKER) && hide(150));
addEventListener("keydown", (e) => e.key === "Escape" && hide(0));
addEventListener("scroll", () => current && hide(0), { capture: true, passive: true });
addEventListener("click", (e) => {
  const marker = e.target.closest(MARKER);
  if (!marker) return;
  if (firstTap) {
    firstTap = false;
    e.preventDefault();
    show(marker);
    return;
  }
  if (marker.dataset.quote) {
    hide(0);
    showQuote(marker.dataset.quote);
  }
});
