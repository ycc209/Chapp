/**
 * Chapp's body, rebuilt from the protein: the 24 subunits of Hsp16.5 (PDB 1SHS, biological assembly 1) as round
 * lumps of gel, as in the concept art (data/design/reference/chapp-original.png), where V4 was smooth tubes; the
 * cage's 14 windows stay open. Each subunit's residues are grouped into lumps (k-means, the same groups in every
 * subunit), each lump a sphere as big as its residues' spread, joined in the order the chain runs through them, and
 * melted together (smooth union): each subunit one closed, whole piece, so the 3D Chapp can come apart into them.
 * Only the body changes: the face, its expressions and the gel stay as they are in public/chapp/chapp.glb, so the
 * body keeps V4's place, turn and round outline (front radius 1.29) for the eyes.
 *
 *   node scripts/chapp-model/body.ts [--lumps 16] [--grow 1] [--base 2] [--soft 3] [--open 4] [--step 1.55]
 *                                    [--face 0.6] [--out file.glb]
 *
 * Then redraw the stills (scripts/chapp-model/stills.ts).
 *
 * lumps: per subunit · grow, base: a lump's radius in Å, grow × its residues' spread + base · soft: how far (Å) the
 * lumps melt into each other · open: how many degrees wider each window is made, by shrinking the lumps on its rim
 * (so they stay round) · step: the grid in Å · face: how much smoother the face is than the rest.
 * The PDB file is downloaded once into data/design/pdb/ (git-ignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const LUMPS = option('lumps', 16);
const GROW = option('grow', 1);
const BASE = option('base', 2);
const SOFT = option('soft', 3);
const STEP = option('step', 1.55);
// How far each atom's colour reaches (Å): the colours of neighbouring subunits run into each other.
const SIGMA = 2.6;
const FACE = option('face', 0.6);
const OPEN = option('open', 4);
const ROOT = resolve(import.meta.dirname, '../..');
const MODEL = resolve(ROOT, 'public/chapp/chapp.glb');
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? resolve(args[outAt + 1]!) : MODEL;
const PDB = resolve(ROOT, 'data/design/pdb/1SHS.pdb1.gz');
const RADIUS = 1.29; // V4's front radius: the eyes sit on it
const GEL = 'Hydrated molecular gel';

type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------------------------
// The glTF as it is

type Json = Record<string, any>;
function readGlb(file: string) {
  const b = readFileSync(file);
  const jsonLength = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8')) as Json;
  const binStart = 20 + jsonLength + 8;
  const bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jsonLength));
  return { json, bin };
}

const { json: gltf, bin } = readGlb(MODEL);
const TYPES: Record<number, typeof Float32Array | typeof Uint8Array | typeof Uint16Array | typeof Uint32Array> = { 5126: Float32Array, 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array };
const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function accessorData(index: number) {
  const a = gltf.accessors[index];
  const view = gltf.bufferViews[a.bufferView];
  const Type = TYPES[a.componentType]!;
  const n = a.count * SIZES[a.type]!;
  const start = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Type(bin.buffer.slice(start, start + n * Type.BYTES_PER_ELEMENT));
}

// The body's meshes, by subunit ("1SHS subunit 2:C" → model 2, chain C), with V4's middle and colour of each.
const bodyNode = gltf.nodes.find((n: Json) => n.name === 'Body');
const subunits = (bodyNode.children as number[]).map(i => {
  const node = gltf.nodes[i];
  const mesh = gltf.meshes[node.mesh];
  const [, model, chain] = /(\d+):([A-Z])$/.exec(mesh.name)!;
  const prim = mesh.primitives[0];
  if (gltf.materials[prim.material].name !== GEL) throw new Error(`${mesh.name} is not the gel`);
  const pos = accessorData(prim.attributes.POSITION) as Float32Array;
  const col = accessorData(prim.attributes.COLOR_0);
  const middle: V3 = [0, 0, 0];
  const colour = [0, 0, 0, 0];
  const count = pos.length / 3;
  for (let v = 0; v < count; v++) for (let c = 0; c < 3; c++) middle[c] += pos[v * 3 + c]! / count;
  const scale = col instanceof Uint8Array ? 255 : col instanceof Uint16Array ? 65535 : 1;
  const width = col.length / count;
  for (let v = 0; v < count; v++) for (let c = 0; c < width; c++) colour[c] += col[v * width + c]! / scale / count;
  return { key: `${model}:${chain}`, mesh: node.mesh as number, material: prim.material as number, middle, colour: colour.slice(0, 3) as V3 };
});
// V4's middles and colours are kept in the file the first time (its meshes are replaced), so every rebuild starts
// from the same place and colours instead of drifting from the last one.
const saved = gltf.asset.extras?.v4Subunits as Record<string, { middle: V3; colour: V3 }> | undefined;
for (const s of subunits) if (saved?.[s.key]) Object.assign(s, saved[s.key]);

// ---------------------------------------------------------------------------------------------------------------
// The atoms

if (!existsSync(PDB)) {
  mkdirSync(resolve(PDB, '..'), { recursive: true });
  const response = await fetch('https://files.rcsb.org/download/1SHS.pdb1.gz');
  if (!response.ok) throw new Error(`RCSB: ${response.status}`);
  writeFileSync(PDB, Buffer.from(await response.arrayBuffer()));
}
type Atom = { p: V3; unit: number; residue: number };
const unitOf = new Map(subunits.map((s, i) => [s.key, i]));
const atoms: Atom[] = [];
let model = '1';
for (const line of gunzipSync(readFileSync(PDB)).toString('latin1').split('\n')) {
  if (line.startsWith('MODEL')) model = line.slice(6).trim();
  if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue;
  if (line.slice(17, 20) === 'HOH' || line.slice(76, 78).trim() === 'H') continue;
  const unit = unitOf.get(`${model}:${line[21]}`);
  if (unit === undefined) continue;
  atoms.push({ p: [Number(line.slice(30, 38)), Number(line.slice(38, 46)), Number(line.slice(46, 54))], unit, residue: Number(line.slice(22, 26)) });
}

// ---------------------------------------------------------------------------------------------------------------
// V4's place and turn: the similarity that takes each subunit's atoms to the middle of its V4 mesh (Horn's method).

function jacobi(m: number[][]) {
  const n = m.length;
  const a = m.map(r => [...r]);
  const v: number[][] = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p]![q]!) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!, akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!, aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!, vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: a.map((r, i) => r[i]!), vectors: v };
}

const atomMiddles = subunits.map(() => [0, 0, 0, 0]);
for (const a of atoms) {
  const m = atomMiddles[a.unit]!;
  m[0] += a.p[0];
  m[1] += a.p[1];
  m[2] += a.p[2];
  m[3]!++;
}
const from = atomMiddles.map(m => [m[0]! / m[3]!, m[1]! / m[3]!, m[2]! / m[3]!] as V3);
const to = subunits.map(s => s.middle);
const mean = (ps: V3[]) => ps.reduce((s, p) => [s[0] + p[0] / ps.length, s[1] + p[1] / ps.length, s[2] + p[2] / ps.length], [0, 0, 0] as V3);
const fromMean = mean(from), toMean = mean(to);
const S = [0, 1, 2].map(() => [0, 0, 0]);
let fromSize = 0;
from.forEach((f, i) => {
  const a = [f[0] - fromMean[0], f[1] - fromMean[1], f[2] - fromMean[2]];
  const b = [to[i]![0] - toMean[0], to[i]![1] - toMean[1], to[i]![2] - toMean[2]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r]![c]! += a[r]! * b[c]!;
  fromSize += a[0]! ** 2 + a[1]! ** 2 + a[2]! ** 2;
});
const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S as [V3, V3, V3];
const N = [
  [xx + yy + zz, yz - zy, zx - xz, xy - yx],
  [yz - zy, xx - yy - zz, xy + yx, zx + xz],
  [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
  [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
];
const eig = jacobi(N);
const best = eig.values.indexOf(Math.max(...eig.values));
const [qw, qx, qy, qz] = eig.vectors.map(r => r[best]!) as [number, number, number, number];
const R = [
  [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
  [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
  [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
];
const turn = (p: V3): V3 => [R[0]![0]! * p[0] + R[0]![1]! * p[1] + R[0]![2]! * p[2], R[1]![0]! * p[0] + R[1]![1]! * p[1] + R[1]![2]! * p[2], R[2]![0]! * p[0] + R[2]![1]! * p[1] + R[2]![2]! * p[2]];
let fit = 0;
from.forEach((f, i) => {
  const r = turn([f[0] - fromMean[0], f[1] - fromMean[1], f[2] - fromMean[2]]);
  fit += r[0] * (to[i]![0] - toMean[0]) + r[1] * (to[i]![1] - toMean[1]) + r[2] * (to[i]![2] - toMean[2]);
});
const SCALE = fit / fromSize;
const place = (p: V3): V3 => {
  const r = turn([p[0] - fromMean[0], p[1] - fromMean[1], p[2] - fromMean[2]]);
  return [r[0] * SCALE + toMean[0], r[1] * SCALE + toMean[1], r[2] * SCALE + toMean[2]];
};
const misfit = Math.sqrt(from.reduce((s, f, i) => s + place(f).reduce((t, c, k) => t + (c - to[i]![k]!) ** 2, 0), 0) / from.length);
console.log(`placed like V4: ${SCALE.toFixed(4)} per Å, subunit middles within ${misfit.toFixed(3)} (rms)`);

// ---------------------------------------------------------------------------------------------------------------
// The lumps: each subunit's residues (their middles) in LUMPS groups, the same groups in every subunit (k-means on
// the first, seeded along the chain), each group a sphere.

const residues = new Map<string, { p: V3; n: number; unit: number; residue: number }>();
for (const a of atoms) {
  const key = `${a.unit}:${a.residue}`;
  const r = residues.get(key) ?? residues.set(key, { p: [0, 0, 0], n: 0, unit: a.unit, residue: a.residue }).get(key)!;
  for (let c = 0; c < 3; c++) r.p[c]! += a.p[c]!;
  r.n++;
}
for (const r of residues.values()) for (let c = 0; c < 3; c++) r.p[c]! /= r.n;
const first = [...residues.values()].filter(r => r.unit === 0).sort((a, b) => a.residue - b.residue);
let centres: V3[] = Array.from({ length: LUMPS }, (_, i) => [...first[Math.floor(((i + 0.5) * first.length) / LUMPS)]!.p] as V3);
const groupOf = new Map<number, number>();
for (let round = 0; round < 30; round++) {
  for (const r of first) {
    let best = 0, bestD = Infinity;
    centres.forEach((c, i) => {
      const d = (c[0] - r.p[0]) ** 2 + (c[1] - r.p[1]) ** 2 + (c[2] - r.p[2]) ** 2;
      if (d < bestD) (bestD = d), (best = i);
    });
    groupOf.set(r.residue, best);
  }
  centres = centres.map((c, i) => {
    const members = first.filter(r => groupOf.get(r.residue) === i);
    return members.length ? (mean(members.map(m => m.p)) as V3) : c;
  });
}
type Lump = { c: V3; r: number; unit: number; group: number };
const lumps: Lump[] = [];
subunits.forEach((_, u) => {
  const mine = [...residues.values()].filter(r => r.unit === u);
  for (let i = 0; i < LUMPS; i++) {
    const members = mine.filter(r => groupOf.get(r.residue) === i);
    if (!members.length) continue;
    const c = mean(members.map(m => m.p));
    const spread = Math.sqrt(members.reduce((s, m) => s + (m.p[0] - c[0]) ** 2 + (m.p[1] - c[1]) ** 2 + (m.p[2] - c[2]) ** 2, 0) / members.length);
    lumps.push({ c, r: GROW * spread + BASE, unit: u, group: i });
  }
});
// The windows: the 14 directions (8 three-fold, 6 four-fold) a ray from the middle leaves by without meeting a lump.
// Each is opened OPEN degrees wider, the lumps on its rim shrunk to clear it (a lump inside it goes).
const hub = mean(lumps.map(l => l.c));
const unit = (p: V3): V3 => {
  const l = Math.hypot(p[0] - hub[0], p[1] - hub[1], p[2] - hub[2]);
  return [(p[0] - hub[0]) / l, (p[1] - hub[1]) / l, (p[2] - hub[2]) / l];
};
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const seen = lumps.map(l => ({ d: unit(l.c), half: Math.asin(Math.min(1, l.r / Math.hypot(l.c[0] - hub[0], l.c[1] - hub[1], l.c[2] - hub[2]))) }));
const probes: { d: V3; open: number }[] = [];
const PROBES = 6000;
for (let i = 0; i < PROBES; i++) {
  const y = 1 - (2 * (i + 0.5)) / PROBES, r = Math.sqrt(1 - y * y), t = i * Math.PI * (3 - Math.sqrt(5));
  const d: V3 = [Math.cos(t) * r, y, Math.sin(t) * r];
  probes.push({ d, open: Math.min(...seen.map(l => angle(d, l.d) - l.half)) });
}
probes.sort((a, b) => b.open - a.open);
const windows: { d: V3; open: number }[] = [];
for (const p of probes) {
  if (windows.length === 14 || p.open <= 0) break;
  if (windows.every(w => angle(w.d, p.d) > (25 * Math.PI) / 180)) windows.push(p);
}
const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
console.log(`${windows.length} windows, ${windows.map(w => deg(w.open)).join(' ')}° open`);
// The face is in V4's +Z, a little low: a window there stays as small as it is, so no hole opens between the eyes.
const faceInPdb = (() => {
  const f: V3 = [0, -0.1, 1];
  const d: V3 = [R[0]![0]! * f[0] + R[1]![0]! * f[1] + R[2]![0]! * f[2], R[0]![1]! * f[0] + R[1]![1]! * f[1] + R[2]![1]! * f[2], R[0]![2]! * f[0] + R[1]![2]! * f[1] + R[2]![2]! * f[2]];
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l] as V3;
})();
for (const w of windows) {
  if (angle(w.d, faceInPdb) < (40 * Math.PI) / 180) continue;
  const cone = w.open + (OPEN * Math.PI) / 180;
  for (const l of lumps) {
    const off = angle(unit(l.c), w.d);
    if (off > Math.PI / 2) continue;
    const room = Math.hypot(l.c[0] - hub[0], l.c[1] - hub[1], l.c[2] - hub[2]) * Math.sin(Math.max(0, off - cone));
    l.r = Math.min(l.r, room);
  }
}
for (let i = lumps.length - 1; i >= 0; i--) if (lumps[i]!.r < 2.5) lumps.splice(i, 1);

// The chain: a subunit is one protein chain, so its lumps are joined in the order the chain runs through them (a
// lump a window took is passed over), each joint a tube a little thinner than the lumps it joins. Apart, every
// subunit is then one whole piece.
type Bond = { a: Lump; b: Lump; r: number };
const route = first.map(r => groupOf.get(r.residue)!);
const bonds: Bond[] = [];
subunits.forEach((_, u) => {
  const mine = new Map(lumps.filter(l => l.unit === u).map(l => [l.group, l]));
  const seen = new Set<string>();
  let last: Lump | undefined;
  for (const group of route) {
    const l = mine.get(group);
    if (!l || l === last) continue;
    if (last) {
      const key = [last.group, l.group].sort((x, y) => x - y).join('-');
      if (!seen.has(key)) {
        seen.add(key);
        bonds.push({ a: last, b: l, r: Math.max(2.5, 0.55 * Math.min(last.r, l.r)) });
      }
    }
    last = l;
  }
});
const sizes = lumps.map(l => l.r).sort((a, b) => a - b);
console.log(`${lumps.length} lumps, radius ${sizes[0]!.toFixed(1)}–${sizes.at(-1)!.toFixed(1)} Å (median ${sizes[sizes.length >> 1]!.toFixed(1)})`);

// The surface: each subunit on its own, closed, so that apart (the stage's three taps, rig.ts) each is a whole piece;
// together they meet in a fine crease. A subunit's spheres are melted together (polynomial smooth minimum) on a grid
// in Å, below zero inside, and cut by marching cubes; normals from the same distance, outward.
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] as const;
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] as const;
const FAR = 4 * STEP + SOFT;
const verts: number[] = [];
const norms: number[] = [];
const tris: number[] = [];
const owners: number[] = [];

function surface(mine: Lump[], joints: Bond[], u: number) {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const l of mine) for (let c = 0; c < 3; c++) (lo[c] = Math.min(lo[c]!, l.c[c]! - l.r)), (hi[c] = Math.max(hi[c]!, l.c[c]! + l.r));
  const pad = 3 * STEP + SOFT;
  const origin: V3 = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
  const [nx, ny, nz] = [0, 1, 2].map(c => Math.ceil((hi[c]! - lo[c]! + 2 * pad) / STEP) + 1) as V3;
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const field = new Float32Array(nx * ny * nz).fill(FAR);
  for (const l of mine) {
    const reach = Math.ceil((l.r + FAR) / STEP);
    const ci = Math.round((l.c[0] - origin[0]) / STEP), cj = Math.round((l.c[1] - origin[1]) / STEP), ck = Math.round((l.c[2] - origin[2]) / STEP);
    for (let k = Math.max(0, ck - reach); k <= Math.min(nz - 1, ck + reach); k++)
      for (let j = Math.max(0, cj - reach); j <= Math.min(ny - 1, cj + reach); j++)
        for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
          const d = Math.hypot(origin[0] + i * STEP - l.c[0], origin[1] + j * STEP - l.c[1], origin[2] + k * STEP - l.c[2]) - l.r;
          if (d > FAR) continue;
          const o = at(i, j, k);
          field[o] = smin(field[o]!, d, SOFT);
        }
  }
  for (const { a, b, r } of joints) {
    const ab: V3 = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
    const ab2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const reach = r + FAR;
    const from = [0, 1, 2].map(c => Math.max(0, Math.floor((Math.min(a.c[c]!, b.c[c]!) - reach - origin[c]!) / STEP)));
    const to = [0, 1, 2].map((c, n) => Math.min([nx, ny, nz][n]! - 1, Math.ceil((Math.max(a.c[c]!, b.c[c]!) + reach - origin[c]!) / STEP)));
    for (let k = from[2]!; k <= to[2]!; k++)
      for (let j = from[1]!; j <= to[1]!; j++)
        for (let i = from[0]!; i <= to[0]!; i++) {
          const p: V3 = [origin[0] + i * STEP - a.c[0], origin[1] + j * STEP - a.c[1], origin[2] + k * STEP - a.c[2]];
          const t = Math.max(0, Math.min(1, (p[0] * ab[0] + p[1] * ab[1] + p[2] * ab[2]) / ab2));
          const d = Math.hypot(p[0] - ab[0] * t, p[1] - ab[1] * t, p[2] - ab[2] * t) - r;
          if (d > FAR) continue;
          const o = at(i, j, k);
          field[o] = smin(field[o]!, d, SOFT);
        }
  }
  const sample = (p: V3) => {
    const x = (p[0] - origin[0]) / STEP, y = (p[1] - origin[1]) / STEP, z = (p[2] - origin[2]) / STEP;
    const i = Math.min(nx - 2, Math.max(0, Math.floor(x))), j = Math.min(ny - 2, Math.max(0, Math.floor(y))), k = Math.min(nz - 2, Math.max(0, Math.floor(z)));
    const fx = x - i, fy = y - j, fz = z - k;
    let s = 0;
    for (let c = 0; c < 8; c++) {
      const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
      s += field[at(i + ox, j + oy, k + oz)]! * (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
    }
    return s;
  };
  const cache = new Map<number, number>();
  const total = nx * ny * nz;
  const h = STEP * 0.5;
  const edgeVertex = (i: number, j: number, k: number, e: number, vals: number[]) => {
    const [a, b] = EDGES[e]!;
    const ca = CORNERS[a], cb = CORNERS[b];
    const ka = at(i + ca[0], j + ca[1], k + ca[2]), kb = at(i + cb[0], j + cb[1], k + cb[2]);
    const key = ka < kb ? ka * total + kb : kb * total + ka;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const t = vals[a]! / (vals[a]! - vals[b]!);
    const p: V3 = [origin[0] + (i + ca[0] + (cb[0] - ca[0]) * t) * STEP, origin[1] + (j + ca[1] + (cb[1] - ca[1]) * t) * STEP, origin[2] + (k + ca[2] + (cb[2] - ca[2]) * t) * STEP];
    const v = verts.length / 3;
    verts.push(...p);
    norms.push(
      sample([p[0] + h, p[1], p[2]]) - sample([p[0] - h, p[1], p[2]]),
      sample([p[0], p[1] + h, p[2]]) - sample([p[0], p[1] - h, p[2]]),
      sample([p[0], p[1], p[2] + h]) - sample([p[0], p[1], p[2] - h]),
    );
    owners.push(u);
    cache.set(key, v);
    return v;
  };
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const vals = CORNERS.map(c => field[at(i + c[0], j + c[1], k + c[2])]!);
        let cube = 0;
        for (let c = 0; c < 8; c++) if (vals[c]! < 0) cube |= 1 << c;
        if (edgeTable[cube] === 0) continue;
        const row = cube << 4;
        for (let t = 0; triTable[row + t] !== -1; t += 3) {
          const a = edgeVertex(i, j, k, triTable[row + t]!, vals);
          const b = edgeVertex(i, j, k, triTable[row + t + 1]!, vals);
          const c = edgeVertex(i, j, k, triTable[row + t + 2]!, vals);
          if (a !== b && b !== c && a !== c) tris.push(a, c, b);
        }
      }
}
// Each piece one body: what marching cubes leaves apart from the main body (a crumb at most, now that the chain
// joins the lumps) is dropped, and said.
let crumbs = 0;
subunits.forEach((_, u) => {
  const start = tris.length;
  const firstVertex = verts.length / 3;
  surface(lumps.filter(l => l.unit === u), bonds.filter(b => b.a.unit === u), u);
  const n = verts.length / 3 - firstVertex;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let t = start; t < tris.length; t += 3) {
    const a = root(tris[t]! - firstVertex);
    for (const v of [tris[t + 1]!, tris[t + 2]!]) parent[root(v - firstVertex)] = a;
  }
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) size.set(root(i), (size.get(root(i)) ?? 0) + 1);
  const main = [...size].sort((x, y) => y[1] - x[1])[0]![0];
  const kept: number[] = [];
  for (let t = start; t < tris.length; t += 3) if (root(tris[t]! - firstVertex) === main) kept.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  crumbs += (tris.length - start - kept.length) / 3;
  tris.length = start;
  tris.push(...kept);
  if (size.size > 1) console.log(`subunit ${subunits[u]!.key}: ${size.size} parts, kept the largest (${[...size.values()].sort((x, y) => y - x).join(', ')} vertices)`);
});
console.log(`${bonds.length} joints along the chains; ${crumbs} triangles off the main bodies dropped`);
const count = verts.length / 3;
console.log(`${count} vertices, ${tris.length / 3} triangles`);

// Everything into V4's place.
const position = new Float32Array(count * 3);
const normal = new Float32Array(count * 3);
for (let v = 0; v < count; v++) {
  const m = turn([norms[v * 3]!, norms[v * 3 + 1]!, norms[v * 3 + 2]!]);
  const l = Math.hypot(...m) || 1;
  position.set(place([verts[v * 3]!, verts[v * 3 + 1]!, verts[v * 3 + 2]!]), v * 3);
  normal.set([m[0] / l, m[1] / l, m[2] / l], v * 3);
}

// ---------------------------------------------------------------------------------------------------------------
// Round: V4's outline is a circle (radius RADIUS). Each direction's outer surface (its envelope, smoothed over the
// sphere so the lumps stay) is scaled to it, every point on the same line from the middle by the same factor.

const middle = mean(to);
const BINS_LAT = 90, BINS_LON = 180;
const outer = new Float32Array(BINS_LAT * BINS_LON);
const binOf = (d: V3) => {
  const lat = Math.min(BINS_LAT - 1, Math.floor((Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI) * BINS_LAT));
  const lon = Math.min(BINS_LON - 1, Math.floor(((Math.atan2(d[2], d[0]) + Math.PI) / (2 * Math.PI)) * BINS_LON));
  return lat * BINS_LON + lon;
};
const dirs: V3[] = [];
const radii = new Float32Array(count);
for (let v = 0; v < count; v++) {
  const d: V3 = [position[v * 3]! - middle[0], position[v * 3 + 1]! - middle[1], position[v * 3 + 2]! - middle[2]];
  const r = Math.hypot(...d);
  radii[v] = r;
  const u: V3 = [d[0] / r, d[1] / r, d[2] / r];
  dirs.push(u);
  const b = binOf(u);
  outer[b] = Math.max(outer[b]!, r);
}
const binDir = (b: number): V3 => {
  const lat = ((Math.floor(b / BINS_LON) + 0.5) / BINS_LAT) * Math.PI, lon = ((b % BINS_LON) + 0.5) / BINS_LON * 2 * Math.PI - Math.PI;
  return [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
};
const filled = [...outer].filter(r => r > 0).sort((a, b) => a - b);
const typical = filled[Math.floor(filled.length / 2)]!;
// A window's directions have no outer surface of their own (or only its rim, nearer the middle): left out.
const binDirs = Array.from({ length: outer.length }, (_, b) => binDir(b));
const binArea = Array.from({ length: outer.length }, (_, b) => Math.sin(((Math.floor(b / BINS_LON) + 0.5) / BINS_LAT) * Math.PI));
const SPREAD = Math.cos((14 * Math.PI) / 180);
const envelope = new Float32Array(outer.length);
for (let b = 0; b < outer.length; b++) {
  const d = binDirs[b]!;
  let sum = 0, weight = 0;
  for (let o = 0; o < outer.length; o++) {
    if (outer[o]! < typical * 0.85) continue;
    const e = binDirs[o]!;
    const cos = d[0] * e[0] + d[1] * e[1] + d[2] * e[2];
    if (cos < SPREAD) continue;
    const w = Math.exp(-((1 - cos) / (1 - SPREAD)) * 3) * binArea[o]!;
    sum += outer[o]! * w;
    weight += w;
  }
  envelope[b] = weight ? sum / weight : typical;
}
// Read between the bins (bilinear, round the sphere): a step from one bin to the next would tear the surface.
const envelopeAt = (d: V3) => {
  const lat = (Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI) * BINS_LAT - 0.5;
  const lon = ((Math.atan2(d[2], d[0]) + Math.PI) / (2 * Math.PI)) * BINS_LON - 0.5;
  const i0 = Math.floor(lat), j0 = Math.floor(lon), fi = lat - i0, fj = lon - j0;
  const e = (i: number, j: number) => envelope[Math.min(BINS_LAT - 1, Math.max(0, i)) * BINS_LON + (((j % BINS_LON) + BINS_LON) % BINS_LON)]!;
  return (e(i0, j0) * (1 - fj) + e(i0, j0 + 1) * fj) * (1 - fi) + (e(i0 + 1, j0) * (1 - fj) + e(i0 + 1, j0 + 1) * fj) * fi;
};
for (let v = 0; v < count; v++) {
  const k = RADIUS / envelopeAt(dirs[v]!) / 1.02;
  for (let c = 0; c < 3; c++) position[v * 3 + c] = middle[c]! + (position[v * 3 + c]! - middle[c]!) * k;
}

// ---------------------------------------------------------------------------------------------------------------
// The face: between and round the eyes the gel is smoother and sits just behind them (as in the concept art), so no
// lump covers an eye. Its outer surface is drawn toward the round outline; the inside of the cage is left alone.

const eyes = ['Eye_L', 'Eye_R'].map(name => gltf.nodes.find((n: Json) => n.name === name).translation as V3);
const faceMiddle: V3 = [0, (eyes[0]![1] + eyes[1]![1]) / 2 - 0.12, 1];
const faceDir = (() => {
  const l = Math.hypot(...faceMiddle);
  return faceMiddle.map(c => c / l) as V3;
})();
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
for (let v = 0; v < count; v++) {
  const p: V3 = [position[v * 3]! - middle[0], position[v * 3 + 1]! - middle[1], position[v * 3 + 2]! - middle[2]];
  const r = Math.hypot(...p);
  const u: V3 = [p[0] / r, p[1] / r, p[2] / r];
  const facing = u[0] * faceDir[0] + u[1] * faceDir[1] + u[2] * faceDir[2];
  const n: V3 = [normal[v * 3]!, normal[v * 3 + 1]!, normal[v * 3 + 2]!];
  const outward = n[0] * u[0] + n[1] * u[1] + n[2] * u[2];
  // Only the outer surface of the face: facing out, near the outline.
  const w = FACE * smoothstep(0.82, 0.93, facing) * smoothstep(0.9, 0.98, r / RADIUS) * smoothstep(-0.2, 0.3, outward);
  let target = RADIUS * 0.985;
  // Behind each eye, the gel sits back so the eye rests in it.
  for (const e of eyes) {
    const dx = (p[0] + middle[0] - e[0]) / 0.17, dy = (p[1] + middle[1] - e[1]) / 0.24;
    target -= 0.06 * Math.exp(-(dx * dx + dy * dy));
  }
  if (w <= 0) continue;
  const k = 1 + ((target - r) / r) * w;
  for (let c = 0; c < 3; c++) position[v * 3 + c] = middle[c]! + p[c]! * k;
  // The face's normals turn toward the smooth outline as it gets smoother.
  const blend = (c: number) => n[c]! * (1 - w) + u[c]! * w;
  const m: V3 = [blend(0), blend(1), blend(2)];
  const l = Math.hypot(...m);
  normal.set([m[0] / l, m[1] / l, m[2] / l], v * 3);
}

// ---------------------------------------------------------------------------------------------------------------
// Colour: each subunit's V4 colour, blended where subunits meet (each atom near a point counts by its Gaussian), so
// the gel is mottled rather than patched.

const CELL = 3 * SIGMA;
const g = -1 / (2 * SIGMA * SIGMA);
const cells = new Map<string, number[]>();
const cellKey = (p: V3) => `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)},${Math.floor(p[2] / CELL)}`;
atoms.forEach((a, i) => {
  const key = cellKey(a.p);
  (cells.get(key) ?? cells.set(key, []).get(key)!).push(i);
});
const colour = new Float32Array(count * 3);
const share = new Float64Array(subunits.length);
for (let v = 0; v < count; v++) {
  const p: V3 = [verts[v * 3]!, verts[v * 3 + 1]!, verts[v * 3 + 2]!];
  share.fill(0);
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), cz = Math.floor(p[2] / CELL);
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const i of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const a = atoms[i]!;
          const d2 = (a.p[0] - p[0]) ** 2 + (a.p[1] - p[1]) ** 2 + (a.p[2] - p[2]) ** 2;
          // Wider than the surface's own blur, so the colours run into each other.
          share[a.unit]! += Math.exp(d2 * g * 0.35);
        }
  let sum = 0;
  const c: V3 = [0, 0, 0];
  share.forEach((s, u) => {
    sum += s;
    for (let k = 0; k < 3; k++) c[k]! += s * subunits[u]!.colour[k]!;
  });
  colour.set(sum ? [c[0] / sum, c[1] / sum, c[2] / sum] : subunits[owners[v]!]!.colour, v * 3);
}

// ---------------------------------------------------------------------------------------------------------------
// Back into the glTF: each subunit's mesh gets its own surface; nothing else in the file changes but the bytes it no
// longer needs.

const pieces = subunits.map(() => [] as number[]);
for (let t = 0; t < tris.length; t += 3) pieces[owners[tris[t]!]!]!.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);

type Added = { data: Uint8Array; target?: number; accessor: Json };
const added: Added[] = [];
const replaced = new Set<number>();
subunits.forEach((s, u) => {
  const prim = gltf.meshes[s.mesh].primitives[0];
  for (const a of [prim.attributes.POSITION, prim.attributes.NORMAL, prim.attributes.COLOR_0, prim.indices]) replaced.add(a);
  const local = new Map<number, number>();
  const index: number[] = [];
  for (const v of pieces[u]!) {
    let i = local.get(v);
    if (i === undefined) local.set(v, (i = local.size));
    index.push(i);
  }
  const n = local.size;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Uint8Array(n * 4);
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const [v, i] of local) {
    for (let c = 0; c < 3; c++) {
      const x = position[v * 3 + c]!;
      pos[i * 3 + c] = x;
      min[c] = Math.min(min[c]!, x);
      max[c] = Math.max(max[c]!, x);
      nor[i * 3 + c] = normal[v * 3 + c]!;
      col[i * 4 + c] = Math.round(Math.min(1, Math.max(0, colour[v * 3 + c]!)) * 255);
    }
    col[i * 4 + 3] = 255;
  }
  const idx = n < 65536 ? new Uint16Array(index) : new Uint32Array(index);
  const start = added.length;
  added.push(
    { data: new Uint8Array(pos.buffer), target: 34962, accessor: { componentType: 5126, count: n, type: 'VEC3', min, max } },
    { data: new Uint8Array(nor.buffer), target: 34962, accessor: { componentType: 5126, count: n, type: 'VEC3' } },
    { data: col, target: 34962, accessor: { componentType: 5121, normalized: true, count: n, type: 'VEC4' } },
    { data: new Uint8Array(idx.buffer), target: 34963, accessor: { componentType: idx instanceof Uint16Array ? 5123 : 5125, count: idx.length, type: 'SCALAR' } },
  );
  prim.attributes.POSITION = -1 - start;
  prim.attributes.NORMAL = -1 - (start + 1);
  prim.attributes.COLOR_0 = -1 - (start + 2);
  prim.indices = -1 - (start + 3);
});

// Every accessor still used, its bytes copied into a fresh buffer; the body's new ones after them.
const chunks: Uint8Array[] = [];
let length = 0;
const views: Json[] = [];
const accessors: Json[] = [];
const push = (data: Uint8Array, target?: number) => {
  const pad = (4 - (length % 4)) % 4;
  if (pad) chunks.push(new Uint8Array(pad));
  length += pad;
  views.push({ buffer: 0, byteOffset: length, byteLength: data.length, ...(target ? { target } : {}) });
  chunks.push(data);
  length += data.length;
  return views.length - 1;
};
const remap = new Map<number, number>();
gltf.accessors.forEach((a: Json, i: number) => {
  if (replaced.has(i)) return;
  const view = gltf.bufferViews[a.bufferView];
  const bytes = Uint8Array.prototype.slice.call(bin, view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const copy = { ...a, bufferView: push(bytes, view.target) };
  remap.set(i, accessors.push(copy) - 1);
});
added.forEach((a, i) => {
  remap.set(-1 - i, accessors.push({ ...a.accessor, bufferView: push(a.data, a.target) }) - 1);
});
const re = (i: number) => {
  const j = remap.get(i);
  if (j === undefined) throw new Error(`accessor ${i} has no place`);
  return j;
};
for (const mesh of gltf.meshes)
  for (const prim of mesh.primitives) {
    for (const k of Object.keys(prim.attributes)) prim.attributes[k] = re(prim.attributes[k]);
    if (prim.indices !== undefined) prim.indices = re(prim.indices);
    if (prim.targets) prim.targets = prim.targets.map((t: Json) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, re(v as number)])));
  }
for (const anim of gltf.animations ?? []) for (const s of anim.samplers) (s.input = re(s.input)), (s.output = re(s.output));
gltf.accessors = accessors;
gltf.bufferViews = views;
gltf.buffers = [{ byteLength: length }];
gltf.asset.generator = 'Chapp body: scripts/chapp-model/body.ts (face and expressions: Chapp reference reconstruction / Codex)';
gltf.asset.extras = {
  ...gltf.asset.extras,
  description:
    'Chapp V5: the V4 face and expressions on a body of round lumps, rebuilt from the PDB 1SHS biological assembly. All 24 subunits and the 14 windows are kept; the outline is rounded to a circle and the face is smoothed, as an artistic choice.',
  v4Subunits: Object.fromEntries(subunits.map(s => [s.key, { middle: s.middle, colour: s.colour }])),
  surface_rounding: `${LUMPS} lumps per subunit (k-means of residues), radius ${GROW} × spread + ${BASE} Å, smooth union ${SOFT} Å, windows opened ${OPEN}°, grid ${STEP} Å; radial envelope normalised to radius ${RADIUS}; face smoothing ${FACE}.`,
};

const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const binPad = (4 - (length % 4)) % 4;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + jsonPad + 8 + length + binPad, 8);
const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(jsonBytes.length + jsonPad, 0);
jsonHead.writeUInt32LE(0x4e4f534a, 4);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(length + binPad, 0);
binHead.writeUInt32LE(0x004e4942, 4);
writeFileSync(OUT, Buffer.concat([header, jsonHead, jsonBytes, Buffer.alloc(jsonPad, 0x20), binHead, ...chunks, Buffer.alloc(binPad)]));
console.log(`${OUT}: ${(Buffer.byteLength(JSON.stringify(gltf)) / 1024).toFixed(0)} KB JSON, ${(length / 1024 / 1024).toFixed(2)} MB of data`);
