// The Markdown of an article that has no wikitext history (from dataset L), as the same { html, toc, description }
// that renderWikitext returns. It covers what L's text uses: headings, paragraphs, lists, tables, bold, italic
// and links.

export function renderMarkdown(source) {
  const toc = [];
  const html = [];
  const ids = new Set();
  let para = [];
  let list = null;
  let table = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushTable = () => {
    if (table.length) html.push(renderTable(table));
    table = [];
  };

  for (const line of source.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    const item = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/);
    const row = line.trim().startsWith("|");
    if (!item) flushList();
    if (!row) flushTable();

    if (heading) {
      flushPara();
      const level = heading[1].length;
      // The title is the page's own h1.
      if (level === 1) continue;
      const text = heading[2];
      const id = uniqueId(slug(text), ids);
      if (level <= 3) toc.push({ level, text: escape(text), id });
      html.push(`<h${Math.min(level, 4)} id="${id}">${inline(text)}</h${Math.min(level, 4)}>`);
    } else if (item) {
      flushPara();
      const tag = item[1] ? "ul" : "ol";
      if (list?.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(item[2]);
    } else if (row) {
      flushPara();
      table.push(line.trim());
    } else if (!line.trim()) {
      flushPara();
    } else {
      // Each line of L's text is a paragraph of its own.
      flushPara();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  flushTable();
  return { html: html.join("\n"), toc, description: null };
}

function renderTable(lines) {
  const cells = (line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const separator = (line) => /^\|?[\s:|-]+\|?$/.test(line) && line.includes("-");
  const sepAt = lines.findIndex(separator);
  const head = sepAt > 0 ? lines.slice(0, sepAt) : [];
  const body = lines.filter((line, i) => i > sepAt || (sepAt < 0 && !separator(line)));
  const rows = (group, tag) => group.map((line) => `<tr>${cells(line).map((c) => `<${tag}>${inline(c)}</${tag}>`).join("")}</tr>`).join("");
  return `<div class="md-table"><table>${head.length ? `<thead>${rows(head, "th")}</thead>` : ""}<tbody>${rows(body, "td")}</tbody></table></div>`;
}

function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a class="ext" href="${url}" target="_blank" rel="noopener">${label}</a>`)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<i>$2</i>");
}

function escape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slug(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
}

function uniqueId(id, ids) {
  let unique = id;
  for (let n = 2; ids.has(unique); n++) unique = `${id}-${n}`;
  ids.add(unique);
  return unique;
}
