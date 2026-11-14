import { fileUrl, getArticle, getArticles, getPreview } from "./fake/api.js";
import { hoverCard } from "./hover-card.js";
import { renderWikitext } from "./wikitext.js";

const DEFAULT_ARTICLE = 4011;

const id = Number(new URLSearchParams(location.search).get("id") ?? DEFAULT_ARTICLE);
setUpViews();
const now = Math.floor(Date.now() / 1000);
const [articles, { version }] = await Promise.all([getArticles(), getArticle(id, now)]);
const summary = articles.find((a) => a.page_id === id);

const head = document.querySelector(".head");
const body = document.querySelector(".body");
const toc = document.querySelector(".toc");

if (!version || !summary) {
  head.innerHTML = `<h1>Not found</h1><p class="dek">This article isn't part of the prototype yet.</p>`;
} else {
  const doc = renderWikitext(version.text, {
    fileUrl,
    renderMath: (tex, displayMode) => katex.renderToString(tex, { displayMode, throwOnError: false }),
  });
  document.title = `${version.title} · Wikipedia`;
  head.innerHTML = `
    <h1>${version.title}</h1>
    ${doc.description ? `<p class="dek">${doc.description}</p>` : ""}
    <p class="meta">
      Last edited ${formatDate(version.row_start)} by ${version.user}
      <span aria-hidden="true">·</span>
      ${summary.versions.toLocaleString("en-US")} versions since ${new Date(summary.first * 1000).getUTCFullYear()}
    </p>`;
  body.innerHTML = doc.html;
  toc.innerHTML = renderToc(doc.toc);
  document.body.classList.add("is-ready");
  trackActiveSection(doc.toc);
  hoverCard({
    root: body,
    selector: "a.wl",
    card: document.querySelector(".card-preview"),
    showDelay: 350,
    render: renderPreview,
  });
  hoverCard({
    root: body,
    selector: ".ref a",
    card: document.querySelector(".card-ref"),
    showDelay: 80,
    render: (link) =>
      `<span class="card-ref-n">${link.dataset.ref}</span>${document.getElementById(`cite-${link.dataset.ref}`).innerHTML}`,
  });
  body.addEventListener("click", (event) => {
    if (event.target.closest("a.wl")) event.preventDefault();
  });
}

// Article and Explore share the page. Explore loads the first time it's opened, and can move to
// another article; switching back to Article then opens that one.
function setUpViews() {
  const layout = document.querySelector(".layout");
  const explore = document.querySelector(".explore");
  const buttons = document.querySelectorAll(".views button");
  let mounted = null;

  const show = (view) => {
    const url = new URL(location.href);
    const current = Number(url.searchParams.get("id") ?? DEFAULT_ARTICLE);
    if (view === "article" && current !== id) {
      url.searchParams.delete("view");
      location.href = url;
      return;
    }
    if (view === "explore") url.searchParams.set("view", "explore");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
    document.body.dataset.view = view;
    layout.hidden = view === "explore";
    explore.hidden = view !== "explore";
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.view === view));
    if (view === "explore") {
      scrollTo(0, 0);
      mounted ??= import("./explore.js").then((m) => m.mountExplore(explore, { id }));
    }
  };

  for (const b of buttons) b.addEventListener("click", () => show(b.dataset.view));
  show(new URLSearchParams(location.search).get("view") === "explore" ? "explore" : "article");
}

function formatDate(rowStart) {
  return new Date(`${rowStart.slice(0, 19).replace(" ", "T")}Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function renderToc(entries) {
  const groups = [];
  for (const entry of entries) {
    if (entry.level === 2 || !groups.length) groups.push({ ...entry, children: [] });
    else groups.at(-1).children.push(entry);
  }
  const items = groups
    .map((g) =>
      g.children.length
        ? `
      <li data-id="${g.id}" class="has-children">
        <button type="button" class="toc-toggle" aria-expanded="false">
          <span>${g.text}</span>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" /></svg>
        </button>
        <div class="toc-sub"><ol>${g.children.map((c) => `<li data-id="${c.id}"><a href="#${c.id}">${c.text}</a></li>`).join("")}</ol></div>
      </li>`
        : `<li data-id="${g.id}"><a href="#${g.id}">${g.text}</a></li>`,
    )
    .join("");
  return `<p class="toc-label">Contents</p><ol><li data-id="top"><a href="#top">Introduction</a></li>${items}</ol>`;
}

// The section being read opens by itself as you scroll; sections with subsections also open and
// close on click without moving the page. A click can close the auto-opened one until you scroll to another.
function trackActiveSection(entries) {
  const headings = entries.map((e) => document.getElementById(e.id)).filter(Boolean);
  const pinned = new Set();
  let dismissed = null;
  let readingId = null;
  let frame = 0;

  const render = () => {
    for (const li of toc.querySelectorAll("li.has-children")) {
      const open = pinned.has(li.dataset.id) || (li.dataset.id === readingId && dismissed !== readingId);
      li.classList.toggle("is-open", open);
      li.querySelector(".toc-toggle").setAttribute("aria-expanded", String(open));
    }
  };

  const update = () => {
    frame = 0;
    let current = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top < 140) current = h;
      else break;
    }
    const activeId = current?.id ?? "top";
    const sectionId =
      current?.tagName === "H3"
        ? entries.slice(0, entries.findIndex((e) => e.id === activeId)).findLast((e) => e.level === 2)?.id
        : activeId;
    if (sectionId !== readingId) dismissed = null;
    readingId = sectionId;
    for (const li of toc.querySelectorAll("li")) {
      li.classList.toggle("is-current", li.dataset.id === activeId);
      li.classList.toggle("is-reading", li.dataset.id === sectionId);
    }
    render();
  };

  toc.addEventListener("click", (event) => {
    const toggle = event.target.closest(".toc-toggle");
    if (!toggle) return;
    const id = toggle.parentElement.dataset.id;
    if (toggle.parentElement.classList.contains("is-open")) {
      pinned.delete(id);
      if (id === readingId) dismissed = id;
    } else {
      pinned.add(id);
      if (dismissed === id) dismissed = null;
    }
    render();
  });
  addEventListener("scroll", () => (frame ||= requestAnimationFrame(update)), { passive: true });
  update();
}

async function renderPreview(link) {
  const preview = await getPreview(link.dataset.title);
  if (!preview) return null;
  const thumb = preview.thumbnail;
  // Drawings (SVG) are shown whole on a soft backdrop; photos fill the frame.
  const media = thumb
    ? `<div class="card-media${/\.svg\b/i.test(thumb.url) ? " is-diagram" : ""}">
        <img src="${thumb.url}" alt="" onerror="this.parentElement.remove()">
      </div>`
    : "";
  return `${media}<div class="card-text">${preview.extract}</div>`;
}
