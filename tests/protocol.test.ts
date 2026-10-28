import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Protocol, problems, type Cite } from '../shared/protocol.ts';
import { formatVolume, plateLayout, standardSeries, workingReagent } from '../shared/calc.ts';

// The BCA document is built from the vendor's manual, which stays out of the public repo (data/ is
// git-ignored). These checks run wherever that local copy exists.
const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const pages = (n: number) => new URL(`../data/sources/pierce-bca/page-${n}.txt`, import.meta.url);
const local = existsSync(file);

// pdftotext keeps the layout, so a sentence can wrap across lines; compare with runs of spaces collapsed.
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function citations(value: unknown, found: Cite[] = []): Cite[] {
  if (Array.isArray(value)) value.forEach(v => citations(v, found));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'cite') found.push(v as Cite);
      else citations(v, found);
    }
  }
  return found;
}

describe.skipIf(!local)('Pierce BCA protocol document', () => {
  const doc = local ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : (null as never);

  it('is internally consistent: ids resolve and every dilution adds up', () => {
    expect(problems(doc)).toEqual([]);
  });

  it('quotes the manual word for word, on the cited page', () => {
    const quotes = citations(doc).filter(c => c.quote);
    expect(quotes.length).toBeGreaterThan(20);
    for (const c of quotes) {
      const page = flat(readFileSync(pages(c.page), 'utf8'));
      expect(page, `page ${c.page}: ${c.quote}`).toContain(flat(c.quote!));
    }
  });

  it("reproduces the manual's own working-reagent example (9 standards + 3 unknowns, 2 replicates, 2 mL)", () => {
    const wr = workingReagent(doc, 'test-tube', 3, 2);
    expect(wr.total).toBe(48_000);
    expect(formatVolume(wr.total)).toBe('48 mL');
  });

  it('splits working reagent 50:1 for a microplate run of 12 samples in duplicate', () => {
    const wr = workingReagent(doc, 'microplate', 12, 2);
    expect(wr.total).toBe(8_400);
    expect(wr.parts.map(p => formatVolume(p.volume))).toEqual(['8.24 mL', '165 µL']);
  });

  it('sizes Table 1 to 2/5 for a plate in duplicate: 400 µL stock and 960 µL diluent', () => {
    const s = standardSeries(doc, 'microplate', 2);
    expect(s.scale).toBe(0.4);
    expect(s.vials.map(v => `${v.id}: ${v.take} of ${v.from ?? 'nothing'} + ${v.diluent}`)).toEqual([
      'A: 120 of stock + 0', 'B: 150 of stock + 50', 'C: 130 of stock + 130', 'D: 70 of B + 70', 'E: 130 of C + 130',
      'F: 130 of E + 130', 'G: 130 of F + 130', 'H: 40 of G + 160', 'I: 0 of nothing + 160',
    ]);
    expect([s.stock, s.diluent, s.need, s.minLeft]).toEqual([400, 960, 50, 120]);
  });

  it('keeps those standards for triplicates and makes 1/5 of the table for single wells', () => {
    expect(standardSeries(doc, 'microplate', 3)).toMatchObject({ scale: 0.4, stock: 400, diluent: 960, need: 75 });
    expect(standardSeries(doc, 'microplate', 1)).toMatchObject({ scale: 0.2, stock: 200, diluent: 480, minLeft: 60 });
  });

  it('needs Table 1 exactly as printed for test tubes in duplicate, which is what it was written for', () => {
    expect(standardSeries(doc, 'test-tube', 2)).toMatchObject({ scale: 1, stock: 1000, diluent: 2400, need: 200 });
  });

  it('lays out 42 wells for 9 standards and 12 samples in duplicate, standards first', () => {
    const wells = plateLayout(doc, 'microplate', 12, 2);
    expect(wells).toHaveLength(42);
    expect(wells.slice(0, 3).map(w => `${w.well}:${w.ref}${w.replicate}`)).toEqual(['A1:A1', 'B1:A2', 'C1:B1']);
    expect(wells[18]).toMatchObject({ kind: 'sample', ref: '1', well: 'C3' });
  });
});
