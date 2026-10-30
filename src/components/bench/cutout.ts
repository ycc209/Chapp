import { useEffect, useRef, useState } from 'react';

/**
 * The user's photo of a bottle (its 240 px square crop from the kit), cut out of its background on the phone, so it
 * can stand on the bench in place of the drawn bottle. No model: the background is what grows in from the crop's
 * edges in small colour steps (a table, a wall, a gradient, a shadow), and the bottle is the largest thing left near
 * the middle. The cut is made as soon as the bottle is matched (screens/kit/store.ts) and says whether it came out
 * whole (`ok`), or why not: the kit screen shows a poor one and asks for a photo of just that bottle, and the bench
 * keeps its drawn bottle until there is a whole one.
 */
export type Cut = {
  src: string;
  width: number;
  height: number;
  /** Whole and on its own: one bottle, not cut off at the crop's edge, out of a background that could be told apart. */
  ok: boolean;
  /** Why not, in Chapp's words ("it’s cut off at the edge"); null when ok. */
  why: string | null;
};

/** Neighbouring background pixels differ by less than this (RGB distance): JPEG noise and gradients, not an edge. */
const STEP = 12;
/** …and stay this close to the edge colour they grew from, so a soft edge (a white bottle on white) can't be crossed. */
const FAR = 30;
/** Seeds on the crop's edge are within this of the edge's median colour. */
const NEAR = 64;

const cuts = new Map<string, Promise<Cut>>();

/** The photo's cut-out, made once per photo. */
export function cutOut(src: string): Promise<Cut> {
  if (typeof document === 'undefined') return Promise.resolve({ src, width: 1, height: 1, ok: false, why: 'the photo could not be opened' });
  let cut = cuts.get(src);
  if (!cut) {
    cut = load(src)
      .then(img => cutFrom(img))
      .catch(() => ({ src, width: 1, height: 1, ok: false, why: 'the photo could not be opened' }));
    cuts.set(src, cut);
  }
  return cut;
}

/** The cut-out once it is ready; null before (and on the server, where there is no canvas). */
export function useCutout(src: string | undefined): Cut | null {
  const [cut, setCut] = useState<Cut | null>(null);
  useEffect(() => {
    setCut(null);
    if (!src) return;
    let live = true;
    cutOut(src).then(c => live && setCut(c));
    return () => {
      live = false;
    };
  }, [src]);
  return cut;
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
  return { src: trimmed.toDataURL('image/png'), width: cw, height: ch, ok: cut.ok, why: cut.why };
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
