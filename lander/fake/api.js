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
  { page_id: 3120, title: "Moon landing", versions: 812, first: 1086048000 },
  { page_id: 3141, title: "Apollo 11", versions: 1176, first: 1078531200 },
  { page_id: 3307, title: "Mars", versions: 1652, first: 1059696000 },
  { page_id: 3415, title: "Sun", versions: 1890, first: 1055203200 },
  { page_id: 3522, title: "Helsinki", versions: 905, first: 1066003200 },
  { page_id: 3610, title: "Sauna", versions: 288, first: 1129852800 },
  { page_id: 3788, title: "Enigma machine", versions: 517, first: 1102204800 },
  { page_id: 3801, title: "World War II", versions: 4120, first: 1048204800 },
  { page_id: 3956, title: "Computer", versions: 2338, first: 1046822400 },
  { page_id: 4102, title: "Honey", versions: 402, first: 1114041600 },
  { page_id: 4233, title: "Tide", versions: 367, first: 1121644800 },
  { page_id: 4318, title: "Gravity", versions: 1210, first: 1068076800 },
  { page_id: 4470, title: "Mona Lisa", versions: 655, first: 1095811200 },
  { page_id: 4529, title: "Renaissance", versions: 984, first: 1081296000 },
  { page_id: 4688, title: "Tyrannosaurus", versions: 742, first: 1099353600 },
  { page_id: 4790, title: "Olympic Games", versions: 1533, first: 1071100800 },
];

// First lines of each page. A real version would search the article text in MariaDB.
const SUMMARY = {
  13: "The Moon is Earth's only natural satellite. It causes the tides and was first visited by people in 1969.",
  219: "Earth is the third planet from the Sun and the only planet known to have life.",
  487: "Albert Einstein was a German-born scientist best known for the theory of relativity and the equation E = mc².",
  512: "Photosynthesis is how plants make food from sunlight, water and carbon dioxide, giving off oxygen.",
  618: "A volcano is an opening in the Earth's crust where hot melted rock, called lava, comes out.",
  744: "Finland is a country in Northern Europe. Its capital city is Helsinki and the sauna is part of its culture.",
  802: "The Internet is a large network of computers that are connected to each other around the world.",
  911: "Ancient Egypt was a civilization along the Nile river, famous for its pyramids and pharaohs.",
  1187: "Alan Turing was an English mathematician who helped break German codes in the Second World War and imagined the first computers.",
  1304: "Climate change is the long change of the weather patterns of the whole Earth, mostly caused by burning fossil fuels.",
  1452: "The honey bee lives in large groups called colonies and makes honey from the nectar of flowers.",
  1620: "Mount Everest is the highest mountain on Earth above sea level, on the border of Nepal and China.",
  1778: "Music is a form of art that uses sound organised in time, with rhythm, melody and harmony.",
  1903: "A black hole is a place in space where gravity pulls so much that even light cannot get out.",
  2051: "Chess is a board game for two players. Each player starts with sixteen pieces and tries to checkmate the king.",
  2290: "Coffee is a drink made from the roasted seeds of the coffee plant. It first came from Ethiopia.",
  2417: "Dinosaurs were a group of reptiles that lived on Earth for about 165 million years before they died out.",
  2633: "Leonardo da Vinci was an Italian painter, scientist and inventor of the Renaissance who painted the Mona Lisa.",
  2818: "Quantum computing uses qubits, which can be zero and one at the same time, to solve some problems much faster.",
  3006: "A rainbow is an arc of colours that appears when sunlight shines through raindrops.",
  3120: "A Moon landing is when a spacecraft arrives on the surface of the Moon. People first walked there in 1969.",
  3141: "Apollo 11 was the spaceflight that first landed people on the Moon, in July 1969. Neil Armstrong walked first.",
  3307: "Mars is the fourth planet from the Sun. It is called the Red Planet because of the iron rust on its surface.",
  3415: "The Sun is the star at the centre of the Solar System. It gives Earth light and heat.",
  3522: "Helsinki is the capital and largest city of Finland, on the coast of the Baltic Sea.",
  3610: "A sauna is a small hot room for sweating and bathing. Saunas come from Finland and are thousands of years old.",
  3788: "The Enigma machine was used by Germany to send secret codes in the Second World War. Alan Turing helped break it.",
  3801: "World War II, or the Second World War, was a war from 1939 to 1945 that involved most of the world's countries.",
  3956: "A computer is a machine that follows instructions, called programs, to work with information.",
  4102: "Honey is a sweet food made by bees from the nectar of flowers. People have eaten it for thousands of years.",
  4233: "Tides are the rise and fall of the sea. They are caused mostly by the gravity of the Moon.",
  4318: "Gravity is the force that pulls things toward each other. It keeps the Moon going around Earth.",
  4470: "The Mona Lisa is a painting by Leonardo da Vinci. It hangs in the Louvre in Paris.",
  4529: "The Renaissance was a time in Europe, from about 1400 to 1600, when art and science grew quickly.",
  4688: "Tyrannosaurus was a large meat-eating dinosaur that walked on two legs and had very small arms.",
  4790: "The Olympic Games are a sports event held every four years, where athletes from many countries compete.",
};

// Lead image of each page, straight from Wikimedia Commons (same shape as the reader's previews).
const THUMBS = {
  13: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e1/FullMoon2010.jpg/330px-FullMoon2010.jpg", width: 330, height: 314 },
  219: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2d/Meteosat-12-fci-march-equinox-2025-noon.jpg/330px-Meteosat-12-fci-march-equinox-2025-noon.jpg", width: 330, height: 330 },
  487: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/28/Albert_Einstein_Head_cleaned.jpg/330px-Albert_Einstein_Head_cleaned.jpg", width: 330, height: 408 },
  512: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/55/Photosynthesis_en.svg/330px-Photosynthesis_en.svg.png", width: 330, height: 330 },
  618: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/48/Augustine_volcano_Jan_24_2006_-_Cyrus_Read.jpg/330px-Augustine_volcano_Jan_24_2006_-_Cyrus_Read.jpg", width: 330, height: 248 },
  744: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bc/Flag_of_Finland.svg/330px-Flag_of_Finland.svg.png", width: 330, height: 202 },
  802: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3f/Internet_map_1024_-_transparent%2C_inverted.png/330px-Internet_map_1024_-_transparent%2C_inverted.png", width: 330, height: 330 },
  911: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/17/Ancient_Egypt_map-en.svg/330px-Ancient_Egypt_map-en.svg.png", width: 330, height: 674 },
  1187: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Alan_turing_header.jpg/330px-Alan_turing_header.jpg", width: 330, height: 440 },
  1304: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e0/Change_in_Average_Temperature_With_Fahrenheit.svg/330px-Change_in_Average_Temperature_With_Fahrenheit.svg.png", width: 330, height: 297 },
  1452: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/The_Lone_Pollinator.jpg/330px-The_Lone_Pollinator.jpg", width: 330, height: 220 },
  1620: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/15/Mt._Everest_from_Gokyo_Ri_November_5%2C_2012.jpg/330px-Mt._Everest_from_Gokyo_Ri_November_5%2C_2012.jpg", width: 330, height: 220 },
  1778: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7b/The_Sounds_of_Earth_-_GPN-2000-001976.jpg/330px-The_Sounds_of_Earth_-_GPN-2000-001976.jpg", width: 330, height: 330 },
  1903: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4f/Black_hole_-_Messier_87_crop_max_res.jpg/330px-Black_hole_-_Messier_87_crop_max_res.jpg", width: 330, height: 330 },
  2051: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6f/ChessSet.jpg/330px-ChessSet.jpg", width: 330, height: 304 },
  2290: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e4/Latte_and_dark_coffee.jpg/330px-Latte_and_dark_coffee.jpg", width: 330, height: 206 },
  2417: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/00/Hul_-_Mantellisaurus_atherfieldensis_-_2.jpg/330px-Hul_-_Mantellisaurus_atherfieldensis_-_2.jpg", width: 330, height: 220 },
  2633: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/Francesco_Melzi_-_Portrait_of_Leonardo_%28colour_correction%29.png/330px-Francesco_Melzi_-_Portrait_of_Leonardo_%28colour_correction%29.png", width: 330, height: 473 },
  2818: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b9/IBM_Quantum_Computer_Demo_at_ITUWTSA_2024%2C_Delhi_2.jpg/330px-IBM_Quantum_Computer_Demo_at_ITUWTSA_2024%2C_Delhi_2.jpg", width: 330, height: 440 },
  3006: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5c/Double-alaskan-rainbow.jpg/330px-Double-alaskan-rainbow.jpg", width: 330, height: 173 },
  3120: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b3/Moon_Soft_Landings.svg/330px-Moon_Soft_Landings.svg.png", width: 330, height: 330 },
  3141: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/41/A_Man_on_the_Moon%2C_AS11-40-5903_%28cropped%29.jpg/330px-A_Man_on_the_Moon%2C_AS11-40-5903_%28cropped%29.jpg", width: 330, height: 334 },
  3307: null,
  3415: null,
  3522: null,
  3610: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/50/Sauna_2.jpg/330px-Sauna_2.jpg", width: 330, height: 494 },
  3788: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bd/Enigma_%28crittografia%29_-_Museo_scienza_e_tecnologia_Milano.jpg/330px-Enigma_%28crittografia%29_-_Museo_scienza_e_tecnologia_Milano.jpg", width: 330, height: 360 },
  3801: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/10/Bundesarchiv_Bild_101I-646-5188-17%2C_Flugzeuge_Junkers_Ju_87.jpg/330px-Bundesarchiv_Bild_101I-646-5188-17%2C_Flugzeuge_Junkers_Ju_87.jpg", width: 330, height: 225 },
  3956: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0c/ENIAC-changing_a_tube_%28cropped%29.jpg/330px-ENIAC-changing_a_tube_%28cropped%29.jpg", width: 330, height: 257 },
  4102: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cc/Runny_hunny.jpg/330px-Runny_hunny.jpg", width: 330, height: 501 },
  4233: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/eb/Tide_overview.svg/330px-Tide_overview.svg.png", width: 330, height: 272 },
  4318: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/14/UGC_1810_and_UGC_1813_in_Arp_273_%28captured_by_the_Hubble_Space_Telescope%29.jpg/330px-UGC_1810_and_UGC_1813_in_Arp_273_%28captured_by_the_Hubble_Space_Telescope%29.jpg", width: 330, height: 334 },
  4470: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/330px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg", width: 330, height: 492 },
  4529: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/22/Da_Vinci_Vitruve_Luc_Viatour.jpg/330px-Da_Vinci_Vitruve_Luc_Viatour.jpg", width: 330, height: 449 },
  4688: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/94/Tyrannosaurus_Rex_Holotype.jpg/330px-Tyrannosaurus_Rex_Holotype.jpg", width: 330, height: 219 },
  4790: { url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5c/Olympic_rings_without_rims.svg/330px-Olympic_rings_without_rims.svg.png", width: 330, height: 152 },
};

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
      text: SUMMARY[id],
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

// ── Fake search ─────────────────────────────────────────────────────────────
// Not in app.py yet. Two kinds:
//   suggestPages(text)  → quick title matches while typing (could be a LIKE on page titles)
//   searchPages(text)   → title matches + pages whose text answers a question (full-text search)

// Where a page opens. The combined app can point this at the reader.
export const pageUrl = (a) => `#/page/${a.page_id}`;

const STOP = new Set("a an the of in on at to for and or is was were are be been did do does how what who whom which when where why with about from by it its this that there their they i me my you your can could would should much many most first ever".split(" "));
const words = (text) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
export const stem = (w) => w.replace(/(ies|es|s|ing|ed)$/, "").slice(0, 6);
export const looksLikeQuestion = (text) => /\?\s*$/.test(text) || /^(what|who|why|how|when|where|which|did|does|is|are|can)\b/i.test(text.trim());

function titleScore(title, q) {
  const t = title.toLowerCase();
  if (!q) return -1;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (q.length > 2 && t.includes(q)) return 3;
  return -1;
}

export async function suggestPages(text) {
  await delay(40);
  const q = text.trim().toLowerCase();
  return ARTICLES.map((a) => ({ a, s: titleScore(a.title, q) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => x.s - y.s || y.a.versions - x.a.versions)
    .slice(0, 6)
    .map((x) => ({ ...x.a, summary: SUMMARY[x.a.page_id], thumbnail: THUMBS[x.a.page_id] ?? null }));
}

export async function searchPages(text) {
  await delay(260);
  const q = text.trim().toLowerCase().replace(/[?!.]+$/, "");
  const terms = [...new Set(words(q).filter((w) => !STOP.has(w) && w.length > 1))];
  const stems = terms.map(stem);

  // 1. pages whose title matches the whole text or one of its words
  const byTitle = ARTICLES.map((a) => {
    let s = titleScore(a.title, q);
    if (s < 0 && terms.some((t) => words(a.title).some((w) => stem(w) === stem(t)))) s = 4;
    return { a, s };
  }).filter((x) => x.s >= 0).sort((x, y) => x.s - y.s || y.a.versions - x.a.versions);

  // 2. pages whose text shares the most words with the question
  const shown = new Set(byTitle.map((x) => x.a.page_id));
  const byText = ARTICLES.filter((a) => !shown.has(a.page_id)).map((a) => {
    const ws = words(SUMMARY[a.page_id]).map(stem);
    const hits = stems.filter((st) => ws.includes(st)).length;
    return { a, s: hits / Math.max(stems.length, 1) };
  }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s || y.a.versions - x.a.versions);

  const pack = (x) => ({ ...x.a, summary: SUMMARY[x.a.page_id], thumbnail: THUMBS[x.a.page_id] ?? null });
  return { terms, pages: byTitle.slice(0, 4).map(pack), related: byText.slice(0, 5).map(pack) };
}
