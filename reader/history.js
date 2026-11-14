import { createArticlePanel } from "./article-panel.js";
import { getArticles, getChange, getHistory } from "./fake/api.js";
import { formatMonth, renderStop } from "./history-cards.js";
import { analyzeHistory, findEditWars, pickMilestones } from "./history-model.js";
import { createMinimap } from "./minimap.js";
import { createTimeline } from "./timeline3d.js";
import { openWarReplay } from "./war-replay.js";

const DEFAULT_ARTICLE = 4011;

const id = Number(new URLSearchParams(location.search).get("id") ?? DEFAULT_ARTICLE);
const [articles, rows] = await Promise.all([getArticles(), getHistory(id)]);
const article = articles.find((a) => a.page_id === id);

const edits = analyzeHistory(rows);
const wars = findEditWars(edits);
const stops = [
  ...pickMilestones(edits, wars).map((edit) => ({ type: "edit", edit, time: edit.time })),
  ...wars.map((war) => ({ type: "war", war, time: war.start })),
].sort((a, b) => a.time - b.time);
const changes = new Map(
  await Promise.all(
    stops.map(async (stop) => {
      const edit = stop.type === "war" ? stop.war.contested : stop.edit;
      return [edit.rev_id, await getChange(edit.rev_id)];
    }),
  ),
);

document.title = `${article.title} · Edit history`;
document.querySelector(".hud-article").textContent = article.title;
document.querySelector(".hud-back").href = `./?id=${id}`;
document.querySelector(".hud-stats").innerHTML = [
  [edits.length, "edits"],
  [new Set(edits.map((e) => e.user)).size, "editors"],
  [wars.filter((w) => w.kind === "dispute").length, "edit wars"],
]
  .map(([n, label]) => `<div><dt>${label}</dt><dd>${n.toLocaleString("en-US")}</dd></div>`)
  .join("");

const month = document.querySelector(".hud-month");
const panel = createArticlePanel({ root: document.querySelector(".panel"), articleId: id });
let panelOpen = false;
let lastTime = edits[0].time;
const minimap = createMinimap({
  root: document.querySelector(".minimap"),
  edits,
  wars,
  onPick: (time) => timeline.goToTime(time),
});
const timeline = createTimeline({
  stage: document.querySelector(".stage"),
  canvas: document.querySelector(".stage-canvas"),
  layer: document.querySelector(".stage-cards"),
  spacer: document.querySelector(".scroll-spacer"),
  edits,
  stops,
  renderCard: (stop) => renderStop(stop, changes),
  onMove: (time) => {
    const label = formatMonth(time);
    if (month.textContent !== label) month.textContent = label;
    minimap.setTime(time);
    lastTime = time;
    if (panelOpen) panel.show(time);
  },
});

const toggle = document.querySelector(".panel-toggle");
function setPanel(open) {
  panelOpen = open;
  document.body.classList.toggle("has-panel", open);
  toggle.setAttribute("aria-pressed", String(open));
  timeline.setInset(open ? document.querySelector(".panel").offsetWidth : 0);
  if (open) panel.show(lastTime);
}
toggle.addEventListener("click", () => setPanel(!panelOpen));
document.querySelector(".panel-close").addEventListener("click", () => setPanel(false));
addEventListener("resize", () => panelOpen && timeline.setInset(document.querySelector(".panel").offsetWidth));

document.querySelector(".stage-cards").addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="replay"]');
  if (!button) return;
  const war = wars.find((w) => w.id === button.dataset.war);
  openWarReplay({ articleId: id, war, before: edits[war.edits[0].index - 1] });
});

addEventListener("keydown", (event) => {
  if (document.body.classList.contains("has-replay")) return;
  if (event.key === "ArrowRight") timeline.next(1);
  else if (event.key === "ArrowLeft") timeline.next(-1);
  else return;
  event.preventDefault();
});
document.body.classList.add("is-ready");
