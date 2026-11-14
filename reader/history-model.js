// Reads an article's edit history: rows shaped like the `article` table queried FOR SYSTEM_TIME ALL,
// oldest first, each { rev_id, user, comment, row_start, chars, sha1 }.

const DAY = 86_400_000;
const IP = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}$/i;

export function parseRowStart(rowStart) {
  return Date.parse(`${rowStart.slice(0, 19).replace(" ", "T")}Z`);
}

// A version whose text hash matches an older, non-adjacent version is a revert: it undid every edit in between.
export function analyzeHistory(rows) {
  const lastSeen = new Map();
  const edits = rows.map((row, index) => {
    const seen = lastSeen.get(row.sha1);
    lastSeen.set(row.sha1, index);
    return {
      ...row,
      index,
      time: parseRowStart(row.row_start),
      delta: row.chars - (index ? rows[index - 1].chars : 0),
      revertsTo: seen !== undefined && seen < index - 1 ? seen : null,
      undoneBy: null,
      section: row.comment.match(/\/\*\s*(.+?)\s*\*\//)?.[1] ?? null,
      kind: /bot$/i.test(row.user) ? "bot" : IP.test(row.user) ? "anonymous" : "person",
    };
  });
  for (const edit of edits) {
    if (edit.revertsTo === null) continue;
    for (let i = edit.revertsTo + 1; i < edit.index; i++) edits[i].undoneBy ??= edit.index;
  }
  return edits;
}

// Reverts less than three days apart form one fight. It counts as a war when it has at least
// four reverts and two people who each made two or more of its edits.
export function findEditWars(edits) {
  const groups = [];
  let current = [];
  for (const edit of edits) {
    if (edit.revertsTo === null) continue;
    if (current.length && edit.time - current.at(-1).time > 3 * DAY) {
      groups.push(current);
      current = [];
    }
    current.push(edit);
  }
  if (current.length) groups.push(current);

  return groups
    .map((reverts) => {
      const span = edits.slice(reverts[0].revertsTo + 1, reverts.at(-1).index + 1);
      const counts = new Map();
      for (const e of span) counts.set(e.user, (counts.get(e.user) ?? 0) + 1);
      const fighters = [...counts]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([user]) => user);
      const undone = span.filter((e) => e.undoneBy !== null);
      const vandalism = undone.filter((e) => e.kind === "anonymous").length >= undone.length * 0.7;
      return {
        id: `war-${span[0].rev_id}`,
        start: span[0].time,
        end: span.at(-1).time,
        edits: span,
        reverts: reverts.length,
        fighters,
        kind: vandalism ? "vandalism" : "dispute",
        section: mostCommon(span.map((e) => e.section).filter(Boolean)),
        contested: undone[0] ?? span[0],
      };
    })
    .filter((war) => war.reverts >= 4 && war.fighters.length >= 2);
}

// The edits worth a card: the first version, the biggest additions and cuts, and the biggest edit of
// every half year. Reverts, undone edits and anything inside a war are left out; wars get their own card.
export function pickMilestones(edits, wars) {
  const inWar = new Set(wars.flatMap((w) => w.edits.map((e) => e.index)));
  const lasting = edits.filter((e) => e.index > 0 && e.revertsTo === null && e.undoneBy === null && !inWar.has(e.index));
  const picked = new Set([edits[0]]);
  for (const e of [...lasting].sort((a, b) => b.delta - a.delta).slice(0, 30)) picked.add(e);
  for (const e of [...lasting].sort((a, b) => a.delta - b.delta).slice(0, 8)) picked.add(e);
  const byHalfYear = new Map();
  for (const e of lasting) {
    const d = new Date(e.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() < 6 ? 1 : 2}`;
    const best = byHalfYear.get(key);
    if (!best || Math.abs(e.delta) > Math.abs(best.delta)) byHalfYear.set(key, e);
  }
  for (const e of byHalfYear.values()) picked.add(e);
  return [...picked].sort((a, b) => a.index - b.index);
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
