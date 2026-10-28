/**
 * Lab words that speech recognizers get wrong, put right before anything reads the transcript: "pierced BCA protein
 * acetate" → "Pierce BCA protein assay". Local and cheap, so both the phone (any recognizer) and the server (Muse Voice
 * Transcribe) run it: mishearings heard in testing first, then near misses of the kit's own names. What still looks
 * like a garbled kit name is flagged (needsModelFix), and only then does the server ask Muse Spark.
 */

/** Names every run may say, whatever the protocol: the storyboard's kit and the bench's acronyms. */
export const BASE_TERMS = ['Pierce BCA Protein Assay Kit', 'BCA', 'BSA', 'PBS'];

/** Mishearings of lab words, and what was said. Each was heard from Muse Voice Transcribe or a browser recognizer. */
const HEARD: [RegExp, string][] = [
  // "pierced BCA", "pierce PCA", "Pierce B.C.A."
  [/\bpierced?\s+[bp]\.?\s?c\.?\s?a\b\.?/gi, 'Pierce BCA'],
  // "PSBCA protein…"
  [/\bp\.?\s?s\.?\s?b\.?\s?c\.?\s?a\b\.?/gi, 'Pierce BCA'],
  // "protein sake it" (assay kit), "protein acetate", "protein shake kit", "protein essay"
  [/\bprotein\s+sake\s+it\b/gi, 'protein assay kit'],
  [/\bprotein\s+(?:acetate|essay|asset|a say|sake|shake)(?=\s+kit\b|\s*[.,!?]|\s*$)/gi, 'protein assay'],
  [/\bb\.\s?c\.\s?a\b\.?/gi, 'BCA'],
  [/\bb\.\s?s\.\s?a\b\.?/gi, 'BSA'],
];

/** Lowercase letters and digits only: what two spellings of a name have in common. */
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Edits (insert, delete, change one character) between two strings. */
export function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/**
 * Near enough to be the same name misheard: the same first letter, about as long (a name said short, "Pierce BCA
 * protein assay", is left alone) and at most one edit in eight.
 */
const near = (heard: string, term: string) =>
  heard[0] === term[0] && Math.abs(heard.length - term.length) <= 2 && distance(heard, term) <= Math.max(1, Math.floor(term.length / 8));

type Word = { text: string; start: number; end: number };
// Dots inside a word stay ("B.C.A"), a sentence's last dot does not.
const words = (text: string): Word[] => [...text.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'’-]|\.(?=[\p{L}\p{N}]))*/gu)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));

/**
 * The transcript with lab words put right. `terms` are the names the run knows (the protocol's kit and components;
 * BASE_TERMS when none are given). Only names of two or more words, or one long word, are matched loosely: short
 * words are too easily something else.
 */
export function fixLabWords(text: string, terms: readonly string[] = BASE_TERMS): string {
  let out = text;
  for (const [heard, said] of HEARD) out = out.replace(heard, said);
  out = fixAcronyms(out, terms);

  // A name said right is never "fixed" into another one ("BCA Reagent A" is one edit from "BCA Reagent B"), and its
  // words are not part of a near miss ("Pierce BCA Protein Assay" is one word short of the kit, not a misheard kit).
  const exact = new Set(terms.map(letters));
  const loose = [...new Set(terms)].filter(t => (t.includes(' ') ? letters(t).length >= 8 : letters(t).length >= 7));
  const named = new Set(loose.map(letters));
  for (const term of loose) {
    const want = letters(term);
    const n = term.split(/\s+/).length;
    const ws = words(out);
    const said = (i: number, size: number) => letters(ws.slice(i, i + size).map(w => w.text).join(''));
    const taken = new Set<number>();
    for (let size = 1; size <= n + 1; size++) {
      for (let i = 0; i + size <= ws.length; i++) if (named.has(said(i, size))) for (let k = i; k < i + size; k++) taken.add(k);
    }
    // Longest window first: "pierce PCA protein assay kit" is one name, not a name and some words.
    let span: Word[] | null = null;
    for (let size = n + 1; size >= Math.max(1, n - 1) && !span; size--) {
      for (let i = 0; i + size <= ws.length && !span; i++) {
        const heard = said(i, size);
        if (exact.has(heard) || !near(heard, want) || ws.slice(i, i + size).some((_, k) => taken.has(i + k))) continue;
        span = ws.slice(i, i + size);
      }
    }
    if (span) out = out.slice(0, span[0]!.start) + term + out.slice(span.at(-1)!.end);
  }
  return out;
}

/**
 * An acronym one letter off a name's ("PCA protein assay kit"), put right when a word beside it is the name's word
 * beside its acronym: "PCA" before "protein" is the kit's BCA.
 */
function fixAcronyms(text: string, terms: readonly string[]): string {
  const names = terms.map(t => t.split(/\s+/)).filter(w => w.length > 1);
  const ws = words(text);
  let out = text;
  for (let i = ws.length - 1; i >= 0; i--) {
    const word = ws[i]!.text;
    if (!/^[A-Z][A-Z0-9]{1,5}$/.test(word) || KNOWN_SHORT.has(word)) continue;
    const same = (a?: string, b?: string) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
    const fix = names
      .flatMap(name => name.map((w, k) => ({ name, w, k })))
      .find(({ name, w, k }) => /^[A-Z0-9]{2,6}$/.test(w) && w !== word && distance(w, word) === 1 && (same(name[k + 1], ws[i + 1]?.text) || same(name[k - 1], ws[i - 1]?.text)));
    if (fix) out = out.slice(0, ws[i]!.start) + fix.w + out.slice(ws[i]!.end);
  }
  return out;
}

/** Acronyms said at the bench that are not a misheard name. */
const KNOWN_SHORT = new Set(['BCA', 'BSA', 'PBS', 'DNA', 'RNA', 'PCR', 'OK', 'UV', 'ELISA', 'HRP', 'TMB', 'SDS', 'EDTA', 'DMSO', 'FBS', 'I', 'A']);

/**
 * Whether a fixed transcript still holds something that looks like a misheard lab name: a capitalized short word
 * (2–6 letters) the run does not know that is one edit from one it does ("PCA", "BCS"). Then a model may know better.
 */
export function needsModelFix(text: string, terms: readonly string[] = BASE_TERMS): boolean {
  const known = new Set([...KNOWN_SHORT, ...terms.flatMap(t => t.split(/\s+/)).filter(w => /^[A-Z0-9]{2,6}$/.test(w))]);
  const acronyms = [...known].filter(w => w.length >= 3);
  return words(text).some(({ text: w }) => {
    const word = w.replace(/\.$/, '');
    if (!/^[A-Z][A-Z0-9]{1,5}$/.test(word) || known.has(word)) return false;
    return acronyms.some(a => distance(word, a) <= 1 || (word.length > a.length && word.includes(a)));
  });
}

/** Every name a protocol gives that may be said aloud: its kit, vendor and components (and the BASE_TERMS). */
export function labTerms(protocols: readonly { kit: { name: string; vendor: string }; components: readonly { name: string }[] }[]): string[] {
  return [...new Set([...BASE_TERMS, ...protocols.flatMap(p => [p.kit.name, p.kit.vendor, ...p.components.map(c => c.name)])])];
}
