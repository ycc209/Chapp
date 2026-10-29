import { normalizeUnit, toMicrogramsPerMl, toMicroliters, toMicromolar, comparable } from './units.ts';

/**
 * Making a solution that is not a kit's own reagent, worked out by the app, never by a model: how much of a solid to
 * weigh for a concentration and a volume, and how much of a stock to take for a dilution (C1V1 = C2V2). Chapp's model
 * only says which of the two the user asked and copies their words; every number here is the user's, or a formula
 * weight from FORMULA_WEIGHTS. Pure, so it is checked without a server.
 */

export type Amount = { value: number; unit: string };

/** The unit words people say or type, as the units the app computes with. */
const UNIT_WORDS: [RegExp, string][] = [
  [/^(?:mol\/l|莫耳|摩爾|摩尔)$/i, 'M'],
  [/^(?:mmol\/l|毫莫耳|毫摩爾|毫摩尔)$/i, 'mM'],
  [/^(?:[uµμ]mol\/l|微莫耳|微摩爾|微摩尔)$/i, 'µM'],
  [/^(?:x|倍)$/i, 'X'],
  [/^(?:毫升|ml)$/i, 'mL'],
  [/^(?:微升|[uµμ]l)$/i, 'µL'],
  [/^(?:升|公升|l)$/i, 'L'],
  [/^(?:%|％|percent)$/i, '%'],
];

/** "1 M", "100 mL", "10X", "2 % w/v", "5 mg/mL", "100毫升" → an amount; null when it is not one. */
export function parseAmount(text: string): Amount | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(.*?)\s*$/.exec(text.replace(/[（(]?\s*w\s*\/\s*v\s*[)）]?/i, '').replace(/,/g, ''));
  if (!m) return null;
  const value = Number(m[1]);
  const said = m[2]!;
  const unit = UNIT_WORDS.find(([re]) => re.test(said))?.[1] ?? normalizeUnit(said);
  if (!Number.isFinite(value) || value <= 0 || !unit) return null;
  return { value, unit };
}

/** The kind of amount: what it can be used for here. */
export function kindOf(a: Amount): 'volume' | 'molar' | 'mass' | 'percent' | 'times' | null {
  if (toMicroliters(a) !== null) return 'volume';
  if (toMicromolar(a) !== null) return 'molar';
  if (toMicrogramsPerMl(a) !== null) return 'mass';
  if (a.unit === '%') return 'percent';
  if (a.unit === 'X') return 'times';
  return null;
}

/** Four significant figures, no trailing zeros: 5.844, 121.1, 0.05844. */
export const figures = (n: number) => String(Number(n.toPrecision(4)));

/** A mass in grams, in the unit that reads best: "5.844 g", "58.44 mg", "12.5 µg". */
export function massText(grams: number): string {
  if (grams >= 1) return `${figures(grams)} g`;
  if (grams >= 1e-3) return `${figures(grams * 1e3)} mg`;
  return `${figures(grams * 1e6)} µg`;
}

/** A volume in µL, in the unit that reads best: "450 mL", "1.5 L", "20 µL". */
export function volumeText(microliters: number): string {
  if (microliters >= 1e6) return `${figures(microliters / 1e6)} L`;
  if (microliters >= 1e3) return `${figures(microliters / 1e3)} mL`;
  return `${figures(microliters)} µL`;
}

export const amountText = (a: Amount) => `${figures(a.value)}${a.unit === '%' || a.unit === 'X' ? '' : ' '}${a.unit}`;

// ---------------------------------------------------------------------------------------------------------------
// Formula weights

/** One form of a chemical: its formula as written on the bottle, and its formula weight in g/mol. */
export type Form = { formula: string; fw: number; water: number };
type Chemical = { names: string[]; forms: Form[] };

const form = (formula: string, fw: number, water = 0): Form => ({ formula, fw, water });

/**
 * Common lab chemicals and their formula weights (g/mol), as on the bottles. A chemical sold with and without water of
 * crystallization has each form: the user names the one they have, or Chapp asks, since the weights differ.
 */
export const FORMULA_WEIGHTS: Chemical[] = [
  { names: ['NaCl', 'sodium chloride', '氯化鈉', '氯化钠'], forms: [form('NaCl', 58.44)] },
  { names: ['KCl', 'potassium chloride', '氯化鉀', '氯化钾'], forms: [form('KCl', 74.55)] },
  { names: ['NaOH', 'sodium hydroxide', '氫氧化鈉', '氢氧化钠'], forms: [form('NaOH', 40.0)] },
  { names: ['KOH', 'potassium hydroxide', '氫氧化鉀', '氢氧化钾'], forms: [form('KOH', 56.11)] },
  { names: ['NaHCO3', 'sodium bicarbonate', 'sodium hydrogen carbonate', '碳酸氫鈉', '碳酸氢钠'], forms: [form('NaHCO3', 84.01)] },
  { names: ['NH4Cl', 'ammonium chloride', '氯化銨', '氯化铵'], forms: [form('NH4Cl', 53.49)] },
  { names: ['(NH4)2SO4', 'ammonium sulfate', '硫酸銨', '硫酸铵'], forms: [form('(NH4)2SO4', 132.14)] },
  { names: ['KH2PO4', 'potassium dihydrogen phosphate', 'monopotassium phosphate', '磷酸二氫鉀', '磷酸二氢钾'], forms: [form('KH2PO4', 136.09)] },
  { names: ['K2HPO4', 'dipotassium hydrogen phosphate', 'dipotassium phosphate', '磷酸氫二鉀', '磷酸氢二钾'], forms: [form('K2HPO4', 174.18), form('K2HPO4·3H2O', 228.22, 3)] },
  {
    names: ['Na2HPO4', 'disodium hydrogen phosphate', 'disodium phosphate', '磷酸氫二鈉', '磷酸氢二钠'],
    forms: [form('Na2HPO4', 141.96), form('Na2HPO4·2H2O', 177.99, 2), form('Na2HPO4·7H2O', 268.07, 7), form('Na2HPO4·12H2O', 358.14, 12)],
  },
  { names: ['NaH2PO4', 'sodium dihydrogen phosphate', 'monosodium phosphate', '磷酸二氫鈉', '磷酸二氢钠'], forms: [form('NaH2PO4', 119.98), form('NaH2PO4·H2O', 137.99, 1), form('NaH2PO4·2H2O', 156.01, 2)] },
  { names: ['MgCl2', 'magnesium chloride', '氯化鎂', '氯化镁'], forms: [form('MgCl2', 95.21), form('MgCl2·6H2O', 203.3, 6)] },
  { names: ['CaCl2', 'calcium chloride', '氯化鈣', '氯化钙'], forms: [form('CaCl2', 110.98), form('CaCl2·2H2O', 147.01, 2)] },
  { names: ['MgSO4', 'magnesium sulfate', '硫酸鎂', '硫酸镁'], forms: [form('MgSO4', 120.37), form('MgSO4·7H2O', 246.47, 7)] },
  { names: ['sodium acetate', 'NaOAc', 'CH3COONa', '醋酸鈉', '乙酸鈉', '醋酸钠', '乙酸钠'], forms: [form('CH3COONa', 82.03), form('CH3COONa·3H2O', 136.08, 3)] },
  { names: ['potassium acetate', 'KOAc', 'CH3COOK', '醋酸鉀', '乙酸鉀', '醋酸钾', '乙酸钾'], forms: [form('CH3COOK', 98.14)] },
  { names: ['trisodium citrate', 'sodium citrate', '檸檬酸鈉', '柠檬酸钠'], forms: [form('Na3C6H5O7', 258.07), form('Na3C6H5O7·2H2O', 294.1, 2)] },
  { names: ['citric acid', '檸檬酸', '柠檬酸'], forms: [form('C6H8O7', 192.12), form('C6H8O7·H2O', 210.14, 1)] },
  { names: ['EDTA', 'Na2EDTA', 'disodium EDTA', 'EDTA disodium', 'EDTA disodium salt'], forms: [form('EDTA (free acid)', 292.24), form('Na2EDTA·2H2O', 372.24, 2)] },
  { names: ['Tris', 'Tris base', 'Trizma', 'Trizma base', 'tromethamine'], forms: [form('Tris base', 121.14)] },
  { names: ['Tris-HCl', 'Tris HCl', 'Trizma hydrochloride'], forms: [form('Tris-HCl', 157.6)] },
  { names: ['HEPES'], forms: [form('HEPES', 238.3)] },
  { names: ['MOPS'], forms: [form('MOPS', 209.26)] },
  { names: ['PIPES'], forms: [form('PIPES', 302.37)] },
  { names: ['glycine', '甘胺酸', '甘氨酸'], forms: [form('glycine', 75.07)] },
  { names: ['SDS', 'sodium dodecyl sulfate', 'sodium lauryl sulfate', '十二烷基硫酸鈉', '十二烷基硫酸钠'], forms: [form('SDS', 288.38)] },
  { names: ['glucose', 'D-glucose', 'dextrose', '葡萄糖'], forms: [form('C6H12O6', 180.16), form('C6H12O6·H2O', 198.17, 1)] },
  { names: ['sucrose', '蔗糖'], forms: [form('sucrose', 342.3)] },
  { names: ['urea', '尿素'], forms: [form('urea', 60.06)] },
  { names: ['imidazole', '咪唑'], forms: [form('imidazole', 68.08)] },
  { names: ['DTT', 'dithiothreitol'], forms: [form('DTT', 154.25)] },
  { names: ['guanidine hydrochloride', 'guanidine HCl', 'GuHCl', '鹽酸胍', '盐酸胍'], forms: [form('guanidine HCl', 95.53)] },
  { names: ['IPTG'], forms: [form('IPTG', 238.3)] },
  { names: ['ampicillin', 'ampicillin sodium', 'ampicillin sodium salt', '安比西林'], forms: [form('ampicillin sodium salt', 371.39)] },
  { names: ['kanamycin', 'kanamycin sulfate', '康黴素', '卡那霉素'], forms: [form('kanamycin sulfate', 582.58)] },
  { names: ['PMSF'], forms: [form('PMSF', 174.19)] },
  { names: ['NaN3', 'sodium azide', '疊氮化鈉', '叠氮化钠'], forms: [form('NaN3', 65.01)] },
  { names: ['boric acid', 'H3BO3', '硼酸'], forms: [form('H3BO3', 61.83)] },
  { names: ['sodium pyruvate', '丙酮酸鈉', '丙酮酸钠'], forms: [form('sodium pyruvate', 110.04)] },
  { names: ['L-glutamine', 'glutamine', '麩醯胺酸', '谷氨酰胺'], forms: [form('L-glutamine', 146.14)] },
  { names: ['ascorbic acid', 'L-ascorbic acid', 'vitamin C', '抗壞血酸', '抗坏血酸'], forms: [form('ascorbic acid', 176.12)] },
];

/** Water of crystallization named in words or as ·nH2O: "hexahydrate", "6H2O", "六水" → 6; "anhydrous", "無水" → 0. */
const WATER: [RegExp, number][] = [
  [/\b(?:anhydrous|anhyd)\b|無水|无水/i, 0],
  [/\bdodecahydrate\b|(?:^|[^\d])12\s*h2o|十二水/i, 12],
  [/\bheptahydrate\b|(?:^|[^\d])7\s*h2o|七水/i, 7],
  [/\bhexahydrate\b|(?:^|[^\d])6\s*h2o|六水/i, 6],
  [/\btrihydrate\b|(?:^|[^\d])3\s*h2o|三水/i, 3],
  [/\bdihydrate\b|(?:^|[^\d])2\s*h2o|二水|兩水|两水/i, 2],
  [/\bmonohydrate\b|[·•∙.*\s]h2o\b|一水/i, 1],
];
const WATER_WORDS = /\b(?:anhydrous|anhyd|dodecahydrate|heptahydrate|hexahydrate|trihydrate|dihydrate|monohydrate)\b|[·•∙.*]?\s*\d*\s*h2o\b|(?:十二|七|六|三|二|兩|两|一)水(?:合物)?|無水|无水/gi;

/** "MgCl₂ · 6 H₂O" → "mgcl2"; "Tris base" → "trisbase": a name to compare, without its water or spacing. */
const key = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(WATER_WORDS, '')
    .replace(/[\s\-·•∙.*_()（）]/g, '');

export type Looked =
  | { kind: 'known'; form: Form }
  | { kind: 'which'; name: string; forms: Form[] }
  | { kind: 'unknown' };

/**
 * The formula weight of what the user named. A chemical with several forms needs the one they have ("MgCl2·6H2O",
 * "anhydrous"): without it Chapp asks, rather than weighing out half or twice as much.
 */
export function lookUp(substance: string): Looked {
  const text = substance.normalize('NFKC');
  const k = key(text);
  if (!k) return { kind: 'unknown' };
  const chemical = FORMULA_WEIGHTS.find(c => c.names.some(n => key(n) === k));
  if (!chemical) return { kind: 'unknown' };
  if (chemical.forms.length === 1) return { kind: 'known', form: chemical.forms[0]! };
  const water = WATER.find(([re]) => re.test(text))?.[1];
  const named = water === undefined ? undefined : chemical.forms.find(f => f.water === water);
  return named ? { kind: 'known', form: named } : { kind: 'which', name: chemical.forms[0]!.formula, forms: chemical.forms };
}

// ---------------------------------------------------------------------------------------------------------------
// The two calculations

export type Weighed = { grams: number; fw: number | null; formula: string | null };

/**
 * How much to weigh to make `volume` of `concentration`: a molar concentration needs the formula weight (g/mol);
 * a mass per volume or a percent (w/v: grams per 100 mL) does not. Null when the units do not fit.
 */
export function weigh(concentration: Amount, volume: Amount, fw: number | null): number | null {
  const microliters = toMicroliters(volume);
  if (microliters === null) return null;
  const liters = microliters / 1e6;
  const micromolar = toMicromolar(concentration);
  if (micromolar !== null) return fw && fw > 0 ? (micromolar / 1e6) * liters * fw : null;
  const ugPerMl = toMicrogramsPerMl(concentration);
  if (ugPerMl !== null) return (ugPerMl * (microliters / 1e3)) / 1e6;
  if (concentration.unit === '%') return (concentration.value / 100) * (microliters / 1e3);
  return null;
}

export type Diluted = { take: number; add: number };

/**
 * C1V1 = C2V2: how much of the stock to take, and how much diluent to add, for `volume` at `final`, both in µL.
 * Null when the two concentrations cannot be compared, or the final one is not below the stock.
 */
export function dilute(stock: Amount, final: Amount, volume: Amount): Diluted | null {
  const microliters = toMicroliters(volume);
  const pair = comparable(stock, final);
  if (microliters === null || !pair) return null;
  const [c1, c2] = pair;
  if (!(c1 > c2) || c2 <= 0) return null;
  const take = (microliters * c2) / c1;
  return { take, add: microliters - take };
}
