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

// Reverts of someone else's edits, less than three days apart, form one fight; people undoing their own
// edit don't count. Fighters are the people reverting or being reverted. It is a dispute when two people
// each reverted the other, and vandalism fought off when one side only ever got reverted. A fight needs
// at least MIN_REVERTS such reverts to count.
const MIN_REVERTS = 4;

export function findEditWars(edits) {
  const reverts = [];
  for (const edit of edits) {
    if (edit.revertsTo === null) continue;
    const undone = edits.slice(edit.revertsTo + 1, edit.index).filter((e) => e.user !== edit.user);
    if (undone.length) reverts.push({ edit, victims: [...new Set(undone.map((e) => e.user))], undone });
  }

  const groups = [];
  let current = [];
  for (const r of reverts) {
    if (current.length && r.edit.time - current.at(-1).edit.time > 3 * DAY) {
      groups.push(current);
      current = [];
    }
    current.push(r);
  }
  if (current.length) groups.push(current);

  return groups
    .filter((group) => group.length >= MIN_REVERTS)
    .map((group) => {
      const span = edits.slice(group[0].edit.revertsTo + 1, group.at(-1).edit.index + 1);
      const involved = new Map();
      const hit = new Set();
      const bump = (user) => involved.set(user, (involved.get(user) ?? 0) + 1);
      for (const { edit, victims } of group) {
        bump(edit.user);
        for (const v of victims) {
          bump(v);
          hit.add(`${edit.user}\n${v}`);
        }
      }
      const ranked = [...involved].sort((a, b) => b[1] - a[1]).map(([user]) => user);
      // The two shown fighting: the busiest pair who reverted each other, otherwise the most reverted
      // person and whoever reverted them most.
      let pair = null;
      for (const a of ranked) {
        for (const b of ranked) {
          if (a !== b && hit.has(`${a}\n${b}`) && hit.has(`${b}\n${a}`)) {
            pair = [a, b];
            break;
          }
        }
        if (pair) break;
      }
      const dispute = pair !== null;
      if (!pair) {
        const victimCount = new Map();
        for (const { victims } of group) for (const v of victims) victimCount.set(v, (victimCount.get(v) ?? 0) + 1);
        const victim = [...victimCount].sort((a, b) => b[1] - a[1])[0][0];
        const byReverter = new Map();
        for (const { edit, victims } of group) {
          if (victims.includes(victim)) byReverter.set(edit.user, (byReverter.get(edit.user) ?? 0) + 1);
        }
        pair = [victim, [...byReverter].sort((a, b) => b[1] - a[1])[0][0]];
      }
      const fighters = [...pair, ...ranked.filter((u) => !pair.includes(u))];
      const fought = group.flatMap(({ edit, undone }) => [edit, ...undone]);
      const contested = group[0].undone[0];
      return {
        id: `war-${span[0].rev_id}`,
        start: span[0].time,
        end: span.at(-1).time,
        edits: span,
        reverts: group.length,
        fighters,
        kind: dispute ? "dispute" : "vandalism",
        section: mostCommon(fought.map((e) => e.section).filter(Boolean)),
        contested,
      };
    });
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
