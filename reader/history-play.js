import { fileUrl, getArticle, getHistory } from "./api.js";
import { censor } from "./censor.js";
import { diff, words } from "./diff.js";
import { formatDate } from "./history-cards.js";
import { analyzeHistory, findEditWars, parseRowStart, pickMilestones } from "./history-model.js";
import { loadMath } from "./math.js";
import { createMinimap } from "./minimap.js";
import { createStoryPath } from "./story-path.js";
import { closeWar, playWar, warHeading } from "./war-inline.js";
import { renderWikitext } from "./wikitext.js";

const SWORDS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5 10 10M13.5 2.5 6 10M8.5 11.5l-3 3M7.5 11.5l3 3M4 9l3 3M12 9l-3 3"/></svg>`;
const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z"/></svg>`;
const AGAIN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M4.5 2v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Milliseconds at 1×: the pause after each version, longer where a war starts; a paragraph opening or
// closing; and how long a changed paragraph shows its new words.
const STEP = 500;
const WAR_HOLD = 2600;
const GROW = 700;
const SHUT = 420;
const READ = 1000;
// Places in one version that the page glides to in turn.
const VISITS = 3;
const CLOSED = { height: "0px", marginTop: "0px", marginBottom: "0px", overflow: "hidden", opacity: "0" };
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
// swords button over every edit war; reaching or clicking one marks where the fight broke out. The
// contents list makes way for a 3D road of the article's life that the reader travels along.
// × or Escape puts today's article back exactly as it was.
export function startHistoryPlay({ id, body, onClose }) {
  const saved = { body: [...body.childNodes], scroll: scrollY };
  const side = document.createElement("aside");
  side.className = "hp-path";
  side.setAttribute("aria-label", "The article's life as a road");
  side.innerHTML = `<canvas></canvas><div class="hp-moment"><p class="hp-year"></p><p class="hp-month"></p></div>`;
  document.querySelector(".layout").append(side);
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
  let path = null;
  // The marker and the road travel at an even pace toward the next version while this one is written.
  let travel = null;
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

    // Clicks and drags on the strip are handled by scrub(), not the strip's own click.
    minimap = createMinimap({ root: $(".hp-map"), edits, wars, onPick: () => {} });
    scrub();
    drawSwords(wars);
    path = createStoryPath({
      canvas: side.querySelector("canvas"),
      edits,
      wars,
      onTime: showMoment,
      onPick: (war) => {
        setPlaying(false);
        jump(frames.findIndex((f) => f.war === war));
      },
    });
    path.setTime(edits[0].time, { instant: true });
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
      const next = frames[i + 1];
      const hold = (frames[i].war ? WAR_HOLD : STEP) / speed;
      // As soon as this version knows how long its writing will take, the trip to the next one starts,
      // timed to arrive as the writing and the pause after it end.
      await show(i, token, true, (ms) => next && travelTo(next.edit.time, ms + hold));
      if (token !== run) return;
      if (!next) break;
      if (travel?.time !== next.edit.time) travelTo(next.edit.time, hold);
      const waited = await wait(Math.max(0, travel.end - performance.now()), token);
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
        else setTimeout(tick, 30);
      };
      setTimeout(tick, 30);
    });
  }

  function travelTo(time, ms) {
    travel = { time, end: performance.now() + ms, left: 0 };
    moveMarker(time, ms);
    path.glide(time, ms);
  }

  // Pausing stops the marker and the road where they are; playing again carries on with the time left.
  function freezeTravel() {
    if (!travel) return;
    travel.left = Math.max(0, travel.end - performance.now());
    const marker = $(".minimap-now");
    marker.style.left = getComputedStyle(marker).left;
    marker.style.transitionDuration = "0ms";
    path.freeze();
  }

  function resumeTravel() {
    if (travel?.left > 0) travelTo(travel.time, travel.left);
  }

  // The year in large type above the road, with the month under it; the year rolls in when it changes.
  let momentYear = null;
  let momentMonth = null;
  function showMoment(time) {
    const d = new Date(time);
    const year = d.getUTCFullYear();
    const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
    if (month !== momentMonth) side.querySelector(".hp-month").textContent = momentMonth = month;
    if (year === momentYear) return;
    const el = side.querySelector(".hp-year");
    const up = momentYear === null || year > momentYear;
    momentYear = year;
    el.textContent = year;
    el.animate([{ opacity: 0, transform: `translateY(${up ? 18 : -18}px)` }, { opacity: 1, transform: "none" }], {
      duration: 450,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  }

  async function show(i, token, animate, onPlan = () => {}) {
    const frame = frames[i];
    const version = await load(frame);
    if (token !== run || closed || !version) return;
    const renderMath = await loadMath(version.text);
    if (token !== run || closed) return;
    at = i;
    // During playback the marker and road are already here, unless playing started from a jump.
    if (animate && travel?.time === frame.edit.time) travel = null;
    else if (!$(".hp-map").classList.contains("is-dragging")) {
      travel = null;
      moveMarker(frame.edit.time, 450, "cubic-bezier(0.25, 0.8, 0.25, 1)");
      path.setTime(frame.edit.time);
    }
    path.setWar(frame.war ?? null);
    $(".hp-date").textContent = formatDate(parseRowStart(version.row_start));
    $(".hp-who").innerHTML = `${escape(censor(version.user))} <span>· version ${(frame.edit.index + 1).toLocaleString("en-US")} of ${edits.length.toLocaleString("en-US")}</span>`;
    if (!frame.war && announced && frame.edit.time > announced.end) announce(null);
    await render(version, renderMath, token, animate, onPlan);
    if (frame.war && token === run && !closed) announce(frame.war);
  }

  function moveMarker(time, ms, easing = "linear") {
    const marker = $(".minimap-now");
    marker.style.transitionDuration = `${ms}ms`;
    marker.style.transitionTimingFunction = easing;
    minimap.setTime(time);
  }

  // The year strip can be dragged: the marker follows the pointer, the road glides along, and the
  // article shows the nearest version as it passes. A click glides the marker there instead of jumping.
  // Letting go carries on from there, playing or paused as before.
  function scrub() {
    const map = $(".hp-map");
    const hover = document.createElement("div");
    hover.className = "hp-hover";
    map.append(hover);
    const start = edits[0].time;
    const end = edits.at(-1).time;
    const timeAt = (event) => {
      const r = map.querySelector(".minimap-svg").getBoundingClientRect();
      return start + Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)) * (end - start);
    };
    let drag = null;
    let shownAt = -1;
    // One version loads at a time while dragging; when it is shown, the latest one asked for comes next.
    let wanted = null;
    let busy = false;
    const preview = async (i) => {
      wanted = i;
      if (busy) return;
      busy = true;
      while (drag && wanted !== null) {
        const k = wanted;
        wanted = null;
        if (k === shownAt) continue;
        shownAt = k;
        await show(k, ++run, false);
      }
      busy = false;
    };
    map.addEventListener("pointermove", (event) => {
      const time = timeAt(event);
      hover.textContent = formatDate(time);
      hover.style.left = `${((time - start) / (end - start)) * 100}%`;
      if (!drag) return;
      if (Math.abs(event.clientX - drag.x) > 4) drag.moved = true;
      if (!drag.moved) return;
      moveMarker(time, 0);
      path.setTime(time);
      $(".hp-date").textContent = formatDate(time);
      preview(frameAt(time));
    });
    map.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".hp-sword") || event.button !== 0) return;
      map.setPointerCapture(event.pointerId);
      closeWar();
      run++;
      looping = false;
      drag = { x: event.clientX, moved: false };
      map.classList.add("is-dragging");
    });
    const finish = (event) => {
      if (!drag) return;
      const time = timeAt(event);
      const moved = drag.moved;
      drag = null;
      shownAt = -1;
      map.classList.remove("is-dragging");
      if (!moved) {
        moveMarker(time, 450, "cubic-bezier(0.25, 0.8, 0.25, 1)");
        path.setTime(time);
      }
      jump(frameAt(time));
    };
    map.addEventListener("pointerup", finish);
    map.addEventListener("pointercancel", finish);
  }

  function jump(i) {
    if (i < 0) return;
    closeWar();
    travel = null;
    if (playing) play(i);
    else {
      looping = false;
      show(i, ++run, false);
    }
  }

  function setPlaying(on) {
    playing = on;
    playButton.innerHTML = on ? PAUSE : PLAY;
    playButton.setAttribute("aria-label", on ? "Pause" : "Play");
    if (!on) {
      freezeTravel();
      return;
    }
    closeWar();
    if (looping) resumeTravel();
    if (!looping) play(at >= frames.length - 1 ? 0 : Math.max(0, at));
  }

  // The article as `version`. Unchanged paragraphs stay where they are. Each place that changed is then
  // visited in turn: the page glides there, new paragraphs open up and are written in, changed ones show
  // their new words before settling, and cut ones close. Only the biggest few places get a visit; the rest
  // change at the same time as the last one, so a version never takes too long.
  async function render(version, renderMath, token, animate, onPlan) {
    const { html } = renderWikitext(version.text, { fileUrl, renderMath });
    const box = document.createElement("div");
    box.innerHTML = html;
    const blocks = [...box.children].map((el) => ({ key: `${el.tagName}.${el.className}:${textOf(el)}`, el }));
    const runs = shown ? diff(shown, blocks, (b) => b.key) : [];
    const changed = runs.reduce((n, r) => n + (r.type === "change" ? r.b.length : 0), 0);
    // A version that replaced most of the article fades over instead.
    if (!shown || (changed > 8 && changed > blocks.length * 0.6)) {
      const swap = () => body.replaceChildren(...blocks.map((b) => b.el));
      onPlan(500 / speed);
      if (animate && shown) await fadeOver(swap);
      else swap();
      shown = blocks;
      return;
    }

    const out = [];
    const kept = [];
    const places = [];
    for (const r of runs) {
      if (r.type === "equal") {
        r.a.forEach((prev, k) => {
          out.push(prev.el);
          kept.push({ key: r.b[k].key, el: prev.el });
        });
        continue;
      }
      const place = { adds: [], rewrites: [], removes: [], size: 0 };
      r.b.forEach((next, k) => {
        const prev = r.a[k];
        kept.push({ key: next.key, el: next.el });
        if (prev && prev.el.tagName === next.el.tagName) {
          place.rewrites.push({ old: prev.el, next: next.el });
          out.push(prev.el);
          place.size += Math.abs(textOf(next.el).length - textOf(prev.el).length) + 20;
        } else {
          next.el.hidden = true;
          place.adds.push(next.el);
          out.push(next.el);
          place.size += textOf(next.el).length + 40;
        }
      });
      for (const prev of r.a.slice(r.b.length)) {
        place.removes.push(prev.el);
        out.push(prev.el);
        place.size += textOf(prev.el).length;
      }
      if ([...place.adds, ...place.removes, ...place.rewrites.map((w) => w.next)].every((el) => el.matches("ol.references"))) {
        place.quiet = true;
      }
      places.push(place);
    }
    // Put the page in order without taking unchanged paragraphs out, so the reader's place holds.
    out.forEach((el, k) => {
      if (body.children[k] !== el) body.insertBefore(el, body.children[k] ?? null);
    });
    while (body.children.length > out.length) body.lastElementChild.remove();
    shown = kept;

    const visits = new Set(
      places
        .filter((p) => !p.quiet)
        .sort((a, b) => b.size - a.size)
        .slice(0, VISITS),
    );
    const ordered = places.filter((p) => visits.has(p));
    // About how long the visits will take, so the road can be timed to it.
    const visitMs = (p) => 500 + (p.rewrites.length ? SHUT + READ + SHUT : p.adds.length ? GROW : SHUT);
    onPlan((animate ? ordered.reduce((sum, p) => sum + visitMs(p), 0) : 0) / speed);
    for (const place of places) if (!visits.has(place)) applyNow(place, animate && !place.quiet);
    for (const place of ordered) {
      if (!animate || token !== run || closed) {
        applyNow(place, false);
        continue;
      }
      // New paragraphs wait at no height where they will open, so the page can glide to that spot.
      for (const el of place.adds) {
        el.hidden = false;
        Object.assign(el.style, CLOSED);
      }
      await glideTo(place.rewrites[0]?.old ?? place.removes[0] ?? place.adds[0], token);
      if (token !== run || closed) {
        applyNow(place, false);
        continue;
      }
      await applyAnimated(place, token);
    }
  }

  // A place's changes, with no visit: animated where they are if asked, otherwise at once.
  function applyNow(place, animated) {
    if (animated) {
      applyAnimated(place, run);
      return;
    }
    for (const el of place.adds) {
      el.hidden = false;
      for (const k of Object.keys(CLOSED)) el.style[k] = "";
    }
    for (const { old, next } of place.rewrites) old.replaceWith(next);
    for (const el of place.removes) el.remove();
  }

  async function applyAnimated(place, token) {
    const ms = (n) => n / speed;
    const work = [];
    for (const el of place.adds) {
      el.hidden = false;
      for (const k of Object.keys(CLOSED)) el.style[k] = "";
      if (!el.matches("ol.references")) el.classList.add("hp-added");
      work.push(openUp(el, 0, ms(GROW)));
    }
    for (const el of place.removes) {
      work.push(openUp(el, el.offsetHeight, ms(SHUT), 0).then(() => el.remove()));
    }
    const settles = [];
    for (const { old, next } of place.rewrites) {
      const marked = rewrite(old, next.cloneNode(true));
      const from = old.offsetHeight;
      old.replaceWith(marked);
      work.push(openUp(marked, from, ms(SHUT)));
      settles.push({ marked, next });
    }
    await Promise.all(work);
    if (settles.length) await wait(ms(READ), token);
    // Changed paragraphs go back to the article's own text, links and all, once read.
    await Promise.all(
      settles.map(({ marked, next }) => {
        if (!marked.isConnected) return null;
        const from = marked.offsetHeight;
        marked.replaceWith(next);
        return openUp(next, from, ms(SHUT));
      }),
    );
  }

  // Animates `el` from `from` px tall to its own height (or `to`), margins and all.
  function openUp(el, from, duration, to = null) {
    const style = getComputedStyle(el);
    const end = to ?? el.offsetHeight;
    if (Math.abs(end - from) < 2 || style.float !== "none" || !duration) return Promise.resolve();
    const margins = (k) => (to === 0 ? "0px" : k === "top" ? style.marginTop : style.marginBottom);
    const keyframes = [
      { height: `${from}px`, marginTop: from ? style.marginTop : "0px", marginBottom: from ? style.marginBottom : "0px", opacity: from ? 1 : 0 },
      { height: `${end}px`, marginTop: margins("top"), marginBottom: margins("bottom"), opacity: to === 0 ? 0 : 1 },
    ];
    el.style.overflow = "hidden";
    return el
      .animate(keyframes, { duration, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" })
      .finished.catch(() => {})
      .finally(() => (el.style.overflow = ""));
  }

  // Brings `el` to a third of the way down the screen: a glide when it's near, a quick dim and jump
  // when it's far, and nothing when it's already in view or the reader is scrolling on their own.
  async function glideTo(el, token) {
    if (performance.now() < handsOffUntil) return;
    const top = el.getBoundingClientRect().top;
    if (top > 90 && top < innerHeight * 0.62) return;
    const to = Math.max(0, scrollY + top - innerHeight * 0.3);
    const distance = Math.abs(to - scrollY);
    if (distance > innerHeight * 2.5) {
      await fadeOver(() => scrollTo({ top: to, behavior: "instant" }));
      return;
    }
    const from = scrollY;
    const duration = (380 + Math.min(620, distance * 0.35)) / speed;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        if (token !== run || closed || performance.now() < handsOffUntil) return resolve();
        const t = Math.min(1, (now - t0) / duration);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        scrollTo({ top: from + (to - from) * eased, behavior: "instant" });
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // Dims the article, runs `change`, and brings it back.
  async function fadeOver(change) {
    const column = document.querySelector(".layout .column");
    // A second fade can cancel this one; the change still happens.
    const fade = (from, to, ms) => column.animate([{ opacity: from }, { opacity: to }], { duration: ms / speed, fill: "forwards" }).finished.catch(() => {});
    await fade(1, 0.08, 180);
    change();
    await fade(0.08, 1, 320);
    column.getAnimations().forEach((a) => a.cancel());
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
      // A paragraph that moves would replay the flash, so it goes once played.
      heading.addEventListener("animationend", () => heading.classList.remove("hp-fought"), { once: true });
      glideTo(heading, run);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    run++;
    closeWar();
    body.replaceChildren(...saved.body);
    path?.stop();
    side.remove();
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

// A changed paragraph, as plain text for now, with its new words written in and the cut ones struck.
// Anything that isn't a paragraph of prose is just swapped and marked.
function rewrite(prev, next) {
  // Old versions sometimes hold table markup the renderer leaves as text; a word diff of that is noise.
  const markup = /\{\||\|-|style=|<\/?t[dhr]\b/.test(next.textContent + prev.textContent);
  if (next.tagName !== "P" || markup || next.querySelector(".katex, img")) {
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
