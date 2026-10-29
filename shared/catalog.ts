/**
 * Catalog numbers the user said, against the kit a search found: "EEA 302" heard, EEA032 found. A misheard or mistyped
 * number finds a neighbour in the vendor's range, so the app says so instead of letting the wrong kit's manual pass
 * for theirs (Notos caught "EEA 302" for EEA032 the same way).
 */

const normal = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The number the user said when the kit found has another (as they said it: "EEA 302"), or null when they named none
 * or it is the one found.
 */
export function otherCatalog(said: string, found: string | undefined): string | null {
  if (!found) return null;
  const catalog = normal(found);
  if (!catalog) return null;
  // Letters glued to three or more digits ("EEA 302", "ab287843"), or four or more digits ("23225").
  const tokens = [...said.matchAll(/\b([A-Za-z]{1,8})[\s-]?(\d{3,}[A-Za-z]?)\b|\b(\d{4,})\b/g)];
  if (!tokens.length) return null;
  // Compared whole and by their digits alone, so "BCA 23225" is 23225 and "MAK-073" is MAK073-1KT.
  const forms = (s: string) => [s, ...(s.replace(/\D/g, '').length >= 4 ? [s.replace(/\D/g, '')] : [])];
  const same = tokens.some(m => forms(normal(m[0])).some(t => forms(catalog).some(c => c.startsWith(t) || t.startsWith(c))));
  if (same) return null;
  // "kit 23226": a word before a number of its own is not part of it; "EEA 302" keeps its letters.
  const [whole, letters, digits] = tokens[0]!;
  return letters && digits && /\s/.test(whole) && digits.length >= 4 ? digits : whole.trim();
}
