import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Protocol } from '../shared/protocol.ts';
import { coverFocus, putCover, sameKit } from '../src/screens/kit/cover.ts';
import { forgetProtocol, kitCover, useCovers } from '../src/state/library.ts';

// The kit's cover (src/screens/kit/cover.ts): which kit the packaging on a photo is, which photo of it stays the
// cover, and where its thumbnail looks. A Map stands in for localStorage.

const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) });
  useCovers.setState({ covers: {} });
});
afterEach(() => vi.unstubAllGlobals());

const BOX = { x: 0.07, y: 0.13, width: 0.72, height: 0.6 };

describe('which kit packaging is', () => {
  it('is the protocol’s by one of its catalog numbers, else by its name with or without the vendor’s', () => {
    expect(sameKit(bca, { vendor: 'Thermo Scientific', catalog: '23227', name: 'Pierce BCA Protein Assay Kit' })).toBe(true);
    expect(sameKit(bca, { vendor: 'Thermo Scientific', catalog: 'a65453', name: '' })).toBe(true);
    expect(sameKit(bca, { vendor: 'Thermo Scientific', catalog: '', name: 'Thermo Scientific Pierce™ BCA Protein Assay Kit' })).toBe(true);
    // The Albumin Standard's own box, and a bottle's label, are not the kit's.
    expect(sameKit(bca, { vendor: 'Thermo Scientific', catalog: '23209', name: 'Albumin Standard' })).toBe(false);
    expect(sameKit(bca, { vendor: 'Thermo Scientific', catalog: '', name: 'Pierce BCA Protein Assay Reagent A' })).toBe(false);
  });
});

describe('the photo that stays the cover', () => {
  it('is the one with the biggest box in a round, and a later round’s photo of the box', () => {
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,AAAA', box: BOX, round: 'one' });
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,BBBB', box: { ...BOX, width: 0.3 }, round: 'one' });
    expect(kitCover('pierce-bca')!.src).toBe('data:image/jpeg;base64,AAAA');
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,CCCC', box: { ...BOX, width: 0.3 }, round: 'two' });
    expect(kitCover('pierce-bca')!.src).toBe('data:image/jpeg;base64,CCCC');
    expect(JSON.parse(localStorage.getItem('chapp.covers')!).state.covers['pierce-bca'].round).toBe('two');
  });

  it('goes with the protocol when it is forgotten', () => {
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,AAAA', box: BOX, round: 'one' });
    forgetProtocol('pierce-bca');
    expect(kitCover('pierce-bca')).toBeUndefined();
  });

  it('ranks a photo whose packaging SAM could not find below one where it did', () => {
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,AAAA', round: 'one' });
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,BBBB', box: BOX, round: 'one' });
    putCover('pierce-bca', { src: 'data:image/jpeg;base64,CCCC', round: 'one' });
    expect(kitCover('pierce-bca')!.src).toBe('data:image/jpeg;base64,BBBB');
  });

  it('shows the packaging in a small thumbnail, else the middle', () => {
    expect(coverFocus(BOX)).toBe('43% 43%');
    expect(coverFocus()).toBe('50% 50%');
  });
});
