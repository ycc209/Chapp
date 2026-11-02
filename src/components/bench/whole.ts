/**
 * The user's bottle made to stand on the bench, from its cut-out (cutout.ts), in pure pixel work so it is tested:
 *
 * - **Upright** (`uprightTurn`): a bottle photographed lying down, or held in a hand, is turned so its long axis
 *   stands up with its cap on top. Which end is the cap, Muse Spark says (POST /api/kit/cap): the shape cannot, since
 *   a vial's cap is often wider than its rounded foot (the 3T3-L1 kit's vials stood on their caps when the narrower
 *   end was taken for the neck). The BCA kit's Reagent A lay in its box, cap to the left; it stands up with its label
 *   reading across, as a standing bottle's does.
 * - **Whole** (`layOver`): what a hand or the photo's edge hid is filled in from Muse Image's picture of the same
 *   bottle whole (POST /api/kit/whole), laid under the photo. Muse Image draws the bottle at its own size and place
 *   (Reagent B came back about 15 % small), so the picture is first lined up by outline (the words it writes on its
 *   own label, never the photo's, play no part) and toned like the photo. Only a real missing piece is filled (the cap
 *   under a thumb), never the band a few pixels wide where the drawn cap is a little taller or the foot a little lower:
 *   a bottle with nothing missing (Reagent A) is left exactly as photographed. Next to the missing piece, and only
 *   there, the photo gives way where it is not the bottle (the glove SAM took in with the cap); everywhere else, the
 *   label too, the photo is untouched.
 *
 * Images are RGBA (as a canvas gives them), `w` × `h`, row by row; masks one byte a pixel.
 */

export type Pixels = Uint8ClampedArray | Uint8Array;

/** Which side of the picture a bottle's cap points to (shared/ai.ts CapSide). */
export type Cap = 'up' | 'down' | 'left' | 'right';
const CAP_ANGLE: Record<Cap, number> = { up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0 };

/** The long axis of the opaque part of `alpha`, and how much longer than wide it is. */
function shapeOf(alpha: Pixels, w: number, h: number) {
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < w * h; i++) if (alpha[i]! > 127) (n++, (sx += i % w), (sy += (i / w) | 0));
  if (n < 50) return null;
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < w * h; i++) {
    if (alpha[i]! <= 127) continue;
    const dx = (i % w) - cx, dy = ((i / w) | 0) - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const axis = 0.5 * Math.atan2(2 * xy, xx - yy);
  const mid = (xx + yy) / 2, spread = Math.sqrt(((xx - yy) / 2) ** 2 + xy ** 2);
  const elongation = Math.sqrt((mid + spread) / Math.max(1e-9, mid - spread));
  return { axis, elongation };
}

/**
 * Clockwise degrees (-180, 180] that stand the bottle in `alpha` upright, its cap on top. `cap` is the side the cap
 * points to (from Muse Spark): the end of the long axis nearer that side goes up; a bottle with no clear long axis
 * (a squat jar) is turned a quarter at a time to put that side up. Without `cap`, a bottle already nearly upright is
 * only straightened, never turned over, and one lying down is left as it is: which end is its cap, its shape cannot
 * say. A turn under 3° is not worth it: 0.
 */
export function uprightTurn(alpha: Pixels, w: number, h: number, cap?: Cap | null): number {
  const shape = shapeOf(alpha, w, h);
  if (!shape) return 0;
  const { axis, elongation } = shape;
  const long = elongation > 1.25;
  let up: number;
  if (cap) {
    const c = CAP_ANGLE[cap];
    const along = Math.cos(axis - c);
    up = long && Math.abs(along) > 0.5 ? (along >= 0 ? axis : axis + Math.PI) : c;
  } else if (long && Math.abs(Math.cos(axis)) < Math.sin(Math.PI / 6)) up = Math.sin(axis) < 0 ? axis : axis + Math.PI;
  else return 0;
  // The cap's direction from the centre, turned to straight up (-90° in image coordinates).
  let turn = -((up * 180) / Math.PI) - 90;
  turn = ((((turn + 180) % 360) + 360) % 360) - 180;
  if (turn === -180) turn = 180;
  return Math.abs(turn) < 3 ? 0 : Math.round(turn * 10) / 10;
}

/**
 * Where a cut (`piece`, `pw` × `ph`, cut out of `crop` unchanged where it is opaque) sits on the crop: the top left
 * where its opaque pixels match, or null. For cuts kept before they said where they were.
 */
export function locate(piece: Pixels, pw: number, ph: number, crop: Pixels, w: number, h: number): [number, number] | null {
  const solid: number[] = [];
  for (let i = 0; i < pw * ph; i++) if (piece[i * 4 + 3] === 255) solid.push(i);
  if (!solid.length) return null;
  const picks = Array.from({ length: Math.min(48, solid.length) }, (_, k) => solid[Math.floor((k * solid.length) / Math.min(48, solid.length))]!);
  const same = (i: number, j: number) => Math.abs(piece[i * 4]! - crop[j * 4]!) <= 3 && Math.abs(piece[i * 4 + 1]! - crop[j * 4 + 1]!) <= 3 && Math.abs(piece[i * 4 + 2]! - crop[j * 4 + 2]!) <= 3;
  for (let oy = 0; oy + ph <= h; oy++)
    for (let ox = 0; ox + pw <= w; ox++)
      if (picks.every(i => same(i, (((i / pw) | 0) + oy) * w + (i % pw) + ox))) return [ox, oy];
  return null;
}

// ---------------------------------------------------------------------------------------------------------------

/** A blur near a Gaussian of `sigma`: three box blurs, on the first `channels` of `ch`-channel pixels. */
export function blur(src: Pixels, w: number, h: number, ch: number, sigma: number, channels = ch): Float32Array {
  const r = Math.max(1, Math.round(sigma * 0.87));
  const a = Float32Array.from(src);
  const b = new Float32Array(w * h * ch);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    for (let line = 0; line < lines; line++)
      for (let c = 0; c < channels; c++) {
        const at = (k: number) => (horizontal ? line * w + k : k * w + line) * ch + c;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += from[at(Math.min(n - 1, Math.max(0, k)))]!;
        for (let k = 0; k < n; k++) {
          to[at(k)] = sum / (2 * r + 1);
          sum += from[at(Math.min(n - 1, k + r + 1))]! - from[at(Math.max(0, k - r))]!;
        }
      }
  };
  for (let round = 0; round < 3; round++) (pass(a, b, true), pass(b, a, false));
  return a;
}

/** The pieces of a mask (4-connected) of at least `least` pixels. */
function bigPieces(mask: Uint8Array, w: number, h: number, least: number): Uint8Array {
  const out = new Uint8Array(w * h), seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const piece = [s];
    seen[s] = 1;
    for (let k = 0; k < piece.length; k++) {
      const i = piece[k]!, x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1])
        if (j >= 0 && mask[j] && !seen[j]) (seen[j] = 1), piece.push(j);
    }
    if (piece.length >= least) for (const i of piece) out[i] = 255;
  }
  return out;
}

/** Pieces of the drawn bottle the photo lacks count from this thick (pixels, twice it plus one) and this share of the bottle. */
const GAP = 5;
const MISSING = 0.03;
/** How far (pixels) round a missing piece the photo is weighed against the drawing (a glove over a cap). */
const NEAR = 12;

/** A transform of the drawing onto the photo: photo point p shows drawing point c + R(-a)·(p - c - t) / s. */
export type Lineup = { s: number; a: number; overlap: number; dx: number; dy: number };

function mapper(f: Pick<Lineup, 's' | 'a' | 'dx' | 'dy'>, cx: number, cy: number) {
  const ca = Math.cos(f.a), sa = Math.sin(f.a);
  return (x: number, y: number): [number, number] => {
    const ux = x - cx - f.dx, uy = y - cy - f.dy;
    return [cx + (ca * ux + sa * uy) / f.s, cy + (-sa * ux + ca * uy) / f.s];
  };
}

/**
 * Where the drawn bottle goes so it lies under the photo's, by outline alone (so the words Muse Image wrote on its
 * label, never the photo's, cannot pull it off), coarse to fine: the photo's bottle all inside the drawn one, with as
 * little of the drawn one left over as can be. What is left over is cheap (it may be the very part the photo lacks,
 * the cap under a thumb); the photo's bottle outside the drawn one is dear. `overlap` is that score, per pixel of the
 * photo's bottle (1 when the two are one outline).
 */
export function lineUp(mask: Pixels, drawnMask: Uint8Array, w: number, h: number): Lineup {
  const cx = w / 2, cy = h / 2;
  const grid = (step: number) => {
    const out: number[] = [];
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) out.push(y * w + x);
    return out;
  };
  const overlap = (f: Pick<Lineup, 's' | 'a' | 'dx' | 'dy'>, G: number[]) => {
    const map = mapper(f, cx, cy);
    let both = 0, photoOnly = 0, drawnOnly = 0;
    for (const i of G) {
      const inPhoto = mask[i]! > 127;
      const [qx, qy] = map(i % w, (i / w) | 0);
      const xi = Math.round(qx), yi = Math.round(qy);
      const inDrawing = xi >= 0 && yi >= 0 && xi < w && yi < h && drawnMask[yi * w + xi]! > 0;
      if (inPhoto && inDrawing) both++;
      else if (inPhoto) photoOnly++;
      else if (inDrawing) drawnOnly++;
    }
    return (both - photoOnly - 0.25 * drawnOnly) / Math.max(1, both + photoOnly);
  };
  const coarse = grid(6), fine = grid(2);
  let best: Lineup = { s: 1, a: 0, dx: 0, dy: 0, overlap: -1 };
  for (let a = -6; a <= 6; a += 3)
    for (let s = 0.7; s <= 1.5001; s += 0.05)
      for (let dy = -48; dy <= 48; dy += 6)
        for (let dx = -48; dx <= 48; dx += 6) {
          const f = { s, a: (a * Math.PI) / 180, dx, dy };
          const o = overlap(f, coarse);
          if (o > best.overlap) best = { ...f, overlap: o };
        }
  let step = { s: 0.025, a: Math.PI / 120, t: 3 };
  best = { ...best, overlap: overlap(best, fine) };
  for (let round = 0; round < 4; round++, step = { s: step.s / 2, a: step.a / 2, t: step.t / 2 }) {
    const from = best;
    for (const da of [-1, 0, 1])
      for (const ds of [-1, 0, 1])
        for (const ddy of [-2, -1, 0, 1, 2])
          for (const ddx of [-2, -1, 0, 1, 2]) {
            const f = { s: from.s + ds * step.s, a: from.a + da * step.a, dx: from.dx + ddx * step.t, dy: from.dy + ddy * step.t };
            const o = overlap(f, fine);
            if (o > best.overlap) best = { ...f, overlap: o };
          }
  }
  return best;
}

/** The background grown in from the frame's edge while it stays near `bg`: what is left is the drawn bottle. */
export function silhouette(px: Pixels, w: number, h: number, bg: number[], near = 38): Uint8Array {
  const isBg = (i: number) => Math.hypot(px[i * 4]! - bg[0]!, px[i * 4 + 1]! - bg[1]!, px[i * 4 + 2]! - bg[2]!) < near;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!seen[i] && isBg(i)) (seen[i] = 1), stack.push(i);
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = seen[i] ? 0 : 255;
  return out;
}

/** The median colour along the frame's edge. */
export function edgeColour(px: Pixels, w: number, h: number): number[] {
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  return [0, 1, 2].map(c => edge.map(i => px[i * 4 + c]!).sort((a, b) => a - b)[edge.length >> 1]!);
}

/** The least (or, `max`, the most) of each (2r+1)² square of a mask. */
function squareFilter(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const pick = max ? Math.max : Math.min, start = max ? 0 : 255;
  const across = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = start;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]!);
      across[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = start;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, across[k * w + x]!);
      out[y * w + x] = v;
    }
  return out;
}

/** A mask without its parts thinner than `r` pixels (a min then a max over (2r+1)² squares). */
function opened(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return squareFilter(squareFilter(mask, w, h, r, false), w, h, r, true);
}

export type Laid = { rgba: Uint8ClampedArray; width: number; height: number; share: number; lineup: Lineup };

/**
 * The photo's bottle (`photo`, its `mask`) made whole from the drawing of it (`drawn`, already scaled to the same
 * `w0` × `h0` frame): the drawing lined up under the photo and toned like it, its pieces the photo lacks filled in,
 * the photo exactly as it is everywhere but next to them. Null, and the photo left as it is, when nothing is missing,
 * or when the drawing is not this bottle's shape (it leaves more than 15 % of the photo's bottle outside it, is more
 * than 1.8 times its size, or runs along less than half of the photo's outline). The result is trimmed to the bottle.
 */
export function layOver(photo: Pixels, mask: Pixels, drawn: Pixels, w0: number, h0: number, note: (why: string) => void = () => {}): Laid | null {
  // A frame wider all round: the drawn bottle may reach past the crop once lined up.
  const pad = Math.round(0.28 * Math.max(w0, h0));
  const w = w0 + 2 * pad, h = h0 + 2 * pad;
  const bg = edgeColour(drawn, w0, h0);
  const P = new Uint8ClampedArray(w * h * 4), D = new Uint8ClampedArray(w * h * 4), M = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) (P[i * 4] = P[i * 4 + 1] = P[i * 4 + 2] = 128), (D[i * 4] = bg[0]!), (D[i * 4 + 1] = bg[1]!), (D[i * 4 + 2] = bg[2]!);
  for (let y = 0; y < h0; y++)
    for (let x = 0; x < w0; x++) {
      const i = y * w0 + x, j = (y + pad) * w + x + pad;
      for (let c = 0; c < 3; c++) (P[j * 4 + c] = photo[i * 4 + c]!), (D[j * 4 + c] = drawn[i * 4 + c]!);
      M[j] = mask[i]!;
    }

  // Line the drawing up under the photo, by outline, and warp it there (bilinear).
  const lineup = lineUp(M, silhouette(D, w, h, bg), w, h);
  const map = mapper(lineup, w / 2, h / 2);
  const warped = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const [qx, qy] = map(x, y);
      const x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
      for (let c = 0; c < 3; c++) {
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
          warped[j + c] = bg[c]!;
          continue;
        }
        const at = (xx: number, yy: number) => D[(yy * w + xx) * 4 + c]!;
        warped[j + c] = (1 - fx) * (1 - fy) * at(x0, y0) + fx * (1 - fy) * at(x0 + 1, y0) + (1 - fx) * fy * at(x0, y0 + 1) + fx * fy * at(x0 + 1, y0 + 1);
      }
      warped[j + 3] = 255;
    }
  const drawnMask = silhouette(warped, w, h, bg);
  // The same bottle: the drawn one holds the photo's, is not far bigger, and runs along most of the photo's outline
  // (all but where something hid it).
  let inPhoto = 0, inBoth = 0, inDrawing = 0, edge = 0, edgeAlong = 0;
  const drawnEdge = new Uint8Array(w * h);
  for (let i = w; i < w * (h - 1); i++) if (drawnMask[i] && (!drawnMask[i - 1] || !drawnMask[i + 1] || !drawnMask[i - w] || !drawnMask[i + w])) drawnEdge[i] = 255;
  const nearEdge = squareFilter(drawnEdge, w, h, 3, true);
  for (let i = w; i < w * (h - 1); i++) {
    if (drawnMask[i]) inDrawing++;
    if (M[i]! <= 127) continue;
    inPhoto++;
    if (drawnMask[i]) inBoth++;
    if (M[i - 1]! <= 127 || M[i + 1]! <= 127 || M[i - w]! <= 127 || M[i + w]! <= 127) (edge++, nearEdge[i] && edgeAlong++);
  }
  const holds = inBoth / Math.max(1, inPhoto), size = inDrawing / Math.max(1, inPhoto), along = edgeAlong / Math.max(1, edge);
  note(`lined up: scale ${lineup.s.toFixed(3)}, turn ${((lineup.a * 180) / Math.PI).toFixed(1)}°, shift ${lineup.dx.toFixed(1)}, ${lineup.dy.toFixed(1)}; holds ${holds.toFixed(2)}, ${size.toFixed(2)} × its size, ${Math.round(along * 100)} % of its outline along the drawing's`);
  if (holds < 0.85 || size > 1.8 || along < 0.5) return note('not this bottle’s shape'), null;

  // The drawing toned like the photo: per channel, a gain and an offset fitted where both are bottle.
  const gen = new Uint8ClampedArray(warped);
  for (let c = 0; c < 3; c++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < w * h; i += 2) {
      if (M[i]! <= 250 || !drawnMask[i]) continue;
      const x = warped[i * 4 + c]!, y = P[i * 4 + c]!;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    if (n < 20) continue;
    const gain = Math.max(0.5, Math.min(2, (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx)));
    const offset = (sy - gain * sx) / n;
    for (let i = 0; i < w * h; i++) gen[i * 4 + c] = warped[i * 4 + c]! * gain + offset;
  }

  // What the photo lacks: the drawn bottle where the photo has none, in pieces big enough to be a part of the bottle
  // (the cap under a thumb), not the band a few pixels wide where Muse Image drew the cap a little taller or the foot a
  // little lower than the photo's. A bottle with no such piece is whole already: it is left as it is.
  const only = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) only[i] = drawnMask[i]! && M[i]! < 128 ? 255 : 0;
  const added = bigPieces(opened(only, w, h, GAP), w, h, Math.max(40, MISSING * inPhoto));
  let addedArea = 0;
  for (let i = 0; i < w * h; i++) if (added[i]) addedArea++;
  if (!addedArea) return note('nothing missing'), null;
  // Next to what is missing, and only there, the photo gives way where it is not the bottle the drawing shows: the
  // glove SAM took in with the hidden cap. Everywhere else, the label too, the photo stays exactly as it is.
  const near = squareFilter(added, w, h, NEAR, true);
  const within = squareFilter(drawnMask, w, h, 2, true);
  const gb = blur(gen, w, h, 4, 4, 3), pb = blur(P, w, h, 4, 4, 3);
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (M[i]! <= 127 || !near[i]) continue;
    const alike = Math.hypot(pb[i * 4]! - gb[i * 4]!, pb[i * 4 + 1]! - gb[i * 4 + 1]!, pb[i * 4 + 2]! - gb[i * 4 + 2]!) < 34;
    keep[i] = within[i] && alike ? 255 : 0;
  }
  const soft = blur(keep, w, h, 1, 1.2);
  const out = new Uint8ClampedArray(w * h * 4);
  let fromPhoto = 0, area = 0;
  let left = w, top = h, right = -1, bottom = -1;
  for (let i = 0; i < w * h; i++) {
    let m: number, under: number;
    if (!near[i]) (m = M[i]! / 255), (under = 0);
    else (m = Math.min(soft[i]!, M[i]!) / 255), (under = drawnMask[i]! && (added[i] || M[i]! > 127) ? 1 : 0);
    const alpha = m + under * (1 - m);
    if (alpha <= 0.03) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = (P[i * 4 + c]! * m + gen[i * 4 + c]! * under * (1 - m)) / alpha;
    out[i * 4 + 3] = Math.round(alpha * 255);
    const x = i % w, y = (i / w) | 0;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    fromPhoto += m;
    area += alpha;
  }
  if (right < left) return null;
  const width = right - left + 1, height = bottom - top + 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(out.subarray(((y + top) * w + left) * 4, ((y + top) * w + left + width) * 4), y * width * 4);
  return { rgba, width, height, share: area ? fromPhoto / area : 1, lineup };
}
