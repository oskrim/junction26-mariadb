import { fileUrl, getArticle, getHistory } from "./api.js";
import { censor } from "./censor.js";
import { diff, words } from "./diff.js";
import { formatDate } from "./history-cards.js";
import { analyzeHistory, findEditWars, parseRowStart, pickMilestones } from "./history-model.js";
import { loadMath } from "./math.js";
import { createMinimap } from "./minimap.js";
import { closeWar, playWar, warHeading } from "./war-inline.js";
import { renderWikitext } from "./wikitext.js";

const SWORDS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5 10 10M13.5 2.5 6 10M8.5 11.5l-3 3M7.5 11.5l3 3M4 9l3 3M12 9l-3 3"/></svg>`;
const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z"/></svg>`;
const AGAIN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M4.5 2v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Milliseconds each version stays on screen at 1×; the version where a war starts stays longer.
const STEP = 1100;
const WAR_HOLD = 3200;
const SPEEDS = [1, 2, 4];
// After the reader scrolls by hand, the page stops following the changes for this long.
const HANDS_OFF = 6000;

const DOCK = `
  <div class="hp-war" hidden></div>
  <div class="hp-row">
    <button type="button" class="hp-play" aria-label="Pause">${PAUSE}</button>
    <div class="hp-when">
      <p class="hp-date">Loading history…</p>
      <p class="hp-who"></p>
    </div>
    <div class="minimap hp-map">
      <div class="hp-swords"></div>
      <svg class="minimap-svg" preserveAspectRatio="none"></svg>
      <div class="minimap-now"></div>
      <div class="minimap-years"></div>
    </div>
    <button type="button" class="hp-speed" aria-label="Playback speed">1×</button>
    <button type="button" class="hp-close" aria-label="Back to today's article">×</button>
  </div>`;

// Replays the article being written, in place: from its first version to today, through the versions
// that mattered most, with what each one added written in. A timeline docks at the bottom, with a
// swords button over every edit war; reaching or clicking one marks where the fight broke out.
// × or Escape puts today's article back exactly as it was.
export function startHistoryPlay({ id, body, toc, renderToc, onClose }) {
  const saved = { body: [...body.childNodes], toc: [...toc.childNodes], scroll: scrollY };
  const dock = document.createElement("div");
  dock.className = "hp-dock";
  dock.innerHTML = DOCK;
  document.body.append(dock);
  document.body.classList.add("hp-mode");
  const $ = (selector) => dock.querySelector(selector);
  const playButton = $(".hp-play");
  const speedButton = $(".hp-speed");

  let frames = [];
  let edits = [];
  let minimap = null;
  let at = -1;
  let playing = true;
  let looping = false;
  let speed = 1;
  let run = 0;
  let closed = false;
  let shown = null;
  let handsOffUntil = 0;
  let announced = null;

  const load = (frame) => (frame.version ??= getArticle(id, Math.floor(frame.edit.time / 1000)).then((r) => r.version));

  async function setUp() {
    edits = analyzeHistory(await getHistory(id));
    const wars = findEditWars(edits);
    const picked = new Map(pickMilestones(edits, wars).map((e) => [e.index, { edit: e }]));
    for (const war of wars) {
      const start = edits[war.edits[0].index];
      picked.set(start.index, { edit: start, war });
    }
    picked.set(edits.length - 1, { edit: edits.at(-1) });
    frames = [...picked.values()].sort((a, b) => a.edit.index - b.edit.index);

    minimap = createMinimap({ root: $(".hp-map"), edits, wars, onPick: (time) => jump(frameAt(time)) });
    drawSwords(wars);
    window.scrollTo({ top: 0, behavior: "instant" });
    play(0);
  }

  function drawSwords(wars) {
    const start = edits[0].time;
    const span = edits.at(-1).time - start;
    const row = $(".hp-swords");
    const width = row.clientWidth || 800;
    // Wars a few months apart would overlap, so each run of close ones spreads out around its middle.
    const GAP = 17;
    const want = wars.map((w) => ((w.start - start) / span) * width);
    const runs = [];
    want.forEach((x, k) => {
      const last = runs.at(-1);
      if (last && x - want[last.at(-1)] < GAP) last.push(k);
      else runs.push([k]);
    });
    const xs = [];
    for (const r of runs) {
      const middle = r.reduce((sum, k) => sum + want[k], 0) / r.length;
      r.forEach((k, j) => (xs[k] = middle + (j - (r.length - 1) / 2) * GAP));
    }
    wars.forEach((war, k) => {
      const x = xs[k];
      const [a, b] = war.fighters.map(censor);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `hp-sword${war.kind === "dispute" ? "" : " is-vandalism"}`;
      button.style.left = `${(x / width) * 100}%`;
      button.dataset.war = war.id;
      button.title = `${war.kind === "dispute" ? "Edit war" : "Vandalism fought off"} · ${formatDate(war.start)} · ${a} vs ${b}`;
      button.innerHTML = SWORDS;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setPlaying(false);
        jump(frames.findIndex((f) => f.war === war));
      });
      row.append(button);
    });
  }

  const frameAt = (time) => Math.max(0, frames.findLastIndex((f) => f.edit.time <= time));

  async function play(from) {
    const token = ++run;
    looping = true;
    for (let i = from; i < frames.length; i++) {
      for (let k = i + 1; k <= i + 3 && k < frames.length; k++) load(frames[k]);
      await show(i, token);
      if (token !== run) return;
      if (i === frames.length - 1) break;
      const hold = (frames[i].war ? WAR_HOLD : STEP) / speed;
      moveMarker(frames[i + 1].edit.time, hold);
      const waited = await wait(hold, token);
      if (!waited) return;
    }
    if (token === run) {
      looping = false;
      playing = false;
      playButton.innerHTML = AGAIN;
      playButton.setAttribute("aria-label", "Play again");
    }
  }

  // Resolves true after `ms` of playing time; false once a jump or close takes over. Pausing stops the clock.
  function wait(ms, token) {
    return new Promise((resolve) => {
      let left = ms;
      let last = performance.now();
      const tick = () => {
        if (token !== run || closed) return resolve(false);
        const t = performance.now();
        if (playing) left -= t - last;
        last = t;
        if (left <= 0) resolve(true);
        else setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }

  async function show(i, token) {
    const frame = frames[i];
    const version = await load(frame);
    if (token !== run || closed || !version) return;
    const renderMath = await loadMath(version.text);
    if (token !== run || closed) return;
    at = i;
    render(version, renderMath);
    moveMarker(frame.edit.time, 0);
    $(".hp-date").textContent = formatDate(parseRowStart(version.row_start));
    $(".hp-who").innerHTML = `${escape(censor(version.user))} <span>· version ${(frame.edit.index + 1).toLocaleString("en-US")} of ${edits.length.toLocaleString("en-US")}</span>`;
    if (frame.war) announce(frame.war);
    else if (announced && frame.edit.time > announced.end) announce(null);
  }

  function moveMarker(time, ms) {
    const marker = $(".minimap-now");
    marker.style.transitionDuration = `${ms}ms`;
    minimap.setTime(time);
  }

  function jump(i) {
    if (i < 0) return;
    closeWar();
    if (playing) play(i);
    else {
      looping = false;
      show(i, ++run);
    }
  }

  function setPlaying(on) {
    playing = on;
    playButton.innerHTML = on ? PAUSE : PLAY;
    playButton.setAttribute("aria-label", on ? "Pause" : "Play");
    if (!on) return;
    closeWar();
    if (!looping) play(at >= frames.length - 1 ? 0 : Math.max(0, at));
  }

  // The article as `version`: unchanged paragraphs stay as they are, new ones are written in and changed
  // ones show their new words. The first change is brought into view unless the reader is scrolling.
  function render(version, renderMath) {
    const { html, toc: entries } = renderWikitext(version.text, { fileUrl, renderMath });
    const box = document.createElement("div");
    box.innerHTML = html;
    const blocks = [...box.children].map((el) => ({ key: `${el.tagName}.${el.className}:${textOf(el)}`, el }));
    const runs = shown ? diff(shown, blocks, (b) => b.key) : [];
    const changed = runs.reduce((n, r) => n + (r.type === "change" ? r.b.length : 0), 0);
    const rewritten = !shown || changed > blocks.length / 2;
    let first = null;
    if (rewritten) {
      shown = blocks;
      body.replaceChildren(...blocks.map((b) => b.el));
      body.classList.remove("hp-swap");
      void body.offsetWidth;
      body.classList.add("hp-swap");
    } else {
      // `shown` keeps the elements on the page, so unchanged paragraphs aren't drawn again.
      const out = [];
      const kept = [];
      const keep = (key, el) => {
        out.push(el);
        kept.push({ key, el });
      };
      for (const r of runs) {
        if (r.type === "equal") {
          // Kept paragraphs lose last version's marks.
          r.a.forEach((prev, k) => keep(prev.key, prev.el.matches(".hp-changed, .hp-added") ? r.b[k].el : prev.el));
          continue;
        }
        r.b.forEach((next, k) => {
          const prev = r.a[k];
          const el = prev && prev.el.tagName === next.el.tagName ? rewrite(prev.el, next.el) : added(next.el);
          if (!el.matches("ol.references")) first ??= el;
          keep(next.key, el);
        });
        for (const prev of r.a.slice(r.b.length)) {
          prev.el.classList.remove("hp-added", "hp-changed");
          prev.el.classList.add("hp-removed");
          out.push(prev.el);
          setTimeout(() => prev.el.remove(), 700);
        }
      }
      body.replaceChildren(...out);
      shown = kept;
    }
    toc.innerHTML = renderToc(entries);

    if (first && playing && performance.now() > handsOffUntil) {
      const top = first.getBoundingClientRect().top;
      if (top < 80 || top > innerHeight - 220) scrollTo({ top: scrollY + top - 160, behavior: "smooth" });
    }
  }

  // An edit war breaks out: its swords ring on the timeline, the fought-over heading flashes, and a
  // note says who fought, with a way to watch the fight right there.
  function announce(war) {
    announced = war;
    const note = $(".hp-war");
    for (const s of dock.querySelectorAll(".hp-sword")) s.classList.toggle("is-on", s.dataset.war === war?.id);
    if (!war) {
      note.hidden = true;
      return;
    }
    const heading = warHeading(body, war);
    const [a, b] = war.fighters.map(censor);
    note.innerHTML = `
      <span class="hp-war-icon">${SWORDS}</span>
      <span><b>${war.kind === "dispute" ? "Edit war breaks out" : "Vandalism fought off"}</b>
        ${war.section ? `over “${escape(war.section)}”` : ""} · ${escape(a)} vs ${escape(b)} · ${war.reverts} reverts</span>
      ${heading ? `<button type="button" class="hp-watch">Watch the fight</button>` : ""}`;
    note.hidden = false;
    note.classList.remove("is-new");
    void note.offsetWidth;
    note.classList.add("is-new");
    note.querySelector(".hp-watch")?.addEventListener("click", () => {
      setPlaying(false);
      playWar({ heading, war, edits, id });
    });
    if (heading) {
      heading.classList.remove("hp-fought");
      void heading.offsetWidth;
      heading.classList.add("hp-fought");
      // Paragraphs are put back on every version, which would replay the flash, so it goes once played.
      heading.addEventListener("animationend", () => heading.classList.remove("hp-fought"), { once: true });
      if (performance.now() > handsOffUntil) {
        scrollTo({ top: scrollY + heading.getBoundingClientRect().top - 140, behavior: "smooth" });
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    run++;
    closeWar();
    body.replaceChildren(...saved.body);
    toc.replaceChildren(...saved.toc);
    body.classList.remove("hp-swap");
    document.body.classList.remove("hp-mode");
    dock.classList.add("is-leaving");
    setTimeout(() => dock.remove(), 250);
    removeEventListener("keydown", onKey, true);
    removeEventListener("wheel", onHands);
    removeEventListener("touchmove", onHands);
    viewWatch.disconnect();
    scrollTo({ top: saved.scroll, behavior: "instant" });
    onClose?.();
  }

  const onKey = (event) => {
    if (document.body.classList.contains("war-mode") || event.target.closest?.("input, textarea")) return;
    if (event.key === "Escape") close();
    else if (event.key === " " && !event.target.closest?.("button")) {
      event.preventDefault();
      setPlaying(!playing);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      jump(Math.min(frames.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1))));
    }
  };
  const onHands = () => (handsOffUntil = performance.now() + HANDS_OFF);
  // Leaving the Article view puts today's article back.
  const viewWatch = new MutationObserver(() => document.body.dataset.view !== "article" && close());
  viewWatch.observe(document.body, { attributes: true, attributeFilter: ["data-view"] });

  // Capturing, so a fight replay open on top hears Escape after this checks for it.
  addEventListener("keydown", onKey, true);
  addEventListener("wheel", onHands, { passive: true });
  addEventListener("touchmove", onHands, { passive: true });
  playButton.addEventListener("click", () => setPlaying(!playing));
  speedButton.addEventListener("click", () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    speedButton.textContent = `${speed}×`;
  });
  $(".hp-close").addEventListener("click", close);

  setUp().catch(() => {
    $(".hp-date").textContent = "No history for this article";
  });
  return { close };
}

// Footnote numbers shift whenever a source is added earlier on, so they are left out of the comparison.
function textOf(el) {
  if (el.matches("ol.references")) return "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll("sup.ref, .katex-mathml").forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, " ").trim();
}

function added(el) {
  if (!el.matches("ol.references")) el.classList.add("hp-added");
  return el;
}

// A changed paragraph, as plain text for now, with its new words written in and the cut ones struck.
// Anything that isn't a paragraph of prose is just swapped and marked.
function rewrite(prev, next) {
  if (next.tagName !== "P" || next.querySelector(".katex, img")) {
    if (!next.matches("ol.references")) next.classList.add("hp-changed");
    return next;
  }
  let n = 0;
  next.innerHTML = diff(words(textOf(prev)), words(textOf(next)))
    .map((r) => {
      if (r.type === "equal") return escape(r.b.join(""));
      const removed = r.a.join("");
      const addedText = r.b.join("");
      const delay = `style="--d:${Math.min(n++, 12) * 60}ms"`;
      return `${removed.trim() ? `<del ${delay}>${escape(removed)}</del>` : ""}${addedText.trim() ? `<ins ${delay}>${escape(addedText)}</ins>` : escape(addedText)}`;
    })
    .join("");
  next.classList.add("hp-changed");
  return next;
}

function escape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
