// ─────────────────────────────────────────────────────────────────────────────
// FAKE API — everything the lander pretends to know lives in this one file.
//
// The first three functions mirror app.py (port 8010) with the same response
// shapes. To go live, replace each body with the fetch shown above it.
// askWikipedia() is a canned chat reply; there is no real chat endpoint yet.
// ─────────────────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Real Simple English Wikipedia titles; edit counts and first-seen dates are plausible, not real.
const ARTICLES = [
  { page_id: 13, title: "Moon", versions: 1984, first: 1062460800 },
  { page_id: 219, title: "Earth", versions: 2611, first: 1057017600 },
  { page_id: 487, title: "Albert Einstein", versions: 2871, first: 1047427200 },
  { page_id: 512, title: "Photosynthesis", versions: 742, first: 1078099200 },
  { page_id: 618, title: "Volcano", versions: 1033, first: 1067644800 },
  { page_id: 744, title: "Finland", versions: 1517, first: 1056499200 },
  { page_id: 802, title: "Internet", versions: 1906, first: 1049155200 },
  { page_id: 911, title: "Ancient Egypt", versions: 1288, first: 1073865600 },
  { page_id: 1187, title: "Alan Turing", versions: 1342, first: 1056931200 },
  { page_id: 1304, title: "Climate change", versions: 3402, first: 1104537600 },
  { page_id: 1452, title: "Honey bee", versions: 611, first: 1111536000 },
  { page_id: 1620, title: "Mount Everest", versions: 958, first: 1092355200 },
  { page_id: 1778, title: "Music", versions: 2205, first: 1046649600 },
  { page_id: 1903, title: "Black hole", versions: 1129, first: 1084147200 },
  { page_id: 2051, title: "Chess", versions: 870, first: 1063756800 },
  { page_id: 2290, title: "Coffee", versions: 694, first: 1097539200 },
  { page_id: 2417, title: "Dinosaur", versions: 1765, first: 1058918400 },
  { page_id: 2633, title: "Leonardo da Vinci", versions: 1401, first: 1069286400 },
  { page_id: 2818, title: "Quantum computing", versions: 5047, first: 1003680653 },
  { page_id: 3006, title: "Rainbow", versions: 433, first: 1118966400 },
];

// Opening lines used for the drifting background text, written in Simple English style.
export const SNIPPETS = [
  "The Moon is Earth's only natural satellite. It is the fifth largest moon in the Solar System.",
  "Photosynthesis is how plants make food from sunlight, water and carbon dioxide.",
  "A volcano is an opening in the Earth's crust where hot melted rock comes out.",
  "Finland is a country in Northern Europe. Its capital city is Helsinki.",
  "The Internet is a large network of computers that are connected to each other.",
  "Ancient Egypt was a civilization that grew along the Nile river for over three thousand years.",
  "Alan Turing was an English mathematician who helped break codes in the Second World War.",
  "Climate change is the long change of the weather patterns of the whole Earth.",
  "The honey bee lives in large groups called colonies and makes honey from nectar.",
  "Mount Everest is the highest mountain on Earth above sea level.",
  "A black hole is a place in space where gravity pulls so much that even light cannot get out.",
  "Chess is a board game for two players. Each player starts with sixteen pieces.",
  "Coffee is a drink made from the roasted seeds of the coffee plant.",
  "Dinosaurs were a group of reptiles that lived on Earth for about 165 million years.",
  "Leonardo da Vinci was an Italian painter, scientist and inventor of the Renaissance.",
  "A rainbow is an arc of colours that appears when sunlight shines through raindrops.",
  "Albert Einstein was a German-born scientist best known for the theory of relativity.",
  "Music is a form of art that uses sound organised in time.",
];

// Word swaps the background "editors" make: [word that gets erased, word typed in its place].
export const EDITS = [
  ["large", "huge"], ["only", "single"], ["country", "nation"], ["helped", "worked"],
  ["highest", "tallest"], ["drink", "beverage"], ["painter", "artist"], ["groups", "families"],
  ["arc", "band"], ["long", "slow"], ["hot", "molten"], ["network", "web"],
  ["scientist", "physicist"], ["form", "kind"], ["opening", "vent"], ["pulls", "drags"],
  ["fifth", "5th"], ["three", "3"], ["sixteen", "16"], ["shines", "passes"],
];

// fetch("/api/articles").then((r) => r.json())
export async function getArticles() {
  await delay(80);
  return ARTICLES;
}

// fetch(`/api/article?id=${id}&at=${at}`).then((r) => r.json())
export async function getArticle(id, at) {
  await delay(80);
  const a = ARTICLES.find((x) => x.page_id === id);
  const stamp = new Date(at * 1000).toISOString().slice(0, 19).replace("T", " ");
  const sql = `SELECT title, rev_id, user, comment, row_start, text\nFROM article FOR SYSTEM_TIME AS OF TIMESTAMP '${stamp}'\nWHERE page_id = ${id}`;
  if (!a || at < a.first) return { sql, version: null };
  const i = ARTICLES.indexOf(a);
  return {
    sql,
    version: {
      title: a.title,
      rev_id: 9000000 + id * 37,
      user: ["Auntof6", "Macdonald-ross", "Eptalon", "Chenzw", "Griffinofwales"][i % 5],
      comment: "copyedit",
      row_start: stamp,
      text: SNIPPETS[i % SNIPPETS.length],
    },
  };
}

// fetch(`/api/graph?at=${at}`).then((r) => r.json())
export async function getGraph(at) {
  await delay(80);
  const nodes = ARTICLES.filter((a) => a.first <= at).map((a) => ({ id: a.page_id, title: a.title, chars: 1800 + a.versions * 3 }));
  const edges = [];
  nodes.forEach((n, i) => nodes.forEach((m, j) => { if (i !== j && (i * 7 + j * 3) % 5 === 0) edges.push({ source: n.id, target: m.id }); }));
  return { sql: [], nodes, edges };
}

// ── Fake chat ───────────────────────────────────────────────────────────────

const ANSWERS = [
  {
    match: /moon/i,
    text: "The Moon article was started in September 2003 as two short sentences. It has been saved 1,984 times since. It grew fastest in 2009, around the 40th anniversary of the first Moon landing, when it gained sections on tides and on the Apollo missions.",
    sources: [13, 219],
  },
  {
    match: /finland|suomi/i,
    text: "Finland first appeared in June 2003. The early version only named the capital and the language. Over 1,517 saves, it gained history, saunas and the 1952 Olympics. The biggest single edit came in 2017, for Finland's 100th year of independence.",
    sources: [744],
  },
  {
    match: /climate/i,
    text: "Climate change is one of the most-edited pages here, with 3,402 saves since 2005. Edits come in waves that match big news: the 2007 IPCC report, Paris in 2015 and the 2019 school strikes. In 2019 alone the article was protected twice to stop edit wars.",
    sources: [1304, 219],
  },
];

const FALLBACK = {
  text: "Good question. Across 642 articles and 23 years of edits, I can show you any page as it looked on any day, who changed it, and which pages linked to it at the time. Try asking about the Moon, Finland or climate change.",
  sources: [13, 744, 1304],
};

// Streams a canned answer word by word. Swap for a real chat endpoint later.
export async function* askWikipedia(question, lang = "en") {
  const hit = ANSWERS.find((a) => a.match.test(question)) ?? FALLBACK;
  await delay(650);
  for (const word of hit.text.split(/(\s+)/)) {
    await delay(word.trim() ? 28 + Math.random() * 40 : 0);
    yield { token: word };
  }
  yield { sources: hit.sources.map((id) => ARTICLES.find((a) => a.page_id === id)) };
}
