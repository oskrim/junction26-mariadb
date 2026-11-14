// Each article's picture: Wikipedia's page image, asked for 50 titles at a time and kept for the page's lifetime.
// Used by the top bar's search list and the Find palette; a title without a picture keeps its letter tile.

const PICTURES = new Map(); // title → thumbnail URL, or null when it has none
const WAITING = new Map(); // title → the request that is asking for it

// Resolves once every title has been asked about; the URLs are then in PICTURES.
export async function loadPictures(titles) {
  const missing = [...new Set(titles)].filter((t) => !PICTURES.has(t) && !WAITING.has(t));
  for (let i = 0; i < missing.length; i += 50) {
    const part = missing.slice(i, i + 50);
    const url = `https://fi.wikipedia.org/w/api.php?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=120&format=json&formatversion=2&origin=*&titles=${encodeURIComponent(part.join("|"))}`;
    const asking = fetch(url)
      .then((r) => r.json())
      .then(({ query }) => {
        const back = new Map((query?.normalized ?? []).map((n) => [n.to, n.from]));
        part.forEach((t) => PICTURES.set(t, null));
        for (const page of query?.pages ?? []) if (page.thumbnail) PICTURES.set(back.get(page.title) ?? page.title, page.thumbnail.source);
      })
      .catch(() => {}) // left unknown, so a later list asks again
      .finally(() => part.forEach((t) => WAITING.delete(t)));
    part.forEach((t) => WAITING.set(t, asking));
  }
  await Promise.all([...new Set(titles)].map((t) => WAITING.get(t)).filter(Boolean));
}

// A letter tile for the title, with data-title so paint() can put the picture in it.
export function thumbHtml(title, name = title, className = "") {
  const letter = (name.match(/\p{L}|\p{N}/u)?.[0] ?? "·").toUpperCase();
  const hue = [...title].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
  return `<span class="pic ${className}" data-title="${escapeAttr(title)}" style="--hue: ${hue}"><span>${escapeAttr(letter)}</span></span>`;
}

// Puts the known pictures into the tiles under root.
export function paint(root) {
  for (const tile of root.querySelectorAll(".pic[data-title]")) {
    const url = PICTURES.get(tile.dataset.title);
    if (!url || tile.querySelector("img")) continue;
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.onload = () => tile.classList.add("has-image");
    img.src = url;
    tile.append(img);
  }
}

const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
