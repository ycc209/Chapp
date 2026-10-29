import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkA2ui, componentsOf, numbersIn } from '../shared/a2ui.ts';
import type { Action, ConverseContext } from '../shared/ai.ts';
import { authorize, claimsChange, durationsSaid, type Rules } from '../server/ai/authorize.ts';
import { checkClaims, checkReply, replyLanguage } from '../server/ai/meta.ts';

// What Chapp may change on its own word (server/ai/authorize.ts), checked against sentences that went wrong in
// BioMuse's and Notos's real conversations: a question moved the run, a "not 72" was taken as done, a change was
// claimed that the app never made. No network.

const rules: Rules = { steps: ['m-mix', 'm-add-wr', 'm-incubate', 'm-read'], timed: [{ id: 'm-add-wr', seconds: 30 }, { id: 'm-incubate', seconds: 1800 }], vials: ['A', 'B', 'C'] };
const next: Action = { type: 'nextStep' };
const verdict = (action: Action, said: string, r = rules) => authorize(action, said, r).verdict;

describe('durationsSaid', () => {
  it('reads lengths of time in English and Chinese, words and digits', () => {
    expect(durationsSaid('change it to 24 hours, not 72 hours')).toEqual([86400, 259200]);
    expect(durationsSaid('change it to 24 hours, not 72')).toEqual([86400]);
    expect(durationsSaid('make it 45 min')).toEqual([2700]);
    expect(durationsSaid('two hours please')).toEqual([7200]);
    expect(durationsSaid('twenty four hours')).toEqual([86400]);
    expect(durationsSaid('改成二十四小時')).toEqual([86400]);
    expect(durationsSaid('改成兩個小時')).toEqual([7200]);
    expect(durationsSaid('一個半小時就好')).toEqual([5400]);
    expect(durationsSaid('半小時')).toEqual([1800]);
    expect(durationsSaid('30分鐘')).toEqual([1800]);
  });

  it('does not take a volume or a count for a time', () => {
    expect(durationsSaid('I have 30 mL left')).toEqual([]);
    expect(durationsSaid('30 samples')).toEqual([]);
    expect(durationsSaid('三分之一')).toEqual([]);
  });
});

describe('authorize', () => {
  it('moves the run when the user asks for it, in so many words', () => {
    expect(verdict(next, 'next step')).toBe('apply');
    expect(verdict(next, '好，下一步')).toBe('apply');
    // Notos: "過去了二十四個小時，那下一步" was not taken as next there; Muse Spark reads it, and the words say it.
    expect(verdict(next, 'Okay, so. So, 過去了二十四個小時,那下一步')).toBe('apply');
    expect(verdict(next, 'can you go to the next step?')).toBe('apply');
  });

  it('asks first when the words are a question or a "not yet"', () => {
    expect(verdict(next, 'is the next step the centrifuge?')).toBe('confirm');
    expect(verdict(next, '下一步是離心嗎？')).toBe('confirm');
    expect(verdict(next, '先不要下一步')).toBe('confirm');
    expect(verdict(next, "don't go to the next step yet")).toBe('confirm');
    expect(verdict(next, 'what does the plate reader need')).toBe('confirm');
  });

  it('sets samples and replicates only to what the user said', () => {
    expect(verdict({ type: 'setSamples', samples: 30 }, 'we have 30 samples')).toBe('apply');
    expect(verdict({ type: 'setSamples', samples: 30 }, '三十個樣本')).toBe('apply');
    expect(verdict({ type: 'setSamples', samples: 36 }, 'fill the plate')).toBe('confirm');
    expect(verdict({ type: 'setReplicates', replicates: 3 }, 'make it triplicates')).toBe('apply');
    expect(verdict({ type: 'setReplicates', replicates: 3 }, '改三重複')).toBe('apply');
    expect(verdict({ type: 'setReplicates', replicates: 3 }, 'make it duplicates')).toBe('confirm');
  });

  it('marks done only what exists, when the user says it is done', () => {
    expect(authorize({ type: 'markDone', id: 'c' }, 'C is done', rules)).toEqual({ verdict: 'apply', action: { type: 'markDone', id: 'C' } });
    expect(verdict({ type: 'markDone', id: 'm-mix' }, '混好了')).toBe('apply');
    expect(verdict({ type: 'markDone', id: 'Z' }, 'Z is done')).toBe('drop');
    expect(verdict({ type: 'markDone', id: 'C' }, 'is C done?')).toBe('confirm');
  });

  it('starts a timer for the step’s own length, never a length the model made up', () => {
    expect(authorize({ type: 'startTimer', id: 'm-incubate', seconds: 600 }, 'start the timer', rules)).toEqual({ verdict: 'apply', action: { type: 'startTimer', id: 'm-incubate', seconds: 1800 } });
    // The run's own length, where the user changed it.
    expect(authorize({ type: 'startTimer', id: 'm-incubate', seconds: 600 }, '開始計時', { ...rules, lengths: { 'm-incubate': 7200 } }).action).toEqual({ type: 'startTimer', id: 'm-incubate', seconds: 7200 });
    // A length the user names now.
    expect(authorize({ type: 'startTimer', id: 'm-incubate', seconds: 1800 }, 'start a 45 min timer', rules).action).toEqual({ type: 'startTimer', id: 'm-incubate', seconds: 2700 });
    expect(verdict({ type: 'startTimer', id: 'm-mix', seconds: 60 }, 'start the timer')).toBe('drop');
    expect(verdict({ type: 'startTimer', id: 'm-incubate', seconds: 1800 }, 'how long is the timer?')).toBe('confirm');
  });

  it('always asks before a step’s length changes, and only to a length the user said', () => {
    // Notos: "change the time into 24 hours, not 70 not 72 hours" was answered "Got it" and nothing changed.
    const asked = 'Okay, in this step, I’m going to change the time into 24 hours, not 70 not 72 hours';
    expect(authorize({ type: 'setStepTime', id: 'm-incubate', seconds: 86400 }, asked, rules)).toEqual({ verdict: 'confirm', action: { type: 'setStepTime', id: 'm-incubate', seconds: 86400 } });
    expect(authorize({ type: 'setStepTime', id: 'm-incubate', seconds: 2700 }, '這步改成四十五分鐘', rules).action).toEqual({ type: 'setStepTime', id: 'm-incubate', seconds: 2700 });
    // One length said, the model's sum off: the user's.
    expect(authorize({ type: 'setStepTime', id: 'm-incubate', seconds: 3000 }, 'make it 45 min', rules).action).toEqual({ type: 'setStepTime', id: 'm-incubate', seconds: 2700 });
    expect(verdict({ type: 'setStepTime', id: 'm-incubate', seconds: 2700 }, 'make it longer')).toBe('drop');
    expect(verdict({ type: 'setStepTime', id: 'm-mix', seconds: 2700 }, 'make it 45 min')).toBe('drop');
  });

  it('lets going somewhere and looking a kit up through', () => {
    expect(verdict({ type: 'navigate', to: '/plan' }, 'hmm')).toBe('apply');
    expect(verdict({ type: 'findProtocol', query: 'Pierce BCA' }, 'BCA?')).toBe('apply');
  });
});

describe('claims', () => {
  it('knows a sentence that says a change was made', () => {
    expect(claimsChange("I've set the timer to 24 hours.")).toBe(true);
    expect(claimsChange('The timer is running.')).toBe(true);
    expect(claimsChange('已經幫你改成 24 小時。')).toBe(true);
    expect(claimsChange('改好了！')).toBe(true);
    expect(claimsChange('Make step 4 24 hours for this run?')).toBe(false);
    expect(claimsChange('Here is what to mix for 30 samples.')).toBe(false);
    expect(claimsChange('Tap it when you are done.')).toBe(false);
  });

  it('takes the claim out when the app made no change, and keeps the rest', () => {
    expect(checkClaims("Got it. I've changed step 4 to 24 hours.", 0, 1)).toEqual({ say: 'Got it.', removed: 1 });
    expect(checkClaims('已經幫你改成 24 小時。', 0, 1)).toEqual({ say: '要我這樣改嗎？', removed: 1 });
    expect(checkClaims("I've started the timer.", 0, 0)).toEqual({ say: "I haven't changed that.", removed: 1 });
    expect(checkClaims("I've started the timer.", 1, 0)).toEqual({ say: "I've started the timer.", removed: 0 });
  });
});

describe('replyLanguage', () => {
  it('answers in the user’s script, decided from their words', () => {
    expect(replyLanguage('這一步改成 45 分鐘')).toMatch(/^Traditional Chinese/);
    expect(replyLanguage('这一步改成 45 分钟')).toBe('Simplified Chinese');
    expect(replyLanguage('Make it 45 min')).toBe('English');
  });
});

describe('numbers the user said in Chinese', () => {
  it('reads Chinese numerals in the user’s words, and only clear ones in Chapp’s', () => {
    expect(numbersIn('三十個樣本，二十四小時，兩個', true)).toEqual([30, 24, 2]);
    expect(numbersIn('我們一起看第一步', false)).toEqual([]);
    expect(numbersIn('要配五毫升，二十四小時', false)).toEqual([5, 24]);
  });
});

describe('choices and questions on the surface', () => {
  const surface = (components: object[]) => [
    { version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: 'chapp' } },
    { version: 'v0.9', updateComponents: { surfaceId: 'answer', components } },
  ];
  it('draws a choice with no kit open, catalog numbers included, but no amount the user did not say', () => {
    const out = checkA2ui(surface([
      { id: 'root', component: 'Column', children: ['q', 'pick'] },
      { id: 'q', component: 'Text', text: 'Which kit did you mean?' },
      { id: 'pick', component: 'ChoicePicker', variant: 'mutuallyExclusive', options: [{ label: 'EEA032', value: 'EEA032' }, { label: 'EEA302' }, { label: 'Add 30 µL', value: 'x' }] },
    ]), { steps: [], said: 'EEA 302', kit: false });
    expect(componentsOf(out.messages).get('pick')).toEqual({ id: 'pick', component: 'ChoicePicker', options: [{ label: 'EEA032', value: 'EEA032' }, { label: 'EEA302', value: 'EEA302' }] });
  });

  it('draws none of Chapp’s cards with no kit open', () => {
    const out = checkA2ui(surface([{ id: 'root', component: 'ReagentCard' }]), { steps: [], said: '', kit: false });
    expect(out.messages).toEqual([]);
    expect(out.dropped).toContain('ReagentCard root (no kit)');
  });

  it('keeps an Ask’s fields it knows', () => {
    const out = checkA2ui(surface([{ id: 'root', component: 'Ask', fields: ['samples', 'replicates', 'colour'] }]), { steps: [], said: '' });
    expect(componentsOf(out.messages).get('root')).toEqual({ id: 'root', component: 'Ask', fields: ['samples', 'replicates'] });
  });
});

describe.skipIf(!existsSync(new URL('../data/protocols/pierce-bca.json', import.meta.url)))('a reply checked against the words (BCA)', () => {
  const context: ConverseContext = { screen: 'run', protocolId: 'pierce-bca', procedure: 'microplate', step: 4, samples: 12, replicates: 2 };
  const reply = (wire: object, said: string) => {
    const checked = checkReply(JSON.stringify({ expression: 'neutral', a2ui: '[]', manualPages: [], ...wire }), context, said);
    if (!checked.ok) throw new Error(checked.issue);
    return checked.reply;
  };

  it('turns a step-length change into a proposal and takes out "I changed it"', () => {
    const out = reply({ say: "Got it, I've changed step 5 to 24 hours.", actions: [{ type: 'setStepTime', to: '', value: 86400, id: 'm-incubate', query: '' }] }, 'make this step 24 hours, not 30 minutes');
    expect(out.actions).toEqual([]);
    expect(out.confirm).toEqual([{ type: 'setStepTime', id: 'm-incubate', seconds: 86400 }]);
    expect(out.say).toBe('Want me to make that change?');
  });

  it('asks before moving on when the user only asked about the next step', () => {
    const out = reply({ say: 'Next you read the plate at 562 nm.', actions: [{ type: 'nextStep', to: '', value: 0, id: '', query: '' }] }, "what's next?");
    expect(out.actions).toEqual([]);
    expect(out.confirm).toEqual([{ type: 'nextStep' }]);
  });

  it('starts the step’s own timer when asked, whatever length the model wrote', () => {
    const out = reply({ say: 'Thirty minutes at 37 °C.', actions: [{ type: 'startTimer', to: '', value: 60, id: 'm-incubate', query: '' }] }, 'start the timer');
    expect(out.actions).toEqual([{ type: 'startTimer', id: 'm-incubate', seconds: 1800 }]);
    // The prompt asks for 0: the app knows the length.
    expect(reply({ say: 'Here it goes.', actions: [{ type: 'startTimer', to: '', value: 0, id: 'm-incubate', query: '' }] }, 'start the timer').actions).toEqual([{ type: 'startTimer', id: 'm-incubate', seconds: 1800 }]);
  });

  it('draws a plan card for the card the user changed by hand, when the model gave it no numbers', () => {
    const a2ui = JSON.stringify([{ version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'Compare', need: { path: '/reagent/make' }, have: '10 mL' }] } }]);
    const checked = checkReply(JSON.stringify({ say: 'Here is the check.', expression: 'neutral', actions: [], a2ui, manualPages: [] }), { ...context, screen: 'chat', shown: { samples: 15, replicates: 2 } }, 'I only have 10 mL. Is that enough?');
    if (!checked.ok) throw new Error(checked.issue);
    expect(componentsOf(checked.reply.a2ui!).get('root')).toMatchObject({ component: 'Compare', samples: 15, replicates: 2, have: '10 mL' });
  });
});
