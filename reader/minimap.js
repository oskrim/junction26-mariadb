// Edits per month across the article's whole life, with edit wars marked in red. Clicking jumps there.
export function createMinimap({ root, edits, wars, onPick }) {
  const svg = root.querySelector(".minimap-svg");
  const marker = root.querySelector(".minimap-now");
  const yearsEl = root.querySelector(".minimap-years");
  const start = edits[0].time;
  const end = edits.at(-1).time;
  const monthOf = (time) => {
    const d = new Date(time);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const first = monthOf(start);
  const months = monthOf(end) - first + 1;
  const counts = new Array(months).fill(0);
  for (const e of edits) counts[monthOf(e.time) - first]++;
  const max = Math.max(...counts);

  const bars = counts
    .map((c, i) => {
      if (!c) return "";
      const h = 8 + 72 * Math.sqrt(c / max);
      return `<rect x="${i + 0.15}" y="${100 - h}" width="0.7" height="${h}" fill="#c8ccd1"/>`;
    })
    .join("");
  const marks = wars
    .map((w) => {
      const i = monthOf(w.start) - first;
      return `<rect x="${i + 0.2}" y="0" width="0.6" height="100" fill="${w.kind === "dispute" ? "#d73333" : "#f0a3a3"}"/>`;
    })
    .join("");
  svg.setAttribute("viewBox", `0 0 ${months} 100`);
  svg.innerHTML = bars + marks;

  const at = (time) => ((time - start) / (end - start)) * 100;
  const firstYear = new Date(start).getUTCFullYear() + 1;
  const lastYear = new Date(end).getUTCFullYear();
  let labels = "";
  for (let y = firstYear; y <= lastYear; y++) {
    labels += `<span style="left:${at(Date.UTC(y, 0, 1))}%">${y % 5 === 0 ? y : `’${String(y).slice(2)}`}</span>`;
  }
  yearsEl.innerHTML = labels;

  root.addEventListener("click", (event) => {
    const r = svg.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
    onPick(start + t * (end - start));
  });

  return {
    setTime(time) {
      marker.style.left = `${Math.min(100, Math.max(0, at(time)))}%`;
    },
  };
}
