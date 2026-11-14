// Learn mode: POST /api/learn (server/learn.py) follows the article's links for the reader and streams a
// short explanation that cites the linked articles it read as [1], [2], ... ([0] is the article itself).
// learn() returns { stream, attachment } like respond(); attachment is a promise of the explored articles.

const at = () => Number(new URLSearchParams(location.search).get("at")) || Math.floor(Date.now() / 1000);

export function learn({ prompt, context, article, history = [] }) {
  const request = {
    prompt,
    context,
    page_id: article.page_id,
    at: at(),
    viewport: { w: innerWidth, h: innerHeight },
    history: history.slice(),
  };
  history.push({ role: "user", text: prompt });
  let found;
  const sources = new Promise((resolve) => (found = resolve));
  return { stream: read(request, found, history), attachment: sources };
}

// Reads the Server-Sent Events: "sources" (explored articles), "message" (text), "done", "error".
async function* read(request, found, history) {
  let text = "";
  try {
    const response = await fetch("/api/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null))?.error ?? `The server returned ${response.status}.`;
      yield `Sorry, I could not explore the links. ${error}`;
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = block.match(/^event: (.*)$/m)?.[1] ?? "message";
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
        if (name === "sources") found(data);
        else if (name === "done") return;
        else {
          // No Markdown emphasis, and each key point is its own paragraph even without a blank line before it.
          const piece = name === "error" ? `\n\nSorry, the answer stopped: ${data}` : data.replace(/\*/g, "").replace(/\s*• /g, "\n\n• ");
          text += piece;
          yield piece;
        }
      }
    }
  } catch (error) {
    yield `Sorry, I could not explore the links. ${error.message}`;
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

// Turns the answer's runs of [n], [n][m] and [n, m] markers into links to the articles they cite.
// `html` is escaped text.
export function citeLinks(html, { here, items }) {
  const byN = new Map(items.map((s) => [s.n, s]));
  byN.set(0, { ...here, url: null });
  return html.replace(/\s*(?:\[\d+(?:\s*,\s*\d+)*\])+/g, (run) => {
    const links = run.match(/\d+/g).map((n) => {
      const s = byN.get(Number(n));
      return s ? `<a class="cite" href="${escape(href(s))}" target="_blank" rel="noopener" title="${escape(s.title)}">${n}</a>` : null;
    });
    return links.every(Boolean) ? `<sup>${links.join(",")}</sup>` : run;
  });
}

const href = (s) => (s.page_id ? `./?id=${s.page_id}` : s.url);

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const style = document.createElement("style");
style.textContent = `
  .attach-sources a.res-item { text-decoration: none; }
  .msg-text sup { line-height: 0; }
  .msg-text a.cite { margin-left: 1px; font-size: 11px; font-weight: 500; text-decoration: none; color: #3366cc; }`;
document.head.append(style);
