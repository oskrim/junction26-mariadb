// The API in server/app.py. Same functions and response shapes as fake/api.js.

const CLOUD = "https://65-109-75-60.sslip.io";

// Pages served by app.py (the cloud, or locally on 8010–8019) ask their own server; a page served any
// other way, such as python3 -m http.server, asks the cloud.
export const BASE = location.origin === CLOUD || /^801\d$/.test(location.port) ? "" : CLOUD;

// Every answer is kept for the page's lifetime: the views ask for the same URLs many times.
const answers = new Map();

function get(path) {
  const url = BASE + path;
  if (!answers.has(url)) {
    const answer = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.json();
    });
    answers.set(url, answer);
    answer.catch(() => answers.delete(url));
  }
  return answers.get(url);
}

// One article ([{ page_id, title, versions, first }]) when id is given, else all of them.
export const getArticles = (id) => get(id == null ? "/api/articles" : `/api/articles?id=${id}`);

// The current time for `at`, in whole minutes so that views opened within a minute share cached answers.
export const now = () => Math.floor(Date.now() / 60000) * 60;

// The language of the article the page shows (?lang=sv|en), else "fi". Swedish and English articles are the
// current version only, under their own wiki's page id.
export function pageLang() {
  const lang = new URLSearchParams(location.search).get("lang");
  return lang === "sv" || lang === "en" ? lang : "fi";
}

// A Finnish article as of at, or a Swedish or English one (current version; at is ignored).
export const getArticle = (id, at, lang = "fi") =>
  get(lang === "fi" ? `/api/article?id=${id}&at=${at}` : `/api/article?id=${id}&lang=${lang}`);

// The article in Finnish, Swedish and English Wikipedia: { languages: [{ lang, page_id, name, title, url, words }],
// sections: [{ section, fi_words, others: { sv|en: { words, paragraphs: [{ section, text }] } } }] }. With lang
// sv|en, id is that wiki's page id and sections is empty.
export const getTellings = (id, lang = "fi") => get(lang === "fi" ? `/api/tellings?id=${id}` : `/api/tellings?id=${id}&lang=${lang}`);

// Previews asked for within PREVIEW_WAIT ms go out as one /api/previews request: Explore asks for ~20 at once.
const PREVIEW_WAIT = 10;
const PREVIEW_BATCH = 100;
let waiting = new Map();

export function getPreview(title) {
  const url = `${BASE}/api/preview?title=${encodeURIComponent(title)}`;
  if (!answers.has(url)) {
    const answer = new Promise((resolve, reject) => {
      if (!waiting.size) setTimeout(sendPreviews, PREVIEW_WAIT);
      waiting.set(title, { resolve, reject });
    });
    answers.set(url, answer);
    answer.catch(() => answers.delete(url));
  }
  return answers.get(url);
}

function sendPreviews() {
  const batch = [...waiting];
  waiting = new Map();
  for (let i = 0; i < batch.length; i += PREVIEW_BATCH) {
    const part = batch.slice(i, i + PREVIEW_BATCH);
    fetch(`${BASE}/api/previews?titles=${encodeURIComponent(part.map(([title]) => title).join("|"))}`)
      .then((r) => {
        if (!r.ok) throw new Error(`/api/previews: ${r.status}`);
        return r.json();
      })
      .then(
        (found) => part.forEach(([title, { resolve }]) => resolve(found[title] ?? null)),
        (error) => part.forEach(([, { reject }]) => reject(error)),
      );
  }
}

// With id, only that article's neighborhood, and each node also has topic, versions and first.
export const getGraph = (at, id) => get(id == null ? `/api/graph?at=${at}` : `/api/graph?at=${at}&id=${id}`);

export const getTopics = () => get("/api/topics");

export const getHistory = (id) => get(`/api/history?id=${id}`);

export const getChange = (revId) => get(`/api/change?rev=${revId}`);

// The loaded articles whose title, then text, contains q: [{ page_id, title, snippet, match }], where match
// is q's [start, end) in snippet (code points), or null when the snippet is the article's first sentence.
// With lang sv|en, that wiki's articles (results may then carry their lang).
export const searchArticles = (q, limit = 8, lang = "fi") =>
  get(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}${lang === "fi" ? "" : `&lang=${lang}`}`);

// Not an API request: turns a [[File:...]] name from the article text into its upload.wikimedia.org
// thumbnail, 330 px wide (a standard width). Special:FilePath would cost two redirects. Mirrors
// thumbnail_url in server/app.py.
export function fileUrl(name) {
  const file = name.trim().replace(/ /g, "_").replace(/^./, (c) => c.toUpperCase());
  const digest = md5(file);
  const lower = file.toLowerCase();
  const suffix = lower.endsWith(".svg") ? ".png" : /\.tiff?$/.test(lower) ? ".jpg" : "";
  const prefix = suffix === ".jpg" ? "lossy-page1-" : "";
  const path = encodeURIComponent(file);
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${digest[0]}/${digest.slice(0, 2)}/${path}/${prefix}330px-${path}${suffix}`;
}

// When a thumbnail fails, the next place the file may be: a file uploaded to Finnish Wikipedia itself (often a
// non-free photo) is under /wikipedia/fi/, not Commons; a file renamed on Commons is found by Special:FilePath,
// which follows the rename. When nothing answers, the image is hidden rather than shown broken. Retrying in the
// capture phase keeps the img's own error handlers from seeing the failures before the last.
const THUMB = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/(commons|fi)\/thumb\/\w\/\w\w\/([^/]+)\/[^/]*?(\d+)px-/;
const FILEPATH = /^https:\/\/(commons\.wikimedia|fi\.wikipedia)\.org\/wiki\/Special:FilePath\//;
addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const thumb = img.src.match(THUMB);
    const tried = (img.dataset.tried ?? "").split(" ");
    let next = null;
    if (thumb && thumb[1] === "commons") next = img.src.replace("/wikipedia/commons/thumb/", "/wikipedia/fi/thumb/");
    else if (thumb) next = `https://commons.wikimedia.org/wiki/Special:FilePath/${thumb[2]}?width=${thumb[3]}`;
    else if (img.src.startsWith("https://commons.wikimedia.org/wiki/Special:FilePath/"))
      next = img.src.replace("https://commons.wikimedia.org/", "https://fi.wikipedia.org/");
    if (!thumb && !FILEPATH.test(img.src)) return; // not a Wikimedia image: its own handlers decide
    event.stopImmediatePropagation();
    if (next && !tried.includes(next)) {
      img.dataset.tried = [...tried, img.src].join(" ").trim();
      img.src = next;
    } else {
      img.hidden = true;
      img.closest("[class*='media']")?.classList.add("is-broken");
    }
  },
  true,
);

// The hex MD5 of a string's UTF-8 bytes (RFC 1321): Commons puts files in folders named after it.
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
  bytes.forEach((b, i) => (words[i >> 2] |= b << ((i % 4) * 8)));
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  words[words.length - 2] = bytes.length * 8;
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f = [(b & c) | (~b & d), (d & b) | (~d & c), b ^ c ^ d, c ^ (b | ~d)][round];
      const g = [i, 5 * i + 1, 3 * i + 5, 7 * i][round] % 16;
      const shift = S[round * 4 + (i % 4)];
      const sum = (a + f + K[i] + words[chunk + g]) >>> 0;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  return [a0, b0, c0, d0]
    .map((v) => [0, 8, 16, 24].map((s) => ((v >>> s) & 0xff).toString(16).padStart(2, "0")).join(""))
    .join("");
}
