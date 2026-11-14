import { buildFakeGraph, graphAt } from "./graph.js";

// FAKE API. Stands in for app.py (port 8010) with the same requests and response shapes.
// To go live, replace each function body with the fetch shown above it; the screens stay unchanged.

const ARTICLES = [
  { page_id: 1187, title: "Alan Turing", versions: 1342, first: 1056931200 },
  { page_id: 2214, title: "Albert Einstein", versions: 2871, first: 1047427200 },
  { page_id: 3905, title: "Atom", versions: 1108, first: 1049673600 },
  { page_id: 4011, title: "Quantum computing", versions: 1906, first: 1033689600 },
  { page_id: 4012, title: "Qubit", versions: 388, first: 1104537600 },
  { page_id: 4377, title: "Quantum mechanics", versions: 2240, first: 1041379200 },
  { page_id: 5120, title: "Richard Feynman", versions: 964, first: 1070236800 },
  { page_id: 6034, title: "Superconductivity", versions: 517, first: 1093996800 },
];

const TEXTS = {
  4011: {
    file: "./fake/quantum-computing.wiki",
    rev_id: 9184412,
    user: "Quantumavenger",
    comment: "/* State of affairs: 2020s */ copyedit, update error-correction milestones",
    row_start: "2026-11-03 14:22:09.512000",
  },
};

// Local copies of the images the article uses; anything else comes straight from Wikimedia Commons.
const LOCAL_FILES = {
  "IBM Quantum Computer Demo at ITUWTSA 2024, Delhi 2.jpg": "ibm-quantum-computer-demo-at-ituwtsa-2024-delhi-2.jpg",
  "Bloch sphere.svg": "bloch-sphere.png",
  "Peter Shor 2017 Dirac Medal Award Ceremony.png": "peter-shor-2017-dirac-medal-award-ceremony.png",
  "Quantum Toffoli Gate Implementation.svg": "quantum-toffoli-gate-implementation.png",
  "A Wafer of the Latest D-Wave Quantum Computers (39188583425).jpg":
    "a-wafer-of-the-latest-d-wave-quantum-computers-39188583425.jpg",
  "IBM Q system (Fraunhofer 2).jpg": "ibm-q-system-fraunhofer-2.jpg",
  "BQP complexity class diagram.svg": "bqp-complexity-class-diagram.png",
};

// Opening lines and lead image of each article this page links to, keyed by link target.
const PREVIEWS = await fetch(new URL("./previews.json", import.meta.url)).then((r) => r.json());

// Looked up by the link text as written, or by the article's own title.
const PREVIEWS_BY_TITLE = Object.fromEntries(
  Object.values(PREVIEWS).filter(Boolean).map((p) => [p.title, p]),
);

// Every article on the map, with when its links were added. Built from the lists above.
const GRAPH = buildFakeGraph(ARTICLES, PREVIEWS, 4011);
const ALL_ARTICLES = GRAPH.articles.map(({ page_id, title, versions, first }) => ({ page_id, title, versions, first }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch("/api/articles").then((r) => r.json())
export async function getArticles() {
  await delay(120);
  return ALL_ARTICLES;
}

// fetch(`/api/article?id=${id}&at=${at}`).then((r) => r.json())
export async function getArticle(id, at) {
  await delay(260);
  const meta = TEXTS[id];
  const article = ARTICLES.find((a) => a.page_id === id);
  const stamp = new Date(at * 1000).toISOString().slice(0, 19).replace("T", " ");
  const sql = `SELECT title, rev_id, user, comment, row_start, text\nFROM article FOR SYSTEM_TIME AS OF TIMESTAMP '${stamp}'\nWHERE page_id = ${id}`;
  if (!meta || !article || at < article.first) return { sql, version: null };
  const text = await fetch(meta.file).then((r) => r.text());
  return {
    sql,
    version: {
      title: article.title,
      rev_id: meta.rev_id,
      user: meta.user,
      comment: meta.comment,
      row_start: meta.row_start,
      text,
    },
  };
}

// Not in app.py yet. A real version could look the title up in /api/articles, then take the
// first paragraph of /api/article. Returns { title, extract, thumbnail: { url, width, height } | null } or null.
export async function getPreview(title) {
  await delay(60);
  return PREVIEWS[title] ?? PREVIEWS_BY_TITLE[title] ?? null;
}

// fetch(`/api/graph?at=${at}`).then((r) => r.json())
export async function getGraph(at) {
  await delay(180);
  return graphAt(GRAPH, at);
}

// Not in app.py yet. Groups articles into broad topics for the map's labels. A real version could
// cluster the link graph, or ask a model to name the clusters. Returns { [page_id]: topic name }.
export async function getTopics() {
  await delay(40);
  return Object.fromEntries(GRAPH.articles.map((a) => [a.page_id, a.topic]));
}

// Not an API request: turns a [[File:...]] name from the article text into an image URL.
export function fileUrl(name) {
  const local = LOCAL_FILES[name];
  if (local) return `./files/${local}`;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=640`;
}
