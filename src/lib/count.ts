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

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  // What recognizers write for a short number heard alone.
  to: 2, too: 2, for: 4,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
