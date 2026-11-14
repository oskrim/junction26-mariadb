// FAKE LINK GRAPH. Builds a believable link graph for the fake API in api.js: every article the
// Quantum computing page links to, a few dozen more, and links between them that appear over time.
// Nothing here is used by the screens directly; they only see getGraph() and getTopics() in api.js.

// Topics group related articles on the map. Real data has no topics yet; see getTopics() in api.js.
const TOPIC_RULES = [
  [
    "People",
    /^(paul benioff|yuri manin|richard feynman|charles h\. bennett|gilles brassard|peter shor|seth lloyd|david p\. divincenzo|john preskill|bill unruh|paul davies|gil kalai|mikhail dyakonov|tanja lange|alan turing|albert einstein|physicists|programmer|niels bohr|max planck|erwin schrödinger|werner heisenberg|john von neumann|ada lovelace|claude shannon|marie curie)/,
  ],
  [
    "Organizations",
    /^(ibm$|international telecommunication|world telecommunication|delhi|harvard|massachusetts institute|quera|california institute|princeton|darpa|nasa|google|chinese academy|university of science|national institute|ieee|the new york times|nature|springer|new scientist|sibos|reviews of modern|summit|microsoft|intel|cern|united states|china|european union|symposium)/,
  ],
  [
    "AI & applications",
    /machine learning|artificial intelligence|deepmind|language model|neural|boltzmann|adversarial|drug discovery|evolutionary|alphaevolve|chemistry|ammonia|haber|nitrogen fixation|biology|molecular|combinatorial|collider|simulat|random number|sensing|hhl|medicine|weather|climate/,
  ],
  [
    "Cryptography & networks",
    /crypt|rsa|diffie|password|lattice|mceliece|coding theory|alice and bob|information security|symmetric|asymmetric|superdense|teleportation|network|fiber|holevo|key distribution|internet|encryption|cipher|email/,
  ],
  [
    "Algorithms & complexity",
    /algorithm|complexity|bqp|bpp|\(complexity\)|np-|polynomial time|exponential time|turing|halting|computab|undecidable|church|oracle|black box|problem|factorization|logarithm|fourier|pell|subgroup|satisfiability|amplitude amplification|jones polynomial|model of computation|program|computer science|unstructured|software|operating system|information/,
  ],
  [
    "Mathematics",
    /matrix|vector|linear|tensor|complex number|probability|norm-|basis|dimension|group|bra–ket|psi|function composition|prime number|ising|mathematic|number|algebra|geometry|calculus|statistics/,
  ],
  [
    "Hardware",
    /superconduct|trapped ion|qubit|wafer|dilution|helium|kelvin|sycamore|ibm q|jiuzhang|nitrogen-vacancy|register|semiconductor|gate|circuit|annealing|adiabatic quantum|topological|one-way|measurement-based|cluster state|nisq|threshold|error correction|parity|pulse|cosmic|ionizing|rare-earth|europium|cobalt|aluminium|electrical|magnetic resonance|mri|optical|boson|transistor|silicon|computer|memory|chip|laser|engineering|electronics/,
  ],
  ["Physics", /./],
];

// Articles the Quantum computing page doesn't link to, so the wider map has somewhere to go.
// Grouped by topic; together with the linked ones this comes close to the 642 articles in the real data.
const EXTRA_TITLES = {
  Physics: [
    "Physics", "Energy", "Light", "Photon", "Electron", "Proton", "Neutron", "Electricity", "Magnetism",
    "Temperature", "Absolute zero", "Entropy", "Thermodynamics", "Theory of relativity", "Speed of light",
    "Uncertainty principle", "Schrödinger's cat", "Double-slit experiment", "Photoelectric effect",
    "Spin (physics)", "Particle physics", "Standard Model", "Higgs boson", "Gravity", "Mass", "Force",
    "Momentum", "Wave", "Frequency", "Wavelength", "Electromagnetic radiation", "X-ray", "Radioactive decay",
    "Nuclear fission", "Nuclear fusion", "Black hole", "Big Bang", "Dark matter", "Quark", "Gluon",
    "Neutrino", "Antimatter", "Plasma (physics)", "Magnetic field", "Electric charge", "Voltage",
    "String theory", "Quantum field theory", "Pauli exclusion principle", "Planck constant",
    "Heat", "Pressure", "Kinetic energy", "Potential energy", "Optics", "Lens", "Prism", "Rainbow",
  ],
  Hardware: [
    "Transistor", "Microchip", "Silicon", "Laser", "Electronics", "Computer memory", "Supercomputer",
    "Central processing unit", "Graphics processing unit", "Hard disk drive", "Solid-state drive",
    "Random-access memory", "Motherboard", "Integrated circuit", "Moore's law", "Vacuum tube",
    "ENIAC", "Personal computer", "Laptop", "Smartphone", "Computer keyboard", "Computer monitor",
    "Diode", "Capacitor", "Resistor", "Liquid nitrogen", "Cryogenics", "Photonics", "Optical fiber",
  ],
  "Algorithms & complexity": [
    "Software", "Operating system", "Programming language", "Algorithm", "Sorting algorithm",
    "Binary search", "Data structure", "Python (programming language)", "C (programming language)",
    "Java (programming language)", "Compiler", "Source code", "Recursion", "Graph theory",
    "Dijkstra's algorithm", "Travelling salesman problem", "P versus NP problem", "Big O notation",
    "Information theory", "Boolean algebra", "Linux", "Microsoft Windows", "Open-source software",
    "Database", "SQL", "Search engine", "Bug (computing)", "Computer program", "Computer virus",
  ],
  Mathematics: [
    "Mathematics", "Algebra", "Geometry", "Calculus", "Statistics", "Number theory", "Prime factor",
    "Euclid", "Pythagorean theorem", "Pi", "Euler's number", "Imaginary number", "Trigonometry",
    "Set theory", "Logic", "Graph (mathematics)", "Infinity", "Fraction", "Equation", "Exponentiation",
    "Logarithm", "Derivative (mathematics)", "Integral", "Topology", "Knot theory", "Fibonacci number",
    "Golden ratio", "Mathematical proof", "Probability distribution", "Random walk",
  ],
  "Cryptography & networks": [
    "Internet", "Email", "Encryption", "Password", "World Wide Web", "Computer network", "Wi-Fi",
    "Bluetooth", "Router (computing)", "Bitcoin", "Blockchain", "Enigma machine", "Caesar cipher",
    "Hash function", "Digital signature", "HTTPS", "Computer security", "Hacker", "Firewall (computing)",
    "Telephone", "Radio", "Satellite", "Morse code", "Telegraph",
  ],
  "AI & applications": [
    "Medicine", "Weather forecasting", "Climate change", "Robot", "Self-driving car", "ChatGPT",
    "Computer vision", "Speech recognition", "Protein folding", "AlphaFold", "Genetics", "DNA",
    "Battery (electricity)", "Solar cell", "Materials science", "Finance", "Stock market", "Logistics",
    "Video game", "Chess", "Go (game)", "Deep Blue (chess computer)", "AlphaGo", "Neural network",
  ],
  People: [
    "Niels Bohr", "Max Planck", "Erwin Schrödinger", "Werner Heisenberg", "John von Neumann",
    "Ada Lovelace", "Claude Shannon", "Marie Curie", "Isaac Newton", "Galileo Galilei", "Paul Dirac",
    "Wolfgang Pauli", "Enrico Fermi", "Stephen Hawking", "Charles Babbage", "Grace Hopper",
    "Tim Berners-Lee", "Bill Gates", "Steve Jobs", "Linus Torvalds", "Donald Knuth", "Edsger W. Dijkstra",
    "Kurt Gödel", "David Hilbert", "Carl Friedrich Gauss", "Leonhard Euler", "Emmy Noether",
    "Lise Meitner", "J. Robert Oppenheimer", "Murray Gell-Mann", "Michael Faraday", "James Clerk Maxwell",
    "Nikola Tesla", "Thomas Edison", "Geoffrey Hinton", "Demis Hassabis", "Lov Grover", "David Deutsch",
  ],
  Organizations: [
    "Microsoft", "Intel", "CERN", "United States", "China", "European Union", "Apple Inc.", "Amazon (company)",
    "Meta Platforms", "Nvidia", "Stanford University", "University of Oxford", "University of Cambridge",
    "Bell Labs", "Los Alamos National Laboratory", "Nobel Prize", "Nobel Prize in Physics", "Turing Award",
    "Japan", "Germany", "United Kingdom", "Canada", "Netherlands", "Finland", "Switzerland", "Australia",
    "Silicon Valley", "IonQ", "Rigetti Computing", "D-Wave Systems", "Alibaba Group", "Baidu",
    "National Science Foundation", "European Space Agency",
  ],
};

const DAY = 86400;
const YEAR = 365.25 * DAY;
const NOW = Date.UTC(2026, 10, 14) / 1000;

export function buildFakeGraph(baseArticles, previews, centerId) {
  const rand = seeded("simple-wiki");
  const byKey = new Map();
  const articles = [];

  const add = (title, extra = {}) => {
    const key = keyOf(title);
    if (byKey.has(key)) return byKey.get(key);
    const article = { title: capitalize(title), ...extra };
    byKey.set(key, article);
    articles.push(article);
    return article;
  };

  for (const a of baseArticles) add(a.title, { ...a });
  const center = articles.find((a) => a.page_id === centerId);
  const linkedFromCenter = Object.entries(previews).map(([title, p]) => add(p?.title ?? title));
  for (const [topic, titles] of Object.entries(EXTRA_TITLES)) for (const title of titles) add(title, { topic });

  const usedIds = new Set(baseArticles.map((a) => a.page_id));
  for (const a of articles) {
    a.topic ??= topicOf(a.title);
    a.chars ??= Math.round(1800 + rand() ** 2 * 38000 + (previews[a.title]?.thumbnail || previews[a.title.toLowerCase()]?.thumbnail ? 6000 : 0));
    if (a.page_id) continue;
    do a.page_id = 900 + Math.floor(rand() * 98000);
    while (usedIds.has(a.page_id));
    usedIds.add(a.page_id);
    a.first = Math.round(Date.UTC(2003, 0, 1) / 1000 + rand() ** 1.6 * 18 * YEAR + rand() * 200 * DAY);
    a.versions = Math.max(12, Math.round((a.chars / 28) * (0.4 + rand())));
  }

  // Links: the center article links to everything it mentions; everything else links mostly
  // within its own topic, with a pull toward bigger articles.
  const links = new Map();
  const link = (from, to, added) => {
    if (from === to) return;
    const key = `${from.page_id}-${to.page_id}`;
    if (!links.has(key)) links.set(key, { from, to, added: Math.min(added, NOW - DAY) });
  };
  for (const to of linkedFromCenter) {
    link(center, to, Math.max(center.first, to.first) + rand() ** 1.4 * (NOW - Math.max(center.first, to.first)));
  }
  const byTopic = Map.groupBy(articles, (a) => a.topic);
  for (const from of articles) {
    if (from === center) continue;
    const count = 4 + Math.floor(rand() * 10);
    for (let i = 0; i < count; i++) {
      const pool = rand() < 0.78 ? byTopic.get(from.topic) : articles;
      const to = pickWeighted(pool, rand);
      link(from, to, Math.max(from.first, to.first) + rand() * 3 * YEAR);
    }
    if (rand() < 0.08) link(from, center, Math.max(from.first, center.first) + rand() * 6 * YEAR);
  }

  return { articles, links: [...links.values()] };
}

// The graph as /api/graph returns it, for a moment in time. Articles grow as they get edited.
export function graphAt({ articles, links }, at) {
  const nodes = articles
    .filter((a) => a.first <= at)
    .map((a) => ({
      id: a.page_id,
      title: a.title,
      chars: Math.round(a.chars * Math.max(0.12, Math.min(1, (at - a.first) / (NOW - a.first)) ** 0.6)),
    }));
  const edges = links
    .filter((l) => l.added <= at && l.from.first <= at && l.to.first <= at)
    .map((l) => ({ source: l.from.page_id, target: l.to.page_id }));
  return { nodes, edges };
}

function pickWeighted(pool, rand) {
  const total = pool.reduce((sum, a) => sum + Math.sqrt(a.chars), 0);
  let r = rand() * total;
  for (const a of pool) if ((r -= Math.sqrt(a.chars)) <= 0) return a;
  return pool.at(-1);
}

function topicOf(title) {
  const t = title.toLowerCase();
  return TOPIC_RULES.find(([, rule]) => rule.test(t))[0];
}

// "qubits", "Qubit" and "qubit" are one article.
function keyOf(title) {
  return title.toLowerCase().replace(/s$/, "");
}

function capitalize(title) {
  return title[0].toUpperCase() + title.slice(1);
}

function seeded(text) {
  let h = 1779033703;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 3432918353);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
