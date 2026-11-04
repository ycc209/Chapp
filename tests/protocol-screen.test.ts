import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Protocol } from '../shared/protocol.ts';
import { answer, bottleDetail, kitContents, notInKit, precautions, principle, shortName, splitName, stepLines } from '../src/screens/protocol/content.ts';
import { amounts, asked, gotIt, heardAnswer, needsOf, noPhoto, open, opening, rowDetail, type Need } from '../src/screens/kit/matching.ts';
import { boxOnCover, squareAround } from '../src/screens/kit/photo.ts';

// The protocol screen words everything from the document; these pin the wording to the BCA document where it exists
// (data/ stays local), and the matching rules and crop geometry everywhere.
const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const local = existsSync(file);

describe('protocol screen wording', () => {
  it('shortens titles and splits bracketed names', () => {
    expect(shortName({ title: 'Pierce BCA Protein Assay' })).toBe('Pierce BCA');
    expect(shortName({ title: 'Bradford Assay Kit' })).toBe('Bradford');
    expect(splitName('Albumin Standard (BSA)')).toEqual({ name: 'Albumin Standard', aside: 'BSA' });
    expect(splitName('BCA Reagent A')).toEqual({ name: 'BCA Reagent A', aside: null });
  });

  describe.skipIf(!local)('from the Pierce BCA document', () => {
    const doc = local ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : (null as never);

    it('answers with the summary, and keeps the rest for Principle', () => {
      const a = answer(doc);
      expect(a.lead).toBe('Pierce BCA');
      expect(a.text).toMatch(/^ is a colorimetric total-protein assay\. Standards and samples react/);
      expect(principle(doc)).toEqual({ aside: '562 nm', paragraphs: [expect.stringMatching(/^Working range 20–2,000/), expect.stringMatching(/^Plot each standard/)] });
    });

    it('lists the kit as the design does, from the document', () => {
      const kit = kitContents(doc);
      expect(kit.items.map(i => [i.name, i.detail])).toEqual([
        ['BCA Reagent A', null],
        ['BCA Reagent B', null],
        ['Albumin Standard', 'BSA · 2 mg/mL'],
      ]);
      expect(kit.store).toBe('Store them at 15–30 °C.');
      // What the box does not hold: the user's own diluent, then the equipment (the pipette goes without saying).
      const own = notInKit(doc, 'microplate');
      expect(own.bottles).toEqual([{ id: 'diluent', name: 'Diluent', aside: 'same buffer as your samples' }]);
      expect(own.gear.map(g => g.replace(/‑/g, '-'))).toEqual(['96-well plate', 'Plate shaker', '37 °C incubator', 'Plate reader']);
      expect(doc.components.map(bottleDetail)).toEqual([
        'Kit · store at 15–30 °C',
        'Kit · store at 15–30 °C',
        'Kit · BSA, 2 mg/mL',
        'Yours · same buffer as your samples',
      ]);
    });

    it('has the seven microplate steps and five precautions, cautions first', () => {
      expect(stepLines(doc, 'microplate')).toHaveLength(7);
      const care = precautions(doc);
      expect(care).toHaveLength(5);
      expect(care[0].text).toMatch(/reducing or metal-chelating/);
    });

    it('sizes each bottle as Plan and Run do: 12 samples in duplicate, as Kit-Filled shows', () => {
      expect(amounts(doc, 'microplate', 12, 2)).toEqual({ 'reagent-a': '9.9 mL', 'reagent-b': '198 µL', bsa: '400 µL', diluent: '960 µL' });
      // Standards already made take no stock or diluent.
      expect(amounts(doc, 'microplate', 12, 2, 2, 'ready')).toEqual({ 'reagent-a': '9.9 mL', 'reagent-b': '198 µL' });
    });
  });
});

describe('matching bottles by hand', () => {
  const needs: Need[] = [
    { id: 'a', name: 'BCA Reagent A', kit: true, role: 'reagent' },
    { id: 'b', name: 'BCA Reagent B', kit: true, role: 'reagent' },
    { id: 'bsa', name: 'Albumin Standard', kit: true, role: 'standard' },
    { id: 'dil', name: 'Diluent', kit: false, role: 'diluent' },
  ];
  const pick = { shot: 's2', box: { x: 0, y: 0, width: 0.5, height: 0.4 }, crop: 'data:' };

  it('asks for the first open bottle, or the one the user chose while it is open', () => {
    expect(asked(needs, { picks: {}, skipped: {} }, null)?.id).toBe('a');
    expect(asked(needs, { picks: { a: pick }, skipped: { b: true } }, null)?.id).toBe('bsa');
    expect(asked(needs, { picks: {}, skipped: {} }, 'dil')?.id).toBe('dil');
    expect(asked(needs, { picks: { dil: pick }, skipped: {} }, 'dil')?.id).toBe('a');
    expect(open(needs, { picks: { a: pick, b: pick, bsa: pick }, skipped: { dil: true } })).toEqual([]);
  });

  it("says what the design says: Chapp's lines and each row's detail", () => {
    expect(opening(3, 4)).toBe('I have 3 photos. Show me the 4 bottles.');
    expect(gotIt('Diluent', 1)).toBe('Diluent, got it. 1 more to check.');
    expect(gotIt('Diluent', 0)).toBe('Diluent, got it.');
    expect(noPhoto('Diluent', 2)).toBe('Okay, no photo of the Diluent. 2 more to check.');
    const n = (id: string) => ({ s1: 1, s2: 2 })[id] ?? 0;
    expect(rowDetail(needs[2], { pending: pick }, n)).toBe('Photo 2 · is this it?');
    expect(rowDetail(needs[2], { pick }, n)).toBe('Kit · photo 2');
    expect(rowDetail(needs[3], { pick: { ...pick, shot: 'gone' } }, n)).toBe('Yours · your photo');
    expect(rowDetail(needs[3], { skipped: true }, n)).toBe('Yours · no photo');
    expect(rowDetail(needs[0], {}, n)).toBe('Kit · not matched yet');
  });

  it('hears a spoken or typed answer that is on screen', () => {
    const confirm = ['Yes', 'Not for this run', 'Something else'];
    expect(heardAnswer('yes', confirm)).toBe('Yes');
    expect(heardAnswer('Yeah, that one.', confirm)).toBe('Yes');
    expect(heardAnswer('not for this run', confirm)).toBe('Not for this run');
    const which = ['BCA Reagent B', 'Albumin Standard', 'Diluent', 'Not for this run'];
    expect(heardAnswer("It's the albumin standard", which)).toBe('Albumin Standard');
    expect(heardAnswer('reagent B', which)).toBe('BCA Reagent B');
    expect(heardAnswer('the diluent', which)).toBe('Diluent');
    expect(heardAnswer('how much reagent do I need?', which)).toBeNull();
    expect(heardAnswer('', which)).toBeNull();
  });
});

describe('crops', () => {
  it('cuts a square of 40% of the short side around the tap, kept inside the photo', () => {
    const box = squareAround({ x: 0.5, y: 0.5 }, 720, 960);
    expect(box.width * 720).toBeCloseTo(288);
    expect(box.height * 960).toBeCloseTo(288);
    expect(box.x).toBeCloseTo(0.3);
    const corner = squareAround({ x: 0.02, y: 0.99 }, 720, 960);
    expect(corner.x).toBe(0);
    expect(corner.y + corner.height).toBeCloseTo(1);
  });

  it('places a box on a cover-fitted thumbnail', () => {
    // A 720×960 photo in a 54×72 thumbnail fits exactly: fractions scale straight across.
    expect(boxOnCover({ x: 0.5, y: 0.25, width: 0.25, height: 0.25 }, { width: 720, height: 960 }, { width: 54, height: 72 })).toEqual({
      left: 27,
      top: 18,
      width: 13.5,
      height: 18,
    });
    // A landscape photo is cropped at the sides: its middle third shows.
    const b = boxOnCover({ x: 0, y: 0, width: 1, height: 1 }, { width: 1920, height: 1080 }, { width: 54, height: 72 });
    expect(b.height).toBe(72);
    expect(b.left).toBeCloseTo((54 - 128) / 2);
  });
});
