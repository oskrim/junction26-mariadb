import fs from "fs"; import { grayPNG } from "./png.mjs";
const [, , src, outPng, W0 = "4096"] = process.argv;
const buf = fs.readFileSync(src); const n = buf.readUInt32LE(80);
const W = +W0, H = W / 2, SS = 2, BW = W * SS, BH = H * SS;
const bits = new Uint8Array(BW * BH);
const uvOf = (x, y, z) => { const r = Math.hypot(x, y, z); return [(Math.atan2(y, x) / (2 * Math.PI) + 0.5) * BW, (Math.acos(z / r) / Math.PI) * BH]; };
function tri(a, b, c) {
  const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxx = Math.min(BW - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxy = Math.min(BH - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const e = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const area = e(a, b, c[0], c[1]); if (Math.abs(area) < 1e-12) return;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = e(b, c, px, py) / area, w1 = e(c, a, px, py) / area, w2 = e(a, b, px, py) / area;
    if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) bits[y * BW + x] = 1;
  }
}
let count = 0;
for (let t = 0; t < n; t++) {
  const o = 84 + t * 50; const v = [];
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 3; k++) { const p = [buf.readFloatLE(o + 12 + k * 12), buf.readFloatLE(o + 16 + k * 12), buf.readFloatLE(o + 20 + k * 12)]; v.push(p); cx += p[0]; cy += p[1]; cz += p[2]; }
  const r = Math.hypot(cx, cy, cz) / 3;
  const d = (buf.readFloatLE(o) * cx + buf.readFloatLE(o + 4) * cy + buf.readFloatLE(o + 8) * cz) / 3 / r;
  if (!(d > 0.9 && r > 0.562 && r < 0.5665)) continue; // floor of the carved letters
  count++;
  const uv = v.map((p) => uvOf(...p));
  const us = uv.map((p) => p[0]);
  if (Math.max(...us) - Math.min(...us) > BW / 2) uv.forEach((p) => { if (p[0] < BW / 2) p[0] += BW; });
  tri(...uv); tri(...uv.map((p) => [p[0] - BW, p[1]]));
}
const px = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += bits[(y * SS + j) * BW + x * SS + i];
  px[y * W + x] = Math.round((s / (SS * SS)) * 255);
}
fs.writeFileSync(outPng, grayPNG(W, H, px));
console.log("letter faces", count, "png bytes", fs.statSync(outPng).size);
