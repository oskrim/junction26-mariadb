// Shows `card` beside a hovered element after a short pause. The card stays while the pointer is
// on it, and moving straight to a neighboring trigger swaps the content without the pause.
export function hoverCard({ root, selector, card, showDelay, render }) {
  let showTimer = 0;
  let hideTimer = 0;
  let current = null;
  let request = 0;

  const hide = () => {
    clearTimeout(showTimer);
    request++;
    hideTimer = setTimeout(() => {
      card.classList.remove("is-visible");
      current = null;
    }, 180);
  };

  root.addEventListener("mouseover", (event) => {
    const el = event.target.closest(selector);
    if (!el) return;
    clearTimeout(hideTimer);
    if (el === current) return;
    clearTimeout(showTimer);
    const token = ++request;
    showTimer = setTimeout(
      async () => {
        const html = await render(el);
        if (token !== request || html === null) return;
        current = el;
        card.innerHTML = html;
        place(card, el);
        card.classList.add("is-visible");
      },
      current ? 0 : showDelay,
    );
  });
  root.addEventListener("mouseout", (event) => {
    const el = event.target.closest(selector);
    if (el && !el.contains(event.relatedTarget)) hide();
  });
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", hide);
}

// Anchors to the first line of a link that wraps, and flips above when there is no room below.
function place(card, el) {
  const r = el.getClientRects()[0];
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const left = clamp(r.left - 16, 16, innerWidth - width - 16);
  const below = r.bottom + 12 + height < innerHeight || r.top - 12 - height < 0;
  card.dataset.side = below ? "below" : "above";
  card.style.left = `${left + scrollX}px`;
  card.style.top = `${(below ? r.bottom + 12 : r.top - 12 - height) + scrollY}px`;
  card.style.setProperty("--caret-x", `${clamp(r.left + Math.min(r.width, 48) / 2 - left, 16, width - 16)}px`);
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
