import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Protocol } from '../shared/protocol.ts';
import { procedureFor } from '../src/screens/protocol/content.ts';
import { SimplePicture } from '../src/screens/protocol/StepPicture.tsx';

// The pictures on the protocol's step cards (StepPicture), drawn from each protocol here: every hands-on step gets
// one, and it carries the protocol's own numbers and colours.

const dir = new URL('../data/protocols/', import.meta.url);
const protocols = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => Protocol.parse(JSON.parse(readFileSync(new URL(f, dir), 'utf8')))) : [];
const HANDS_ON = new Set(['standards', 'prepare', 'mix', 'load', 'treat', 'wash']);
const draw = (p: Protocol, stepId: string) => renderToStaticMarkup(<SimplePicture protocol={p} stepId={stepId} />);

describe.skipIf(!protocols.length)('step pictures', () => {
  it.each(protocols.map(p => [p.id, p] as const))('%s: every hands-on step is drawn', (_, p) => {
    const proc = procedureFor(p);
    for (const step of [...(proc.prep ?? []), ...proc.steps].filter(s => HANDS_ON.has(s.stage))) {
      const svg = draw(p, step.id);
      expect(svg, step.id).toMatch(/^<svg[^>]*viewBox="0 0 100 100"/);
      expect(svg.length, step.id).toBeGreaterThan(200);
    }
  });

  it('draws BCA’s standards as its vials and its working reagent in the colour the protocol gives it', () => {
    const bca = protocols.find(p => p.id === 'pierce-bca');
    if (!bca) return;
    const proc = procedureFor(bca);
    const standards = draw(bca, proc.steps.find(s => s.stage === 'standards')!.id);
    for (const vial of ['A', 'E', 'I']) expect(standards).toContain(`>${vial}</text>`);
    const mix = draw(bca, proc.steps.find(s => s.stage === 'mix')!.id);
    expect(mix).toContain('#3aa76d');
    expect(mix).toContain('>50</text>');
  });
});
