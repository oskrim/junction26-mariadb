import { getHistory } from "./api.js";
import { censor } from "./censor.js";
import { analyzeHistory, findEditWars } from "./history-model.js";
import { openWarReplay } from "./war-replay.js";

const SWORDS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5 10 10M13.5 2.5 6 10M8.5 11.5l-3 3M7.5 11.5l3 3M4 9l3 3M12 9l-3 3"/></svg>`;

// Marks each section of the article that was once fought over with a small swords button by its heading.
// Pressing it dims the rest of the article and replays the fight right there, in place of the section's
// text; × or Escape, or a click on the dimmed page, brings the article back.
export async function addWarMarkers({ body, id }) {
  const rows = await getHistory(id).catch(() => []);
  if (!rows.length) return;
  const edits = analyzeHistory(rows);
  const wars = findEditWars(edits);
  const headings = [...body.querySelectorAll("h2, h3")].map((el) => ({ el, title: el.textContent }));

  for (const war of wars) {
    const heading = war.section && bestHeading(war.section, headings)?.el;
    if (!heading) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "war-mark";
    button.innerHTML = `${SWORDS}<span>${new Date(war.start).getUTCFullYear()}</span>`;
    const [a, b] = war.fighters.map(censor);
    button.title = `${war.kind === "dispute" ? "Edit war" : "Vandalism fought off"} here · ${a} vs ${b} · ${war.reverts} reverts — watch it`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      play(heading, war, edits[war.edits[0].index - 1], id);
    });
    let marks = heading.querySelector(".war-marks");
    if (!marks) {
      marks = document.createElement("span");
      marks.className = "war-marks";
      heading.append(marks);
    }
    marks.append(button);
  }
}

let active = null;

async function play(heading, war, before, articleId) {
  active?.close();
  const section = sectionOf(heading);
  const stage = document.createElement("div");
  stage.className = "war-stage is-loading";
  stage.innerHTML = `<p class="war-loading">Loading the fight…</p>`;
  section.at(-1).after(stage);
  for (const el of section.slice(1)) el.classList.add("war-hidden");
  heading.classList.add("war-focus");
  document.body.classList.add("war-mode");
  heading.scrollIntoView({ behavior: "smooth", block: "start" });

  let replay = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (replay) replay.close();
    else finish();
  };
  const finish = () => {
    closed = true;
    stage.remove();
    for (const el of section) el.classList.remove("war-hidden", "war-focus");
    document.body.classList.remove("war-mode");
    removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onOutside, true);
    viewWatch.disconnect();
    if (active?.close === close) active = null;
  };
  const onKey = (event) => event.key === "Escape" && close();
  const onOutside = (event) => {
    if (!event.target.closest(".war-stage, .war-focus, .bar")) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  // Leaving the Article view ends the replay.
  const viewWatch = new MutationObserver(() => document.body.dataset.view !== "article" && close());
  viewWatch.observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  addEventListener("keydown", onKey, true);
  document.addEventListener("click", onOutside, true);
  active = { close };

  stage.replaceChildren();
  try {
    replay = await openWarReplay({ mount: stage, articleId, war, before, inline: true, onClose: finish });
  } catch {
    finish();
    return;
  }
  stage.classList.remove("is-loading");
  if (closed) replay.close();
}

// The heading and everything under it up to the next heading of the same or a higher level.
function sectionOf(heading) {
  const level = Number(heading.tagName[1]);
  const els = [heading];
  for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
    if (/^H[1-6]$/.test(el.tagName) && Number(el.tagName[1]) <= level) break;
    els.push(el);
  }
  return els;
}

// Sections get renamed over the years ("Sodan nimet" is now "Sodan nimitykset"), so headings match on
// the shared beginnings of their words, and the first word has to be one of them.
function bestHeading(section, headings) {
  const stems = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").match(/[\p{L}\d]+/gu)?.map((w) => w.slice(0, 4)) ?? [];
  const want = stems(section);
  let best = null;
  let bestScore = 0;
  for (const h of headings) {
    const have = new Set(stems(h.title));
    if (!have.has(want[0])) continue;
    const shared = want.filter((w) => have.has(w)).length;
    const score = shared / Math.max(want.length, have.size);
    if (score > bestScore) [best, bestScore] = [h, score];
  }
  return bestScore >= 0.5 ? best : null;
}
