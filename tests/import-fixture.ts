import type { Intro, Parts } from '../server/ai/import.ts';

// A made-up kit small enough to check by hand: one bottle of standard, two reagents mixed 10:1, a three-vial table
// and a four-step microplate procedure. What the four calls would send back, already in the wire format.
export const parts = (): Parts => ({
  inventory: {
    docTitle: 'Demo Assay Kit Manual', publisher: 'Demo Bio', docId: 'DM-1', revision: '2', date: '2026-01-02', pages: 2,
    kitName: 'Demo Assay Kit', vendor: 'Demo Bio', kitCite: 'p1 table: Contents',
    variants: [{ catalog: 'D100', scale: '100 assays' }],
    contents: [
      { catalog: 'D100', component: 'Reagent A', amount: '1 x 50 mL' },
      { catalog: 'D100', component: 'reagent-b', amount: '5 mL' },
      { catalog: 'D100', component: 'std', amount: '' },
    ],
    components: [
      { id: 'Reagent A', name: 'Reagent A', role: 'reagent', suppliedBy: 'kit', concentration: '', storage: '2–8', labels: ['Reagent A'] },
      { id: 'reagent-b', name: 'Reagent B', role: 'reagent', suppliedBy: 'kit', concentration: '', storage: '-20', labels: [] },
      { id: 'std', name: 'Standard', role: 'standard', suppliedBy: 'kit', concentration: '1 mg/mL', storage: '', labels: [] },
      { id: 'buffer', name: 'Buffer', role: 'diluent', suppliedBy: 'user', concentration: '', storage: '', labels: [] },
    ],
    equipment: [{ id: 'reader', name: 'Plate reader', icon: 'plate-reader', setting: '450 nm' }],
    mixes: [
      { id: 'wr', name: 'Working Reagent', short: 'WR', cite: 'p1: Mix 10 parts A with 1 part B.' },
      { id: 'lonely', name: 'Half a mix', short: '', cite: 'p1: x' },
    ],
    mixParts: [{ mix: 'wr', component: 'Reagent A', parts: 10, amount: '' }, { mix: 'wr', component: 'reagent-b', parts: 1, amount: '' }, { mix: 'lonely', component: 'std', parts: 1, amount: '' }],
    curves: [{ id: 'curve', name: 'Standard', stock: 'std', diluent: 'buffer', range: '10-1000 ug/mL', cite: 'p1 table: Table 1' }],
    procedures: [{ id: 'plate', name: 'Microplate', format: 'microplate', ratio: '1:10', sample: '20 uL', mixPerSample: '200 uL', mix: 'wr', curve: 'curve', range: '10-1000 ug/mL' }],
  },
  steps: {
    steps: [
      { procedureId: 'plate', stepId: 'p-warm', before: true, stage: 'prepare', title: 'Warm the reagents', key: 'Bring Reagents A and B to room temperature', makes: '', equipment: [], cite: 'p1: Bring the reagents to room temperature.' },
      { procedureId: 'plate', stepId: 'p-standards', before: false, stage: 'standards', title: 'Make the standards', key: 'Vials A–C', makes: 'curve', equipment: [], cite: 'p1: Dilute the standard.' },
      { procedureId: 'plate', stepId: 'p-load', before: false, stage: 'load', title: 'Load', key: '20 µL per well', makes: '', equipment: [], cite: 'p2: Add 20 µL.' },
      { procedureId: 'Microplate', stepId: 'p-incubate', before: false, stage: 'incubate', title: 'Incubate', key: '37 °C · 30 min', makes: '', equipment: [], cite: 'p2: Incubate at 37°C for 30 minutes.' },
      { procedureId: 'plate', stepId: 'p-read', before: false, stage: 'read', title: 'Read', key: 'Read at 450 nm', makes: '', equipment: ['Reader'], cite: 'p2: Read at 450 nm.' },
    ],
    timers: [{ stepId: 'p-incubate', label: 'Incubate', time: '30 min', temperature: '37', covered: true }],
    additions: [
      { stepId: 'p-load', what: 'standards-and-samples', ref: '', volume: '20 uL', per: 'well' },
      { stepId: 'p-load', what: 'mix', ref: '', volume: '200 uL', per: 'well' },
    ],
    alternatives: [{ stepId: 'p-incubate', label: 'Longer', time: '2 h', temperature: '15-30', range: '', curve: '', cite: 'p2: Or 2 hours at room temperature.' }],
    notes: [
      { stepId: 'p-load', kind: 'tip', text: 'Pipette slowly.', cite: 'p2: Avoid bubbles.' },
      { stepId: 'p-read', kind: 'info', text: 'No source for this one.', cite: 'p2' },
    ],
  },
  curves: {
    points: [
      { curve: 'curve', id: 'a', diluent: '0', from: 'Stock', take: '100 uL', concentration: '1000 ug/mL', blank: false },
      { curve: 'curve', id: 'B', diluent: '50 uL', from: 'A', take: '50 uL', concentration: '500 ug/mL', blank: false },
      { curve: 'curve', id: 'C', diluent: '100 uL', from: '', take: '0', concentration: '0', blank: true },
    ],
  },
  notes: {
    title: 'Demo™ Assay Kit', summary: 'Colorimetric demo assay: it turns yellow. Range 10–1,000 µg/mL.',
    overviewProcedure: 'plate', overviewSteps: ['Mix A and B 10:1', 'Incubate 30 min at 37°C'], overviewExpected: [], overviewCite: 'p1 figure: Fig. 1',
    hasAnalysis: true, readout: 450, acceptableMin: 0, acceptableMax: 0, fitPreferred: [], fitByHand: '', fitAvoid: ['linear'], analysisCite: 'p2: Plot the standards.',
    notes: [
      { on: 'wr', kind: 'expected', text: 'It turns green.', cite: 'p1: The WR is green.' },
      { on: 'general', kind: 'info', text: 'Research use only.', cite: 'p1: For research use only.' },
      { on: 'somewhere-else', kind: 'caution', text: 'Wear gloves.', cite: 'p1: Wear gloves.' },
    ],
    defaultsProcedure: 'plate', defaultsSamples: 0, defaultsReplicates: 0, defaultsCite: '',
  },
});

/** The intro the same made-up manual would get: what the kit is and its at-a-glance lines, read fast. */
export const intro = (): Intro => ({
  kitName: 'Demo Assay Kit', vendor: 'Demo Bio', catalogs: ['D100'], docTitle: 'Demo Assay Kit Manual', publisher: 'Demo Bio', docId: 'DM-1', revision: '2',
  title: 'Demo Assay', summary: 'Colorimetric demo assay: samples turn yellow with the working reagent; read at 450 nm. Range 10–1,000 µg/mL.',
  overviewSteps: ['Mix A and B 10:1', '20 µL sample + 200 µL WR', 'Incubate 30 min at 37°C', 'Read at 450 nm'],
  overviewExpected: ['Wells turn yellow'],
  overviewCite: 'p1 figure: Fig. 1 Procedure summary',
  procedureName: 'Microplate', otherProcedures: [],
  steps: [{ text: 'Dilute the standard into vials A–C', page: 1 }, { text: 'Add 20 µL of each to a well', page: 2 }, { text: 'Incubate at 37°C for 30 minutes', page: 2 }, { text: 'Read at 450 nm', page: 2 }],
  contents: [{ name: 'Reagent A', amount: '50 mL' }, { name: 'Reagent B', amount: '5 mL' }, { name: 'Standard', amount: '1 vial' }],
});
