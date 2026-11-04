import type { Box, Point } from './ai.ts';

/**
 * Boxes on photos of a kit, for both sides: the server tidies what SAM 3.1 finds (server/ai/vision.ts), the app crops
 * and draws them (src/screens/kit/), and the mock provider answers with the bottles of the drawn sample photos
 * (src/screens/kit/sample.ts), whose layout lives here so the two agree. All boxes are fractions of the photo.
 */

/** Photos go to the models at most this many px on their long side: a 1 mL ampule's label still has letters. */
export const ANALYZE_MAX = 1600;
/** A bottle's crop for reading its label: its box and this much more of its size around it, 256–768 px long. */
export const LABEL_PAD = 0.1;
export const LABEL_MIN = 256;
export const LABEL_MAX = 768;

/** The pixel rectangle a label crop cuts from a `width` × `height` photo, and the size it is drawn at. */
export function labelCrop(box: Box, width: number, height: number) {
  const p = padded(box, LABEL_PAD);
  const sx = Math.round(p.x * width);
  const sy = Math.round(p.y * height);
  const sw = Math.max(1, Math.min(width - sx, Math.round(p.width * width)));
  const sh = Math.max(1, Math.min(height - sy, Math.round(p.height * height)));
  const long = Math.max(sw, sh);
  const scale = long > LABEL_MAX ? LABEL_MAX / long : long < LABEL_MIN ? LABEL_MIN / long : 1;
  return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}

/** Words that say nothing of which product it is: every kit's labels have them. */
export const LABEL_GENERIC = new Set(['protein', 'assay', 'assays', 'reagent', 'reagents', 'kit', 'buffer', 'solution', 'standard', 'standards', 'store', 'for', 'research', 'use', 'only', 'the', 'and', 'with']);

export const area = (b: Box) => b.width * b.height;

export const contains = (b: Box, p: Point) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

/** The area two boxes share. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/** `box` grown by `pad` of its own width and height on every side, cut back to the photo. */
export function padded(box: Box, pad: number): Box {
  const x = clamp01(box.x - box.width * pad);
  const y = clamp01(box.y - box.height * pad);
  return { x, y, width: clamp01(box.x + box.width * (1 + pad)) - x, height: clamp01(box.y + box.height * (1 + pad)) - y };
}

/**
 * The square around `box` on a photo of `width` × `height` px, `margin` times the box's long side (never more than
 * the photo's short side), slid back inside the photo: what a bottle's 56 px thumbnail shows.
 */
export function squareOn(box: Box, width: number, height: number, margin = 1.15): Box {
  const side = Math.min(Math.max(box.width * width, box.height * height) * margin, width, height);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const x = clamp((box.x + box.width / 2) * width - side / 2, width - side);
  const y = clamp((box.y + box.height / 2) * height - side / 2, height - side);
  return { x: x / width, y: y / height, width: side / width, height: side / height };
}

/** The smallest box that holds the point, or null. */
export function boxAt(boxes: Box[], p: Point): Box | null {
  return boxes.filter(b => contains(b, p)).sort((a, b) => area(a) - area(b))[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// The drawn sample photos: 720 × 960, the bottles standing on a bench, two to the first photo and one to each other.

export const SAMPLE = { width: 720, height: 960, base: 0.8 * 960 };

export type SampleShape = { w: number; h: number; neck: [number, number]; cap: [number, number]; body: string; capColor: string };

export const SAMPLE_SHAPES: Record<'wide' | 'medium' | 'vial' | 'tall', SampleShape> = {
  wide: { w: 250, h: 330, neck: [90, 28], cap: [124, 52], body: '#f4f2ec', capColor: '#2f5fae' },
  medium: { w: 150, h: 212, neck: [56, 20], cap: [78, 38], body: '#f6f4ee', capColor: '#2f5fae' },
  vial: { w: 112, h: 196, neck: [52, 16], cap: [74, 40], body: '#eaf1f4', capColor: '#c94040' },
  tall: { w: 164, h: 452, neck: [72, 40], cap: [94, 50], body: '#e6edef', capColor: '#3a8f6a' },
};

export type SampleBottle = {
  /** Which of the bottles asked for (their order). */
  index: number;
  /** Its middle, in px. */
  cx: number;
  shape: SampleShape;
  /** Cap to base, as fractions of the photo. */
  box: Box;
};

/**
 * Where each bottle stands on the sample photos, by role (reagent, standard, diluent): the first reagent is a wide
 * bottle, later ones medium, the standard a vial, the diluent tall.
 */
export function sampleLayout(roles: string[]): SampleBottle[][] {
  const { width: W, height: H, base } = SAMPLE;
  const indices = roles.map((_, i) => i);
  const groups = [indices.slice(0, 2), ...indices.slice(2).map(i => [i])].filter(g => g.length);
  let reagents = 0;
  return groups.map(group => {
    const centers = group.length === 1 ? [0.5] : [0.32, 0.72];
    return group.map((index, j) => {
      const role = roles[index];
      const shape = role === 'standard' ? SAMPLE_SHAPES.vial : role === 'diluent' ? SAMPLE_SHAPES.tall : reagents++ === 0 ? SAMPLE_SHAPES.wide : SAMPLE_SHAPES.medium;
      const cx = centers[j] * W;
      const top = base - shape.h - shape.neck[1] - shape.cap[1];
      const w = Math.max(shape.w, shape.cap[0]);
      return { index, cx, shape, box: { x: (cx - w / 2) / W, y: top / H, width: w / W, height: (base - top) / H } };
    });
  });
}
