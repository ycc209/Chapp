import { describe, expect, it } from 'vitest';
import { checkPointers, checkReply, systemPrompt } from '../server/ai/meta.ts';
import { solutionReply, type Calc } from '../server/ai/solution.ts';
import { dilute, lookUp, massText, parseAmount, volumeText, weigh } from '../shared/solution.ts';

// Making a solution that is not a kit's reagent: the model only copies the user's words into `calc`; the app works the
// numbers out (shared/solution.ts) and says them (server/ai/solution.ts). No reply points at a card that is not there,
// and a general answer (small talk, what something is, what went wrong) keeps its numbers, marked as not the manual's.

const calc = (c: Partial<Calc>): Calc => ({ kind: 'weigh', substance: '', concentration: '', volume: '', stock: '', formulaWeight: '', ...c });
const wire = (say: string, c: Partial<Calc> = { kind: '' }, a2ui = '[]', general = false) => JSON.stringify({ say, expression: 'neutral', actions: [], a2ui, manualPages: [], general, calc: calc(c) });
const TW = 'Traditional Chinese as used in Taiwan (繁體中文)';

describe('the amounts people say', () => {
  it('reads units as typed or said', () => {
    expect(parseAmount('1 M')).toEqual({ value: 1, unit: 'M' });
    expect(parseAmount('100 ml')).toEqual({ value: 100, unit: 'mL' });
    expect(parseAmount('100毫升')).toEqual({ value: 100, unit: 'mL' });
    expect(parseAmount('10x')).toEqual({ value: 10, unit: 'X' });
    expect(parseAmount('2 % w/v')).toEqual({ value: 2, unit: '%' });
    expect(parseAmount('5 mg/ml')).toEqual({ value: 5, unit: 'mg/mL' });
    expect(parseAmount('0.5 mmol/L')).toEqual({ value: 0.5, unit: 'mM' });
    expect(parseAmount('some')).toBeNull();
  });
});

describe('formula weights', () => {
  it('knows common chemicals by formula, name or Chinese name', () => {
    expect(lookUp('NaCl')).toMatchObject({ kind: 'known', form: { fw: 58.44 } });
    expect(lookUp('氯化鈉')).toMatchObject({ kind: 'known', form: { fw: 58.44 } });
    expect(lookUp('Tris base')).toMatchObject({ kind: 'known', form: { fw: 121.14 } });
  });

  it('needs the form of one sold with and without water, since the weights differ', () => {
    expect(lookUp('MgCl2')).toMatchObject({ kind: 'which', forms: [{ fw: 95.21 }, { fw: 203.3 }] });
    expect(lookUp('MgCl₂·6H₂O')).toMatchObject({ kind: 'known', form: { formula: 'MgCl2·6H2O', fw: 203.3 } });
    expect(lookUp('氯化鎂六水合物')).toMatchObject({ kind: 'known', form: { fw: 203.3 } });
    expect(lookUp('anhydrous CaCl2')).toMatchObject({ kind: 'known', form: { fw: 110.98 } });
    expect(lookUp('Na2HPO4·12H2O')).toMatchObject({ kind: 'known', form: { fw: 358.14 } });
    expect(lookUp('NaH2PO4 monohydrate')).toMatchObject({ kind: 'known', form: { fw: 137.99 } });
  });

  it('does not guess one it does not have', () => {
    expect(lookUp('cycloheximide')).toEqual({ kind: 'unknown' });
  });
});

describe('the numbers', () => {
  it('weighs out a molar, mass or percent solution', () => {
    expect(massText(weigh(parseAmount('1 M')!, parseAmount('100 mL')!, 58.44)!)).toBe('5.844 g');
    expect(massText(weigh(parseAmount('10 mM')!, parseAmount('500 mL')!, 121.14)!)).toBe('605.7 mg');
    expect(massText(weigh(parseAmount('5 mg/mL')!, parseAmount('10 mL')!, null)!)).toBe('50 mg');
    expect(massText(weigh(parseAmount('2 %')!, parseAmount('100 mL')!, null)!)).toBe('2 g');
    expect(weigh(parseAmount('1 M')!, parseAmount('100 mL')!, null)).toBeNull();
  });

  it('dilutes a stock: C1V1 = C2V2', () => {
    const at = (s: string, f: string, v: string) => {
      const d = dilute(parseAmount(s)!, parseAmount(f)!, parseAmount(v)!);
      return d && [volumeText(d.take), volumeText(d.add)];
    };
    expect(at('10X', '1X', '500 mL')).toEqual(['50 mL', '450 mL']);
    expect(at('1 M', '10 mM', '1 mL')).toEqual(['10 µL', '990 µL']);
    expect(at('95 %', '70 %', '100 mL')).toEqual(['73.68 mL', '26.32 mL']);
    expect(at('1X', '10X', '1 mL')).toBeNull();
    expect(at('1 M', '5 mg/mL', '1 mL')).toBeNull();
  });
});

describe('what Chapp says', () => {
  const ask = '100 mL 1 M NaCl 要秤幾克？';

  it('answers with the app’s numbers, in the user’s language', () => {
    expect(solutionReply(calc({ substance: 'NaCl', concentration: '1 M', volume: '100 mL' }), ask, TW)).toBe('100 mL 的 1 M NaCl：秤 5.844 g（NaCl，58.44 g/mol），溶解後加水定容到 100 mL。');
    expect(solutionReply(calc({ substance: 'NaCl', concentration: '1 M', volume: '100 mL' }), 'How much NaCl for 100 mL of 1 M?', 'English')).toBe(
      'For 100 mL of 1 M NaCl: weigh 5.844 g (NaCl, 58.44 g/mol), dissolve it and make it up to 100 mL with water.',
    );
    expect(solutionReply(calc({ kind: 'dilute', substance: 'PBS', stock: '10X', concentration: '1X', volume: '500 mL' }), '10X PBS 怎麼配 500 mL 1X', TW)).toBe('從 10X PBS 配 500 mL 的 1X：取 50 mL 原液，加 450 mL 水（或你的稀釋液）。');
  });

  it('never uses a number the user did not say: it asks instead', () => {
    expect(solutionReply(calc({ substance: 'NaCl', concentration: '1 M', volume: '100 mL' }), 'NaCl 1 M 要秤幾克', TW)).toBe('要配多少體積？');
    expect(solutionReply(calc({ kind: 'dilute', stock: '20X', concentration: '1X', volume: '500 mL' }), '怎麼配 500 mL 1X', TW)).toBe('你的原液（stock）濃度是多少？');
  });

  it('takes numbers from earlier in the conversation, and the formula weight on the user’s bottle', () => {
    expect(solutionReply(calc({ substance: 'NaCl', concentration: '1 M', volume: '500 mL' }), `${ask}\n那 500 mL 呢？`, TW)).toContain('秤 29.22 g');
    expect(solutionReply(calc({ substance: 'cycloheximide', concentration: '10 mM', volume: '1 mL', formulaWeight: '281.35' }), '10 mM cycloheximide 1 mL，分子量 281.35', TW)).toBe(
      '1 mL 的 10 mM cycloheximide：秤 2.814 mg（cycloheximide，281.35 g/mol），溶解後加水定容到 1 mL。',
    );
  });

  it('asks which form, or for the formula weight, rather than guess', () => {
    expect(solutionReply(calc({ substance: 'MgCl2', concentration: '1 M', volume: '100 mL' }), '1 M MgCl2 100 mL', TW)).toBe('MgCl2 有好幾種含水的形式，分子量不同（MgCl2 95.21、MgCl2·6H2O 203.3 g/mol）。你瓶子上是哪一種？');
    expect(solutionReply(calc({ substance: 'cycloheximide', concentration: '10 mM', volume: '1 mL' }), '10 mM cycloheximide 1 mL', TW)).toBe('我沒有 cycloheximide 的分子量。瓶子標籤上的 FW（或 MW）是多少？');
  });

  it('replaces the model’s words with the app’s answer, with no card beside it', () => {
    const checked = checkReply(wire('', { substance: 'NaCl', concentration: '1 M', volume: '100 mL' }), { screen: 'home' }, ask);
    if (!checked.ok) throw new Error(checked.issue);
    expect(checked.reply.say).toBe('100 mL 的 1 M NaCl：秤 5.844 g（NaCl，58.44 g/mol），溶解後加水定容到 100 mL。');
    expect(checked.reply.a2ui).toBeUndefined();
  });

  it('is told how, and that it may not work the numbers out itself', () => {
    expect(systemPrompt({ screen: 'home' })).toContain('- calc: when the user asks how to make a solution that is not this kit\'s own reagent');
  });
});

describe('a reply that points at a card', () => {
  const picker = JSON.stringify([
    { version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: 'chapp' } },
    { version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'ChoicePicker', options: [{ label: 'Pierce BCA', value: 'Pierce BCA' }, { label: 'Micro BCA', value: 'Micro BCA' }] }] } },
  ]);

  it('loses the pointing sentence when no card is drawn', () => {
    const checked = checkReply(wire('要秤的量幫你算好放在下面卡片了。'), { screen: 'home' }, '100 mL 1 M NaCl 要秤幾克？');
    if (!checked.ok) throw new Error(checked.issue);
    expect(checked.reply.say).toBe('這個我沒辦法確認，所以不猜。');
    expect(checkPointers("Here's what to mix for 30 samples. Keep it below 25 °C.", false)).toEqual({ say: 'Keep it below 25 °C.', removed: 1 });
  });

  it('draws no card on a screen that shows only words, and keeps it where cards are drawn', () => {
    const home = checkReply(wire('Which one did you mean?', { kind: '' }, picker), { screen: 'home' }, 'BCA');
    const chat = checkReply(wire('Which one did you mean?', { kind: '' }, picker), { screen: 'chat' }, 'BCA');
    if (!home.ok || !chat.ok) throw new Error('rejected');
    expect(home.reply.a2ui).toBeUndefined();
    expect(chat.reply.a2ui).toHaveLength(2);
    expect(systemPrompt({ screen: 'home' })).toContain('This screen shows only your words: never point to a card');
    expect(systemPrompt({ screen: 'chat' })).not.toContain('This screen shows only your words');
  });
});

describe('a general answer', () => {
  const dna = 'DNA 在 260 nm 吸光最強，蛋白質在 280 nm。';
  const say = (text: string, general: boolean, question: string) => {
    const checked = checkReply(wire(text, { kind: '' }, '[]', general), { screen: 'home' }, question);
    if (!checked.ok) throw new Error(checked.issue);
    return checked.reply.say;
  };

  it('keeps its own numbers, marked as general knowledge, not the manual’s', () => {
    expect(say(dna, true, 'DNA 和蛋白質各在哪個波長吸光？')).toBe(`${dna}（這是一般知識，不是說明書上的。）`);
    expect(say('DNA absorbs most at 260 nm, protein at 280 nm.', true, 'Which wavelengths do DNA and protein absorb at?')).toBe('DNA absorbs most at 260 nm, protein at 280 nm. (General knowledge, not from a manual.)');
  });

  it('needs no mark without numbers of its own', () => {
    expect(say('辛苦了，先坐下來休息一下吧。', true, '今天實驗做得好累')).toBe('辛苦了，先坐下來休息一下吧。');
  });

  it('is not one when the model says it is about an experiment: its numbers keep to the facts', () => {
    expect(say('退火溫度通常比引子的 Tm 低約 5 °C，多在 55–65 °C。', false, 'PCR 的退火溫度一般怎麼設？')).toBe('這個數字我沒辦法從說明書確認，所以不猜。');
  });
});
