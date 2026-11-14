import { censor } from "./censor.js";

// Turns MediaWiki markup (the `text` field from /api/article) into reader HTML.
// Rendered fragments are parked in `store` and referenced by control-character placeholders,
// so later passes never re-read HTML as wiki markup.

const inlineMark = (i) => `\u0001${i}\u0002`;
const blockMark = (i) => `\n\u0003${i}\u0004\n`;

// Stands where the article asks for its footnote list ({{Reflist}}); replaced once the list is built.
const REFLIST = "<!--reflist-->";

const HATNOTES = { main: "Main article", further: "Further information", "see also": "See also" };
const CITATIONS = /^(cite\b.*|citation)$/;
const FILE_OPTION =
  /^(thumb|thumbnail|frame|frameless|framed|border|right|left|center|centre|none|upright(=.*)?|\d*x?\d+px|(alt|link|class|lang|page)=.*)$/i;

export function renderWikitext(source, { fileUrl, renderMath }) {
  const store = [];
  const keep = (html) => inlineMark(store.push(html) - 1);
  const keepBlock = (html) => blockMark(store.push(html) - 1);
  const refs = [];
  const refsByKey = new Map();
  let description = null;

  // Footnotes get their numbers at the end, in reading order; until then they are \u0005index\u0006 marks.
  function cite(key, body) {
    let index = key ? refsByKey.get(key) : undefined;
    if (index === undefined) {
      index = refs.push({ n: null, body: null }) - 1;
      if (key) refsByKey.set(key, index);
    }
    if (body !== null && refs[index].body === null) refs[index].body = body;
    return `\u0005${index}\u0006`;
  }

  const numbered = [];
  const number = (s) =>
    s.replace(/\u0005(\d+)\u0006/g, (_, i) => {
      const ref = refs[i];
      ref.n ??= numbered.push(ref);
      return `<sup class="ref"><a href="#cite-${ref.n}" data-ref="${ref.n}">${ref.n}</a></sup>`;
    });

  function template(inner) {
    const [rawName, ...rest] = splitParams(inner);
    const name = rawName.trim().toLowerCase().replace(/_/g, " ");
    const pos = [];
    const named = {};
    for (const part of rest) {
      const m = part.match(/^\s*([\w -]+?)\s*=([\s\S]*)$/);
      if (m) named[m[1].toLowerCase()] = m[2].trim();
      else pos.push(part.trim());
    }

    if (name === "short description") {
      description = pos[0] ?? null;
      return "";
    }
    if (name === "sfn" || name === "sfnp" || name === "harvnb") {
      const page = named.p ? `, p. ${named.p}` : named.pp ? `, pp. ${named.pp}` : "";
      return cite(`sfn:${inner}`, `${pos.slice(0, 2).join(" ")}${page}.`);
    }
    if (name === "efn") return cite(named.name ?? null, pos[0] ?? "");
    if (name in HATNOTES) {
      const links = pos.map((t) => inline(`[[${t}]]`)).join(", ");
      return keepBlock(`<p class="hatnote">${HATNOTES[name]}: ${links}</p>`);
    }
    if (CITATIONS.test(name)) return keep(inline(citation(name, named)));
    switch (name) {
      case "math":
        return keep(`<span class="tmath">${inline(pos[0] ?? named[1] ?? "")}</span>`);
      case "mvar":
        return keep(`<i class="tmath">${inline(pos[0] ?? "")}</i>`);
      case "sup":
      case "sub":
        return keep(`<${name}>${inline(pos[0] ?? "")}</${name}>`);
      case "ket":
        return keep(`|${inline(pos[0] ?? "")}⟩`);
      case "bra":
        return keep(`⟨${inline(pos[0] ?? "")}|`);
      case "sfrac":
        return keep(
          pos.length === 3
            ? `${inline(pos[0])}<sup>${inline(pos[1])}</sup>⁄<sub>${inline(pos[2])}</sub>`
            : `<sup>${inline(pos[0] ?? "")}</sup>⁄<sub>${inline(pos[1] ?? "")}</sub>`,
        );
      case "blockquote":
      case "quote":
        return keepBlock(`<blockquote>${inline(named.text ?? pos[0] ?? "")}</blockquote>`);
      case "nowrap":
        return keep(`<span class="nowrap">${inline(pos[0] ?? "")}</span>`);
      case "gloss":
        return `‘${pos[0] ?? ""}’`;
      case "nbsp":
        return "&nbsp;";
      case "en dash":
      case "ndash":
        return "–";
      case "mdash":
        return "—";
      case "hyphen":
        return "-";
      case "reflist":
        return keepBlock(REFLIST);
      case "!":
        return "|";
      default:
        return "";
    }
  }

  // Innermost templates first, so nested ones are already resolved when their parent runs.
  function expandTemplates(text) {
    let prev;
    do {
      prev = text;
      text = text.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => template(inner));
    } while (text !== prev);
    return text;
  }

  function figure(inner) {
    const parts = splitParams(inner);
    const name = parts[0].replace(/^(file|image):/i, "").trim();
    const caption = parts.slice(1).filter((p) => !FILE_OPTION.test(p.trim())).at(-1) ?? "";
    const alt = parts.find((p) => /^\s*alt=/.test(p))?.replace(/^\s*alt=/, "") ?? stripTags(restore(inline(caption)));
    return keepBlock(
      `<figure class="figure"><img src="${attr(fileUrl(name))}" alt="${attr(alt)}" loading="lazy">` +
        (caption ? `<figcaption>${inline(caption)}</figcaption>` : "") +
        `</figure>`,
    );
  }

  const restore = (s) => {
    let prev;
    do {
      prev = s;
      s = s.replace(/\u0001(\d+)\u0002|\u0003(\d+)\u0004/g, (_, a, b) => store[a ?? b]);
    } while (s !== prev);
    return s;
  };

  let text = censor(source).replace(/<!--[\s\S]*?-->/g, "").replace(/__[A-Z]+__/g, "");
  text = text.replace(/<math([^>]*)>([\s\S]*?)<\/math>/g, (_, attrs, tex) =>
    /display\s*=\s*"?block/.test(attrs)
      ? keepBlock(`<div class="math-block">${renderMath(tex.trim(), true)}</div>`)
      : keep(renderMath(tex.trim(), false)),
  );
  text = text.replace(/<references\s*\/>/gi, "{{reflist}}");
  text = text.replace(/<ref([^>]*?)(?:\/>|>([\s\S]*?)<\/ref>)/g, (_, attrs, body) =>
    cite(refName(attrs), body ?? null),
  );
  text = expandTemplates(text);
  text = replaceFiles(text, figure);

  const toc = [];
  const html = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) html.push(renderList(list));
    list = [];
  };

  for (const line of text.split("\n")) {
    const heading = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    const block = line.match(/^\u0003(\d+)\u0004$/);
    const listItem = line.match(/^([*#]+)\s*(.*)$/);
    if (!listItem) flushList();

    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 4);
      const label = restore(inline(heading[2]));
      const plain = stripTags(label).trim();
      const id = slug(plain);
      if (level <= 3) toc.push({ level, text: plain, id });
      html.push(`<h${level} id="${id}">${label}</h${level}>`);
    } else if (block) {
      flushPara();
      html.push(store[block[1]]);
    } else if (listItem) {
      flushPara();
      list.push({ marker: listItem[1], text: listItem[2] });
    } else if (/^:+/.test(line)) {
      flushPara();
      html.push(`<p class="indent">${inline(line.replace(/^:+\s*/, ""))}</p>`);
    } else if (/^;/.test(line)) {
      flushPara();
      const [term, def] = line.slice(1).split(/\s:\s/);
      html.push(`<p class="term"><b>${inline(term)}</b>${def ? ` ${inline(def)}` : ""}</p>`);
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();

  const bodyHtml = number(restore(html.join("\n")));
  // Notes can cite further sources themselves (an {{sfn}} inside an {{efn}}), so walk by index.
  const items = [];
  for (let i = 0; i < numbered.length; i++) {
    const ref = numbered[i];
    items.push(`<li id="cite-${ref.n}">${number(restore(inline(expandTemplates(ref.body ?? ""))))}</li>`);
  }
  const footnotes = items.length ? `<ol class="references">${items.join("")}</ol>` : "";
  if (bodyHtml.includes(REFLIST)) return { html: bodyHtml.replace(REFLIST, footnotes).replaceAll(REFLIST, ""), toc, description };
  if (!footnotes) return { html: bodyHtml, toc, description };
  toc.push({ level: 2, text: "References", id: "references" });
  return { html: `${bodyHtml}\n<h2 id="references">References</h2>${footnotes}`, toc, description };

  function renderList(lines) {
    let out = "";
    const stack = [];
    for (const { marker, text } of lines) {
      while (stack.length > marker.length) out += `</li></${stack.pop()}>`;
      if (stack.length && stack.length === marker.length) out += "</li>";
      while (stack.length < marker.length) {
        const tag = marker[stack.length] === "#" ? "ol" : "ul";
        out += `<${tag}>`;
        stack.push(tag);
      }
      out += `<li>${inline(text)}`;
    }
    while (stack.length) out += `</li></${stack.pop()}>`;
    return out;
  }
}

function inline(s) {
  s = s.replace(/<\/?(span|nowiki|abbr|div|center|font|big|blockquote|poem)\b[^>]*>/gi, "");
  s = s.replace(/&(?![a-zA-Z]+;|#\d+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/&lt;(\/?)(sub|sup|br|i|b|small|em|strong|s|u)\s*\/?&gt;/gi, "<$1$2>");
  s = s.replace(/\[\[:?([^[\]|]+)(?:\|([^[\]]*))?\]\]([a-z]*)/g, (_, target, label, trail) => {
    if (/^category:/i.test(target)) return "";
    // Older versions end with links to the same article in other languages, such as [[de:Quantencomputer]].
    if (/^[a-z]{2,3}(-[a-z]+)*:/.test(target) && !/^(wikt|s):/i.test(target)) return "";
    const text = (label || target) + trail;
    if (/^(wikt|wiktionary|commons|s):/i.test(target)) return text;
    return `<a class="wl" href="#" data-title="${attr(target.split("#")[0].trim())}">${text}</a>`;
  });
  s = s.replace(
    /\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g,
    (_, url, label) => `<a class="ext" href="${url}" target="_blank" rel="noopener">${label}</a>`,
  );
  s = s.replace(/\[(https?:\/\/[^\s\]]+)\]/g, (_, url) => `<a class="ext" href="${url}" target="_blank" rel="noopener">↗</a>`);
  return s
    .replace(/'''''(.+?)'''''/g, "<b><i>$1</i></b>")
    .replace(/'''(.+?)'''/g, "<b>$1</b>")
    .replace(/''(.+?)''/g, "<i>$1</i>");
}

function citation(kind, p) {
  const names = [];
  for (let k = 1; k <= 12; k++) {
    const last = p[`last${k}`] ?? p[`author${k}`] ?? (k === 1 ? (p.last ?? p.author) : undefined);
    if (!last) break;
    const first = p[`first${k}`] ?? (k === 1 ? p.first : undefined);
    names.push(first ? `${last}, ${first}` : last);
  }
  const authors = names.length > 3 ? `${names[0]} et al.` : names.join("; ");
  const year = (p.date ?? p.year ?? "").match(/\d{4}/)?.[0];
  const title = p.title ? (p.url ? `[${p.url} ${p.title}]` : p.title) : "";
  const isBook = kind === "cite book";
  const container = p.journal ?? p.website ?? p.work ?? p.newspaper ?? p.magazine ?? p.conference ?? p["book-title"];
  return [
    authors && `${authors}${year ? ` (${year})` : ""}.`,
    !authors && year && `(${year}).`,
    title && (isBook ? `''${title}''.` : `“${title}”.`),
    container && `''${container}''.`,
    !container && p.publisher && `${p.publisher}.`,
    p.eprint && `arXiv:${p.eprint}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// Splits on "|" that sit outside [[links]].
function splitParams(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("[[", i)) {
      depth++;
      cur += "[[";
      i++;
    } else if (s.startsWith("]]", i) && depth > 0) {
      depth--;
      cur += "]]";
      i++;
    } else if (s[i] === "|" && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out;
}

// File links nest other links in their captions, so they need bracket counting rather than a regex.
function replaceFiles(text, fn) {
  const start = /\[\[(?:file|image):/gi;
  let out = "";
  let i = 0;
  for (;;) {
    start.lastIndex = i;
    const m = start.exec(text);
    if (!m) break;
    out += text.slice(i, m.index);
    let depth = 0;
    let j = m.index;
    for (; j < text.length; j++) {
      if (text.startsWith("[[", j)) {
        depth++;
        j++;
      } else if (text.startsWith("]]", j)) {
        depth--;
        j++;
        if (depth === 0) break;
      }
    }
    out += fn(text.slice(m.index + 2, j - 1));
    i = j + 1;
  }
  return out + text.slice(i);
}

function refName(attrs) {
  return attrs.match(/name\s*=\s*"?([^"]+?)"?\s*$/)?.[1].trim() ?? null;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
}

function attr(s) {
  return s.replace(/&(?![a-zA-Z]+;|#\d+;)/g, "&amp;").replace(/"/g, "&quot;");
}

// Short plain-text version of a wiki markup fragment, for previews of what an edit changed.
export function plainText(s) {
  return censor(s)
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?(<\/ref>|$)/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\{\{[\s\S]*$|^[\s\S]*?\}\}/g, "")
    .replace(/\|\s*[\w-]+\s*=\s*[^|]*/g, "")
    .replace(/\[\[(?:[^[\]|]*\|)?([^[\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s([^\]]+)\]/g, "$1")
    .replace(/\[?https?:\/\/(?:www\.)?([^/\s\]|]+)[^\s\]]*\]?/g, "link to $1")
    .replace(/<[^>]+>|'{2,}|^[*#:;=\s]+|=+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
