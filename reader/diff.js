// Longest-common-subsequence diff over any two lists, grouped into runs:
// [{ type: "equal" | "change", a: [...], b: [...] }]. A change run holds what was removed (a) and added (b).
export function diff(a, b, key = (x) => x) {
  let start = 0;
  while (start < a.length && start < b.length && key(a[start]) === key(b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && key(a[endA - 1]) === key(b[endB - 1])) {
    endA--;
    endB--;
  }

  const runs = [];
  const push = (type, x, y) => {
    const last = runs.at(-1);
    if (last?.type === type) {
      last.a.push(...x);
      last.b.push(...y);
    } else runs.push({ type, a: [...x], b: [...y] });
  };
  if (start) push("equal", a.slice(0, start), b.slice(0, start));

  const n = endA - start;
  const m = endB - start;
  // Very long rewrites are shown as one replaced block instead of paying for a huge table.
  if (n * m > 4_000_000) push("change", a.slice(start, endA), b.slice(start, endB));
  else {
    const ka = a.slice(start, endA).map(key);
    const kb = b.slice(start, endB).map(key);
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] =
          ka[i] === kb[j]
            ? table[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ka[i] === kb[j]) {
        push("equal", [a[start + i]], [b[start + j]]);
        i++;
        j++;
      } else if (j < m && (i === n || table[i * (m + 1) + j + 1] >= table[(i + 1) * (m + 1) + j])) {
        push("change", [], [b[start + j]]);
        j++;
      } else {
        push("change", [a[start + i]], []);
        i++;
      }
    }
  }

  if (endA < a.length) push("equal", a.slice(endA), b.slice(endB));
  return runs;
}

export function words(text) {
  return text.match(/\s+|[^\s]+/g) ?? [];
}
