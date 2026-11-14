// Real search for the landing page, using the app's API (server/app.py). Same shapes the screens
// already use from fake/api.js; if the API can't be reached, it quietly falls back to the fake.
import * as fake from "./fake/api.js";

const CLOUD = "https://65-109-75-60.sslip.io";

// Same rule as reader/api.js: pages served by app.py itself (the cloud, or locally on 8010–8019) ask
// their own server; anything else (python3 -m http.server, the 5130 dev server) asks the cloud.
const BASE = location.origin === CLOUD || /^801\d$/.test(location.port) ? "" : CLOUD;

// Where an article opens: the reader next to us when the app serves this page at /home/, else the cloud app.
const APP = location.pathname.startsWith("/home/") ? "" : CLOUD;
export const pageUrl = (a) => `${APP}/?id=${a.page_id}`;
export const isLive = () => live;
export { looksLikeQuestion, stem } from "./fake/api.js";

let live = true;
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

const search = (q, limit) => get(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);

// Lead pictures for a list of titles, in one request.
async function withPictures(rows) {
  if (!rows.length) return rows;
  const titles = rows.map((r) => r.title).join("|");
  const previews = await get(`/api/previews?titles=${encodeURIComponent(titles)}`).catch(() => ({}));
  return rows.map((r) => ({
    page_id: r.page_id,
    title: r.title,
    summary: r.snippet || previews[r.title]?.extract || "",
    thumbnail: previews[r.title]?.thumbnail ?? null,
  }));
}

// Words worth searching for on their own when the whole question matches nothing.
const STOP = new Set(("a an the of in on at to for and or is was were are be did do does how what who whom which when where why with about from by it its this that there they can could would " +
  "mikä mitä kuka ketkä miksi miten milloin missä mistä mihin oli on ovat olivat ja tai se ne että kun jos kuinka paljon").split(" "));
const keywords = (text) => [...new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/))]
  .filter((w) => w.length > 2 && !STOP.has(w))
  .sort((a, b) => b.length - a.length)
  .slice(0, 3);

// While typing: articles whose title (then text) contains what was typed.
export async function suggestPages(text) {
  try {
    const rows = await search(text.trim(), 6);
    live = true;
    return withPictures(rows);
  } catch {
    live = false;
    return fake.suggestPages(text);
  }
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

// Articles whose title is exactly one of these words (the server can say if an article exists by title).
async function exactTitles(words) {
  const titles = [...new Set(words.map(cap))];
  const found = await get(`/api/previews?titles=${encodeURIComponent(titles.join("|"))}`).catch(() => ({}));
  return titles.map((t) => found[t]).filter((p) => p?.id).map((p) => ({ page_id: p.id, title: p.title, snippet: p.extract }));
}

// On Enter: the article named exactly what was typed first, then titles containing it (shortest first —
// usually the main article), then articles whose text matches the most words of the question.
// The server returns matches alphabetically, so the ranking here is a stand-in for real relevance.
export async function searchPages(text) {
  const q = text.trim().replace(/[?!.]+$/, "");
  const terms = keywords(q);
  try {
    const [exact, whole, ...byWord] = await Promise.all([
      exactTitles([q, ...terms]), search(q, 20), ...terms.map((t) => search(t, 20)),
    ]);
    live = true;
    const lower = q.toLowerCase();
    const seen = new Set();
    const take = (r) => (seen.has(r.page_id) ? false : (seen.add(r.page_id), true));

    const exactWhole = exact.filter((r) => r.title.toLowerCase() === lower);
    const titled = whole.filter((r) => r.title.toLowerCase().includes(lower))
      .sort((a, b) => b.title.toLowerCase().startsWith(lower) - a.title.toLowerCase().startsWith(lower) || a.title.length - b.title.length);
    const pages = [...exactWhole, ...titled].filter(take).slice(0, 4);

    const score = new Map();
    const add = (r, n) => { const e = score.get(r.page_id) ?? { r, n: 0 }; e.n += n; score.set(r.page_id, e); };
    exact.forEach((r) => add(r, 3));                                  // an article named after a key word
    whole.forEach((r) => add(r, 2));                                  // matches the whole text
    byWord.forEach((list) => list.forEach((r) => add(r, 1)));          // +1 for every key word it matches
    const related = [...score.values()]
      .sort((a, b) => b.n - a.n || a.r.title.length - b.r.title.length)
      .map((e) => e.r).filter(take).slice(0, 6);

    const [p, rel] = await Promise.all([withPictures(pages), withPictures(related)]);
    return { terms: terms.length ? terms : [lower], pages: p, related: rel };
  } catch {
    live = false;
    return fake.searchPages(text);
  }
}
