// The API in server/app.py. Same functions and response shapes as fake/api.js.

const CLOUD = "https://65-109-75-60.sslip.io";

// Pages served by app.py (the cloud, or locally on 8010/8011) ask their own server; a page served any
// other way, such as python3 -m http.server, asks the cloud.
export const BASE = location.origin === CLOUD || ["8010", "8011"].includes(location.port) ? "" : CLOUD;

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

export const getArticle = (id, at) => get(`/api/article?id=${id}&at=${at}`);

export const getPreview = (title) => get(`/api/preview?title=${encodeURIComponent(title)}`);

// With id, only that article's neighborhood, and each node also has topic, versions and first.
export const getGraph = (at, id) => get(id == null ? `/api/graph?at=${at}` : `/api/graph?at=${at}&id=${id}`);

export const getTopics = () => get("/api/topics");

export const getHistory = (id) => get(`/api/history?id=${id}`);

export const getChange = (revId) => get(`/api/change?rev=${revId}`);

// The loaded articles whose title, then text, contains q: [{ page_id, title, snippet, match }], where match
// is q's [start, end) in snippet (code points), or null when the snippet is the article's first sentence.
export const searchArticles = (q) => get(`/api/search?q=${encodeURIComponent(q)}&limit=8`);

// Not an API request: turns a [[File:...]] name from the article text into an image URL.
export function fileUrl(name) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=640`;
}
