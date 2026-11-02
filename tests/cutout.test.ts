import { describe, expect, it } from 'vitest';
import { alongWhy, cutPixels, outlineInCrop } from '../src/components/bench/cutout.ts';

// A bottle cut out of its kit photo (src/components/bench/cutout.ts), on made-up pixels: a dark shape on a light
// table comes out whole; one against the crop's edge, or wider than tall, comes out but is said not to be whole.

const W = 60;
const H = 60;

/** A light table (with a faint gradient, as a photo has) with `shapes` painted dark on it. */
function photo(...shapes: { x: number; y: number; w: number; h: number; colour?: [number, number, number] }[]) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const shade = 225 + Math.round((y / H) * 10);
      px.set([shade, shade + 4, shade + 8, 255], i);
    }
  for (const s of shapes)
    for (let y = s.y; y < s.y + s.h; y++)
      for (let x = s.x; x < s.x + s.w; x++) px.set([...(s.colour ?? [70, 90, 120]), 255], (y * W + x) * 4);
  return px;
}

describe('cutPixels', () => {
  it('cuts a bottle standing in the middle out whole', () => {
    const cut = cutPixels(photo({ x: 22, y: 8, w: 16, h: 44 }), W, H)!;
    expect(cut.ok).toBe(true);
    expect(cut.why).toBeNull();
    expect([cut.left, cut.top, cut.right, cut.bottom]).toEqual([22, 8, 37, 51]);
    // Opaque inside, soft at the edge, nothing on the table.
    expect(cut.alpha[30 * W + 30]).toBe(255);
    expect(cut.alpha[30 * W + 22]).toBeLessThan(255);
    expect(cut.alpha[30 * W + 22]).toBeGreaterThan(0);
    expect(cut.alpha[30 * W + 10]).toBe(0);
  });

  it('still cuts a bottle against the crop’s edge, but says it is cut off', () => {
    const cut = cutPixels(photo({ x: 0, y: 8, w: 24, h: 44 }), W, H)!;
    expect(cut.ok).toBe(false);
    expect(cut.why).toMatch(/cut off/);
    expect(cut.left).toBe(0);
  });

  it('says a shape wider than tall is not one bottle', () => {
    const cut = cutPixels(photo({ x: 6, y: 20, w: 48, h: 20 }), W, H)!;
    expect(cut.ok).toBe(false);
    expect(cut.why).toMatch(/one bottle/);
  });

  it('takes the bottle, not the other thing beside it', () => {
    const cut = cutPixels(photo({ x: 24, y: 8, w: 14, h: 44 }, { x: 2, y: 40, w: 8, h: 12, colour: [160, 60, 60] }), W, H)!;
    expect(cut.ok).toBe(true);
    expect(cut.left).toBe(24);
  });

  it('finds nothing on an empty table', () => {
    expect(cutPixels(photo(), W, H)).toBeNull();
  });
});

describe('outlineInCrop', () => {
  it('puts SAM’s outline (fractions of the photo) onto the crop’s pixels, with its box clamped to the crop', () => {
    // The crop is the photo's middle half, drawn 240 px square; the outline a bottle in the crop's middle.
    const square = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const on = outlineInCrop('M0.4,0.3L0.6,0.3L0.6,0.7L0.4,0.7Z', square, 240, 240);
    expect(on.d).toBe('M72.0,24.0L168.0,24.0L168.0,216.0L72.0,216.0Z');
    expect([on.left, on.top, on.right, on.bottom]).toEqual([72, 24, 168, 216]);
    // A point past the crop's edge is clamped.
    expect(outlineInCrop('M0.1,0.1L0.9,0.1L0.9,0.9Z', square, 240, 240)).toMatchObject({ left: 0, top: 0, right: 239, bottom: 239 });
    expect(outlineInCrop('', square, 240, 240).d).toBe('');
  });

  it('calls a cut along SAM’s outline whole unless the outline reaches the crop’s edge (the photo cuts the bottle off)', () => {
    const square = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    expect(alongWhy(outlineInCrop('M0.4,0.3L0.6,0.3L0.6,0.7L0.4,0.7Z', square, 240, 240), 240, 240)).toBeNull();
    expect(alongWhy(outlineInCrop('M0.4,0.25L0.6,0.25L0.6,0.7L0.4,0.7Z', square, 240, 240), 240, 240)).toBe('it’s cut off at the edge');
    expect(alongWhy({ left: 30, top: 20, right: 238, bottom: 200 }, 240, 240)).toBe('it’s cut off at the edge');
  });
});
