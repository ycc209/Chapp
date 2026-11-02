/**
 * Comparing what was heard. Partial transcripts settle on the final words but not on their punctuation ("下一步，"
 * then "下一步。"; "Next step," then "Next step."), so the same words are the same turn whatever the marks and
 * spaces around them (measured 6 of 6 on 2026-10-31, through Muse Voice Transcribe's realtime endpoint).
 */
export const normalizeHeard = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

export const sameWords = (a: string, b: string) => normalizeHeard(a) === normalizeHeard(b);

/**
 * What `text` says after the words already taken as a turn (`committed`, normalized): the rest of a final transcript
 * that grew past the partial it was committed on. Null when it does not begin with those words.
 */
export function afterCommitted(text: string, committed: string): string | null {
  if (!committed) return text.trim();
  let matched = 0;
  for (let i = 0; i < text.length; i++) {
    const c = normalizeHeard(text[i]!);
    if (!c) continue;
    if (c !== committed[matched]) return null;
    matched += c.length;
    if (matched >= committed.length) return text.slice(i + 1).replace(/^[\s\p{P}]+/u, '').trim();
  }
  return null;
}
