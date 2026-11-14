// STL → { globe.json, globe.bin }: 51 pieces, letters flattened (they live in letters.png), simplified, quantized, meshopt-encoded.
import fs from "fs";
import { MeshoptSimplifier as S, MeshoptEncoder as E } from "meshoptimizer";
const [, , src, outDir, ERR = "0.006"] = process.argv;
await S.ready; await E.ready;
const R_OUT = 0.57;
const buf = fs.readFileSync(src); const n = buf.readUInt32LE(80);
// weld
const map = new Map(); let pos = []; const idx = new Uint32Array(n * 3); const letterTri = new Uint8Array(n);
const key = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
for (let t = 0; t < n; t++) {
  const o = 84 + t * 50; let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 3; k++) {
    const x = buf.readFloatLE(o + 12 + k * 12), y = buf.readFloatLE(o + 16 + k * 12), z = buf.readFloatLE(o + 20 + k * 12);
    cx += x; cy += y; cz += z;
    const kk = key(x, y, z); let v = map.get(kk);
    if (v === undefined) { v = pos.length / 3; map.set(kk, v); pos.push(x, y, z); }
    idx[t * 3 + k] = v;
  }
  const r = Math.hypot(cx, cy, cz) / 3, d = (buf.readFloatLE(o) * cx + buf.readFloatLE(o + 4) * cy + buf.readFloatLE(o + 8) * cz) / 3 / r;
  if (d > 0.9 && r > 0.562 && r < 0.5665) letterTri[t] = 1;
}
pos = Float32Array.from(pos); const V = pos.length / 3;
// flatten the carved letters: push every vertex of a letter floor up to the outer surface
const snap = new Uint8Array(V);
for (let t = 0; t < n; t++) if (letterTri[t]) for (let k = 0; k < 3; k++) snap[idx[t * 3 + k]] = 1;
for (let v = 0; v < V; v++) { const r0 = Math.hypot(pos[v*3], pos[v*3+1], pos[v*3+2]); if (r0 > 0.5625 && r0 < R_OUT) snap[v] = 1; } // the whole thin outer skin
for (let v = 0; v < V; v++) if (snap[v]) { const r = Math.hypot(pos[v*3], pos[v*3+1], pos[v*3+2]); for (let a = 0; a < 3; a++) pos[v*3+a] *= R_OUT / r; }
// re-weld after snapping (floor corners now sit on the wall tops)
const map2 = new Map(); const remap = new Uint32Array(V); const pos2 = [];
for (let v = 0; v < V; v++) { const kk = key(pos[v*3], pos[v*3+1], pos[v*3+2]); let w = map2.get(kk); if (w === undefined) { w = pos2.length / 3; map2.set(kk, w); pos2.push(pos[v*3], pos[v*3+1], pos[v*3+2]); } remap[v] = w; }
const P = Float32Array.from(pos2);
// components on the re-welded mesh
const V2 = P.length / 3; const par = new Int32Array(V2).map((_, i) => i);
const f = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
const tris = [];
for (let t = 0; t < n; t++) {
  const a = remap[idx[t*3]], b = remap[idx[t*3+1]], c = remap[idx[t*3+2]];
  if (a === b || b === c || a === c) continue;
  tris.push(a, b, c); const ra = f(a); par[f(b)] = ra; par[f(c)] = ra;
}
const byComp = new Map();
for (let i = 0; i < tris.length; i += 3) { const r = f(tris[i]); if (!byComp.has(r)) byComp.set(r, []); byComp.get(r).push(tris[i], tris[i+1], tris[i+2]); }
const pieces = [...byComp.values()].filter((t) => t.length > 300);
// simplify + pack
const SCALE = 32767 / 0.6;
const parts = []; const manifest = { scale: 1 / SCALE, radius: R_OUT, pieces: [] }; let off = 0, totalTris = 0;
for (const T of pieces) {
  // local vertex set
  const lmap = new Map(); const lpos = []; const lidx = new Uint32Array(T.length);
  T.forEach((v, i) => { let w = lmap.get(v); if (w === undefined) { w = lpos.length / 3; lmap.set(v, w); lpos.push(P[v*3], P[v*3+1], P[v*3+2]); } lidx[i] = w; });
  const lp = Float32Array.from(lpos);
  const [si] = S.simplify(lidx, lp, 3, 0, +ERR, []);
  const [rm, unique] = E.reorderMesh(si, true, true);
  const q = new Int16Array(unique * 4); let cx = 0, cy = 0, cz = 0;
  for (let v = 0; v < lp.length / 3; v++) { const w = rm[v]; if (w === 0xffffffff) continue; for (let a = 0; a < 3; a++) q[w*4+a] = Math.round(lp[v*3+a] * SCALE); }
  for (let w = 0; w < unique; w++) { cx += q[w*4]; cy += q[w*4+1]; cz += q[w*4+2]; }
  const i16 = new Uint16Array(si.length); for (let i = 0; i < si.length; i++) i16[i] = si[i];
  const vb = E.encodeVertexBuffer(new Uint8Array(q.buffer), unique, 8);
  const ib = E.encodeIndexBuffer(new Uint8Array(i16.buffer), si.length, 2);
  const c = [cx, cy, cz].map((x) => x / unique / SCALE); const cl = Math.hypot(...c);
  manifest.pieces.push({ vertices: unique, indices: si.length, vb: [off, vb.length], ib: [off + vb.length, ib.length], dir: c.map((x) => +(x / cl).toFixed(4)) });
  parts.push(Buffer.from(vb), Buffer.from(ib)); off += vb.length + ib.length; totalTris += si.length / 3;
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/globe.bin`, Buffer.concat(parts));
fs.writeFileSync(`${outDir}/globe.json`, JSON.stringify(manifest));
console.log(`err ${ERR}: pieces ${pieces.length}, triangles ${totalTris}, bin ${(off/1024).toFixed(0)} KB`);
