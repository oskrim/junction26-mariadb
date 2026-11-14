// The chat assistant: Ask and Find go to POST /api/ask in server/ask.py, which reads the article as it
// was at the moment being viewed and answers with Gemini. Visualise is still the canned demo.
// respond() returns { stream, attachment }: stream yields text chunks; attachment may be a promise.
// onStep(name, data), when given, receives the server's progress events: "step", "thinking" and "error".
// Without it, an error becomes part of the answer text.

import { respond as cannedRespond } from "./fake/assistant.js";

export const PAST_CHATS = [];

const at = () => Number(new URLSearchParams(location.search).get("at")) || Math.floor(Date.now() / 1000);

export function respond({ mode, prompt, context, article, turn = 0, history = [], onStep = null }) {
  if (mode === "visualise") return cannedRespond({ mode, prompt, context, article, turn });
  const request = { mode, prompt, context, page_id: article.page_id, at: at(), history: history.slice() };
  history.push({ role: "user", text: prompt });
  let found = null;
  const attachment = mode === "find" ? new Promise((resolve) => (found = resolve)) : null;
  return { stream: record(answer(request, onStep, found), history), attachment };
}

// Ask streams "message" text; Find sends one "result" with its text and attachment.
async function* answer(request, onStep, found) {
  try {
    for await (const { name, data } of events("/api/ask", request)) {
      if (name === "message") yield data;
      else if (name === "result") {
        found(data.attachment && escapeResults(data.attachment));
        yield data.text;
      } else if (name === "error" && !onStep) yield `\n\nSorry, the answer stopped: ${data}`;
      else onStep?.(name, data);
    }
  } finally {
    found?.(null);
  }
}

// Posts request to url and yields its Server-Sent Events as { name, data } until "done" or "error". A request
// that fails before or during the stream ends with one "error" event.
export async function* events(url, request) {
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } catch (error) {
    yield { name: "error", data: `Could not reach the server: ${error.message}` };
    return;
  }
  if (!response.ok) {
    yield { name: "error", data: (await response.json().catch(() => null))?.error ?? `The server returned ${response.status}.` };
    return;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      yield { name: "error", data: `The connection broke: ${error.message}` };
      return;
    }
    if (chunk.done) {
      yield { name: "error", data: "The connection closed before the answer was complete." };
      return;
    }
    buffer += chunk.value;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = block.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
      if (name === "done") return;
      yield { name, data };
      if (name === "error") return;
    }
  }
}

// Keeps the chat's history in step with what was shown, for follow-up questions.
async function* record(stream, history) {
  let text = "";
  for await (const piece of stream) {
    text += piece;
    yield piece;
  }
  history.push({ role: "ai", text });
}

// chat.js puts result fields into HTML as they are.
function escapeResults({ type, groups }) {
  const clean = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, escapeHtml(String(v))]));
  return { type, groups: groups.map((g) => ({ label: escapeHtml(g.label), items: g.items.map(clean) })) };
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Clicking a quote under "In this article" scrolls to that passage in the article and highlights it.
addEventListener("click", (event) => {
  const title = event.target.closest(".res-item")?.querySelector(".res-title")?.textContent;
  const body = document.querySelector(".body");
  if (!title || !body) return;
  const range = findText(body, title) ?? findText(body, title.slice(0, 60));
  if (!range) return;
  range.startContainer.parentElement.scrollIntoView({ behavior: "smooth", block: "center" });
  if (globalThis.Highlight && CSS.highlights) CSS.highlights.set("ask-quote", new Highlight(range));
});

const style = document.createElement("style");
style.textContent = "::highlight(ask-quote) { background: #ffe58a; color: inherit; }";
document.head.append(style);

// Finds the quote in the rendered article, ignoring spacing.
function findText(root, quote) {
  const needle = quote.replace(/\s+/g, " ").trim();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, from: text.length });
    text += node.data.replace(/\s+/g, " ");
  }
  const start = text.indexOf(needle);
  if (start < 0) return null;
  const locate = (offset) => {
    const hit = nodes.findLast((n) => n.from <= offset);
    return [hit.node, Math.min(offset - hit.from, hit.node.data.length)];
  };
  const range = document.createRange();
  range.setStart(...locate(start));
  range.setEnd(...locate(start + needle.length));
  return range;
}
