import { censor } from "./censor.js";
import { diff, words } from "./diff.js";
import { fileUrl, getArticle } from "./api.js";
import { formatDate } from "./history-cards.js";
import { parseRowStart } from "./history-model.js";
import { renderWikitext } from "./wikitext.js";

// The article as it read at the moment the timeline is at. When the version changes, the differences
// from the version shown before are marked and the panel scrolls to the first one.
export function createArticlePanel({ root, articleId }) {
  const meta = root.querySelector(".panel-meta");
  const doc = root.querySelector(".panel-doc");
  const scroller = root.querySelector(".panel-scroll");
  let shown = null;
  let wanted = 0;
  let timer = 0;
  let request = 0;

  async function load() {
    const token = ++request;
    const { version } = await getArticle(articleId, Math.floor(wanted / 1000));
    if (token !== request || !version || version.rev_id === shown?.revId) return;
    render(version);
  }

  function render(version) {
    const { html } = renderWikitext(version.text, {
      fileUrl,
      renderMath: (tex, displayMode) => katex.renderToString(tex, { displayMode, throwOnError: false }),
    });
    const box = document.createElement("div");
    box.innerHTML = html;
    box.querySelectorAll("ol.references").forEach((el) => el.remove());
    const blocks = [...box.children].map((el) => ({ key: `${el.tagName}:${textOf(el)}`, tag: el.tagName, html: el.outerHTML }));

    let first = null;
    const counts = { changed: 0, added: 0, removed: 0 };
    const runs = shown ? diff(shown.blocks, blocks, (b) => b.key) : [];
    const changedShare = runs.reduce((n, r) => n + (r.type === "change" ? r.b.length : 0), 0) / Math.max(1, blocks.length);
    // Past about half the article, marking every word would bury the text; the clean version reads better.
    const rewritten = changedShare > 0.5;
    if (!shown || rewritten) doc.innerHTML = blocks.map((b) => b.html).join("");
    else {
      const out = [];
      for (const run of runs) {
        if (run.type === "equal") {
          out.push(...run.b.map(element));
          continue;
        }
        run.b.forEach((next, i) => {
          const prev = run.a[i];
          const el = prev && prev.tag === next.tag ? wordDiff(prev, next) : marked(next, "is-added");
          if (el.classList.contains("is-changed")) counts.changed++;
          else counts.added++;
          out.push(el);
          first ??= el;
        });
        for (const prev of run.a.slice(run.b.length)) {
          const el = marked(prev, "is-removed");
          counts.removed++;
          out.push(el);
          first ??= el;
        }
      }
      doc.replaceChildren(...out);
    }

    meta.innerHTML = `
      <p class="panel-when">${formatDate(parseRowStart(version.row_start))} <span>· ${escape(censor(version.user))}</span></p>
      <p class="panel-diff">${
        !shown
          ? "The article as it read on this day"
          : rewritten
            ? `Largely rewritten <span>since ${formatDate(shown.time)}</span>`
            : summary(counts, shown.time)
      }</p>`;
    shown = { revId: version.rev_id, time: parseRowStart(version.row_start), blocks };
    if (first) scroller.scrollTo({ top: first.offsetTop - 96, behavior: "smooth" });
  }

  return {
    // Forgets the version on screen, so the next one is shown clean instead of compared.
    reset() {
      shown = null;
    },
    // Called every frame while the timeline moves, so it loads at most every 160 ms, with the latest time.
    show(time) {
      wanted = time;
      timer ||= setTimeout(() => {
        timer = 0;
        load();
      }, 160);
    },
  };
}

// Footnote numbers shift whenever a source is added earlier on, so they are left out of the comparison.
function textOf(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("sup.ref, .katex-mathml").forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, " ").trim();
}

function element(block) {
  const box = document.createElement("div");
  box.innerHTML = block.html;
  return box.firstElementChild;
}

function marked(block, className) {
  const el = element(block);
  el.classList.add(className);
  return el;
}

// Changed paragraphs are shown as plain text with the removed words struck and the new ones marked.
function wordDiff(prev, next) {
  const el = element(next);
  if (el.matches(".infobox") || el.querySelector(".katex, img")) {
    el.classList.add("is-changed");
    return el;
  }
  const html = diff(words(textOf(element(prev))), words(textOf(el)))
    .map((run) => {
      if (run.type === "equal") return escape(run.b.join(""));
      const removed = run.a.join("");
      const added = run.b.join("");
      return `${removed.trim() ? `<del>${escape(removed)}</del>` : ""}${added.trim() ? `<ins>${escape(added)}</ins>` : escape(added)}`;
    })
    .join("");
  el.innerHTML = html;
  el.classList.add("is-changed");
  return el;
}

function summary({ changed, added, removed }, since) {
  const parts = [
    changed && `${changed} changed`,
    added && `${added} added`,
    removed && `${removed} removed`,
  ].filter(Boolean);
  const what = parts.length ? `${parts.join(", ")} ${changed + added + removed === 1 ? "paragraph" : "paragraphs"}` : "No visible change";
  return `${what} <span>since ${formatDate(since)}</span>`;
}

function escape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
