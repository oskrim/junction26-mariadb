// The API in server/app.py. Same functions and response shapes as fake/api.js.

const get = (path) =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });

export const getArticles = () => get("/api/articles");

export const getArticle = (id, at) => get(`/api/article?id=${id}&at=${at}`);

export const getPreview = (title) => get(`/api/preview?title=${encodeURIComponent(title)}`);

export const getGraph = (at) => get(`/api/graph?at=${at}`);

export const getTopics = () => get("/api/topics");

export const getHistory = (id) => get(`/api/history?id=${id}`);

export const getChange = (revId) => get(`/api/change?rev=${revId}`);

// Not an API request: turns a [[File:...]] name from the article text into an image URL.
export function fileUrl(name) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=640`;
}
