import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { outlineOf, polygonArea, ringsOf, samOutline, simplify } from '../server/ai/samMask.ts';
import { parseSamRecords } from '../server/ai/vision.ts';

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

// SAM 3.1's real reply on the 23225 product shot (data/smoke/kit/raw/, git-ignored), decoded by Meta's parser, when
// both are on this machine.
const SAVED = new URL('../data/smoke/kit/raw/sam-govsci-23225-bottle.json', import.meta.url);
const PACKAGE: string = '@meta-sam/parser';
const parser = await import(PACKAGE).then(() => true, () => false);

describe.runIf(existsSync(SAVED) && parser)('samOutline with Meta\'s parser', () => {
  it('outlines every bottle of a real reply, inside its box', async () => {
    const find = (o: unknown): string => (typeof o === 'string' && o.includes('<|box') ? o : o && typeof o === 'object' ? (Object.values(o).map(find).find(Boolean) ?? '') : '');
    const records = parseSamRecords(find(JSON.parse(readFileSync(SAVED, 'utf8'))));
    const outlines = await Promise.all(records.map(r => samOutline(r.mask!)));
    expect(outlines.every(Boolean)).toBe(true);
    // Each outline's points sit in its box, give or take the half pixel the parser traces along.
    records.forEach((r, i) => {
      for (const [x, y] of ringsOf(outlines[i]!)[0]!) {
        expect(x).toBeGreaterThanOrEqual(r.box.x - 0.01);
        expect(x).toBeLessThanOrEqual(r.box.x + r.box.width + 0.01);
        expect(y).toBeGreaterThanOrEqual(r.box.y - 0.01);
        expect(y).toBeLessThanOrEqual(r.box.y + r.box.height + 0.01);
      }
    });
  });
});
