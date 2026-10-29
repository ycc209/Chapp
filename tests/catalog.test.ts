import { describe, expect, it } from 'vitest';
import { otherCatalog } from '../shared/catalog.ts';

// The catalog number the user said against the kit a search found (shared/catalog.ts). No network.

describe('otherCatalog', () => {
  it('names the number said when the kit found has another', () => {
    // Notos: "EEA 302" was heard for EEA032.
    expect(otherCatalog('我要做 EEA 302 的實驗', 'EEA032')).toBe('EEA 302');
    expect(otherCatalog('Abcam ab12437', 'ab124964')).toBe('ab12437');
    expect(otherCatalog('I got a Pierce BCA kit 23226', '23225')).toBe('23226');
  });

  it('is quiet when the number is the one found, written any way', () => {
    expect(otherCatalog('Pierce BCA 23225', '23225')).toBeNull();
    expect(otherCatalog('ab 287843 differentiation kit', 'ab287843')).toBeNull();
    expect(otherCatalog('MAK-073', 'MAK073-1KT')).toBeNull();
  });

  it('is quiet when no number was said, or the kit found has none', () => {
    expect(otherCatalog('Pierce BCA protein assay', '23225')).toBeNull();
    expect(otherCatalog('EEA 302', undefined)).toBeNull();
    expect(otherCatalog('12 samples in duplicate', '23225')).toBeNull();
  });
});
