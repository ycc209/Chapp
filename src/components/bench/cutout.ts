import { useEffect, useRef, useState } from 'react';
import type { Box } from '../../../shared/ai.ts';
import { api } from '../../api/client.ts';
import { layOver, locate, uprightTurn, type Cap } from './whole.ts';

/**
 * The user's photo of a bottle (its 240 px square crop from the kit), cut out of its background on the phone, so it
 * can stand on the bench in place of the drawn bottle. No model: the background is what grows in from the crop's
 * edges in small colour steps (a table, a wall, a gradient, a shadow), and the bottle is the largest thing left near
 * the middle. When SAM 3.1 found the bottle, its mask is the cut instead (cutAlong), checked as the phone's own cut
 * is: a bottle the photo cuts off at its edge is not whole. The cut is made as soon as the bottle is matched
 * (screens/kit/store.ts) and says whether it came out whole (`ok`), or why not: the kit screen (or the protocol, after
 * a video) shows a poor one and asks for a photo of just that bottle, unless the user keeps it (keepAsIs), and the
 * bench keeps its drawn bottle until there is a whole one. SAM's cuts are kept on the phone by the crop they were made
 * from, so the bench finds them again after a reload.
 *
 * On the bench the bottle stands as `benchCut` makes it (whole.ts): turned upright when the photo has it lying down
 * (which end is its cap, Muse Spark says),
 * then whole, Muse Image filling in what a hand or the photo's edge hid, the photo laid over its picture. Each step is
 * shown as soon as it is ready; the whole one is kept on the phone like SAM's cuts, so Muse Image draws a bottle once.
 */
export type Cut = {
  src: string;
  width: number;
  height: number;
  /** Whole and on its own: one bottle, not cut off at the crop's edge, out of a background that could be told apart. */
  ok: boolean;
  /** Why not, in Chapp's words ("it’s cut off at the edge"); null when ok. */
  why: string | null;
  /** Where the cut's top left is on the crop, in its pixels. */
  at?: [number, number];
  /** How far along the bench's making it is: turned upright, or made whole (or as whole as it could be made). */
  stage?: 'upright' | 'whole';
  /** Of a whole bottle, the share Muse Image drew (what the photo hid); 0 when all of it is the photo. */
  drawn?: number;
};

/** Neighbouring background pixels differ by less than this (RGB distance): JPEG noise and gradients, not an edge. */
const STEP = 12;
/** …and stay this close to the edge colour they grew from, so a soft edge (a white bottle on white) can't be crossed. */
const FAR = 30;
/** Seeds on the crop's edge are within this of the edge's median colour. */
const NEAR = 64;

const cuts = new Map<string, Promise<Cut>>();
const unopened = (src: string): Cut => ({ src, width: 1, height: 1, ok: false, why: 'the photo could not be opened' });

/** The photo's cut-out, made once per photo: SAM's when it was kept, else the phone's own. */
export function cutOut(src: string): Promise<Cut> {
  if (typeof document === 'undefined') return Promise.resolve(unopened(src));
  let cut = cuts.get(src);
  if (!cut) {
    const had = keptCut(src);
    cut = had
      ? Promise.resolve(had)
      : load(src)
          .then(img => cutFrom(img))
          .catch(() => unopened(src));
    cuts.set(src, cut);
  }
  return cut;
}

/**
 * The cut along SAM's outline of the bottle (an SVG path of M/L/Z in fractions of the photo): the mask is the cut,
 * so it comes out whole. `square` is where the crop sits on the photo. Kept on the phone; when it cannot be made,
 * the phone's own cut stands in.
 */
export function cutAlong(crop: string, outline: string, square: Box): Promise<Cut> {
  if (typeof document === 'undefined') return cutOut(crop);
  const cut = load(crop)
    .then(img => {
      const made = alongFrom(img, outline, square);
      keepCut(crop, made);
      return made;
    })
    .catch(() => {
      cuts.delete(crop);
      return cutOut(crop);
    });
  cuts.set(crop, cut);
  return cut;
}

// SAM's cuts, kept by the crop they were made from (its hash: the crop itself is in the run).
const KEPT = 'chapp.cuts';
const KEEP_AT_MOST = 32;
type Kept = { order: string[]; cuts: Record<string, Cut> };
let table: Kept | null = null;

function keyOf(src: string): string {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) | 0;
  return `${src.length}-${(h >>> 0).toString(36)}`;
}

function kept(): Kept {
  if (!table) {
    try {
      table = JSON.parse(localStorage.getItem(KEPT) ?? '') as Kept;
      if (!Array.isArray(table.order) || typeof table.cuts !== 'object') throw new Error();
    } catch {
      table = { order: [], cuts: {} };
    }
  }
  return table;
}

const keptCut = (src: string, kind = ''): Cut | undefined => kept().cuts[kind + keyOf(src)];

function keepCut(src: string, cut: Cut, kind = '') {
  const key = kind + keyOf(src);
  const k = kept();
  k.cuts[key] = cut;
  k.order = [...k.order.filter(o => o !== key), key];
  while (k.order.length > KEEP_AT_MOST) delete k.cuts[k.order.shift()!];
  try {
    localStorage.setItem(KEPT, JSON.stringify(k));
  } catch {
    /* not kept past this page */
  }
}

function alongFrom(img: HTMLImageElement, outline: string, square: Box): Cut {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!w || !h || !g) throw new Error('no canvas');
  g.drawImage(img, 0, 0);
  const on = outlineInCrop(outline, square, w, h);
  g.globalCompositeOperation = 'destination-in';
  g.fill(new Path2D(on.d));
  const cw = on.right - on.left + 1;
  const ch = on.bottom - on.top + 1;
  const trimmed = document.createElement('canvas');
  trimmed.width = cw;
  trimmed.height = ch;
  trimmed.getContext('2d')!.drawImage(canvas, on.left, on.top, cw, ch, 0, 0, cw, ch);
  const why = alongWhy(on, w, h);
  return { src: trimmed.toDataURL('image/png'), width: cw, height: ch, ok: why === null, why, at: [on.left, on.top] };
}

/**
 * Why a cut along SAM's outline is not whole, in Chapp's words as the phone's own cut says it; null when it is. The
 * crop leaves a margin round the bottle (shared/kit.ts squareOn), so an outline reaching the crop's edge is a bottle
 * the photo cuts off. Pure, so it is tested.
 */
export function alongWhy(on: { left: number; top: number; right: number; bottom: number }, w: number, h: number): string | null {
  return on.left <= 1 || on.top <= 1 || on.right >= w - 2 || on.bottom >= h - 2 ? 'it’s cut off at the edge' : null;
}

// Cuts the user kept though they did not come out whole ("Keep it"), by their crop: not asked about again.
const AS_IS = 'chapp.keptAsIs';

export function keptAsIs(src: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(AS_IS) ?? '[]') as string[]).includes(keyOf(src));
  } catch {
    return false;
  }
}

export function keepAsIs(src: string) {
  try {
    const keys = (JSON.parse(localStorage.getItem(AS_IS) ?? '[]') as string[]).filter(k => k !== keyOf(src));
    localStorage.setItem(AS_IS, JSON.stringify([...keys, keyOf(src)].slice(-KEEP_AT_MOST)));
  } catch {
    /* asked again after a reload */
  }
}

/**
 * SAM's outline (fractions of the photo) on the crop (`square` of the photo, drawn `w` × `h`): the path in the
 * crop's pixels and the box round it, within the crop. Pure, so it is tested.
 */
export function outlineInCrop(outline: string, square: Box, w: number, h: number): { d: string; left: number; top: number; right: number; bottom: number } {
  const numbers = (outline.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) pts.push([((numbers[i]! - square.x) / square.width) * w, ((numbers[i + 1]! - square.y) / square.height) * h]);
  // Whole pixels round the points, a hair of floating-point error forgiven.
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return {
    d: pts.length ? `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z` : '',
    left: Math.floor(clamp(Math.min(...xs) + 1e-6, w - 1)),
    top: Math.floor(clamp(Math.min(...ys) + 1e-6, h - 1)),
    right: Math.ceil(clamp(Math.max(...xs) - 1e-6, w - 1)),
    bottom: Math.ceil(clamp(Math.max(...ys) - 1e-6, h - 1)),
  };
}

/**
 * The bottle as the bench shows it: its cut-out once ready, then upright, then whole (benchCut), each as it comes;
 * null before (and on the server, where there is no canvas).
 */
export function useCutout(src: string | undefined): Cut | null {
  const [cut, setCut] = useState<Cut | null>(null);
  useEffect(() => {
    setCut(null);
    if (!src) return;
    let live = true;
    let shown = -1;
    const rank = (c: Cut) => (c.stage === 'whole' ? 2 : c.stage === 'upright' ? 1 : 0);
    const show = (c: Cut) => {
      if (!live || rank(c) < shown) return;
      shown = rank(c);
      setCut(c);
    };
    void cutOut(src).then(show);
    void benchCut(src, show);
    return () => {
      live = false;
    };
  }, [src]);
  return cut;
}

// ---------------------------------------------------------------------------------------------------------------
// On the bench: upright, then whole (whole.ts).

// Kept under a new name when how they are made changes: the first ones took the narrower end for the cap, the
// second and third let the drawing's words onto the photo's label, the fourth added the drawing's slightly bigger
// outline to bottles that were whole.
const WHOLE = 'w5-';
const benches = new Map<string, Promise<Cut>>();
/** Set once the server says it draws no bottles (the mock): the bench keeps the upright cut. */
let noDrawing = false;

/** RGBA of an image, drawn at `w` × `h` (its own size when not given). */
function pixelsOf(img: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

function canvasOf(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const data = g.createImageData(w, h);
  data.data.set(rgba);
  g.putImageData(data, 0, 0);
  return canvas;
}

/** `source` turned `deg` clockwise about its centre, on a canvas `size` square, `fill` behind (transparent when none). */
function turned(source: CanvasImageSource, w: number, h: number, deg: number, size: number, fill?: string): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  if (fill) {
    g.fillStyle = fill;
    g.fillRect(0, 0, size, size);
  }
  g.translate(size / 2, size / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(source, -w / 2, -h / 2, w, h);
  return g.getImageData(0, 0, size, size).data;
}

/** The trimmed PNG of the opaque part of `rgba`. */
function trimmedCut(rgba: Uint8ClampedArray, w: number, h: number, extra: Partial<Cut>): Cut | null {
  let [left, top, right, bottom] = [w, h, -1, -1];
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3]! <= 8) continue;
    const x = i % w, y = (i / w) | 0;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  const cw = right - left + 1, ch = bottom - top + 1;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d')!.drawImage(canvasOf(rgba, w, h), left, top, cw, ch, 0, 0, cw, ch);
  return { src: out.toDataURL('image/png'), width: cw, height: ch, ok: true, why: null, ...extra };
}

const OVER: Record<Cap, Cap> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/**
 * Which way the cut's cap points (the shape alone cannot say), asked of Muse Spark twice: the bottle alone on white,
 * and the same turned over. Only an answer the two agree on counts; else null, and the bottle is only straightened.
 * Alone, so a neighbour's cap cannot answer for it; on the 3T3-L1 kit's crowded vials and the BCA kit's bottles, every
 * answer was right this way, where the whole crop got one vial of five wrong.
 */
async function capOf(piece: HTMLImageElement, w: number, h: number): Promise<Cap | null> {
  const view = (deg: number) => {
    const scale = 2, pad = 20;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale + 2 * pad;
    canvas.height = h * scale + 2 * pad;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((deg * Math.PI) / 180);
    g.drawImage(piece, (-w * scale) / 2, (-h * scale) / 2, w * scale, h * scale);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    return url.slice(url.indexOf(',') + 1);
  };
  try {
    const [a, b] = await Promise.all([0, 180].map(async deg => (await api.bottleCap({ photo: { type: 'image/jpeg', data: view(deg) } })).cap));
    return a && b && OVER[a] === b ? a : null;
  } catch {
    return null;
  }
}

/**
 * The bottle for the bench, from the crop `src`: upright (shown through `show` at once), then whole when Muse Image
 * can draw it (kept). A cut that is not whole stays as it is; anything that fails leaves the step before.
 */
export function benchCut(src: string, show: (cut: Cut) => void = () => {}): Promise<Cut> {
  if (typeof document === 'undefined') return cutOut(src);
  const had = keptCut(src, WHOLE);
  if (had) {
    show(had);
    return Promise.resolve(had);
  }
  let made = benches.get(src);
  if (!made) {
    made = makeBenchCut(src, show).catch(() => cutOut(src));
    benches.set(src, made);
  } else void made.then(show);
  return made;
}

async function makeBenchCut(src: string, show: (cut: Cut) => void): Promise<Cut> {
  const base = await cutOut(src);
  if (!base.ok) return base;
  const [crop, piece] = await Promise.all([load(src), load(base.src)]);
  const w = crop.naturalWidth, h = crop.naturalHeight;
  const cropPx = pixelsOf(crop, w, h);
  const piecePx = pixelsOf(piece, base.width, base.height);
  const at = base.at ?? locate(piecePx, base.width, base.height, cropPx, w, h);
  if (!at) return base;

  // The cut's mask on the crop, the turn that stands it up, and both turned onto a square that holds them.
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++) {
      const X = x + at[0], Y = y + at[1];
      if (X < w && Y < h) mask[Y * w + X] = piecePx[(y * base.width + x) * 4 + 3]!;
    }
  const deg = uprightTurn(mask, w, h, await capOf(piece, base.width, base.height));
  const r = (deg * Math.PI) / 180;
  const size = Math.ceil(Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r)));
  const maskRGBA = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) (maskRGBA[i * 4] = maskRGBA[i * 4 + 1] = maskRGBA[i * 4 + 2] = 255), (maskRGBA[i * 4 + 3] = mask[i]!);
  const upCrop = turned(crop, w, h, deg, size, '#ffffff');
  const upMaskRGBA = turned(canvasOf(maskRGBA, w, h), w, h, deg, size);
  const upMask = new Uint8Array(size * size);
  const upCut = new Uint8ClampedArray(upCrop);
  for (let i = 0; i < size * size; i++) (upMask[i] = upMaskRGBA[i * 4 + 3]!), (upCut[i * 4 + 3] = upMask[i]!);
  const upright = deg ? trimmedCut(upCut, size, size, { stage: 'upright' }) : { ...base, stage: 'upright' as const };
  if (!upright) return base;
  show(upright);
  if (noDrawing) return upright;

  // Muse Image's picture of it whole, in the same frame; the photo laid over it.
  const jpeg = canvasOf(upCrop, size, size).toDataURL('image/jpeg', 0.9);
  let drawn: string;
  try {
    const reply = await api.wholeBottle({ photo: { type: 'image/jpeg', data: jpeg.slice(jpeg.indexOf(',') + 1) } });
    drawn = `data:${reply.photo.type};base64,${reply.photo.data}`;
  } catch (error) {
    // The mock and servers without Muse Image say so (501): no point asking again on this page.
    if (/cannot draw bottles/.test(String((error as Error)?.message))) noDrawing = true;
    return upright;
  }
  const picture = await load(drawn);
  const laid = layOver(upCrop, upMask, pixelsOf(picture, size, size), size, size);
  const whole = laid ? trimmedCut(laid.rgba, laid.width, laid.height, { stage: 'whole', drawn: Math.round((1 - laid.share) * 100) / 100 }) : null;
  // Kept either way: a picture that did not fit this bottle would not fit it the next time either.
  const done = whole ?? { ...upright, stage: 'whole' as const, drawn: 0 };
  keepCut(src, done, WHOLE);
  show(done);
  return done;
}

/** The cut-outs of several photos (by any key), each as it is ready; a key whose photo changed is missing until then. */
export function useCutouts(srcs: Record<string, string>): Record<string, Cut> {
  const [found, setFound] = useState<Record<string, Cut>>({});
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [key, src] of Object.entries(srcs)) {
      if (seen.current[key] === src) continue;
      seen.current[key] = src;
      setFound(f => {
        if (!(key in f)) return f;
        const { [key]: _, ...rest } = f;
        return rest;
      });
      void cutOut(src).then(cut => seen.current[key] === src && setFound(f => ({ ...f, [key]: cut })));
    }
  }, [srcs]);
  return found;
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function cutFrom(img: HTMLImageElement): Cut {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const whole = (why: string): Cut => ({ src: img.src, width: w, height: h, ok: false, why });
  if (!w || !h) return whole('the photo could not be opened');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return whole('the photo could not be opened');
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, h);
  const cut = cutPixels(data.data, w, h);
  if (!cut) return whole('nothing stood out from the background');

  const out = g.createImageData(w, h);
  out.data.set(data.data);
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = cut.alpha[i]!;
  g.putImageData(out, 0, 0);
  const cw = cut.right - cut.left + 1;
  const ch = cut.bottom - cut.top + 1;
  const trimmed = document.createElement('canvas');
  trimmed.width = cw;
  trimmed.height = ch;
  trimmed.getContext('2d')!.drawImage(canvas, cut.left, cut.top, cw, ch, 0, 0, cw, ch);
  return { src: trimmed.toDataURL('image/png'), width: cw, height: ch, ok: cut.ok, why: cut.why, at: [cut.left, cut.top] };
}

export type CutPixels = { alpha: Uint8ClampedArray; left: number; top: number; right: number; bottom: number; ok: boolean; why: string | null };

/**
 * The cut itself, on RGBA pixels: the bottle's alpha (soft at its edge), its box, and whether it came out whole. Null
 * when nothing stands out from the background at all. Pure, so it is tested.
 */
export function cutPixels(px: Uint8ClampedArray, w: number, h: number): CutPixels | null {
  const dist = (a: number, b: number) => Math.hypot(px[a]! - px[b]!, px[a + 1]! - px[b + 1]!, px[a + 2]! - px[b + 2]!);

  // The edge's median colour; seeds are the edge pixels near it. A busy edge (other bottles, a hand) has few.
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  const median = [0, 1, 2].map(c => edge.map(i => px[i * 4 + c]!).sort((a, b) => a - b)[edge.length >> 1]!);
  const nearMedian = (i: number) => Math.hypot(px[i * 4]! - median[0]!, px[i * 4 + 1]! - median[1]!, px[i * 4 + 2]! - median[2]!) < NEAR;
  const seeds = edge.filter(nearMedian);
  const busy = seeds.length < edge.length * 0.4;

  // Background: grown from the seeds while each step is small and the colour stays near the seed's.
  const bg = new Uint8Array(w * h);
  const from = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const i of seeds) if (!bg[i]) (bg[i] = 1), (from[i] = i), (queue[tail++] = i);
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || bg[j] || dist(i * 4, j * 4) >= STEP || dist(from[i]! * 4, j * 4) >= FAR) continue;
      bg[j] = 1;
      from[j] = from[i]!;
      queue[tail++] = j;
    }
  }
  const covered = tail / (w * h);

  // The bottle: the largest piece left that reaches the middle third, else the largest piece at all.
  const piece = new Int32Array(w * h).fill(-1);
  let best = { id: -1, size: 0, middle: false };
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || piece[s] !== -1) continue;
    let size = 0;
    let middle = false;
    head = tail = 0;
    queue[tail++] = s;
    piece[s] = s;
    while (head < tail) {
      const i = queue[head++]!;
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > w / 3 && x < (2 * w) / 3 && y > h / 3 && y < (2 * h) / 3) middle = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || bg[j] || piece[j] !== -1) continue;
        piece[j] = s;
        queue[tail++] = j;
      }
    }
    if ((middle && !best.middle) || (middle === best.middle && size > best.size)) best = { id: s, size, middle };
  }
  if (best.id < 0) return null;

  let [left, top, right, bottom] = [w, h, 0, 0];
  let onLeft = 0;
  let onRight = 0;
  for (let i = 0; i < w * h; i++) {
    if (piece[i] !== best.id) continue;
    const x = i % w;
    const y = (i / w) | 0;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    if (x === 0) onLeft++;
    if (x === w - 1) onRight++;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;

  // Whole, or why not: in Chapp's words, for "I couldn’t cut the Reagent A out of photo 2 cleanly: …".
  const why = !best.middle
    ? 'nothing stands in the middle'
    : onLeft > h * 0.15 || onRight > h * 0.15 || (top === 0 && bottom === h - 1)
      ? 'it’s cut off at the edge'
      : busy || covered < 0.2
        ? 'the background is too busy'
        : best.size > w * h * 0.9
          ? 'it fills the whole picture'
          : width > height * 1.1 || best.size < w * h * 0.06 || height < h * 0.3
            ? 'it doesn’t come out as one bottle'
            : null;

  // Soft edges, a little inside the bottle so no fringe of background comes with it: a pixel's alpha follows how
  // much of its 3 × 3 neighbourhood is bottle, from a straight edge (half) to the inside (all).
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++) {
      if (piece[y * w + x] !== best.id) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && piece[yy * w + xx] === best.id) n++;
        }
      alpha[y * w + x] = Math.round(255 * Math.min(1, Math.max(0, (n - 3) / 6)));
    }
  return { alpha, left, top, right, bottom, ok: why === null, why };
}
