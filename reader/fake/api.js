import { buildFakeGraph, graphAt } from "./graph.js";

// FAKE API. Stands in for app.py (port 8010) with the same requests and response shapes.
// To go live, replace each function body with the fetch shown above it; the screens stay unchanged.

const ARTICLES = [
  { page_id: 1187, title: "Alan Turing", versions: 1342, first: 1056931200 },
  { page_id: 2214, title: "Albert Einstein", versions: 2871, first: 1047427200 },
  { page_id: 3905, title: "Atom", versions: 1108, first: 1049673600 },
  { page_id: 4011, title: "Quantum computing", versions: 5047, first: 1003680653 },
  { page_id: 4012, title: "Qubit", versions: 388, first: 1104537600 },
  { page_id: 4377, title: "Quantum mechanics", versions: 2240, first: 1041379200 },
  { page_id: 5120, title: "Richard Feynman", versions: 964, first: 1070236800 },
  { page_id: 6034, title: "Superconductivity", versions: 517, first: 1093996800 },
];

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

// Which files hold each article's history. Only Quantum computing has one in the prototype.
const ARTICLE_FILES = { 4011: { history: "./history.json", versions: "./versions/", wars: "./wars/" } };

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
// The real API returns the exact version at that moment. The prototype stores the text of about 400 of the
// 5,047 versions (each card's edit and every edit inside a war), so it returns the latest stored one.
export async function getArticle(id, at) {
  await delay(120);
  const article = ARTICLES.find((a) => a.page_id === id);
  const stamp = new Date(at * 1000).toISOString().slice(0, 19).replace("T", " ");
  const sql = `SELECT title, rev_id, user, comment, row_start, text\nFROM article FOR SYSTEM_TIME AS OF TIMESTAMP '${stamp}'\nWHERE page_id = ${id}`;
  const files = ARTICLE_FILES[id];
  if (!article || !files) return { sql, version: null };
  const [rows, texts] = await Promise.all([historyRows(files), storedTexts(files)]);
  const atMs = at * 1000;
  const row = rows.findLast((r) => texts.has(r.rev_id) && Date.parse(`${r.row_start.slice(0, 19).replace(" ", "T")}Z`) <= atMs);
  if (!row) return { sql, version: null };
  const { rev_id, user, comment, row_start } = row;
  return { sql, version: { title: article.title, rev_id, user, comment, row_start, text: await texts.get(rev_id)() } };
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

// Not in app.py yet. Every saved version of an article, oldest first, without the text:
// SELECT rev_id, user, comment, row_start, CHAR_LENGTH(text) AS chars, sha1
// FROM article FOR SYSTEM_TIME ALL WHERE page_id = %s ORDER BY row_start
export async function getHistory(id) {
  await delay(200);
  const files = ARTICLE_FILES[id];
  return files ? historyRows(files) : [];
}

let changes = null;

// Not in app.py yet. The text one edit added and removed, as { added: string[], removed: string[] } of wiki markup.
// A real version can diff /api/article at the edit's row_start against the second before it.
export async function getChange(revId) {
  changes ??= fetch(new URL("./changes.json", import.meta.url)).then((r) => r.json());
  return (await changes)[revId] ?? null;
}

// Not an API request: turns a [[File:...]] name from the article text into an image URL.
export function fileUrl(name) {
  const local = LOCAL_FILES[name];
  if (local) return `./files/${local}`;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=640`;
}

const cache = new Map();
const once = (key, load) => {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key);
};
const json = (path) => fetch(new URL(path, import.meta.url)).then((r) => r.json());
const gunzip = async (path) =>
  new Response((await fetch(new URL(path, import.meta.url))).body.pipeThrough(new DecompressionStream("gzip"))).text();

const historyRows = (files) => once(files.history, () => json(files.history));

// Maps rev_id to a loader for that version's text, from single files and from war packs.
function storedTexts(files) {
  return once(`texts:${files.versions}`, async () => {
    const [versions, wars] = await Promise.all([json(`${files.versions}index.json`), json(`${files.wars}index.json`)]);
    const texts = new Map(versions.map((rev) => [rev, () => once(`v:${rev}`, () => gunzip(`${files.versions}${rev}.wiki.gz`))]));
    for (const war of wars) {
      const pack = () => once(`w:${war.id}`, async () => unpack(JSON.parse(await gunzip(`${files.wars}${war.id}.json.gz`))));
      war.revs.forEach((rev, i) => texts.set(rev, async () => (await pack())[i]));
    }
    return texts;
  });
}

// A war pack holds its first version in full and each later one as line patches against the one before.
function unpack({ base, patches }) {
  const versions = [base];
  let lines = base.split("\n");
  for (const ops of patches) {
    lines = [...lines];
    for (const [from, to, replacement] of [...ops].reverse()) lines.splice(from, to - from, ...replacement);
    versions.push(lines.join("\n"));
  }
  return versions;
}
