// The API in server/app.py. Same functions and response shapes as fake/api.js.

const CLOUD = "https://65-109-75-60.sslip.io";

// Pages served by app.py (the cloud, or locally on 8010/8011) ask their own server; a page served any
// other way, such as python3 -m http.server, asks the cloud.
const BASE = location.origin === CLOUD || ["8010", "8011"].includes(location.port) ? "" : CLOUD;

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

export const getArticles = () => get("/api/articles");

export const getArticle = (id, at) => get(`/api/article?id=${id}&at=${at}`);

export const getPreview = (title) => get(`/api/preview?title=${encodeURIComponent(title)}`);

export const getGraph = (at) => get(`/api/graph?at=${at}`);

export const getTopics = () => get("/api/topics");

export const getHistory = (id) => get(`/api/history?id=${id}`);

export const getChange = (revId) => get(`/api/change?rev=${revId}`);

// The loaded articles whose title, then text, contains q: [{ page_id, title, snippet }].
export const searchArticles = (q) => get(`/api/search?q=${encodeURIComponent(q)}&limit=8`);

// Not an API request: turns a [[File:...]] name from the article text into an image URL.
export function fileUrl(name) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=640`;
}
