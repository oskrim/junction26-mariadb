import { fileUrl, getArticle, getHistory } from "./api.js";
import { censor } from "./censor.js";
import { diff, words } from "./diff.js";
import { formatDate } from "./history-cards.js";
import { analyzeHistory, findEditWars, parseRowStart, pickMilestones } from "./history-model.js";
import { loadMath } from "./math.js";
import { createMinimap } from "./minimap.js";
import { createStoryPath, editorColor } from "./story-path.js";
import { FIGHTER_COLORS } from "./timeline3d.js";
import { closeWar, warHeading } from "./war-inline.js";
import { renderWikitext } from "./wikitext.js";

const SWORDS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5 10 10M13.5 2.5 6 10M8.5 11.5l-3 3M7.5 11.5l3 3M4 9l3 3M12 9l-3 3"/></svg>`;
const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z"/></svg>`;
const AGAIN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M4.5 2v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Milliseconds at 1×: the pause after each version, longer where a war starts; a paragraph opening or
// closing; and how long a changed paragraph shows its new words.
const STEP = 300;
const ROUND_HOLD = 450;
const QUIET_ROUND = 550;
const MIN_TRIP = 1600;
const ERASE = 550;
const REVEAL = 900;
// Rounds of a war shown at most, and how fast ordinary versions and war rounds play, at 1×.
const ROUNDS = 10;
const FAST = 2;
const SLOW = 1;
const WAR_HOLD = 1800;
const GROW = 700;
const SHUT = 420;
// Typing goes at an even PER_LETTER ms a letter (deleting two at a time). Each version types at most
// QUOTA letters; the rest of it fades in. Typed text then shows for SETTLE ms.
const PER_LETTER = 28;
const QUOTA = 150;
const SETTLE = 700;
const LONG_HEAD = 60; // letters typed of a long passage before the rest streams in
// Streaming a long passage takes STREAM_BASE plus STREAM_PER_LETTER a letter, out of STREAM_TOTAL a version.
const STREAM_BASE = 500;
const STREAM_PER_LETTER = 0.8;
const STREAM_TOTAL = 3000;
// Places in one version the page glides to; the others change quietly where they are.
const VISITS = 1;
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
  side.innerHTML = `
    <canvas></canvas>
    <p class="hp-key"><span>← cuts</span><span>adds →</span></p>
    <div class="hp-moment"><p class="hp-year"></p><p class="hp-month"></p></div>`;
  document.querySelector(".layout").append(side);
  const dock = document.createElement("div");
  dock.className = "hp-dock";
  dock.innerHTML = DOCK;
  document.body.append(dock);
  document.body.classList.add("hp-mode");
  // The war note sits at the top of the road panel, above the fight.
  side.append(dock.querySelector(".hp-war"));
  const $ = (selector) => dock.querySelector(selector) ?? side.querySelector(selector);
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
  // Playback speed for the version on screen: the article's ordinary growth goes quickly, edit wars slowly.
  let rate = 1;
  let run = 0;
  let closed = false;
  let shown = null;
  let handsOffUntil = 0;
  let announced = null;

  // A version that fails to load is skipped, and asked for again next time.
  const load = (frame) =>
    (frame.version ??= getArticle(id, Math.floor(frame.edit.time / 1000))
      .then((r) => r.version)
      .catch(() => {
        frame.version = null;
        return null;
      }));

  async function setUp() {
    edits = analyzeHistory(await getHistory(id));
    const wars = findEditWars(edits);
    const picked = new Map(pickMilestones(edits, wars).map((e) => [e.index, { edit: e }]));
    // Each war is played round by round: a stop just before it, so the first round shows only the
    // contested edit and the page goes to where the fight is; then up to ROUNDS of its edits that were
    // undone or undid, evenly picked, ending with how it ended.
    for (const war of wars) {
      const start = edits[war.edits[0].index];
      if (start.index > 0) picked.set(start.index - 1, { edit: edits[start.index - 1] });
      const moves = war.edits.filter((e, k) => !k || k === war.edits.length - 1 || e.revertsTo !== null || e.undoneBy !== null);
      const rounds = moves.length <= ROUNDS ? moves : Array.from({ length: ROUNDS }, (_, k) => moves[Math.round((k * (moves.length - 1)) / (ROUNDS - 1))]);
      rounds.forEach((e, k) => picked.set(e.index, { edit: e, round: war, n: k + 1, of: rounds.length, ...(k ? {} : { war }) }));
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
      stops: frames.map((f) => f.edit.index),
      onTime: showMoment,
      onPick: (war) => jump(Math.max(0, frames.findIndex((f) => f.war === war) - 1)),
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
      // Keeps playing, from just before the war breaks out.
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        jump(Math.max(0, frames.findIndex((f) => f.war === war) - 1));
      });
      row.append(button);
    });
  }

  const frameAt = (time) => Math.max(0, frames.findLastIndex((f) => f.edit.time <= time));

  async function play(from) {
    const token = ++run;
    looping = true;
    for (let i = from; i < frames.length; i++) {
      for (let k = i + 1; k <= i + 5 && k < frames.length; k++) load(frames[k]);
      const time = frames[i].edit.time;
      // A war round with nothing to type (its edit touched only the infobox, a table or the sources) passes
      // as quickly as the blow on the road.
      let typing = 0;
      const hold = () =>
        (frames[i].war ? WAR_HOLD : frames[i].round ? (typing ? ROUND_HOLD : QUIET_ROUND) : STEP) / rate;
      // While a version is written, the marker and the road travel to it: as soon as it knows how long
      // its writing will take, the trip starts, timed to arrive as the writing and the pause after it end.
      await show(i, token, true, (ms) => {
        typing = ms;
        travelTo(time, ms + hold());
      });
      if (token !== run) return;
      if (travel?.time !== time) travelTo(time, hold());
      // The next version starts after the pause, even if the road is still on its way: an estimate that ran
      // long must not leave the page waiting.
      const waited = await wait(Math.min(hold(), Math.max(0, travel.end - performance.now())), token);
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

  // Every trip takes at least MIN_TRIP and eases in and out, so the road never stops dead or darts ahead.
  function travelTo(time, ms) {
    ms = Math.max(MIN_TRIP / rate, ms);
    travel = { time, end: performance.now() + ms, left: 0 };
    moveMarker(time, ms, "cubic-bezier(0.45, 0, 0.55, 1)");
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

  // The year in large type under the road, with the month under it; a new date simply takes its place.
  let momentYear = null;
  let momentMonth = null;
  function showMoment(time) {
    const d = new Date(time);
    const year = d.getUTCFullYear();
    const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
    if (month !== momentMonth) side.querySelector(".hp-month").textContent = momentMonth = month;
    if (year === momentYear) return;
    const el = side.querySelector(".hp-year");
    momentYear = year;
    el.textContent = year;
  }

  async function show(i, token, animate, onPlan = () => {}) {
    const frame = frames[i];
    const version = await load(frame);
    if (token !== run || closed || !version) return;
    const renderMath = await loadMath(version.text);
    if (token !== run || closed) return;
    at = i;
    // During playback the marker and road travel here while the version is written; after a jump they
    // glide over at once.
    path.setStop(i);
    if (!animate && !$(".hp-map").classList.contains("is-dragging")) {
      travel = null;
      moveMarker(frame.edit.time, 450, "cubic-bezier(0.25, 0.8, 0.25, 1)");
      path.setTime(frame.edit.time);
    }
    path.setWar(frame.war ?? null);
    // On the road the fighters trade blows round by round; the last round names the winner.
    path.setFight(
      frame.round && {
        war: frame.round,
        by: frame.round.fighters.indexOf(frame.edit.user),
        revert: frame.edit.revertsTo !== null,
        final: frame.n === frame.of,
      },
    );
    $(".hp-date").textContent = formatDate(parseRowStart(version.row_start));
    $(".hp-who").innerHTML = `${escape(censor(version.user))} <span>· version ${(frame.edit.index + 1).toLocaleString("en-US")} of ${edits.length.toLocaleString("en-US")}</span>`;
    if (!frame.war && announced && (frame.edit.time > announced.end || frame.edit.time < announced.start)) announce(null);
    rate = speed * (frame.round ? SLOW : FAST);
    showRound(frame);
    // In a war the fighters type in their own colors, and an undo says so.
    const fighter = frame.round?.fighters.indexOf(frame.edit.user) ?? -1;
    typist = {
      name: `${censor(version.user)}${frame.round && frame.edit.revertsTo !== null ? " · undo" : ""}`,
      color: fighter === 0 || fighter === 1 ? FIGHTER_COLORS[fighter] : editorColor(frame.edit.user, frame.edit.kind),
      war: !!frame.round,
    };
    await render(version, renderMath, token, animate, onPlan, frame.round);
    if (token !== run || closed) return;
    if (frame.war) announce(frame.war);
    showRound(frame);
    noteWhere(frame.round);
  }

  // The war note names the section a round is actually fought in, which can differ from the war's.
  function noteWhere(war, el = visited) {
    const where = war && announced === war && sectionTitle(el);
    if (where) $(".hp-war-where").textContent = `in “${where}”`;
  }

  // The war note counts the rounds as they are played.
  function showRound(frame) {
    if (!frame.round || announced !== frame.round) return;
    const round = $(".hp-war-round");
    const last = frame.round.edits.findLast((e) => frame.round.fighters.slice(0, 2).includes(e.user));
    if (round) {
      round.textContent =
        frame.n === frame.of && last ? `${censor(last.user)} has the last word` : `round ${frame.n} of ${frame.of}`;
    }
    if (frame.n > 1) $(".hp-war b").textContent = frame.round.kind === "dispute" ? "Edit war" : "Vandalism fought off";
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
    // Playing again before this version has loaded starts from here, not from where it was.
    at = i;
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
  // The paragraph the last version's visit went to: where a fight that breaks out is marked.
  let visited = null;
  // Who the cursor types for: the version's editor, named on the cursor in their color from the road.
  let typist = null;

  // `war`: the war this version is a round of; the page then stays with the section fought over.
  async function render(version, renderMath, token, animate, onPlan, war = null) {
    visited = null;
    const { html } = renderWikitext(version.text, { fileUrl, renderMath });
    const box = document.createElement("div");
    box.innerHTML = html;
    const blocks = [...box.children].map((el) => ({ key: `${el.tagName}.${el.className}:${textOf(el)}`, el }));
    const runs = shown ? diff(shown, blocks, (b) => b.key) : [];
    const changed = runs.reduce((n, r) => n + (r.type === "change" ? r.b.length : 0), 0);
    // A version that replaced most of the article fades over instead.
    if (!shown || (changed > 8 && changed > blocks.length * 0.6)) {
      const swap = () => body.replaceChildren(...blocks.map((b) => b.el));
      onPlan(500 / rate);
      if (animate && shown) await fadeOver(swap);
      else swap();
      shown = blocks;
      // A round that blanked or restored the whole article goes back to the section fought over.
      const heading = war && warHeading(body, war);
      if (heading && animate) await glideTo(heading, token);
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
      const partner = partners(r.a, r.b);
      r.b.forEach((next, k) => {
        const prev = partner[k];
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
      const paired = new Set(partner);
      for (const prev of r.a.filter((a) => !paired.has(a))) {
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

    // In a war, a change in the section fought over is visited first, whatever its size.
    const fought = war ? sectionElements(warHeading(body, war)) : new Set();
    const inFight = (p) => [...p.adds, ...p.removes, ...p.rewrites.map((w) => w.old)].some((el) => fought.has(el));
    const visits = new Set(
      places
        .filter((p) => !p.quiet)
        .sort((a, b) => inFight(b) - inFight(a) || b.size - a.size)
        .slice(0, VISITS),
    );
    const ordered = places.filter((p) => visits.has(p));
    // About how long the visit will take, so the road can be timed to it.
    const visitMs = (p) =>
      500 +
      (typeable(p) ? Math.min(QUOTA, typingLetters(p)) * PER_LETTER + SETTLE + streamingMs(p) : GROW) +
      Math.min(3, p.removes.filter(erasable).length) * ERASE;
    onPlan((animate ? ordered.reduce((sum, p) => sum + visitMs(p), 0) : 0) / rate);
    for (const place of places) if (!visits.has(place)) applyQuietly(place, animate && !place.quiet);
    for (const place of ordered) {
      if (!animate || token !== run || closed) {
        applyQuietly(place, false);
        continue;
      }
      // New paragraphs wait at no height where they will open, so the page can glide to that spot.
      for (const el of place.adds) {
        el.hidden = false;
        Object.assign(el.style, CLOSED);
      }
      const spot = place.rewrites[0]?.old ?? place.removes[0] ?? place.adds[0];
      await glideTo(spot, token);
      visited = place.rewrites[0]?.next ?? place.adds[0] ?? null;
      noteWhere(war, place.rewrites[0]?.old ?? spot);
      if (token !== run || closed) {
        applyQuietly(place, false);
        continue;
      }
      await applyTyped(place, token);
    }
  }

  // A place the page doesn't visit changes where it is: new paragraphs open, changed ones are swapped
  // with a soft highlight, cut ones close. Without `animated`, all at once.
  function applyQuietly(place, animated) {
    const ms = (n) => (animated ? n / rate : 0);
    for (const el of place.adds) {
      el.hidden = false;
      for (const k of Object.keys(CLOSED)) el.style[k] = "";
      if (animated && !el.matches("ol.references")) el.classList.add("hp-added");
      openUp(el, 0, ms(GROW)).then(() => animated && prose(el) && reveal(el, run));
    }
    for (const { old, next } of place.rewrites) {
      const from = old.offsetHeight;
      old.replaceWith(next);
      if (animated && !next.matches("ol.references")) next.classList.add("hp-changed");
      openUp(next, from, ms(SHUT));
    }
    for (const el of place.removes) {
      if (!animated) {
        el.remove();
        continue;
      }
      // Text on screen is erased before its space closes.
      const top = el.getBoundingClientRect().top;
      const seen = top < innerHeight && top > -el.offsetHeight;
      (seen && erasable(el) ? erase(el, run, false) : Promise.resolve())
        .then(() => openUp(el, el.offsetHeight, ms(SHUT), 0))
        .then(() => el.remove());
    }
  }

  // Writes `el`'s text in a few words at a time, without a cursor, in about REVEAL ms, then puts its own
  // markup (links and all) back. Pausing holds it; a jump or close finishes it at once.
  function reveal(el, token) {
    const html = el.innerHTML;
    const words = textOf(el).split(/(?<=\s)/);
    if (words.length < 4) return Promise.resolve();
    el.textContent = "";
    const start = performance.now();
    let paused = 0;
    let last = start;
    return new Promise((resolve) => {
      const step = (now) => {
        if (!playing) paused += now - last;
        last = now;
        const t = token !== run || closed ? 1 : Math.min(1, (now - start - paused) / (REVEAL / rate));
        if (t < 1) {
          el.textContent = words.slice(0, Math.ceil(words.length * t)).join("");
          return requestAnimationFrame(step);
        }
        el.innerHTML = html;
        resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // Erases `el`'s text from the end, quickly: about ERASE ms however long it is, with the editor's cursor
  // when `cursor` is set. A jump or close finishes it at once.
  function erase(el, token, cursor = true) {
    const text = textOf(el);
    el.classList.add("hp-erasing");
    el.textContent = "";
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span);
    let caret = null;
    if (cursor && typist) {
      caret = document.createElement("span");
      caret.className = "hp-caret";
      caret.style.setProperty("--c", typist.color);
      const tag = document.createElement("span");
      tag.className = "hp-caret-name";
      tag.textContent = typist.name;
      caret.append(tag);
      el.append(caret);
    }
    const duration = ERASE / rate;
    const start = performance.now();
    return new Promise((resolve) => {
      let paused = 0;
      let last = start;
      const step = (now) => {
        if (!playing) paused += now - last;
        last = now;
        const t = token !== run || closed ? 1 : Math.min(1, (now - start - paused) / duration);
        span.textContent = text.slice(0, Math.round(text.length * (1 - t)));
        if (t < 1) return requestAnimationFrame(step);
        caret?.remove();
        resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // The visited place is written as if by hand: a cursor goes through it in reading order, deleting
  // the old words a letter at a time and typing the new ones, one change after another. Paragraphs then
  // settle into the article's own text, links and all.
  async function applyTyped(place, token) {
    const jobs = [];
    for (const el of place.adds) {
      for (const k of Object.keys(CLOSED)) el.style[k] = "";
      el.hidden = false;
      if (!prose(el)) {
        el.classList.add("hp-added");
        await openUp(el, 0, GROW / rate);
        continue;
      }
      const draft = blank(el);
      el.replaceWith(draft);
      jobs.push({ draft, next: el, ops: [{ ins: textOf(el), whole: true }] });
    }
    for (const { old, next } of place.rewrites) {
      if (!prose(next) || !prose(old)) {
        old.replaceWith(next);
        next.classList.add("hp-changed");
        continue;
      }
      // The old paragraph stays as it is until the cursor gets to it.
      jobs.push({ draft: blank(next), next, ops: wordEdits(textOf(old), textOf(next)), from: old });
    }
    // The cursor goes through the place from top to bottom.
    const at = (job) => (job.from?.isConnected ? job.from : job.draft);
    jobs.sort((a, b) => (at(a).compareDocumentPosition(at(b)) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // Once the version's QUOTA is typed, the rest fades in: new paragraphs open up, and edits left in a
    // paragraph appear at once.
    // A war round types only a short stretch, so blows follow each other.
    const quota = typist?.war ? { left: 50, stream: 600 } : { left: QUOTA, stream: STREAM_TOTAL };
    for (const job of jobs) {
      if (job.from?.isConnected) job.from.replaceWith(job.draft);
      if (quota.left > 0 || quota.stream > 50 || !job.ops[0].whole) {
        await typeInto(job.draft, job.ops, quota, token);
        continue;
      }
      job.draft.replaceWith(job.next);
      job.next.classList.add("hp-added");
      job.draft = null;
      reveal(job.next, token);
      openUp(job.next, 0, GROW / rate);
    }
    // Paragraphs and sections that are gone are erased quickly, top to bottom, once the new text is in,
    // and their space closes. Past the first few, the rest just close.
    let erased = 0;
    for (const el of place.removes) {
      if (erasable(el) && erased < 3 && token === run && !closed) {
        erased++;
        await erase(el, token);
      }
      openUp(el, el.offsetHeight, SHUT / rate, 0).then(() => el.remove());
    }
    // In a war the next blow follows straight on.
    if (jobs.length) await wait((typist?.war ? 250 : SETTLE) / rate, token);
    for (const { draft, next } of jobs) {
      if (!draft?.isConnected) continue;
      const from = draft.offsetHeight;
      draft.replaceWith(next);
      openUp(next, from, SHUT / rate);
    }
  }

  // Plays `ops` into `el` at PER_LETTER ms a letter (at 1×), using up `quota`; once it runs out the rest
  // fades in. A jump or close finishes it at once.
  function typeInto(el, ops, quota, token) {
    const caret = document.createElement("span");
    caret.className = "hp-caret";
    if (typist) {
      caret.style.setProperty("--c", typist.color);
      const tag = document.createElement("span");
      tag.className = "hp-caret-name";
      tag.textContent = typist.name;
      caret.append(tag);
    }
    const parts = [];
    for (const op of ops) {
      if (op.keep) {
        el.append(op.keep);
        continue;
      }
      const span = document.createElement("span");
      span.className = op.del ? "hp-del" : op.whole ? "hp-new" : "hp-ins";
      span.textContent = op.del ?? "";
      el.append(span);
      parts.push({ span, op, typed: 0 });
    }
    const finish = (from = 0) => {
      for (const part of parts.slice(from)) {
        if (part.op.del) part.span.remove();
        else if (part.span.textContent !== part.op.ins) {
          part.span.textContent = part.op.ins;
          part.span.classList.add("hp-rest");
        }
      }
      caret.remove();
    };
    // Past the opening of a long passage, or once the version's typing quota is spent, the rest streams
    // in: a few words a frame with the cursor riding along, faster the longer it is, from the version's
    // shared streaming time. When that is spent too, what is left appears at once.
    let streaming = false;
    let perMs = 0;
    const startStream = (from) => {
      streaming = true;
      const left = parts.slice(from).reduce((n, p) => n + (p.op.del ? p.span.textContent.length : p.op.ins.length - p.span.textContent.length), 0);
      const ms = Math.min(quota.stream, STREAM_BASE + left * STREAM_PER_LETTER);
      quota.stream -= ms;
      perMs = ms > 20 ? left / ms : Infinity;
    };
    return new Promise((resolve) => {
      let k = 0;
      let budget = 0;
      let last = performance.now();
      const step = (now) => {
        if (token !== run || closed) {
          finish();
          return resolve();
        }
        if (playing) budget += (now - last) * rate;
        last = now;
        if (quota.left <= 0 && !streaming) startStream(k);
        if (streaming) {
          if (perMs === Infinity) {
            finish(k);
            return resolve();
          }
          let n = Math.ceil(budget * perMs);
          budget = 0;
          while (n > 0 && k < parts.length) {
            const part = parts[k];
            if (caret.previousSibling !== part.span) part.span.after(caret);
            if (part.op.del) {
              const text = part.span.textContent;
              part.span.textContent = text.slice(0, Math.max(0, text.length - n));
              n -= text.length;
              if (!part.span.textContent) {
                part.span.remove();
                k++;
              }
            } else {
              // Words come whole.
              const have = part.span.textContent.length;
              let upTo = Math.min(part.op.ins.length, have + n);
              const space = part.op.ins.indexOf(" ", upTo);
              if (space !== -1 && space - upTo < 12) upTo = space + 1;
              part.span.textContent = part.op.ins.slice(0, upTo);
              n -= upTo - have;
              if (upTo >= part.op.ins.length) k++;
            }
          }
          if (k < parts.length) return requestAnimationFrame(step);
          caret.remove();
          return resolve();
        }
        while (budget >= PER_LETTER && k < parts.length && quota.left > 0) {
          const part = parts[k];
          if (caret.previousSibling !== part.span) part.span.after(caret);
          budget -= PER_LETTER;
          quota.left--;
          if (part.op.del) {
            // Deleting goes two letters at a time; a long cut goes in one stroke once it has started.
            const text = part.span.textContent;
            part.span.textContent = part.op.del.length - text.length >= LONG_HEAD ? "" : text.slice(0, -2);
            if (!part.span.textContent) {
              part.span.remove();
              k++;
            }
          } else {
            part.span.textContent = part.op.ins.slice(0, ++part.typed);
            if (part.typed >= part.op.ins.length) k++;
            else if (part.typed >= LONG_HEAD && part.op.ins.length > LONG_HEAD * 2) {
              startStream(k);
              break;
            }
          }
        }
        if (k < parts.length) return requestAnimationFrame(step);
        caret.remove();
        resolve();
      };
      requestAnimationFrame(step);
    });
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
    const duration = (380 + Math.min(620, distance * 0.35)) / rate;
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
    const fade = (from, to, ms) => column.animate([{ opacity: from }, { opacity: to }], { duration: ms / rate, fill: "forwards" }).finished.catch(() => {});
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
        <span class="hp-war-where">${war.section ? `over “${escape(war.section)}”` : ""}</span> · ${escape(a)} vs ${escape(b)} · <span class="hp-war-round"></span></span>`;
    note.hidden = false;
    note.classList.remove("is-new");
    void note.offsetWidth;
    note.classList.add("is-new");
    if (heading) {
      heading.classList.remove("hp-fought");
      void heading.offsetWidth;
      heading.classList.add("hp-fought");
      // A paragraph that moves would replay the flash, so it goes once played.
      heading.addEventListener("animationend", () => heading.classList.remove("hp-fought"), { once: true });
    }
    // The page is already at the contested paragraph; it is marked. Without one, it goes to the heading.
    if (visited?.isConnected) {
      visited.classList.remove("hp-fight-spot");
      void visited.offsetWidth;
      visited.classList.add("hp-fight-spot");
    } else if (heading) {
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

// The title of the section `el` is in: the nearest heading above it.
function sectionTitle(el) {
  for (let at = el?.previousElementSibling; at; at = at.previousElementSibling) {
    if (/^H[2-4]$/.test(at.tagName)) return at.textContent.trim();
  }
  return null;
}

// For each new block in a changed run, the old block it is an edit of: the one of the same kind that
// shares the most words with it (at least a fifth of the longer one's), so text that moved is edited, not removed and
// typed again. Very long runs pair by position.
function partners(before, after) {
  const same = (a, b) => a.el.tagName === b.el.tagName;
  if (before.length * after.length > 4000) return after.map((b, k) => (before[k] && same(before[k], b) ? before[k] : null));
  const wordsOf = (block) => new Set(block.key.slice(block.key.indexOf(":") + 1).toLowerCase().match(/[\p{L}\d]+/gu) ?? []);
  const sets = new Map([...before, ...after].map((block) => [block, wordsOf(block)]));
  const used = new Set();
  return after.map((b, k) => {
    let best = null;
    let bestScore = 0.2;
    for (const a of before) {
      if (used.has(a) || !same(a, b)) continue;
      const x = sets.get(a);
      const y = sets.get(b);
      let shared = 0;
      for (const w of x) if (y.has(w)) shared++;
      const score = shared / Math.max(1, x.size, y.size);
      if (score > bestScore) [best, bestScore] = [a, score];
    }
    // Blocks without words (images, empty lines) pair by position.
    if (!best && !sets.get(b).size && before[k] && !used.has(before[k]) && same(before[k], b)) best = before[k];
    if (best) used.add(best);
    return best;
  });
}

// A heading and the elements under it, up to the next heading of the same or a higher level.
function sectionElements(heading) {
  const els = new Set();
  if (!heading) return els;
  const level = Number(heading.tagName[1]);
  els.add(heading);
  for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
    if (/^H[1-6]$/.test(el.tagName) && Number(el.tagName[1]) <= level) break;
    els.add(el);
  }
  return els;
}

// What can be erased letter by letter: prose and lists, not pictures, the infobox or tables.
function erasable(el) {
  return (prose(el) || /^(UL|OL|BLOCKQUOTE)$/.test(el.tagName)) && !el.matches("ol.references") && !el.querySelector("img, table");
}

// Prose that can be typed: paragraphs and headings of plain text, not old table markup or maths.
function prose(el) {
  return /^(P|H2|H3|H4)$/.test(el.tagName) && !el.querySelector(".katex, img") && !/\{\||\|-|style=|<\/?t[dhr]\b/.test(el.textContent);
}

// About how many letters typing `place` takes, as typeInto counts them.
function typingLetters(place) {
  const count = (ops) =>
    ops.reduce((n, op) => n + Math.min(LONG_HEAD + 1, op.ins?.length ?? 0) + Math.min(LONG_HEAD / 2 + 1, (op.del?.length ?? 0) / 2), 0);
  let letters = 0;
  for (const el of place.adds) if (prose(el)) letters += count([{ ins: textOf(el) }]);
  for (const { old, next } of place.rewrites) if (prose(old) && prose(next)) letters += count(wordEdits(textOf(old), textOf(next)));
  return letters;
}

// About how long the long passages in `place` stream for, past what is typed letter by letter.
function streamingMs(place) {
  const long = [...place.adds.filter(prose).map((el) => textOf(el).length), ...place.rewrites.map(({ next }) => (prose(next) ? textOf(next).length : 0))]
    .filter((n) => n > LONG_HEAD * 2)
    .reduce((sum, n) => sum + STREAM_BASE + n * STREAM_PER_LETTER, 0);
  return Math.min(STREAM_TOTAL, long);
}

function typeable(place) {
  return place.adds.some(prose) || place.rewrites.some(({ next }) => prose(next));
}

// An empty element like `el`, for typing into.
function blank(el) {
  const draft = document.createElement(el.tagName);
  draft.className = `${el.className} hp-draft`;
  if (el.id) draft.id = el.id;
  return draft;
}

// The word changes from `before` to `after`, as kept, deleted and inserted text in reading order.
function wordEdits(before, after) {
  const ops = [];
  for (const r of diff(words(before), words(after))) {
    if (r.type === "equal") {
      ops.push({ keep: r.b.join("") });
      continue;
    }
    const removed = r.a.join("");
    const added = r.b.join("");
    if (removed.trim()) ops.push({ del: removed });
    if (added.trim()) ops.push({ ins: added });
    else if (added) ops.push({ keep: added });
  }
  return ops;
}

function escape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
