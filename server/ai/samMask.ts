/**
 * SAM 3.1's masks → outlines the phone can draw and cut along. Each object SAM finds comes with its mask, base85-coded
 * (vision.ts parses the token; the raster is the box's height × width). Meta's own parser for that output decodes
 * it (`@meta-sam/parser`: npm install @meta-sam/parser); this asks it for the mask as a polygonal SVG path, keeps the
 * biggest ring, simplifies it to the pixel, and puts it in fractions of the photo, like the box. Without the package
 * there are no outlines: the phone shows SAM's boxes and cuts the bottle out itself.
 */

/** One mask as SAM wrote it, with where its raster sits on the photo (pixels) and the photo's size. */
export type SamMask = { encoding: 'lossless' | 'one_bit'; width: number; height: number; payload: string; left: number; top: number; frameWidth: number; frameHeight: number };

type Parser = { decodeMaskToSVGPath(mask: { encoding: 'lossless' | 'one_bit'; width: number; height: number; payload: string }): string };

// The package name as a plain string, so a server without the package still starts (and type-checks).
const PACKAGE: string = '@meta-sam/parser';
let parser: Promise<Parser | null> | undefined;
const load = () => (parser ??= (import(PACKAGE) as Promise<Parser>).catch(() => null));

/** The mask's outline as an SVG path (M/L/Z) in fractions of the photo; undefined without the package or a usable mask. */
export async function samOutline(mask: SamMask): Promise<string | undefined> {
  const p = await load();
  if (!p) return undefined;
  let path: string;
  try {
    // The parser takes the payload with its marker on the front, as SAM wrote it (~ lossless, ! one-bit): version
    // 0.1.0 refuses it without ("lossless mask payloads must start with ~"), whatever its type comment says.
    const marker = mask.encoding === 'one_bit' ? '!' : '~';
    path = p.decodeMaskToSVGPath({ encoding: mask.encoding, width: mask.width, height: mask.height, payload: marker + mask.payload });
  } catch {
    return undefined;
  }
  return outlineOf(path, mask);
}

export type Pt = [number, number];

/** The path's biggest ring, simplified to the pixel and put in fractions of the photo; undefined when there is none. */
export function outlineOf(path: string, at: Pick<SamMask, 'left' | 'top' | 'frameWidth' | 'frameHeight'>): string | undefined {
  const ring = ringsOf(path).sort((a, b) => polygonArea(b) - polygonArea(a))[0];
  if (!ring) return undefined;
  const kept = simplify(ring, 1);
  if (kept.length < 3) return undefined;
  return `M${kept.map(([x, y]) => `${((at.left + x) / at.frameWidth).toFixed(4)},${((at.top + y) / at.frameHeight).toFixed(4)}`).join('L')}Z`;
}

/** The rings of a path of absolute M/L/Z commands (what the parser traces), each a list of points. */
export function ringsOf(path: string): Pt[][] {
  const rings: Pt[][] = [];
  let ring: Pt[] = [];
  let x: number | null = null;
  const close = () => {
    if (ring.length >= 3) rings.push(ring);
    ring = [];
    x = null;
  };
  for (const token of path.match(/[MLZ]|-?\d+(?:\.\d+)?/gi) ?? []) {
    const c = token.toUpperCase();
    if (c === 'M') close();
    else if (c === 'Z') close();
    else if (c !== 'L') {
      const n = Number(token);
      if (x === null) x = n;
      else {
        ring.push([x, n]);
        x = null;
      }
    }
  }
  close();
  return rings;
}

export function polygonArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Ramer–Douglas–Peucker: the points of `ring` that keep it within `epsilon` of itself. */
export function simplify(ring: Pt[], epsilon: number): Pt[] {
  if (ring.length < 3) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let most = 0;
    for (let i = a + 1; i < b; i++) {
      const d = offLine(ring[i]!, ring[a]!, ring[b]!);
      if (d > most) {
        most = d;
        far = i;
      }
    }
    if (far >= 0 && most > epsilon) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/** How far `p` is from the segment `a`–`b`. */
function offLine([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
