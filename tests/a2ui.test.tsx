import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { checkA2ui, componentsOf, dataPaths, numbersIn, type A2uiMessage } from '../shared/a2ui.ts';
import { Protocol } from '../shared/protocol.ts';
import { checkSay, sayableNumbers, systemPrompt } from '../server/ai/meta.ts';
import { A2uiSurface } from '../src/components/a2ui/Surface.tsx';
import { dataModel, valueAt, volumeIn } from '../src/components/a2ui/data.ts';
import { useRun } from '../src/state/run.ts';

// A2UI v0.9 as Chapp speaks it: the server's checks on what Muse Spark writes, the words agreeing with the card, and
// the phone's renderer filling the data model from the run. No network.

const file = new URL('../data/protocols/pierce-bca.json', import.meta.url);
const bca = existsSync(file) ? Protocol.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
const steps = [{ id: 'm-mix' }, { id: 'm-add-wr', timer: {} }, { id: 'm-incubate', timer: {} }];
const rules = (said = '') => ({ steps, said });
const surface = (components: object[], version: unknown = 'v0.9') => [
  { version, createSurface: { surfaceId: 'answer', catalogId: 'chapp' } },
  { version, updateComponents: { surfaceId: 'answer', components } },
];
const kept = (out: { messages: A2uiMessage[] }) => [...componentsOf(out.messages).values()];

describe('checkA2ui', () => {
  it('keeps a valid surface as it is, from a string or an array', () => {
    const components = [
      { id: 'root', component: 'Card', child: 'col' },
      { id: 'col', component: 'Column', children: ['title', 'make'] },
      { id: 'title', component: 'Text', text: 'Working reagent', variant: 'h3' },
      { id: 'make', component: 'Text', text: { path: '/reagent/make' } },
    ];
    const out = checkA2ui(JSON.stringify(surface(components)), rules());
    expect(out.messages).toEqual(surface(components));
    expect(out.dropped).toEqual([]);
    expect(checkA2ui(surface(components), rules()).messages).toEqual(surface(components));
  });

  it('puts the version right, and the createSurface first when it is missing', () => {
    const out = checkA2ui([{ updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'ReagentCard' }] } }], rules());
    expect(out.messages).toEqual(surface([{ id: 'root', component: 'ReagentCard' }]));
    expect(out.dropped).toContain('version fixed');
  });

  it('never takes a data model from the model', () => {
    const out = checkA2ui([...surface([{ id: 'root', component: 'ReagentCard' }]), { version: 'v0.9', updateDataModel: { surfaceId: 'answer', path: '/reagent/make', value: '99 mL' } }], rules());
    expect(out.messages).toHaveLength(2);
    expect(out.dropped).toContain('updateDataModel');
  });

  it('drops unknown components, bindings outside the data model and numbers the user did not say, then what hung from them', () => {
    const out = checkA2ui(surface([
      { id: 'root', component: 'Column', children: ['a', 'b', 'c', 'd', 'e', 'gone'] },
      { id: 'a', component: 'Chart', data: [1, 2] },
      { id: 'b', component: 'Text', text: { path: '/secret/numbers' } },
      { id: 'c', component: 'Text', text: 'Make 13 mL' },
      { id: 'd', component: 'Card', child: 'a' },
      { id: 'e', component: 'Text', text: 'For your 30 samples' },
    ]), rules('I have 30 samples'));
    expect(kept(out)).toEqual([{ id: 'root', component: 'Column', children: ['e'] }, { id: 'e', component: 'Text', text: 'For your 30 samples' }]);
    expect(out.dropped).toEqual(expect.arrayContaining(['unknown Chart', 'Text b (text)', 'Text c (text)']));
  });

  it('is no surface when no root is left', () => {
    expect(checkA2ui(surface([{ id: 'root', component: 'Text', text: 'Use 40 µL' }]), rules()).messages).toEqual([]);
    expect(checkA2ui(surface([{ id: 'main', component: 'ReagentCard' }]), rules()).messages).toEqual([]);
    expect(checkA2ui('[]', rules())).toEqual({ messages: [], dropped: [] });
    expect(checkA2ui('{not json', rules()).dropped).toEqual(['a2ui not JSON (9 chars: {x x)']);
  });

  it('checks the steps a card names, and that a timer card names a timed one', () => {
    const out = checkA2ui(surface([
      { id: 'root', component: 'Column', children: ['s', 't', 'u', 'v'] },
      { id: 's', component: 'StepCard', stepId: 'm-mix' },
      { id: 't', component: 'TimerCard', stepId: 'm-incubate' },
      { id: 'u', component: 'TimerCard', stepId: 'm-mix' },
      { id: 'v', component: 'StepCard', stepId: 'm-dance' },
    ]), rules());
    expect(kept(out).map(c => c.id)).toEqual(['root', 's', 't']);
  });

  it('keeps samples and replicates the user named, and a Compare of a volume against what they said they have', () => {
    const out = checkA2ui(surface([
      { id: 'root', component: 'Column', children: ['r', 'c', 'x'] },
      { id: 'r', component: 'ReagentCard', samples: 30, replicates: 3 },
      { id: 'c', component: 'Compare', need: { path: '/reagent/make' }, have: '15 mL', samples: 30 },
      { id: 'x', component: 'Compare', need: { path: '/plan/wells' }, have: '15 mL' },
    ]), rules('I have 30 samples but only 15 mL of working reagent left'));
    const [, r, c] = kept(out);
    // 3 replicates were never said: the card shows the run's.
    expect(r).toEqual({ id: 'r', component: 'ReagentCard', samples: 30 });
    expect(c).toEqual({ id: 'c', component: 'Compare', need: { path: '/reagent/make' }, have: '15 mL', samples: 30 });
    expect(kept(out)).toHaveLength(3);
  });

  it('reads a bare path as the binding it means, and a bare amount with the unit the user said', () => {
    const out = checkA2ui(surface([{ id: 'root', component: 'Compare', need: '/reagent/make', have: 15, samples: 30 }]), rules('I have 30 samples but only 15 mL of working reagent left'));
    expect(kept(out)).toEqual([{ id: 'root', component: 'Compare', need: { path: '/reagent/make' }, have: '15 mL', samples: 30 }]);
    // An amount the user never said, or a need that is not a volume, says why it went.
    const wrong = checkA2ui(surface([{ id: 'root', component: 'Column', children: ['a', 'b'] }, { id: 'a', component: 'Compare', need: '/reagent/make', have: '20 mL' }, { id: 'b', component: 'Compare', need: '/plan/wells', have: '15 mL' }]), rules('only 15 mL left'));
    expect(wrong.messages).toEqual([]);
    expect(wrong.dropped).toEqual(expect.arrayContaining(['Compare a (have)', 'Compare b (need not a volume)']));
  });

  it('keeps independent standard counts on each calculated card and rejects unsupported counts', () => {
    const components = [
      { id: 'root', component: 'Column', children: ['p', 'r', 's', 'bad'] },
      ...['PlateCard', 'ReagentCard', 'StandardsCard'].map((component, i) => ({ id: ['p', 'r', 's'][i]!, component, samples: 12, replicates: 3, standardReplicates: 2 })),
      { id: 'bad', component: 'PlateCard', standardReplicates: 5 },
    ];
    const out = checkA2ui(surface(components), rules('12 samples in 3 replicates, standards in 2 replicates; not 5'));
    expect(kept(out).slice(1, 4)).toEqual(components.slice(1, 4));
    expect(componentsOf(out.messages).get('bad')).toEqual({ id: 'bad', component: 'PlateCard' });
  });

  it('reads A2UI written one message per line, in a code fence, or as one message with both keys', () => {
    const create = { version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: 'chapp' } };
    const update = { version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'ReagentCard' }] } };
    const want = surface([{ id: 'root', component: 'ReagentCard' }]);
    expect(checkA2ui(`${JSON.stringify(create)}\n${JSON.stringify(update)}`, rules()).messages).toEqual(want);
    expect(checkA2ui(`\`\`\`json\n${JSON.stringify([create, update])}\n\`\`\``, rules()).messages).toEqual(want);
    expect(checkA2ui(JSON.stringify({ ...create, ...update }), rules()).messages).toEqual(want);
  });

  it('takes a Compare’s need written as "bound"', () => {
    const out = checkA2ui(surface([{ id: 'root', component: 'Compare', bound: { path: '/reagent/make' }, have: '10 mL' }]), rules('I have 10 mL'));
    expect(componentsOf(out.messages).get('root')).toEqual({ id: 'root', component: 'Compare', need: { path: '/reagent/make' }, have: '10 mL' });
  });

  it('follows a loop only once', () => {
    const out = checkA2ui(surface([
      { id: 'root', component: 'Column', children: ['a'] },
      { id: 'a', component: 'Card', child: 'root' },
    ]), rules());
    expect(kept(out).map(c => c.id)).toEqual(['root', 'a']);
  });

  it('lists the data paths the prompt offers', () => {
    expect(dataPaths(steps)).toEqual(expect.arrayContaining(['/reagent/make', '/standards/stock', '/steps/m-mix/key', '/steps/m-incubate/time']));
    expect(dataPaths(steps)).not.toContain('/steps/m-mix/time');
    expect(numbersIn('1,500 µg/mL, 0.5 mL and twelve samples', true)).toEqual([1500, 0.5, 12]);
  });
});

describe.skipIf(!bca)('the words agree with the card', () => {
  const context = { screen: 'chat', protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 3, standardReplicates: 3, standards: 'kit' as const };
  const card = surface([{ id: 'root', component: 'ReagentCard' }]) as A2uiMessage[];

  it('takes out a number Chapp worked out itself, pointing at the card instead', () => {
    const sayable = sayableNumbers(systemPrompt(context), 'How much working reagent for triplicates?', bca, context, card);
    // The app makes 15 mL for 12 samples in triplicate; "13 mL" was the model's own sum (the 2026-10-29 screenshot).
    expect(sayable.has(15)).toBe(true);
    expect(checkSay('For triplicates you need 13 mL of working reagent.', sayable, true)).toEqual({ say: 'Here it is, worked out for your plan.', removed: 1 });
    expect(checkSay('Mix it 50 to 1. You need 13 mL.', sayable, true)).toEqual({ say: 'Mix it 50 to 1.', removed: 1 });
    expect(checkSay('Here is what to mix for your 12 samples.', sayable, true).removed).toBe(0);
    expect(checkSay('你需要 13 mL。', sayable, false).say).toMatch(/不猜/);
  });

  it('may say what the card works out for the samples the user asked about', () => {
    const thirty = surface([{ id: 'root', component: 'ReagentCard', samples: 30 }]) as A2uiMessage[];
    const sayable = sayableNumbers(systemPrompt(context), 'How much for 30 samples?', bca, context, thirty);
    const make = Number(String(valueAt(dataModel(bca!, { ...context, samples: 30, standardReplicates: 3 }), '/reagent/make')).split(' ')[0]);
    expect(sayable.has(make)).toBe(true);
  });
});

describe.skipIf(!bca)('the renderer', () => {
  useRun.setState({ protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' });

  it('fills the data model from the run’s plan, as the plan screen works it out', () => {
    const model = dataModel(bca!, { procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' });
    expect(model.plan.wells).toBe('42');
    expect(model.reagent).toMatchObject({ make: '10 mL', partA: '9.8 mL', partB: '196 µL', ratio: '50 : 1' });
    expect(model.steps['m-incubate']).toMatchObject({ time: '30 min', temp: '37 °C' });
    expect(volumeIn('15 mL')).toBe(15000);
    expect(volumeIn('about 200µl')).toBe(200);
  });

  it('draws bound values from the data model, never from the model’s words', () => {
    const html = renderToStaticMarkup(
      <A2uiSurface
        protocol={bca!}
        messages={surface([
          { id: 'root', component: 'Card', child: 'col' },
          { id: 'col', component: 'Column', children: ['title', 'row'] },
          { id: 'title', component: 'Text', text: 'Working reagent', variant: 'h3' },
          { id: 'row', component: 'Row', children: ['label', 'make'] },
          { id: 'label', component: 'Text', text: 'To make', variant: 'caption' },
          { id: 'make', component: 'Text', text: { path: '/reagent/make' } },
        ]) as A2uiMessage[]}
      />,
    );
    expect(html).toContain('Working reagent');
    expect(html).toContain('10 mL');
  });

  it('works Chapp’s cards out for the samples asked about, and judges a Compare', () => {
    const html = renderToStaticMarkup(
      <A2uiSurface
        protocol={bca!}
        messages={surface([
          { id: 'root', component: 'Column', children: ['r', 'c'] },
          { id: 'r', component: 'ReagentCard', samples: 30 },
          { id: 'c', component: 'Compare', need: { path: '/reagent/make' }, have: '15 mL', samples: 30 },
        ]) as A2uiMessage[]}
      />,
    );
    // 30 samples × 2 and 9 standards × 2 = 78 wells × 200 µL, 10 % spare → 20 mL to make.
    expect(html).toContain('Working reagent · 20 mL');
    expect(html).toContain('30 samples × 2');
    expect(html).toContain('Short by 5 mL');
  });

  it('draws nothing without a root', () => {
    expect(renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={[]} />)).toBe('');
  });

  it('renders 54 wells for twelve triplicate samples and nine duplicate standards', () => {
    for (const counts of [{ replicates: 3 }, { replicates: 3, standardReplicates: 2 }]) {
      const html = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={surface([{ id: 'root', component: 'PlateCard', samples: 12, ...counts }]) as A2uiMessage[]} />);
      expect(html).toContain('Plate · 54 wells');
      expect(html).not.toContain('63 wells');
    }
    const single = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={surface([{ id: 'root', component: 'PlateCard', samples: 12, replicates: 3, standardReplicates: 1 }]) as A2uiMessage[]} />);
    expect(single).toContain('Plate · 45 wells');
  });

  it('offers a plan when only the standard count differs and renders that count', () => {
    const html = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={surface([
      { id: 'root', component: 'Column', children: ['p', 's'] },
      { id: 'p', component: 'PlateCard', samples: 12, replicates: 2, standardReplicates: 1 },
      { id: 's', component: 'StandardsCard', standardReplicates: 1 },
    ]) as A2uiMessage[]} live onAnswer={() => {}} />);
    expect(html).toContain('Plate · 33 wells');
    expect(html).toContain('Use this plan');
    expect(html).toContain('>×1<');
  });

  it('lets the latest answer’s card be changed, and offers its plan for the run when it is not the run’s', () => {
    const messages = surface([{ id: 'root', component: 'ReagentCard', samples: 30 }]) as A2uiMessage[];
    const live = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={messages} live onAnswer={() => {}} />);
    expect(live).toContain('aria-label="Samples"');
    expect(live).toContain('Use this plan');
    // An older answer, or one that cannot answer back: just the card.
    expect(renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={messages} />)).not.toContain('Use this plan');
  });

  it('numbers a step as Run does: the analysis after the run is not one of its steps', () => {
    const steps = (id: string) => renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={surface([{ id: 'root', component: 'StepCard', stepId: id }]) as A2uiMessage[]} />);
    expect(steps('m-read')).toContain('Step 6 of 6');
    expect(steps('m-analyze')).toContain('After the run');
  });

  it('puts one set of plan controls under the last plan card, shared by all of them', () => {
    const messages = surface([
      { id: 'root', component: 'Column', children: ['r', 'p'] },
      { id: 'r', component: 'ReagentCard', samples: 30 },
      { id: 'p', component: 'PlateCard', samples: 30 },
    ]) as A2uiMessage[];
    const html = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={messages} live onAnswer={() => {}} />);
    expect(html.match(/aria-label="Samples"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="Samples"')).toBeGreaterThan(html.indexOf('Plate · '));
  });

  it('asks about the plan filled in with the run’s values, in the language asked in', () => {
    useRun.setState({ samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit', procedure: 'microplate' });
    const messages = surface([{ id: 'root', component: 'Ask', fields: ['samples', 'replicates'] }]) as A2uiMessage[];
    const en = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={messages} live onAnswer={() => {}} ask="How much reagent do I need?" />);
    expect(en).toContain('A few things first');
    expect(en).toContain('>12<');
    expect(en).toContain('aria-checked="true" aria-label="Duplicate"');
    expect(en).toContain('Continue');
    const zh = renderToStaticMarkup(<A2uiSurface protocol={bca!} messages={messages} live onAnswer={() => {}} ask="我要配多少工作液？" />);
    expect(zh).toContain('先確認一下');
    expect(zh).toContain('繼續');
  });

  it('draws a choice even with no kit open, and no Chapp card then', () => {
    const html = renderToStaticMarkup(
      <A2uiSurface
        protocol={null}
        live
        onAnswer={() => {}}
        messages={surface([
          { id: 'root', component: 'Column', children: ['q', 'pick', 'r'] },
          { id: 'q', component: 'Text', text: 'Which one did you mean?' },
          { id: 'pick', component: 'ChoicePicker', options: [{ label: 'EEA032', value: 'EEA032' }, { label: 'EEA302', value: 'EEA302' }] },
          { id: 'r', component: 'ReagentCard' },
        ]) as A2uiMessage[]}
      />,
    );
    expect(html).toContain('EEA032');
    expect(html).toContain('EEA302');
    expect(html).not.toContain('Working reagent');
  });
});
