// The V1 mascot, retired for Chapp V4 (public/chapp/chapp.glb, 24 Hsp16.5 subunits); its model and stills are in v1/.
// Builds chapp.glb: one smooth protein-like body (signed distance field + marching cubes),
// glossy eyes with glints, a small smile, blush and a blue → teal → lavender gradient baked
// into vertex colors, plus "breathe" and "blink" animations.
import { writeFileSync } from 'node:fs';
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

const OUT = process.argv[2] || 'public/chapp/chapp.glb';
const STEP = Number(process.argv[3] || 0.024);

// ---------------------------------------------------------------- shape

const len = (x, y, z) => Math.hypot(x, y, z);
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
function ellipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = px - cx, y = py - cy, z = pz - cz;
  const k0 = len(x / rx, y / ry, z / rz), k1 = len(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
const sphere = (px, py, pz, cx, cy, cz, r) => len(px - cx, py - cy, pz - cz) - r;
const hash = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

const EYE = { x: 0.365, y: 0.04 };
// The molecular surface: soft bumps everywhere except the face, so the face stays clean.
const BUMPS = [];
const N = 58;
for (let i = 0; i < N; i++) {
  const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), t = i * Math.PI * (3 - Math.sqrt(5));
  const d = [Math.cos(t) * r, y, Math.sin(t) * r];
  if (d[2] > 0.3 && d[1] > -0.62 && d[1] < 0.58 && Math.abs(d[0]) < 0.86) continue;
  if (d[1] < -0.82) continue;
  BUMPS.push({ c: [d[0] * 0.84, d[1] * 0.8 + 0.02, d[2] * 0.79], r: 0.235 + hash(i) * 0.06 });
}
const PUFFS = [[-0.3, 0.9, 0.1, 0.235], [0.02, 1.02, 0.02, 0.265], [0.33, 0.88, 0.08, 0.215]];

function sdf(x, y, z) {
  let d = ellipsoid(x, y, z, 0, 0.04, 0, 1.0, 0.95, 0.88);
  d = smin(d, ellipsoid(x, y, z, 0, -0.34, 0, 1.03, 0.62, 0.9), 0.32);
  for (const b of BUMPS) d = smin(d, sphere(x, y, z, b.c[0], b.c[1], b.c[2], b.r), 0.14);
  for (const p of PUFFS) d = smin(d, sphere(x, y, z, p[0], p[1], p[2], p[3]), 0.12);
  // shallow sockets so the eyes sit in the face instead of on it
  for (const s of [-1, 1]) d = smax(d, -ellipsoid(x, y, z, s * EYE.x, EYE.y, 0.95, 0.17, 0.22, 0.09), 0.08);
  return d;
}

const grad = (x, y, z) => {
  const e = 0.004;
  const g = [sdf(x + e, y, z) - sdf(x - e, y, z), sdf(x, y + e, z) - sdf(x, y - e, z), sdf(x, y, z + e) - sdf(x, y, z - e)];
  const l = len(...g);
  return [g[0] / l, g[1] / l, g[2] / l];
};
// where a ray from the front hits the face
const faceZ = (x, y) => { let z = 1.6; for (let i = 0; i < 200; i++) { const d = sdf(x, y, z); if (d < 1e-4) break; z -= d * 0.9; } return z; };

// ---------------------------------------------------------------- marching cubes

const B = { x: [-1.4, 1.4], y: [-1.25, 1.42], z: [-1.3, 1.3] };
const nx = Math.ceil((B.x[1] - B.x[0]) / STEP) + 1, ny = Math.ceil((B.y[1] - B.y[0]) / STEP) + 1, nz = Math.ceil((B.z[1] - B.z[0]) / STEP) + 1;
const field = new Float32Array(nx * ny * nz);
const at = (i, j, k) => i + nx * (j + ny * k);
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) field[at(i, j, k)] = sdf(B.x[0] + i * STEP, B.y[0] + j * STEP, B.z[0] + k * STEP);

const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const verts = [], index = [], cache = new Map();
function edgeVertex(i, j, k, e, vals) {
  const [a, b] = EDGES[e];
  const ca = CORNERS[a], cb = CORNERS[b];
  const ga = [i + ca[0], j + ca[1], k + ca[2]], gb = [i + cb[0], j + cb[1], k + cb[2]];
  const ka = at(...ga), kb = at(...gb);
  const key = ka < kb ? ka * 8e6 + kb : kb * 8e6 + ka;
  let v = cache.get(key);
  if (v !== undefined) return v;
  const t = vals[a] / (vals[a] - vals[b]);
  const p = [0, 1, 2].map((c) => (ga[c] + (gb[c] - ga[c]) * t) * STEP + [B.x[0], B.y[0], B.z[0]][c]);
  v = verts.length / 3;
  verts.push(p[0], p[1], p[2]);
  cache.set(key, v);
  return v;
}
for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
  const vals = CORNERS.map((c) => field[at(i + c[0], j + c[1], k + c[2])]);
  let cube = 0;
  for (let c = 0; c < 8; c++) if (vals[c] < 0) cube |= 1 << c;
  if (edgeTable[cube] === 0) continue;
  const row = cube << 4;
  for (let t = 0; triTable[row + t] !== -1; t += 3) {
    const a = edgeVertex(i, j, k, triTable[row + t], vals);
    const b = edgeVertex(i, j, k, triTable[row + t + 1], vals);
    const c = edgeVertex(i, j, k, triTable[row + t + 2], vals);
    if (a !== b && b !== c && a !== c) index.push(a, c, b);
  }
}

// ---------------------------------------------------------------- colour, normals

const srgb = (hex) => [0, 2, 4].map((o) => parseInt(hex.slice(1 + o, 3 + o), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const LAVENDER = srgb('#a99cf0'), BLUE = srgb('#79b9f3'), TEAL = srgb('#6fd3c6'), FACE = srgb('#d3ebfb'), BLUSH = srgb('#ff93b6');

const normals = new Float32Array(verts.length), colors = new Uint8Array((verts.length / 3) * 4);
for (let v = 0; v < verts.length / 3; v++) {
  const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
  const n = grad(x, y, z);
  normals.set(n, v * 3);
  let c = mix(LAVENDER, BLUE, smooth(-0.85, 0.15, y));
  c = mix(c, TEAL, smooth(0.45, 1.15, y) * 0.85);
  c = mix(c, FACE, smooth(0.35, 0.95, n[2]) * smooth(-0.75, -0.25, y) * (1 - smooth(0.5, 0.85, y)) * 0.5);
  for (const s of [-1, 1]) {
    const dx = x - s * 0.64, dy = y + 0.17, w = Math.exp(-(dx * dx) / 0.026 - (dy * dy) / 0.014) * smooth(0.2, 0.6, z);
    c = mix(c, BLUSH, w * 0.7);
  }
  // ambient occlusion from the field: how much room there is along the normal
  let ao = 0;
  for (const h of [0.04, 0.09, 0.16]) ao += Math.min(1, Math.max(0, sdf(x + n[0] * h, y + n[1] * h, z + n[2] * h) / h));
  c = c.map((ch) => ch * (0.7 + 0.3 * (ao / 3)));
  colors.set([...c.map((ch) => Math.round(toLinear(ch) * 255)), 255], v * 4);
}

// ---------------------------------------------------------------- face parts

function uvSphere(rx, ry, rz, seg = 40, ring = 28, color) {
  const p = [], nrm = [], col = [], idx = [];
  for (let r = 0; r <= ring; r++) {
    const th = (r / ring) * Math.PI, sy = Math.cos(th), sr = Math.sin(th);
    for (let s = 0; s <= seg; s++) {
      const ph = (s / seg) * Math.PI * 2, sx = sr * Math.cos(ph), sz = sr * Math.sin(ph);
      p.push(sx * rx, sy * ry, sz * rz);
      const nn = [sx / rx, sy / ry, sz / rz], l = len(...nn);
      nrm.push(nn[0] / l, nn[1] / l, nn[2] / l);
      if (color) col.push(...color(sx, sy, sz));
    }
  }
  for (let r = 0; r < ring; r++) for (let s = 0; s < seg; s++) {
    const a = r * (seg + 1) + s, b = a + seg + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  return { p, n: nrm, c: col.length ? col : null, i: idx };
}
// a thin tube along a curve, used for the smile
function tube(points, radius, seg = 12) {
  const p = [], nrm = [], idx = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], tl = len(...t);
    const T = t.map((v) => v / tl), up = [0, 0, 1];
    let Nn = [T[1] * up[2] - T[2] * up[1], T[2] * up[0] - T[0] * up[2], T[0] * up[1] - T[1] * up[0]];
    const nl = len(...Nn); Nn = Nn.map((v) => v / nl);
    const Bn = [T[1] * Nn[2] - T[2] * Nn[1], T[2] * Nn[0] - T[0] * Nn[2], T[0] * Nn[1] - T[1] * Nn[0]];
    for (let s = 0; s <= seg; s++) {
      const ang = (s / seg) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
      const d = [0, 1, 2].map((c) => Nn[c] * cs + Bn[c] * sn);
      p.push(...points[i].map((v, c) => v + d[c] * radius));
      nrm.push(...d);
    }
  }
  for (let i = 0; i < points.length - 1; i++) for (let s = 0; s < seg; s++) {
    const a = i * (seg + 1) + s, b = a + seg + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  // round caps
  for (const end of [0, points.length - 1]) {
    const cap = uvSphere(radius, radius, radius, 12, 8);
    const base = p.length / 3;
    p.push(...cap.p.map((v, i) => v + points[end][i % 3]));
    nrm.push(...cap.n);
    idx.push(...cap.i.map((v) => v + base));
  }
  return { p, n: nrm, c: null, i: idx };
}

const NAVY = srgb('#16233f'), IRIS = srgb('#2f5e9e');
const eyeShape = uvSphere(0.158, 0.21, 0.082, 48, 32, (sx, sy, sz) => {
  // dark at the top, a little blue light pooling at the bottom
  const t = smooth(0.1, -0.85, sy) * smooth(-0.2, 0.6, sz);
  return [...mix(NAVY, IRIS, t).map(toLinear), 1];
});
const glintBig = uvSphere(0.052, 0.066, 0.015, 24, 16);
const glintSmall = uvSphere(0.025, 0.025, 0.011, 16, 12);
const eyes = [-1, 1].map((s) => {
  const x = s * EYE.x, y = EYE.y, z = faceZ(x, y);
  const n = grad(x, y, z);
  return { s, pos: [x, y, z - 0.016], rotY: Math.atan2(n[0], n[2]) * 0.9, rotX: -Math.atan2(n[1], n[2]) * 0.6 };
});
const smilePts = [];
for (let i = 0; i <= 24; i++) {
  const u = -1 + (2 * i) / 24, x = u * 0.095, y = -0.235 - (1 - u * u) * 0.05;
  smilePts.push([x, y, faceZ(x, y) + 0.008]);
}
const smile = tube(smilePts, 0.017);

// ---------------------------------------------------------------- glTF

const chunks = [];
let binLength = 0;
const bufferViews = [], accessors = [];
function addView(typed, target) {
  const pad = (4 - (binLength % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); binLength += pad; }
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
  chunks.push(bytes); binLength += bytes.byteLength;
  return bufferViews.length - 1;
}
function addAccessor(typed, type, componentType, opts = {}) {
  const view = addView(typed, opts.target);
  const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const acc = { bufferView: view, componentType, count: typed.length / comps, type, ...(opts.normalized ? { normalized: true } : {}) };
  if (opts.minmax) {
    const min = Array(comps).fill(Infinity), max = Array(comps).fill(-Infinity);
    for (let i = 0; i < typed.length; i++) { const c = i % comps; min[c] = Math.min(min[c], typed[i]); max[c] = Math.max(max[c], typed[i]); }
    acc.min = min; acc.max = max;
  }
  accessors.push(acc);
  return accessors.length - 1;
}
function addMesh(name, geo, material) {
  const attrs = {
    POSITION: addAccessor(new Float32Array(geo.p), 'VEC3', 5126, { minmax: true, target: 34962 }),
    NORMAL: addAccessor(new Float32Array(geo.n), 'VEC3', 5126, { target: 34962 }),
  };
  if (geo.c) attrs.COLOR_0 = addAccessor(geo.c instanceof Uint8Array ? geo.c : new Uint8Array(geo.c.map((v) => Math.round(v * 255))), 'VEC4', 5121, { normalized: true, target: 34962 });
  const big = geo.p.length / 3 > 65535;
  const indices = addAccessor(big ? new Uint32Array(geo.i) : new Uint16Array(geo.i), 'SCALAR', big ? 5125 : 5123, { target: 34963 });
  meshes.push({ name, primitives: [{ attributes: attrs, indices, material }] });
  return meshes.length - 1;
}
const meshes = [];
const materials = [
  { name: 'chapp_body', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.46 },
    extensions: { KHR_materials_sheen: { sheenColorFactor: [0.62, 0.58, 0.96], sheenRoughnessFactor: 0.5 }, KHR_materials_clearcoat: { clearcoatFactor: 0.18, clearcoatRoughnessFactor: 0.35 } } },
  { name: 'chapp_eye', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.24 },
    extensions: { KHR_materials_specular: { specularFactor: 0.3 } } },
  { name: 'chapp_glint', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.2 }, emissiveFactor: [1, 1, 1] },
  { name: 'chapp_smile', pbrMetallicRoughness: { baseColorFactor: [...NAVY.map(toLinear), 1], metallicFactor: 0, roughnessFactor: 0.5 } },
];

const bodyMesh = addMesh('body', { p: verts, n: Array.from(normals), c: colors, i: index }, 0);
const eyeMesh = addMesh('eye', eyeShape, 1);
const glintMesh = addMesh('glint', glintBig, 2);
const glintSmallMesh = addMesh('glint_small', glintSmall, 2);
const smileMesh = addMesh('smile', smile, 3);

const quat = (rx, ry) => { // rotation X then Y
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2), cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
  return [sx * cy, cx * sy, -sx * sy, cx * cy];
};
const nodes = [{ name: 'chapp', children: [] }, { name: 'body', mesh: bodyMesh }, { name: 'smile', mesh: smileMesh }];
nodes[0].children.push(1, 2);
for (const e of eyes) {
  const side = e.s < 0 ? 'L' : 'R';
  const g1 = nodes.push({ name: 'glint_' + side, mesh: glintMesh, translation: [-0.05, 0.075, 0.074], rotation: [0, 0, Math.sin(-0.25), Math.cos(-0.25)] }) - 1;
  const g2 = nodes.push({ name: 'glint_small_' + side, mesh: glintSmallMesh, translation: [0.054, -0.08, 0.07] }) - 1;
  const eye = nodes.push({ name: 'eye_' + side, mesh: eyeMesh, translation: e.pos, rotation: quat(e.rotX, e.rotY), children: [g1, g2] }) - 1;
  nodes[0].children.push(eye);
}

// Animations: a slow breath with a float, and a blink every four seconds.
const animations = [];
function track(name, channels) {
  const samplers = [], chans = [];
  for (const ch of channels) {
    const input = addAccessor(new Float32Array(ch.t), 'SCALAR', 5126, { minmax: true });
    const output = addAccessor(new Float32Array(ch.v.flat()), 'VEC3', 5126);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    chans.push({ sampler: samplers.length - 1, target: { node: ch.node, path: ch.path } });
  }
  animations.push({ name, samplers, channels: chans });
}
const T = Array.from({ length: 33 }, (_, i) => (i / 32) * 3.6);
track('breathe', [
  { node: 0, path: 'translation', t: T, v: T.map((t) => [0, 0.045 * Math.sin((t / 3.6) * Math.PI * 2), 0]) },
  { node: 0, path: 'scale', t: T, v: T.map((t) => { const b = Math.sin((t / 3.6) * Math.PI * 2); return [1 + 0.012 * b, 1 - 0.014 * b, 1 + 0.012 * b]; }) },
]);
const eyeNodes = nodes.map((n, i) => (n.name.startsWith('eye_') ? i : -1)).filter((i) => i >= 0);
const BT = [0, 3.2, 3.28, 3.34, 3.44, 4];
track('blink', eyeNodes.map((node) => ({ node, path: 'scale', t: BT, v: [[1, 1, 1], [1, 1, 1], [1.04, 0.12, 1], [1.04, 0.12, 1], [1, 1, 1], [1, 1, 1]] })));

const json = {
  asset: { version: '2.0', generator: 'Chapp build_chapp.mjs' },
  extensionsUsed: ['KHR_materials_sheen', 'KHR_materials_clearcoat', 'KHR_materials_specular'],
  scene: 0, scenes: [{ name: 'Chapp', nodes: [0] }],
  nodes, meshes, materials, accessors, bufferViews, animations,
  buffers: [{ byteLength: 0 }],
};
const pad4 = (n) => (n + 3) & ~3;
const bin = new Uint8Array(pad4(binLength));
let off = 0;
for (const c of chunks) { bin.set(c, off); off += c.byteLength; }
json.buffers[0].byteLength = bin.byteLength;
let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
const jsonPadded = new Uint8Array(pad4(jsonBytes.length)).fill(0x20);
jsonPadded.set(jsonBytes);
const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
const out = new Uint8Array(total), dv = new DataView(out.buffer);
dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
dv.setUint32(12, jsonPadded.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonPadded, 20);
const b0 = 20 + jsonPadded.length;
dv.setUint32(b0, bin.length, true); dv.setUint32(b0 + 4, 0x004e4942, true); out.set(bin, b0 + 8);
writeFileSync(OUT, out);
console.log(`${OUT}: ${(total / 1024).toFixed(0)} KB, body ${verts.length / 3} verts / ${index.length / 3} tris, ${BUMPS.length} bumps, eyes at z ${eyes.map((e) => e.pos[2].toFixed(3)).join(', ')}`);
