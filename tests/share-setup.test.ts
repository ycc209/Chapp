import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleReadings } from '../shared/fit.ts';
import { Protocol } from '../shared/protocol.ts';
import { SharedSetup, type StoredShare } from '../shared/share.ts';
import { runSetup } from '../src/components/lab/model.ts';
import { buildShare, importPatch, kitRows, parsePhotos, parseTrim, shortName, standardR2, travels, whenSaid, type RunSnapshot } from '../src/screens/share/setup.ts';

// Between a run and a shared setup, with the real BCA protocol: what each trim sends, what the labmate is told they
// get, and what importing writes into their run.

const bca = Protocol.parse(JSON.parse(readFileSync(new URL('../data/protocols/pierce-bca.json', import.meta.url), 'utf8')));

/** The storyboard's run, the kit's 9 and 12 samples in duplicate, with Chapp's sample plate as its readings. */
function storyRun(): RunSnapshot {
  const plan = { procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' } as const;
  const readings = sampleReadings(runSetup(bca, plan).roles, bca.analysis!.fit);
  return { protocolId: 'pierce-bca', ...plan, photos: { bsa: 'data:image/jpeg;base64,AAAA' }, readings };
}

const stored = (setup: SharedSetup): StoredShare => ({ ...setup, id: 'abcdefghjk', sharedAt: '2026-10-28T09:00:00.000Z' });

describe('what a share carries', () => {
  it('names the kit and its bottles the way Scan-Import lists them', () => {
    expect(shortName(bca)).toBe('Pierce BCA');
    expect(kitRows(bca)).toEqual([
      { id: 'reagent-a', label: 'BCA Reagent A' },
      { id: 'reagent-b', label: 'BCA Reagent B' },
      { id: 'bsa', label: 'Albumin Standard', detail: 'BSA · 2 mg/mL' },
      { id: 'diluent', label: 'Diluent', detail: 'Same buffer as your samples' },
    ]);
  });

  it('sends everything, without the results, or just the protocol, with the kit photos', () => {
    const run = storyRun();
    const all = buildShare('all', run, bca, { r2: standardR2(bca, run) });
    const noresults = buildShare('noresults', run, bca);
    const protocol = buildShare('protocol', run, bca);
    for (const s of [all, noresults, protocol]) {
      expect(SharedSetup.safeParse(s).success).toBe(true);
      expect(s.kit.filter(c => c.photo).map(c => c.id)).toEqual(['bsa']);
    }
    expect(all.plan).toEqual({ samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' });
    expect(Object.keys(all.results!.readings)).toHaveLength(42);
    expect(noresults.plan).toEqual({ samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' });
    expect(noresults.results).toBeUndefined();
    expect(protocol.plan).toBeUndefined();
    expect(protocol.results).toBeUndefined();
  });

  it('keeps the kit photos on the phone when asked, and names the sharer', () => {
    const s = buildShare('all', storyRun(), bca, {}, { photos: false, from: 'CJ Yu' });
    expect(SharedSetup.safeParse(s).success).toBe(true);
    expect(s.kit.some(c => c.photo)).toBe(false);
    expect(s.from).toBe('CJ Yu');
    expect(travels(s, bca).photos).toBeUndefined();
    expect(travels(buildShare('all', storyRun(), bca), bca).photos).toBe(1);
    // Anything but a small image data URL stays behind.
    expect(buildShare('protocol', { ...storyRun(), photos: { bsa: 'blob:https://x/1' } }, bca).kit.some(c => c.photo)).toBe(false);
  });

  it('sends the kit’s cover with the photos, and keeps it with them', () => {
    const cover = { src: 'data:image/jpeg;base64,BBBB', box: { x: 0.07, y: 0.13, width: 0.72, height: 0.6 }, round: 'shot-1' };
    const s = buildShare('protocol', storyRun(), bca, {}, { cover });
    expect(SharedSetup.safeParse(s).success).toBe(true);
    expect(s.cover).toEqual({ photo: cover.src, box: cover.box });
    expect(travels(s, bca)).toMatchObject({ photos: 1, cover: true });
    const kept = buildShare('protocol', storyRun(), bca, {}, { cover, photos: false });
    expect(kept.cover).toBeUndefined();
    expect(travels(kept, bca).cover).toBeUndefined();
    // A cover that is not a small image data URL stays behind too; a box outside the photo is turned away.
    expect(buildShare('protocol', storyRun(), bca, {}, { cover: { ...cover, src: 'blob:https://x/2' } }).cover).toBeUndefined();
    expect(SharedSetup.safeParse({ ...s, cover: { photo: cover.src, box: { ...cover.box, width: 2 } } }).success).toBe(false);
    // A cover whose packaging SAM did not find goes without where it is.
    const unplaced = buildShare('protocol', storyRun(), bca, {}, { cover: { src: cover.src, round: 'shot-2' } });
    expect(unplaced.cover).toEqual({ photo: cover.src });
    expect(SharedSetup.safeParse(unplaced).success).toBe(true);
  });

  it('hears whether to send the photos', () => {
    expect(parsePhotos('Without the photos')).toBe(false);
    expect(parsePhotos("don't send my pictures")).toBe(false);
    expect(parsePhotos('send the photos too')).toBe(true);
    expect(parsePhotos('just the protocol')).toBeNull();
  });

  it('leaves the results out of "everything" while there are no readings', () => {
    expect(buildShare('all', { ...storyRun(), readings: {} }, bca).results).toBeUndefined();
  });

  it('fits the sample plate as the results screens do', () => {
    const r2 = standardR2(bca, storyRun())!;
    expect(r2).toBeGreaterThan(0.99);
    expect(r2).toBeLessThan(1);
    expect(standardR2(bca, { ...storyRun(), readings: {} })).toBeUndefined();
  });

  it('marks Chapp\'s example readings, so the labmate sees "Sample data" too', () => {
    const run = storyRun();
    expect(buildShare('all', run, bca, { sampleData: true }).results!.sampleData).toBe(true);
    expect(buildShare('all', run, bca, { sampleData: false }).results!.sampleData).toBe(false);
  });
});

describe('what the labmate is told they get', () => {
  it('matches Scan-Import: 7 steps; 9 standards ×2, 12 samples ×2, 10 mL working reagent; 12 samples measured', () => {
    const run = storyRun();
    const t = travels(buildShare('all', run, bca, { r2: 0.998 }), bca);
    expect(t).toEqual({ steps: 7, plan: { standards: 9, standardReplicates: 2, samples: 12, replicates: 2, reagentMl: 10 }, results: { samples: 12, r2: 0.998 }, photos: 1 });
    expect(travels(buildShare('protocol', run, bca, {}, { photos: false }), bca)).toEqual({ steps: 7 });
  });

  it('rounds the working reagent up like the Plan artboard (need + 10%, to a round number of mL)', () => {
    // 42 wells × 200 µL = 8.4 mL → 9.24 → 10; triplicate 63 wells → 12.6 → 13.86 → 15.
    expect(travels({ procedure: 'microplate', plan: { samples: 12, replicates: 2 } }, bca).plan!.reagentMl).toBe(10);
    expect(travels({ procedure: 'microplate', plan: { samples: 12, replicates: 3 } }, bca).plan!.reagentMl).toBe(15);
  });

  it('counts the standards the plan made: five standards once beside samples ×3', () => {
    const t = travels({ procedure: 'microplate', plan: { samples: 12, replicates: 3, standardReplicates: 1, standards: 'five' } }, bca);
    // 5 + 36 = 41 wells × 200 µL = 8.2 mL → 9.02 → 10 mL.
    expect(t.plan).toEqual({ standards: 5, standardReplicates: 1, samples: 12, replicates: 3, reagentMl: 10 });
  });

  it('says when the results were shared', () => {
    const now = new Date('2026-10-28T18:00:00');
    expect(whenSaid('2026-10-28T08:00:00', now)).toBe('today');
    expect(whenSaid('2026-10-27T23:00:00', now)).toBe('yesterday');
    expect(whenSaid('2026-10-20T12:00:00', now)).toBe('Oct 20');
  });
});

describe('importing', () => {
  const labmate: RunSnapshot = {
    protocolId: 'pierce-bca',
    procedure: 'test-tube',
    samples: 3,
    replicates: 1,
    standardReplicates: 1,
    standards: 'halve',
    photos: { bsa: 'data:image/jpeg;base64,BBBB' },
    readings: { A1: 1 },
  };

  it("writes the sharer's protocol, plan and readings and starts the run over", () => {
    const run = storyRun();
    const patch = importPatch(stored(buildShare('all', run, bca)), labmate);
    expect(patch).toMatchObject({ protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit', step: 0, done: {}, timers: {} });
    expect(patch.readings).toEqual(run.readings);
    expect(patch.readingsFrom).toBe('plate');
    // Their own photo of the same kit's bottle stays.
    expect(patch.photos).toEqual({ bsa: 'data:image/jpeg;base64,BBBB' });
  });

  it('keeps their own plan when only the protocol came, and clears old readings', () => {
    const patch = importPatch(stored(buildShare('protocol', storyRun(), bca)), labmate);
    expect(patch).toMatchObject({ procedure: 'microplate', samples: 3, replicates: 1, standardReplicates: 1, standards: 'halve', readings: {}, readingsFrom: null });
  });

  it('keeps Chapp\'s example readings labeled "Sample data" on the labmate\'s phone', () => {
    const patch = importPatch(stored(buildShare('all', storyRun(), bca, { sampleData: true })), labmate);
    expect(patch.readingsFrom).toBe('sample');
  });

  it('reads a share from before the plan carried its standards as the kit\'s table, like the samples', () => {
    const old = stored({ ...buildShare('noresults', storyRun(), bca), plan: { samples: 8, replicates: 3 } });
    expect(importPatch(old, labmate)).toMatchObject({ samples: 8, replicates: 3, standardReplicates: 3, standards: 'kit' });
  });

  it('drops photos of another kit, and takes photos that came with a share', () => {
    const other = { ...labmate, protocolId: 'other-kit' };
    expect(importPatch(stored(buildShare('noresults', storyRun(), bca, {}, { photos: false })), other).photos).toEqual({});
    const withPhoto = stored({ ...buildShare('noresults', storyRun(), bca), kit: [{ id: 'bsa', label: 'BSA', photo: 'data:image/jpeg;base64,CCCC' }] });
    expect(importPatch(withPhoto, other).photos).toEqual({ bsa: 'data:image/jpeg;base64,CCCC' });
    // Photos the labmate took of this kit before come back; the share's fill the rest.
    const theirs = { bsa: 'data:image/jpeg;base64,MINE', 'reagent-a': 'data:image/jpeg;base64,AAAA' };
    expect(importPatch(withPhoto, other, theirs).photos).toEqual(theirs);
  });
});

describe('trimming by replying', () => {
  it.each([
    ['Without the results', 'noresults'],
    ['send it without the results please', 'noresults'],
    ['leave out the data', 'noresults'],
    ['no results', 'noresults'],
    ['Just the protocol', 'protocol'],
    ['only the protocol.', 'protocol'],
    ['protocol only', 'protocol'],
    ['without the plan', 'protocol'],
    ['send everything', 'all'],
    ['include the results', 'all'],
  ])('"%s" → %s', (said, scope) => {
    expect(parseTrim(said)).toBe(scope);
  });

  it('leaves anything else to Chapp', () => {
    expect(parseTrim('who can scan this?')).toBeNull();
    expect(parseTrim('12 samples')).toBeNull();
    expect(parseTrim('')).toBeNull();
  });
});

describe('a share of a plate changed during the run', () => {
  it('carries the wells moved and added with the plan, and puts them back on import', () => {
    const edits = { moved: { B3: 'H12' }, added: [{ name: 'heat shock', wells: ['G5', 'G6'] }] };
    const run = { ...storyRun(), edits };
    const setup = buildShare('all', run, bca);
    expect(setup.plan?.edits).toEqual(edits);
    expect(SharedSetup.safeParse(setup).success).toBe(true);
    const patch = importPatch(stored(setup), { ...storyRun(), protocolId: null });
    expect(patch.edits).toEqual(edits);
    // A run with nothing changed sends no edits, and an import of it starts clean.
    const plain = buildShare('all', storyRun(), bca);
    expect(plain.plan && 'edits' in plain.plan).toBe(false);
    expect(importPatch(stored(plain), storyRun()).edits).toEqual({ moved: {}, added: [] });
  });
});
