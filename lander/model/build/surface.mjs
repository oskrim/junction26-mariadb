// STL → surface.png, one grey channel: 0–100 = seam between two pieces, 100–255 = carved letter. Both wrap around the ball (equirectangular).
import fs from "fs"; import { grayPNG } from "./png.mjs";
const [, , src, outPng, W0 = "4096", LINE = "2.2"] = process.argv;
const buf = fs.readFileSync(src); const n = buf.readUInt32LE(80);
const W = +W0, H = W / 2;
// weld + components so every face knows its piece
const map = new Map(); let nv = 0; const idx = new Uint32Array(n * 3);
for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
  const o = 84 + t * 50 + 12 + k * 12;
  const kk = `${Math.round(buf.readFloatLE(o) * 1e5)},${Math.round(buf.readFloatLE(o + 4) * 1e5)},${Math.round(buf.readFloatLE(o + 8) * 1e5)}`;
  let v = map.get(kk); if (v === undefined) { v = nv++; map.set(kk, v); } idx[t * 3 + k] = v;
}
const par = new Int32Array(nv).map((_, i) => i); const f = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
for (let t = 0; t < n; t++) { const a = f(idx[t*3]); par[f(idx[t*3+1])] = a; par[f(idx[t*3+2])] = a; }
const ids = new Map();
// rasterizers
const letter = new Uint8Array(W * 2 * H * 2), piece = new Uint16Array(W * H);
function raster(tri, BW, BH, put) {
  const us = tri.map((p) => p[0]);
  if (Math.max(...us) - Math.min(...us) > BW / 2) tri.forEach((p) => { if (p[0] < BW / 2) p[0] += BW; });
  for (const shift of [0, -BW]) {
    const [a, b, c] = tri.map((p) => [p[0] + shift, p[1]]);
    const e = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    const area = e(a, b, c[0], c[1]); if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(BW - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(BH - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (e(b, c, px, py) / area >= -1e-6 && e(c, a, px, py) / area >= -1e-6 && e(a, b, px, py) / area >= -1e-6) put(y * BW + x);
    }
  }
}
const uv = (p, BW, BH) => { const r = Math.hypot(...p); return [(Math.atan2(p[1], p[0]) / (2 * Math.PI) + 0.5) * BW, (Math.acos(p[2] / r) / Math.PI) * BH]; };
for (let t = 0; t < n; t++) {
  const o = 84 + t * 50; const v = []; let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 3; k++) { const p = [buf.readFloatLE(o + 12 + k * 12), buf.readFloatLE(o + 16 + k * 12), buf.readFloatLE(o + 20 + k * 12)]; v.push(p); cx += p[0]; cy += p[1]; cz += p[2]; }
  const r = Math.hypot(cx, cy, cz) / 3, d = (buf.readFloatLE(o) * cx + buf.readFloatLE(o + 4) * cy + buf.readFloatLE(o + 8) * cz) / 3 / r;
  if (r < 0.555) continue; // only the outside skin, including the rounded top of each cut edge
  const root = f(idx[t * 3]); if (!ids.has(root)) ids.set(root, ids.size + 1); const id = ids.get(root);
  raster(v.map((p) => uv(p, W, H)), W, H, (i) => (piece[i] = id));
  if (d > 0.9 && r > 0.5625 && r < 0.5665) raster(v.map((p) => uv(p, W * 2, H * 2)), W * 2, H * 2, (i) => (letter[i] = 1));
}
// seams: distance (in true angle, so lines keep their width near the bottom) to a pixel of another piece
const R = new Float32Array(W * H), G = new Uint8Array(W * H);
const line = +LINE; // half-width in pixels at the equator
for (let y = 0; y < H; y++) {
  const s = Math.max(Math.sin(((y + 0.5) / H) * Math.PI), 0.05);
  const rx = Math.ceil((line + 1) / s), ry = Math.ceil(line + 1);
  for (let x = 0; x < W; x++) {
    let l = 0; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) l += letter[(y * 2 + j) * W * 2 + x * 2 + i]; R[y * W + x] = l / 4;
    const me = piece[y * W + x]; if (!me) continue;
    let best = 1e9;
    for (let dy = -ry; dy <= ry; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -rx; dx <= rx; dx++) {
        const other = piece[yy * W + ((x + dx + W) % W)];
        if (other && other !== me) { const dd = Math.hypot(dx * s, dy); if (dd < best) best = dd; }
      }
    }
    G[y * W + x] = Math.round(100 * Math.min(1, Math.max(0, line + 0.5 - best)));
  }
}
const out = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) out[i] = R[i] > 0 ? Math.round(100 + R[i] * 155) : G[i];
fs.writeFileSync(outPng, grayPNG(W, H, out));
console.log("pieces", ids.size, "png KB", (fs.statSync(outPng).size / 1024).toFixed(0));
