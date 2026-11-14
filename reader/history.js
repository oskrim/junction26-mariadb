import { createArticlePanel } from "./article-panel.js";
import { getArticles, getChange, getHistory } from "./fake/api.js";
import { formatMonth, renderStop } from "./history-cards.js";
import { analyzeHistory, findEditWars, pickMilestones } from "./history-model.js";
import { createMinimap } from "./minimap.js";
import { createTimeline } from "./timeline3d.js";
import { openWarReplay } from "./war-replay.js";


const MARKUP = `
  <aside class="panel" aria-label="Article at this moment">
    <div class="panel-scroll">
      <header class="panel-head">
        <button type="button" class="panel-close" aria-label="Hide article">×</button>
        <div class="panel-meta"></div>
      </header>
      <article class="panel-doc"></article>
    </div>
    <section class="panel-fight" aria-label="Edit war replay"></section>
  </aside>

  <div class="stage">
    <canvas class="stage-canvas"></canvas>
    <div class="stage-cards"></div>

    <div class="hud-top">
      <div class="hud-title">
        <p class="hud-kicker">Edit history</p>
        <h1 class="hud-article"></h1>
        <button type="button" class="panel-toggle" aria-pressed="false">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/></svg>
          Show article
        </button>
      </div>
      <dl class="hud-stats"></dl>
    </div>

    <div class="hud-date">
      <p class="hud-month"></p>
      <div class="hud-row">
        <div class="spacing" role="radiogroup" aria-label="Spacing">
          <span>Spacing</span>
          <button type="button" role="radio" data-spacing="tight" aria-checked="true">Tight</button>
          <button type="button" role="radio" data-spacing="normal" aria-checked="false">Normal</button>
          <button type="button" role="radio" data-spacing="roomy" aria-checked="false">Roomy</button>
        </div>
        <p class="hud-hint">Scroll to travel · ← → jump between cards</p>
      </div>
    </div>

    <div class="minimap">
      <svg class="minimap-svg" preserveAspectRatio="none"></svg>
      <div class="minimap-now"></div>
      <div class="minimap-years"></div>
    </div>
  </div>
  <div class="scroll-spacer"></div>`;

// The History view: a 3D timeline of the article's edits, with the article at that moment and the
// edit war replays in a sidebar. Returns { hide } so a running replay stops when the view is left.
export async function mountHistory(root, { id }) {
  const [articles, rows] = await Promise.all([getArticles(), getHistory(id)]);
  const article = articles.find((a) => a.page_id === id);
  if (!rows.length || !article) {
    root.innerHTML = `<p class="history-empty">The prototype only has the edit history of Quantum computing.</p>`;
    return { hide() {} };
  }
  root.innerHTML = MARKUP;
  const $ = (selector) => root.querySelector(selector);
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

  $(".hud-article").textContent = article.title;
  $(".hud-stats").innerHTML = [
    [edits.length, "edits"],
    [new Set(edits.map((e) => e.user)).size, "editors"],
    [wars.filter((w) => w.kind === "dispute").length, "edit wars"],
  ]
    .map(([n, label]) => `<div><dt>${label}</dt><dd>${n.toLocaleString("en-US")}</dd></div>`)
    .join("");

  const month = $(".hud-month");
  const panel = createArticlePanel({ root: $(".panel"), articleId: id });
  let panelOpen = false;
  let fight = null;
  let lastTime = edits[0].time;
  const minimap = createMinimap({
    root: $(".minimap"),
    edits,
    wars,
    onPick: (time) => timeline.goToTime(time),
  });
  const timeline = createTimeline({
    stage: $(".stage"),
    canvas: $(".stage-canvas"),
    layer: $(".stage-cards"),
    spacer: $(".scroll-spacer"),
    edits,
    stops,
    renderCard: (stop) => renderStop(stop, changes),
    onMove: (time) => {
      const label = formatMonth(time);
      if (month.textContent !== label) month.textContent = label;
      minimap.setTime(time);
      lastTime = time;
      if (panelOpen && !fight) panel.show(time);
    },
  });

  const spacing = $(".spacing");
  spacing.addEventListener("click", (event) => {
    const button = event.target.closest("[data-spacing]");
    if (!button) return;
    for (const b of spacing.querySelectorAll("[data-spacing]")) b.setAttribute("aria-checked", String(b === button));
    timeline.setSpacing(button.dataset.spacing);
  });

  const toggle = $(".panel-toggle");
  function setPanel(open) {
    if (!open) fight?.close();
    panelOpen = open;
    root.classList.toggle("has-panel", open);
    toggle.setAttribute("aria-pressed", String(open));
    timeline.setInset(open ? $(".panel").offsetWidth : 0);
    if (open) panel.show(lastTime);
  }
  toggle.addEventListener("click", () => setPanel(!panelOpen));
  $(".panel-close").addEventListener("click", () => setPanel(false));
  addEventListener("resize", () => panelOpen && timeline.setInset($(".panel").offsetWidth));

  // A fight plays in the sidebar while the camera follows it along the braid, one turn at a time.
  const panelRoot = $(".panel");
  $(".stage-cards").addEventListener("click", async (event) => {
    const button = event.target.closest('[data-action="replay"]');
    if (!button) return;
    const war = wars.find((w) => w.id === button.dataset.war);
    fight?.close();
    setPanel(true);
    panelRoot.classList.add("is-fighting");
    timeline.goToTime(war.start);
    fight = await openWarReplay({
      mount: $(".panel-fight"),
      articleId: id,
      war,
      before: edits[war.edits[0].index - 1],
      onTurn: (edit) => timeline.goToTime(edit.time),
      onClose: () => {
        fight = null;
        panelRoot.classList.remove("is-fighting");
        panel.reset();
        panel.show(lastTime);
      },
    });
  });

  addEventListener("keydown", (event) => {
    if (root.hidden || document.body.classList.contains("has-replay")) return;
    if (event.key === "ArrowRight") timeline.next(1);
    else if (event.key === "ArrowLeft") timeline.next(-1);
    else return;
    event.preventDefault();
  });
  root.classList.add("is-ready");
  return { hide: () => fight?.close() };
}
