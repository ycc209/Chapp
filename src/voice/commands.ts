import type { Action } from '../../shared/ai.ts';

/**
 * The few things said at the bench often enough to answer on the phone: no round trip, no cost. The whole utterance
 * has to be the command (give or take "okay" and "please"), so a question that only mentions "next" or "12 samples"
 * goes to the server like everything else. Anything unsure returns null.
 */
export function matchCommand(text: string): Action[] | null {
  // A question is never a command: "A is done?" asks, it does not tell.
  if (/[?？]\s*$/.test(text)) return null;
  const said = strip(normalize(text));
  if (!said) return null;

  if (NEXT.test(said)) return [{ type: 'nextStep' }];
  if (PREVIOUS.test(said)) return [{ type: 'previousStep' }];

  const plicate = said.match(REPLICATE_WORD);
  if (plicate) return [{ type: 'setReplicates', replicates: PLICATES[plicate[1]!]! }];
  const replicates = said.match(REPLICATE_COUNT);
  if (replicates) {
    const n = count(replicates[1]!);
    return n !== null && n >= 1 && n <= 6 ? [{ type: 'setReplicates', replicates: n }] : null;
  }

  const samples = said.match(SAMPLES);
  if (samples) {
    const n = count(samples[1]!);
    // One plate holds 96 wells; a bigger number is more likely misheard, and the server can ask.
    return n !== null && n >= 1 && n <= 96 ? [{ type: 'setSamples', samples: n }] : null;
  }

  return markDone(said);
}

// --- Normalizing what the recognizer wrote ------------------------------------------------------------------------

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/o\.k\./g, 'ok')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\bokay\b/g, 'ok')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING = /^(?:ok|alright|all right|so|and|now|then|um|uh|hey chapp|chapp)\s+/;
const TRAILING = /\s+(?:please|thanks|thank you|now|chapp)$/;

/** Drops the filler around a command: "okay, next step please" is "next step". */
function strip(said: string) {
  let out = said;
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(LEADING, '').replace(TRAILING, '');
  }
  return out;
}

// --- Steps --------------------------------------------------------------------------------------------------------

const NEXT = /^(?:(?:go|go to|move to|move on to|on to|onto)\s+)?(?:the\s+)?next(?:\s+(?:step|one))?$|^下一步$/;
const PREVIOUS = /^(?:go\s+)?back(?:\s+(?:a|one)\s+step)?$|^(?:(?:go|go to|go back to)\s+)?(?:the\s+)?previous(?:\s+(?:step|one))?$|^step back$|^上一步$/;

// --- Replicates ---------------------------------------------------------------------------------------------------

const PLICATES: Record<string, number> = { singlicate: 1, duplicate: 2, triplicate: 3, quadruplicate: 4 };
const SET = '(?:make it|make them|do it|do them|do|run it|run them|run|let\'s do it|let\'s do|lets do|we\'ll do|switch to|change to|change it to|use|set it to)';
const REPLICATE_WORD = new RegExp(`^(?:${SET}\\s+)?(?:in\\s+)?(singlicate|duplicate|triplicate|quadruplicate)s?$`);
const REPLICATE_COUNT = new RegExp(`^(?:${SET}\\s+)?(\\S+(?:\\s\\S+)?)\\s+(?:replicates|reps|repeats)$`);

// --- Samples ------------------------------------------------------------------------------------------------------

const HAVE = '(?:i have|we have|i\'ve got|we\'ve got|i got|we got|there are|there\'s|it\'s|make it|set it to|change it to|change to|let\'s do|lets do|do|run|use)';
const SAMPLES = new RegExp(`^(?:${HAVE}\\s+)?(\\S+(?:\\s\\S+)?)\\s+samples?$`);

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  // What recognizers write for a short number heard alone.
  to: 2, too: 2, for: 4,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "12", "twelve", "twenty four" → a number; anything else → null. */
export function count(words: string): number | null {
  if (/^\d+$/.test(words)) return Number(words);
  const [first, second, ...rest] = words.split(' ');
  if (rest.length || !first) return null;
  if (second === undefined) return ONES[first] ?? TENS[first] ?? null;
  const tens = TENS[first];
  const ones = ONES[second];
  return tens !== undefined && ones !== undefined && ones < 10 && !['to', 'too', 'for'].includes(second) ? tens + ones : null;
}

// --- A standard is done -------------------------------------------------------------------------------------------

/** Standard vials are lettered A–I in the protocol (standardCurves[].points[].id). */
const LETTERS = 'abcdefghi';
/** How a letter heard alone gets spelled out. Only trusted with "is" or a word like "vial" around it. */
const SPELLED: Record<string, string> = { ay: 'a', bee: 'b', see: 'c', sea: 'c', dee: 'd', ef: 'f', eff: 'f', gee: 'g', aitch: 'h', eye: 'i' };
const DONE = '(?:ok|done|finished|ready|good)';
const NOUN = '(?:standard|vial|tube)';

function markDone(said: string): Action[] | null {
  // "mark A done", "mark vial A as done"
  let m = said.match(new RegExp(`^mark\\s+(?:${NOUN}\\s+)?(\\S+)\\s+(?:as\\s+)?(?:done|finished|complete)$`));
  if (m) return letters([m[1]!], true);
  // "A and B are done", "A, B and C done"
  m = said.match(new RegExp(`^(?:${NOUN}s?\\s+)?((?:\\S+\\s+)+?and\\s+\\S+)\\s+(?:are\\s+)?${DONE}$`));
  if (m) return letters(m[1]!.split(/\s+/).filter(w => w !== 'and'), true);
  // "A is OK", "A's done", "vial B done", "C done"
  m = said.match(new RegExp(`^(${NOUN}\\s+)?(\\S+?)(?:'s|\\s+is)?\\s+${DONE}$`));
  if (m) {
    const firm = Boolean(m[1]) || /'s|\sis\s/.test(said);
    const letter = m[2]!;
    // "I done" is more often "I'm done" misheard than vial I.
    if (letter === 'i' && !firm) return null;
    return letters([letter], firm);
  }
  return null;
}

function letters(words: string[], firm: boolean): Action[] | null {
  const ids: string[] = [];
  for (const word of words) {
    const letter = word.length === 1 ? word : firm ? SPELLED[word] : undefined;
    if (!letter || !LETTERS.includes(letter)) return null;
    ids.push(letter.toUpperCase());
  }
  return ids.length ? ids.map(id => ({ type: 'markDone', id })) : null;
}
