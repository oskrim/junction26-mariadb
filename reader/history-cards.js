import { censor } from "./censor.js";
import { FIGHTER_COLORS } from "./timeline3d.js";
import { plainText } from "./wikitext.js";

export function renderStop(stop, changes) {
  return stop.type === "war"
    ? warCard(stop.war, changes.get(stop.war.contested.rev_id) ?? null)
    : editCard(stop.edit, changes.get(stop.edit.rev_id) ?? null);
}

// The small label a stop shows in the scene until the camera reaches it.
export function renderPin(stop) {
  if (stop.type === "war") {
    const { war } = stop;
    return `
      <div class="tl-pin is-war is-${war.kind}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5l8 8M13.5 2.5l-8 8M9 12l3-3M7 12L4 9M12 12.5l1.5 1.5M4 12.5L2.5 14"/></svg>
        <b>${war.kind === "dispute" ? "Edit war" : "Vandalism"}</b>
        <span>${war.section ? esc(war.section) : formatMonth(war.start)}</span>
      </div>`;
  }
  const { edit } = stop;
  return `
    <div class="tl-pin">
      ${avatar(edit.user, edit.kind, null)}
      <b>${esc(censor(edit.user))}</b>
      ${edit.index === 0 ? `<span class="tl-delta is-new">Created</span>` : deltaBadge(edit.delta)}
    </div>`;
}

function editCard(edit, change) {
  const created = edit.index === 0;
  const comment = cleanComment(edit.comment);
  return `
    <article class="tl-card">
      <header class="tl-head">
        ${avatar(edit.user, edit.kind, null)}
        <div class="tl-who"><b>${esc(censor(edit.user))}</b><time>${formatDate(edit.time)}</time></div>
        ${created ? `<span class="tl-delta is-new">Created</span>` : deltaBadge(edit.delta)}
      </header>
      <p class="tl-summary">
        ${edit.section ? `<span class="tl-chip">${esc(edit.section)}</span>` : ""}
        ${comment ? esc(comment) : `<span class="tl-muted">No edit summary</span>`}
      </p>
      ${changeBlock(change)}
    </article>`;
}

function warCard(war, change) {
  const dispute = war.kind === "dispute";
  const [a, b] = war.fighters;
  const count = (user) => war.edits.filter((e) => e.user === user).length;
  const fighter = (user, k) => `
    <div class="tl-fighter">
      ${avatar(user, kindOf(war, user), FIGHTER_COLORS[k])}
      <div><b>${esc(censor(user))}</b><span>${count(user)} edits</span></div>
    </div>`;
  const contested = [...(change?.added ?? []), ...(change?.removed ?? [])].map(plainText).find((s) => s.length > 20) ?? null;
  return `
    <article class="tl-card tl-war is-${war.kind}">
      <p class="tl-kicker">${dispute ? "Edit war" : "Vandalism fought off"} · ${formatMonth(war.start)}</p>
      <h3 class="tl-war-title">${war.section ? esc(war.section) : "Across the article"}</h3>
      <div class="tl-fighters">${fighter(a, 0)}<span class="tl-vs">vs</span>${fighter(b, 1)}</div>
      ${sizeChart(war)}
      <p class="tl-war-meta">
        <b>${war.reverts} reverts</b> in ${duration(war.end - war.start)}
        <span aria-hidden="true">·</span> ${war.edits.length} edits
      </p>
      ${foughtOver(contested, change)}
      <button type="button" class="tl-watch" data-action="replay" data-war="${war.id}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>Watch the fight
      </button>
    </article>`;
}

// A passage when the contested edit had one; otherwise the words it cut and added, which is what a copy-edit fight is about.
function foughtOver(passage, change) {
  if (passage) return `<p class="tl-fought"><span>Fought over</span>${esc(clip(passage, 180))}</p>`;
  const removed = (change?.removed ?? []).map(plainText).filter(Boolean);
  const added = (change?.added ?? []).map(plainText).filter(Boolean);
  if (!removed.length && !added.length) return "";
  const list = (words) => words.slice(0, 4).map(esc).join(" · ");
  return `<p class="tl-fought"><span>Fought over wording</span>
    ${removed.length ? `<s>${list(removed)}</s>` : ""}${removed.length && added.length ? "<br>" : ""}${list(added)}</p>`;
}

// Article length across the fight, one dot per edit in the fighter's color: the sawtooth is the back and forth.
function sizeChart(war) {
  const w = 268;
  const h = 64;
  const sizes = war.edits.map((e) => e.chars);
  const min = Math.min(...sizes);
  const range = Math.max(1, Math.max(...sizes) - min);
  const pts = war.edits.map((e, i) => ({
    x: 6 + (i / Math.max(1, war.edits.length - 1)) * (w - 12),
    y: h - 8 - ((e.chars - min) / range) * (h - 16),
    e,
  }));
  const line = pts.map((p, i) => (i ? `H${p.x.toFixed(1)}V${p.y.toFixed(1)}` : `M${p.x.toFixed(1)} ${p.y.toFixed(1)}`)).join("");
  const dots = pts
    .map(({ x, y, e }) => {
      const k = war.fighters.indexOf(e.user);
      const color = k === 0 || k === 1 ? FIGHTER_COLORS[k] : "#a2a9b1";
      const r = e.revertsTo !== null ? 4 : 2.6;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
    })
    .join("");
  return `<svg class="tl-chart" viewBox="0 0 ${w} ${h}" aria-label="Article length during the edit war">
    <path d="${line}" fill="none" stroke="#c8ccd1" stroke-width="1.5"/>${dots}</svg>`;
}

function changeBlock(change) {
  if (!change) return "";
  const added = change.added.map(plainText).filter((s) => s.length > 3).sort((a, b) => b.length - a.length)[0];
  const removed = change.removed.map(plainText).filter((s) => s.length > 3).sort((a, b) => b.length - a.length)[0];
  if (!added && !removed) return "";
  return `<div class="tl-change">
    ${added ? `<p class="tl-add">${esc(clip(added, 200))}</p>` : ""}
    ${removed ? `<p class="tl-del">${esc(clip(removed, 120))}</p>` : ""}
  </div>`;
}

function avatar(user, kind, ring) {
  const hue = [...user].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const label =
    kind === "anonymous"
      ? "IP"
      : user
          .split(/[\s_.-]+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0].toUpperCase())
          .join("");
  const style = `--hue:${hue}${ring ? `;--ring:${ring}` : ""}`;
  return `<span class="tl-avatar is-${kind}${ring ? " has-ring" : ""}" style="${style}">${esc(label)}</span>`;
}

function kindOf(war, user) {
  return war.edits.find((e) => e.user === user)?.kind ?? "person";
}

// Edit summaries are wiki markup too; keep only the words.
export function cleanComment(comment) {
  return censor(comment)
    .replace(/\/\*.*?\*\//, "")
    .replace(/\[\[(?:[^[\]|]*\|)?([^[\]]*)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s:–-]+/, "")
    .trim();
}

function deltaBadge(delta) {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const cls = delta > 0 ? "is-plus" : delta < 0 ? "is-minus" : "";
  return `<span class="tl-delta ${cls}">${sign}${Math.abs(delta).toLocaleString("en-US")}</span>`;
}

function duration(ms) {
  const hours = ms / 3_600_000;
  if (hours < 1) return "under an hour";
  if (hours < 36) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function formatDate(time) {
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatMonth(time) {
  return new Date(time).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
