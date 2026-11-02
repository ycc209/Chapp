import { describe, expect, it } from 'vitest';
import { layOver, locate, uprightTurn } from '../src/components/bench/whole.ts';

// The bench's own bottle (src/components/bench/whole.ts): turned upright, and made whole from a drawing of it.

/** A bottle's mask: a body `bw` × `bh`, and a neck `nw` wide and `nh` long at one end (`neck`: which way it points). */
function bottleMask(w: number, h: number, neck: 'up' | 'down' | 'left' | 'right', bw = 60, bh = 110, nw = 26, nh = 30) {
  const m = new Uint8Array(w * h);
  const vertical = neck === 'up' || neck === 'down';
  const [BW, BH] = vertical ? [bw, bh] : [bh, bw];
  const cx = w / 2, cy = h / 2;
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(h, Math.round(y1)); y++) for (let x = Math.max(0, Math.round(x0)); x < Math.min(w, Math.round(x1)); x++) m[y * w + x] = 255;
  };
  fill(cx - BW / 2, cy - BH / 2, cx + BW / 2, cy + BH / 2);
  if (neck === 'up') fill(cx - nw / 2, cy - BH / 2 - nh, cx + nw / 2, cy - BH / 2);
  if (neck === 'down') fill(cx - nw / 2, cy + BH / 2, cx + nw / 2, cy + BH / 2 + nh);
  if (neck === 'left') fill(cx - BW / 2 - nh, cy - nw / 2, cx - BW / 2, cy + nw / 2);
  if (neck === 'right') fill(cx + BW / 2, cy - nw / 2, cx + BW / 2 + nh, cy + nw / 2);
  return m;
}

describe('uprightTurn', () => {
  it('stands a lying bottle up with its cap on top, the side Muse Spark says the cap is on', () => {
    // The cap on the narrow end, as on a bottle with a neck…
    expect(uprightTurn(bottleMask(240, 240, 'left'), 240, 240, 'left')).toBe(90);
    expect(uprightTurn(bottleMask(240, 240, 'right'), 240, 240, 'right')).toBe(-90);
    // …or on the wide end, as on a vial whose cap is wider than its rounded foot: the shape alone would turn it over.
    expect(uprightTurn(bottleMask(240, 240, 'left'), 240, 240, 'right')).toBe(-90);
    expect(uprightTurn(bottleMask(240, 240, 'up'), 240, 240, 'down')).toBe(180);
  });

  it('leaves a standing bottle standing, and never turns one over without being told where its cap is', () => {
    expect(uprightTurn(bottleMask(240, 240, 'up'), 240, 240, 'up')).toBe(0);
    expect(uprightTurn(bottleMask(240, 240, 'down'), 240, 240)).toBe(0);
    expect(uprightTurn(bottleMask(240, 240, 'left'), 240, 240)).toBe(0);
  });

  it('turns a squat jar a quarter at a time to put its cap up', () => {
    const jar = new Uint8Array(240 * 240);
    for (let y = 90; y < 150; y++) for (let x = 60; x < 180; x++) jar[y * 240 + x] = 255;
    expect(uprightTurn(jar, 240, 240, 'up')).toBe(0);
    expect(uprightTurn(jar, 240, 240)).toBe(0);
    expect(uprightTurn(jar, 240, 240, 'left')).toBe(90);
  });
});

describe('locate', () => {
  it('finds where a cut came from on its crop, by its opaque pixels', () => {
    const w = 60, h = 50;
    // A crop with no pattern in it (a small LCG), so the cut matches in one place only.
    let seed = 7;
    const crop = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (seed = (seed * 1103515245 + 12345) % 2147483648) % 256));
    const pw = 20, ph = 15, at: [number, number] = [13, 21];
    const piece = new Uint8ClampedArray(pw * ph * 4);
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const j = ((y + at[1]) * w + x + at[0]) * 4, i = (y * pw + x) * 4;
        piece.set(crop.subarray(j, j + 3), i);
        // Round the corners off, as a bottle's outline would: transparent there.
        piece[i + 3] = (x < 3 || x > pw - 4) && (y < 3 || y > ph - 4) ? 0 : 255;
      }
    expect(locate(piece, pw, ph, crop, w, h)).toEqual(at);
    expect(locate(piece, pw, ph, new Uint8ClampedArray(w * h * 4), w, h)).toBeNull();
  });
});

/**
 * A made-up bottle, upright in a `size` square: a pale body with a white label striped by grey "text", a narrow neck and
 * a cap, `scale` times as big about the middle and `dy` lower; drawn on `bg`. Its mask too.
 */
function paint(size: number, bg: number[], scale = 1, dy = 0, tone = 1) {
  const px = new Uint8ClampedArray(size * size * 4), mask = new Uint8Array(size * size);
  const c = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x - c) / scale, v = (y - c - dy) / scale; // bottle coordinates: body |u| < 30, -40 < v < 60
      let rgb: number[] | null = null;
      if (Math.abs(u) < 30 && v > -40 && v < 60) {
        rgb = [190, 215, 205];
        if (v > -15 && v < 40) rgb = (((Math.round(v) % 6) + 6) % 6) < 2 && Math.abs(u) < 22 ? [70, 70, 80] : [245, 245, 245];
      } else if (Math.abs(u) < 12 && v > -58 && v <= -40) rgb = [200, 225, 215];
      else if (Math.abs(u) < 15 && v > -75 && v <= -58) rgb = [230, 236, 240];
      const i = y * size + x;
      const col = rgb ? rgb.map(k => Math.min(255, k * tone)) : bg;
      px.set([col[0]!, col[1]!, col[2]!, 255], i * 4);
      mask[i] = rgb ? 255 : 0;
    }
  return { px, mask };
}

describe('layOver', () => {
  /** A row of RGB values of an RGBA image. */
  const rowOf = (px: Uint8ClampedArray, w: number, y: number, x0: number, n: number) => Array.from(px.subarray((y * w + x0) * 4, (y * w + x0 + n) * 4)).filter((_, k) => k % 4 !== 3);
  /** The first and last rows of a mask's middle column. */
  const span = (mask: Uint8Array, size: number) => {
    const rows = Array.from({ length: size }, (_, y) => y).filter(y => mask[y * size + size / 2]);
    return [rows[0]!, rows[rows.length - 1]!] as const;
  };

  it('puts the drawing under the photo, lined up by outline, and the photo over it exactly as it is', () => {
    const size = 200;
    // The photo: its cap and neck hidden (behind a thumb), so not in its mask.
    const photo = paint(size, [255, 255, 255]);
    for (let y = 0; y < 62; y++) for (let x = 0; x < size; x++) (photo.mask[y * size + x] = 0), photo.px.set([232, 205, 180], (y * size + x) * 4);
    // The drawing: the same bottle whole, a little bigger and lower, darker, on dark grey.
    const drawn = paint(size, [60, 60, 60], 1.08, 6, 0.85);
    const laid = layOver(photo.px, photo.mask, drawn.px, size, size)!;
    expect(laid).not.toBeNull();
    // Lined up: the drawing shrunk back by its 1.08 and moved up by its 6.
    expect(laid.lineup.s).toBeCloseTo(1 / 1.08, 1);
    expect(Math.abs(laid.lineup.dy + 6 / 1.08)).toBeLessThan(2.5);
    // Whole: as tall as the bottle with its cap (135 px), the cap drawn in.
    expect(laid.height).toBeGreaterThan(128);
    expect(laid.height).toBeLessThan(142);
    const cap = laid.rgba.subarray((4 * laid.width + Math.round(laid.width / 2)) * 4, (4 * laid.width + Math.round(laid.width / 2)) * 4 + 4);
    expect(cap[3]).toBeGreaterThan(200);
    // The photo's part is the photo, pixel for pixel: its label rows, as they were.
    const [top, bottom] = span(photo.mask, size);
    for (const dy of [5, 30, 31, 40, 41, 60]) expect(rowOf(laid.rgba, laid.width, laid.height - 1 - (bottom - top) + dy, Math.round(laid.width / 2) - 15, 30)).toEqual(rowOf(photo.px, size, top + dy, size / 2 - 15, 30));
  });

  it("leaves the photo's label as it is, whatever words the drawing wrote on its own", () => {
    const size = 200;
    const photo = paint(size, [255, 255, 255]);
    for (let i = 0; i < size * size; i++) if (((i / size) | 0) < 62) photo.mask[i] = 0;
    // Muse Image's label says something else: no stripes at all where the photo has them.
    const drawn = paint(size, [60, 60, 60], 1.05, 3, 0.9);
    for (let i = 0; i < size * size; i++) if (drawn.mask[i] && drawn.px[i * 4]! < 100) drawn.px.set([240, 240, 240], i * 4);
    const laid = layOver(photo.px, photo.mask, drawn.px, size, size)!;
    expect(laid).not.toBeNull();
    const [top, bottom] = span(photo.mask, size);
    for (const dy of [30, 31, 40, 41, 50]) expect(rowOf(laid.rgba, laid.width, laid.height - 1 - (bottom - top) + dy, Math.round(laid.width / 2) - 15, 30)).toEqual(rowOf(photo.px, size, top + dy, size / 2 - 15, 30));
  });

  it('leaves a whole bottle as it is, though Muse Image drew it a little bigger', () => {
    const size = 200;
    const photo = paint(size, [255, 255, 255]);
    // Drawn 6 % bigger: a band a few pixels wide all round, nothing missing.
    expect(layOver(photo.px, photo.mask, paint(size, [60, 60, 60], 1.06, 2, 0.9).px, size, size)).toBeNull();
  });

  it('gives up when the drawing is not this bottle, rather than put it under the photo', () => {
    const size = 160;
    const photo = paint(size, [255, 255, 255]);
    const other = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) other.set(i % size < 80 ? [200, 40, 40, 255] : [60, 60, 60, 255], i * 4);
    expect(layOver(photo.px, photo.mask, other, size, size)).toBeNull();
  });
});
