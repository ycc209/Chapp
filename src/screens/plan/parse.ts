import { count } from '../../lib/count.ts';
import type { Way } from './plan.ts';

/**
 * Reads a plan said in one breath ("five standards once, samples in triplicate", "12 samples in duplicate", "make it
 * triplicates", "the kit's 9") into the run's numbers, on the phone. Every word has to be understood: anything else in
 * the sentence ("what if…", "next", "A is OK") returns null, and the words go to Chapp instead.
 */

export type PlanChange = { samples?: number; replicates?: number; standardReplicates?: number; standards?: Way };

export type PlanWords = {
  /** How many vials each way makes ("five standards" is 'five', "nine standards" the kit's). */
  counts: Record<'kit' | 'halve' | 'five', number>;
  /** The top of the halving series, µg/mL ("halve from 2,000"). */
  top: number;
};

type Token =
  | { t: 'num'; n: number }
  | { t: 'samples' }
  | { t: 'standards' }
  | { t: 'rep'; k: number }
  | { t: 'way'; way: Way }
  | { t: 'all' }
  | { t: 'sep' };

const REP_WORDS: Record<string, number> = {
  once: 1, single: 1, singly: 1, singlicate: 1, singlicates: 1, singles: 1,
  twice: 2, duplicate: 2, duplicates: 2, duplicated: 2,
  thrice: 3, triplicate: 3, triplicates: 3, triplicated: 3,
};
const SAMPLE_WORDS = new Set(['sample', 'samples', 'unknown', 'unknowns']);
const STANDARD_WORDS = new Set(['standard', 'standards', 'vial', 'vials']);
const KIT_WORDS = new Set(['kit', "kit's", 'kits']);
const HALVE_WORDS = new Set(['halve', 'halving', 'halved', 'halves', 'half', 'serial', 'twofold']);
const READY_WORDS = new Set(['premade', 'ready', 'prepared']);
const ALL_WORDS = new Set(['all', 'both', 'everything']);
const SEP_WORDS = new Set([',', 'and', 'then', 'plus', 'with']);
/** After a number, these make it a replicate count: "3 times", "2 replicates", "two each". */
const TIMES_WORDS = new Set(['times', 'replicates', 'replicate', 'reps', 'repeats', 'each']);
const FILLER = new Set(
  `ok alright so um uh please thanks thank you now chapp hey let's lets let us make it them do run use go i we i'm i've
  we've we're have got there are is be to set change switch my our of those these just only instead actually in the a
  an for from on at per each want would like i'd we'd i'll we'll can could should how about same already dilution
  dilutions table series okay they they're it's its back again`.split(/\s+/),
);
/** Recognizers write "to", "too" and "for" for 2 and 4; here they are far more often the plain words. */
const NOT_NUMBERS = new Set(['to', 'too', 'for']);

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 2,000 → 2000
    .replace(/(\d)\s*[x×]\b|(\d)\s*×/g, (_, a: string | undefined, b: string | undefined) => `x ${a ?? b}`) // 3x, 3× → x 3
    .replace(/×/g, ' x ')
    .replace(/\bx(\d+)\b/g, 'x $1')
    .replace(/[-–]/g, ' ')
    .replace(/[,.;:!]+/g, ' , ')
    .replace(/[^\p{L}\p{N}',\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A number at words[i] (one or two words: "12", "twelve", "twenty four"), and how many words it took. */
function numberAt(words: string[], i: number): { n: number; used: number } | null {
  const w = words[i];
  if (!w || NOT_NUMBERS.has(w)) return null;
  const next = words[i + 1];
  if (next && !NOT_NUMBERS.has(next)) {
    const two = count(`${w} ${next}`);
    if (two !== null && !/^\d+$/.test(w)) return { n: two, used: 2 };
  }
  const one = count(w);
  return one === null ? null : { n: one, used: 1 };
}

function tokenize(said: string, words: PlanWords): Token[] | null {
  const ws = said.split(' ');
  const out: Token[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    // "x 3", "times 3": a replicate count.
    if (w === 'x' || w === 'times') {
      const num = numberAt(ws, i + 1);
      if (!num) return null;
      out.push({ t: 'rep', k: num.n });
      i += num.used;
      continue;
    }
    const num = numberAt(ws, i);
    if (num) {
      const after = ws[i + num.used];
      if (after && TIMES_WORDS.has(after)) {
        out.push({ t: 'rep', k: num.n });
        i += num.used;
      } else {
        out.push({ t: 'num', n: num.n });
        i += num.used - 1;
      }
      continue;
    }
    if (w in REP_WORDS) out.push({ t: 'rep', k: REP_WORDS[w]! });
    else if (w === 'quadruplicate' || w === 'quadruplicates') out.push({ t: 'rep', k: 4 });
    else if (SAMPLE_WORDS.has(w)) out.push({ t: 'samples' });
    else if (STANDARD_WORDS.has(w)) out.push({ t: 'standards' });
    else if (KIT_WORDS.has(w)) {
      out.push({ t: 'way', way: 'kit' });
      // "the kit's 9": the number names the kit's own count.
      const n = numberAt(ws, i + 1);
      if (n && n.n === words.counts.kit) i += n.used;
    } else if (HALVE_WORDS.has(w)) {
      out.push({ t: 'way', way: 'halve' });
      // "halve from 2,000": the top has to be the one the halving starts from.
      let j = i + 1;
      if (ws[j] === 'from') j++;
      const n = numberAt(ws, j);
      if (n) {
        if (n.n !== words.top) return null;
        i = j + n.used - 1;
      }
    } else if (READY_WORDS.has(w) || (w === 'made' && (ws[i - 1] === 'already' || ws[i + 1] === 'already'))) {
      out.push({ t: 'way', way: 'ready' });
    }
    else if (ALL_WORDS.has(w)) out.push({ t: 'all' });
    else if (SEP_WORDS.has(w)) out.push({ t: 'sep' });
    else if (!FILLER.has(w)) return null;
  }
  return out;
}

/** The plan in what was said, or null when it is not (only) a plan. */
export function parsePlan(text: string, words: PlanWords): PlanChange | null {
  if (/[?？]\s*$/.test(text)) return null;
  const tokens = tokenize(normalize(text), words);
  if (!tokens) return null;

  const out: PlanChange = {};
  type Subject = 'samples' | 'standards';
  // Subjects named since the last replicate word: "12 samples, in duplicate" → the duplicate is the samples'.
  let pending: Subject[] = [];
  // A number waiting for its noun ("12 samples", "five standards").
  let num: number | null = null;
  // A replicate said before its subject: "triplicate samples".
  let early: number | null = null;

  const setWay = (way: Way) => {
    if (out.standards && out.standards !== way) return false;
    out.standards = way;
    return true;
  };
  const setReps = (subjects: Subject[], k: number) => {
    if (k < 1 || k > 4) return false;
    for (const s of subjects) {
      const key = s === 'samples' ? 'replicates' : 'standardReplicates';
      if (out[key] !== undefined && out[key] !== k) return false;
      out[key] = k;
    }
    return true;
  };
  const subject = (s: Subject) => {
    if (early !== null) {
      if (!setReps([s], early)) return false;
      early = null;
    } else if (!pending.includes(s)) pending.push(s);
    return true;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    switch (tok.t) {
      case 'num':
        if (num !== null) return null;
        num = tok.n;
        break;
      case 'samples':
        if (num !== null) {
          if (num < 1 || num > 96) return null;
          out.samples = num;
          num = null;
        }
        if (!subject('samples')) return null;
        break;
      case 'standards':
        if (num !== null) {
          // "Five standards", "nine standards": the way that makes that many vials.
          const way = (['kit', 'halve', 'five'] as const).find(w => words.counts[w] === num);
          if (!way || !setWay(way)) return null;
          num = null;
        }
        if (!subject('standards')) return null;
        break;
      case 'way':
        if (num !== null || !setWay(tok.way) || !subject('standards')) return null;
        break;
      case 'all':
        pending = ['samples', 'standards'];
        break;
      case 'rep': {
        if (num !== null) return null;
        if (pending.length) {
          if (!setReps(pending, tok.k)) return null;
          pending = [];
          break;
        }
        const next = tokens[i + 1];
        const nextNoun = next?.t === 'samples' || next?.t === 'standards' || (next?.t === 'num' && ['samples', 'standards'].includes(tokens[i + 2]?.t ?? ''));
        if (nextNoun) early = tok.k;
        // Said on its own ("make it triplicates"): samples and standards alike, as the storyboard's 63 wells.
        else if (!setReps(['samples', 'standards'], tok.k)) return null;
        break;
      }
      case 'sep':
        if (num !== null) return null;
        break;
    }
  }
  if (num !== null || early !== null) return null;
  return Object.keys(out).length ? out : null;
}
