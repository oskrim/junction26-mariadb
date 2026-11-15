// Model answers as HTML. Gemini writes plain text with some Markdown habits; those become real formatting:
// blank-line paragraphs, "-", "*", "•" and "1." lists, short "#" headings, **bold** and *italic*. Everything is
// escaped first, so only these tags are ever produced. Citation markers like [1] pass through for citeLinks.

export function formatAnswer(text) {
  const blocks = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) blocks.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d{1,2}[.)])\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (!line) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(`<h4>${inline(heading[1].replace(/\*+/g, ""))}</h4>`);
    } else if (bullet) {
      flushPara();
      const tag = /^\d/.test(line) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(bullet[1]);
    } else if (list && raw.startsWith("  ")) {
      list.items[list.items.length - 1] += ` ${line}`; // a list item's continuation line
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks.join("");
}

// Escaped text with **bold** and *italic*; a lone asterisk (3 * 4) stays as it is.
export function inline(text) {
  return emphasis(escape(text));
}

export function emphasis(html) {
  return html
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, "$1<em>$2</em>");
}

export const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
