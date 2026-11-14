// Learn mode: POST /api/learn (server/learn.py) follows the article's links for the reader and streams a
// short explanation that cites the linked articles it read as [1], [2], ... ([0] is the article itself).
// learn() returns { stream, attachment } like respond(); attachment is a promise of the explored articles.
// shape "lesson" or "reply" asks for the Learn view's lesson or a short answer during one (see server/learn.py);
// those come as written.

import { BASE } from "./api.js";
import { events } from "./assistant.js";

const at = () => Number(new URLSearchParams(location.search).get("at")) || Math.floor(Date.now() / 1000);

export function learn({ prompt, context, article, history = [], onStep = null, shape = null }) {
  const request = {
    prompt,
    context,
    page_id: article.page_id,
    at: at(),
    viewport: { w: innerWidth, h: innerHeight },
    history: history.slice(),
    ...(shape && { shape }),
  };
  history.push({ role: "user", text: prompt });
  let found;
  const sources = new Promise((resolve) => (found = resolve));
  return { stream: read(request, found, history, onStep), attachment: sources };
}

// "sources" is the explored articles, "message" a piece of text; progress events go to onStep.
async function* read(request, found, history, onStep) {
  let text = "";
  try {
    for await (const { name, data } of events(BASE + "/api/learn", request)) {
      if (name === "sources") found(data);
      else if (name === "message" || (name === "error" && !onStep)) {
        // No Markdown emphasis, and each key point is its own paragraph even without a blank line before it.
        const piece =
          name === "error" ? `\n\nSorry, the answer stopped: ${data}` : request.shape ? data : data.replace(/\*/g, "").replace(/\s*• /g, "\n\n• ");
        text += piece;
        yield piece;
      } else onStep?.(name, data);
    }
  } finally {
    found(null);
    history.push({ role: "ai", text });
  }
}

// The articles the agent went through, as a list under the answer.
export function sourcesHtml({ explored, items }) {
  return `<div class="attach attach-results attach-sources">
    <p class="res-label">Read ${items.length} of ${explored} linked articles · [0] is this article</p>
    <ul>${items
      .map(
        (s) => `
        <li><a class="res-item" href="${escape(href(s))}" target="_blank" rel="noopener">
          <span class="res-title">${s.n}. ${escape(s.title)}</span>
          <span class="res-meta">${s.page_id ? "In this app" : "Wikipedia"}</span>
          <span class="res-note">${escape(s.why)}</span>
        </a></li>`,
      )
      .join("")}</ul></div>`;
}

// Turns the answer's runs of [n], [n][m], [n, m] and [n], [m] markers into citation markers that carry
// their tooltip text. Learn's markers link to the article they cite; Ask's ("quotes") are buttons that show
// the quote in the article. Markers without a source are dropped. `html` is escaped text.
export function citeLinks(html, { type, here, items }) {
  const byN = new Map(items.map((s) => [s.n, s]));
  if (type === "sources") byN.set(0, { ...here, url: null, why: "The article you are reading" });
  const marker = (n) => {
    const s = byN.get(n);
    if (!s) return null;
    const tip = `data-tip-title="${escape(s.title)}" data-tip-meta="${escape(s.why ?? (s.section || "Introduction"))}" data-tip-quote="${escape(s.quote ?? "")}"`;
    return type === "quotes" && !s.link
      ? `<button type="button" class="cite" data-quote="${escape(s.quote)}" ${tip}>${items.indexOf(s) + 1}</button>`
      : `<a class="cite" href="${escape(href(s))}" target="_blank" rel="noopener" ${tip}>${n}</a>`;
  };
  return html.replace(/\s*\[\d+(?:\s*,\s*\d+)*\](?:\s*,?\s*\[\d+(?:\s*,\s*\d+)*\])*/g, (run) => {
    const links = [...new Set(run.match(/\d+/g).map(Number))].map(marker).filter(Boolean);
    return links.length ? `<sup>${links.join(",")}</sup>` : "";
  });
}

// An Ask quote from a related article or another version links to that text.
const href = (s) => s.link ?? (s.page_id ? `./?id=${s.page_id}` : s.url);

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
