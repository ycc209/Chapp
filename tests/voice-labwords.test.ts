import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_TERMS, distance, fixLabWords, labTerms, needsModelFix } from '../src/voice/labWords.ts';

// The lab-word fixes run on every transcript (src/voice/controller.ts, server/ai/meta.ts transcribe). No network.

// The BCA kit's names as the server builds them from data/protocols/pierce-bca.json (labTerms).
const BCA_TERMS = labTerms([
  {
    kit: { name: 'Pierce BCA Protein Assay Kit', vendor: 'Thermo Scientific' },
    components: [{ name: 'BCA Reagent A' }, { name: 'BCA Reagent B' }, { name: 'Albumin Standard' }],
  },
]);

describe('fixLabWords', () => {
  it.each([
    // Heard by Muse Voice Transcribe from macOS voices saying the storyboard's first line (2026-10-28).
    ['I just got a pierce PCA Protein Assay Kit. Help me run it.', 'I just got a Pierce BCA Protein Assay Kit. Help me run it.'],
    ['I just got a PSBCA protein sake it help me run it', 'I just got a Pierce BCA protein assay kit help me run it'],
    ['I just got a Pierce BCA protein shake kit. Help me run it.', 'I just got a Pierce BCA protein assay kit. Help me run it.'],
    ['I just got a pierced BCA protein acetate kit.', 'I just got a Pierce BCA protein assay kit.'],
    ['I just got a PCA Protein Assay Kit.', 'I just got a BCA Protein Assay Kit.'],
    ['B.C.A. kit please', 'BCA kit please'],
    ['Add PCA reagent B now', 'Add BCA reagent B now'],
    ['what about the albumen standard?', 'what about the Albumin Standard?'],
    ['I got a Pierce BCA protein assay kitt', 'I got a Pierce BCA Protein Assay Kit'],
  ])('%s → %s', (heard, said) => {
    expect(fixLabWords(heard, BCA_TERMS)).toBe(said);
  });

  it.each([
    'Add BCA reagent B now',
    'Pierce BCA protein assay',
    'Make it triplicates.',
    'C is okay.',
    'Next.',
    'the protein shake in the fridge',
    'What if it turns cloudy when I add B?',
    '加 B 之後變混濁怎麼辦？',
  ])('leaves "%s" as it was said', said => {
    expect(fixLabWords(said, BCA_TERMS)).toBe(said);
  });

  it('works on the phone without a protocol, from the base terms', () => {
    expect(fixLabWords('I just got a pierced BCA protein acetate kit')).toBe('I just got a Pierce BCA protein assay kit');
    expect(BASE_TERMS).toContain('Pierce BCA Protein Assay Kit');
  });
});

describe('needsModelFix', () => {
  it('flags a short capitalized word one letter off a known one, and nothing else', () => {
    expect(needsModelFix('I have a PCA kit', BCA_TERMS)).toBe(true);
    expect(needsModelFix('Is the BSA in the fridge?', BCA_TERMS)).toBe(false);
    expect(needsModelFix('Run the PCR after this', BCA_TERMS)).toBe(false);
    expect(needsModelFix('C is okay.', BCA_TERMS)).toBe(false);
    expect(needsModelFix('I just got a Pierce BCA Protein Assay Kit.', BCA_TERMS)).toBe(false);
  });
});

describe('distance', () => {
  it('counts edits', () => {
    expect(distance('BCA', 'PCA')).toBe(1);
    expect(distance('kitten', 'sitting')).toBe(3);
    expect(distance('', 'abc')).toBe(3);
  });
});

// What scripts/voice-smoke.ts heard from the live transcriber (data/smoke/converse/voice-*.json, git-ignored).
const saved = new URL('../data/smoke/converse/', import.meta.url);
const runs = existsSync(saved) ? readdirSync(saved).filter(f => f.startsWith('voice-')).map(f => new URL(f, saved)) : [];

describe.skipIf(!runs.length)('live transcripts', () => {
  it('put the kit’s name right in every saved transcript that said it', () => {
    for (const file of runs) {
      for (const { said, heard } of JSON.parse(readFileSync(file, 'utf8')) as { said: string; heard: string }[]) {
        if (!/Pierce BCA/.test(said) || !heard) continue;
        expect(fixLabWords(heard, BCA_TERMS), heard).toMatch(/Pierce BCA protein assay kit/i);
      }
    }
  });
});
