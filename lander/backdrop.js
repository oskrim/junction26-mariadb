// Faint lines of article text drifting behind everything. Every so often an
// invisible editor erases a word and types a new one, like Wikipedia being edited live.
import { SNIPPETS, EDITS } from "./fake/api.js";

const SWAP = new Map();
EDITS.forEach(([a, b]) => { SWAP.set(a, b); SWAP.set(b, a); });

const shuffle = (arr) => arr.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lineHTML() {
  const text = shuffle(SNIPPETS).slice(0, 7).join("   ·   ");
  return text.replace(/[A-Za-z0-9'’-]+/g, (w) => `<span class="w">${w}</span>`);
}

export function createBackdrop(root) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rows = Math.ceil(innerHeight / 62) + 1;

  for (let i = 0; i < rows; i++) {
    const row = document.createElement("div");
    row.className = "drift-row";
    const html = lineHTML();
    row.innerHTML = `<div class="drift-track" style="--dur:${180 + Math.random() * 160}s;--dir:${i % 2 ? "reverse" : "normal"};--delay:${-Math.random() * 200}s"><span>${html}</span><span aria-hidden="true">${html}</span></div>`;
    row.style.fontSize = `${14 + (i % 3) * 1.5}px`;
    root.appendChild(row);
  }
  if (reduced) return;

  // pick a visible word that has a sensible swap; fall back to any visible word
  function pickWord() {
    const all = [...root.querySelectorAll(".w:not(.editing)")];
    const cx = innerWidth / 2, cy = innerHeight * 0.48;
    const visible = all.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.right < 24 || r.left > innerWidth - 24 || r.bottom < 0 || r.top > innerHeight) return false;
      // keep edits out of the bright centre where the globe and box sit
      const dx = (r.left + r.width / 2 - cx) / (innerWidth * 0.3), dy = (r.top - cy) / (innerHeight * 0.4);
      return dx * dx + dy * dy > 1;
    });
    const good = visible.filter((el) => SWAP.has(el.textContent.toLowerCase()));
    const list = good.length ? good : [];
    return list[Math.floor(Math.random() * list.length)];
  }

  async function edit(el) {
    const from = el.textContent;
    let to = SWAP.get(from.toLowerCase());
    if (from[0] === from[0].toUpperCase()) to = to[0].toUpperCase() + to.slice(1);
    el.classList.add("editing");
    await sleep(500);
    for (let n = from.length; n > 0; n--) { el.textContent = from.slice(0, n - 1); await sleep(55); }
    await sleep(320);
    for (let n = 1; n <= to.length; n++) { el.textContent = to.slice(0, n); await sleep(85 + Math.random() * 60); }
    await sleep(1100);
    el.classList.remove("editing");
  }

  (async function loop() {
    await sleep(1400);
    while (true) {
      const el = pickWord();
      if (el && !document.hidden) edit(el);
      await sleep(1800 + Math.random() * 2200);
    }
  })();
}
