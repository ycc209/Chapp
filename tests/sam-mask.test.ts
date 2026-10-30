import { describe, expect, it } from 'vitest';
import { outlineOf, polygonArea, ringsOf, simplify } from '../server/ai/samMask.ts';

// SAM's mask as an outline (server/ai/samMask.ts): the parser's polygonal path → its biggest ring, simplified to the
// pixel, in fractions of the photo. The decoding itself is Meta's package; this is what is done with its path.

describe('ringsOf', () => {
  it('reads absolute M/L/Z subpaths, with or without commas', () => {
    expect(ringsOf('M0 0L4 0L4 3L0 3ZM1,1L2,1L2,2Z')).toEqual([
      [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ],
      [
        [1, 1],
        [2, 1],
        [2, 2],
      ],
    ]);
    expect(ringsOf('')).toEqual([]);
    expect(ringsOf('M1 1L2 2Z')).toEqual([]);
  });
});

describe('simplify', () => {
  it('drops the points of a pixel-traced edge that lie on the line, keeps a corner', () => {
    const stair: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
    ];
    expect(simplify(stair, 1)).toEqual([
      [0, 0],
      [3, 0],
      [3, 3],
    ]);
  });
  it('keeps a bump bigger than epsilon', () => {
    expect(
      simplify(
        [
          [0, 0],
          [5, 3],
          [10, 0],
        ],
        1,
      ),
    ).toHaveLength(3);
  });
});

describe('outlineOf', () => {
  it('takes the biggest ring and puts it where the mask sits on the photo, in fractions', () => {
    // A 4 × 4 mask at (10, 20) on a 100 × 200 photo, with a one-pixel speck beside the bottle.
    const path = 'M0 0L4 0L4 4L0 4ZM0 0L1 0L1 1L0 1Z';
    expect(outlineOf(path, { left: 10, top: 20, frameWidth: 100, frameHeight: 200 })).toBe('M0.1000,0.1000L0.1400,0.1000L0.1400,0.1200L0.1000,0.1200Z');
  });
  it('is nothing for an empty path', () => {
    expect(outlineOf('', { left: 0, top: 0, frameWidth: 10, frameHeight: 10 })).toBeUndefined();
  });
  it('measures rings', () => {
    expect(
      polygonArea([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
    ).toBe(12);
  });
});
