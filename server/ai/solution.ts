import { numbersIn } from '../../shared/a2ui.ts';
import { comparable } from '../../shared/units.ts';
import { amountText, dilute, kindOf, lookUp, massText, parseAmount, volumeText, weigh, type Amount } from '../../shared/solution.ts';

/**
 * Chapp's answer to "how much NaCl for 100 mL of 1 M?" or "how do I make 1X from 10X?": the model only says which of
 * the two was asked and copies the user's words (`calc` in meta.ts); the numbers are the app's (shared/solution.ts),
 * written here in the user's language. A number the model copied that the user never said (now or earlier in the
 * conversation) counts as missing, so Chapp asks for it rather than use it.
 */

export type Calc = { kind: string; substance: string; concentration: string; volume: string; stock: string; formulaWeight: string };

type Lang = 'en' | 'zh' | 'hans';
type Words = Record<Lang, string>;

/** replyLanguage's answer ("English", "Simplified Chinese", "Traditional Chinese …") as one of the three. */
const langOf = (language: string): Lang => (language.startsWith('English') ? 'en' : language.startsWith('Simplified') ? 'hans' : 'zh');

/** The answer to a calc, or null when there is none to give (kind ""). */
export function solutionReply(calc: Calc, said: string, language: string): string | null {
  if (calc.kind !== 'weigh' && calc.kind !== 'dilute') return null;
  const lang = langOf(language);
  const heard = new Set(numbersIn(said, true));
  // Only the user's own numbers: one they never said is treated as not given.
  const amount = (text: string): Amount | null => {
    const a = parseAmount(text);
    return a && heard.has(a.value) ? a : null;
  };
  const name = calc.substance.trim();
  return calc.kind === 'weigh' ? weighReply(amount(calc.concentration), amount(calc.volume), name, calc.formulaWeight, heard, lang) : diluteReply(amount(calc.stock), amount(calc.concentration), amount(calc.volume), name, lang);
}

function weighReply(c: Amount | null, v: Amount | null, name: string, fwSaid: string, heard: Set<number>, lang: Lang): string {
  const ck = c && kindOf(c);
  const concentration = ck === 'molar' || ck === 'mass' || ck === 'percent' ? c : null;
  const volume = v && kindOf(v) === 'volume' ? v : null;
  if (!concentration || !volume) return missing(!concentration, !volume, lang);
  const what = name || pick(lang, { en: 'it', zh: '它', hans: '它' });
  const C = `${amountText(concentration)}${ck === 'percent' ? ' (w/v)' : ''}`;
  const V = amountText(volume);

  let fw: number | null = null;
  let formula = '';
  if (ck === 'molar') {
    const own = Number(fwSaid.replace(/[^\d.]/g, ''));
    if (own > 0 && heard.has(own)) [fw, formula] = [own, name];
    else {
      if (!name) return pick(lang, { en: 'What are you weighing out?', zh: '要秤的是哪一種試劑？', hans: '要称的是哪一种试剂？' });
      const found = lookUp(name);
      if (found.kind === 'which') {
        const forms = found.forms.map(f => `${f.formula} ${f.fw}`).join(pick(lang, { en: ', ', zh: '、', hans: '、' }));
        return pick(lang, {
          en: `${found.name} comes in more than one form, each a different weight (${forms} g/mol). Which one is on your bottle?`,
          zh: `${found.name} 有好幾種含水的形式，分子量不同（${forms} g/mol）。你瓶子上是哪一種？`,
          hans: `${found.name} 有好几种含水的形式，分子量不同（${forms} g/mol）。你瓶子上是哪一种？`,
        });
      }
      if (found.kind === 'unknown')
        return pick(lang, {
          en: `I don't have the formula weight of ${name}. What FW (or MW) is on the bottle's label?`,
          zh: `我沒有 ${name} 的分子量。瓶子標籤上的 FW（或 MW）是多少？`,
          hans: `我没有 ${name} 的分子量。瓶子标签上的 FW（或 MW）是多少？`,
        });
      [fw, formula] = [found.form.fw, found.form.formula];
    }
  }
  const grams = weigh(concentration, volume, fw);
  if (grams === null) return missing(true, false, lang);
  const mass = massText(grams);
  // The formula weight as the bottle or the table gives it, not rounded.
  const why = fw ? pick(lang, { en: ` (${formula}, ${fw} g/mol)`, zh: `（${formula}，${fw} g/mol）`, hans: `（${formula}，${fw} g/mol）` }) : '';
  return pick(lang, {
    en: `For ${V} of ${C} ${what}: weigh ${mass}${why}, dissolve it and make it up to ${V} with water.`,
    zh: `${V} 的 ${C} ${what}：秤 ${mass}${why}，溶解後加水定容到 ${V}。`,
    hans: `${V} 的 ${C} ${what}：称 ${mass}${why}，溶解后加水定容到 ${V}。`,
  });
}

function diluteReply(s: Amount | null, f: Amount | null, v: Amount | null, name: string, lang: Lang): string {
  const volume = v && kindOf(v) === 'volume' ? v : null;
  if (!s || !f || !volume) {
    if (!s && f && volume) return pick(lang, { en: 'How concentrated is your stock?', zh: '你的原液（stock）濃度是多少？', hans: '你的原液（stock）浓度是多少？' });
    return missing(!f, !volume, lang);
  }
  const S = `${amountText(s)}${name ? ` ${name}` : ''}`;
  const F = amountText(f);
  const V = amountText(volume);
  const done = dilute(s, f, volume);
  if (!done) {
    const pair = comparable(s, f);
    return pair
      ? pick(lang, { en: `${F} isn't weaker than ${amountText(s)}, so it can't be diluted from it.`, zh: `${F} 沒有比 ${amountText(s)} 稀，沒辦法從它稀釋出來。`, hans: `${F} 没有比 ${amountText(s)} 稀，没办法从它稀释出来。` })
      : pick(lang, { en: `${amountText(s)} and ${F} are in different units, so I can't work out the dilution.`, zh: `${amountText(s)} 和 ${F} 的單位不同，我沒辦法直接換算。`, hans: `${amountText(s)} 和 ${F} 的单位不同，我没办法直接换算。` });
  }
  const take = volumeText(done.take);
  const add = volumeText(done.add);
  return pick(lang, {
    en: `For ${V} of ${F} from ${S}: take ${take} of the stock and add ${add} of water (or your diluent).`,
    zh: `從 ${S} 配 ${V} 的 ${F}：取 ${take} 原液，加 ${add} 水（或你的稀釋液）。`,
    hans: `从 ${S} 配 ${V} 的 ${F}：取 ${take} 原液，加 ${add} 水（或你的稀释液）。`,
  });
}

/** Asks for what the user has not said yet. */
function missing(concentration: boolean, volume: boolean, lang: Lang): string {
  if (concentration && volume) return pick(lang, { en: 'What concentration, and how much do you want to make?', zh: '要配什麼濃度、配多少體積？', hans: '要配什么浓度、配多少体积？' });
  if (concentration) return pick(lang, { en: 'What concentration do you want?', zh: '要配什麼濃度？', hans: '要配什么浓度？' });
  return pick(lang, { en: 'How much do you want to make?', zh: '要配多少體積？', hans: '要配多少体积？' });
}

const pick = (lang: Lang, words: Words) => words[lang];
