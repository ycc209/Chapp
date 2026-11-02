/**
 * The bench's pictures: real lab items drawn by Muse Image in one scientific-illustration style (BioRender-like, from
 * one flask drawn as the style), cut out of their backgrounds and kept in public/bench/*.png. Each stands on its foot
 * at (0, 0), y up being negative, and this says where: its box in bench units (BenchView draws on 240 × 240), which
 * fraction of the picture's width is over the origin (`cx`, the body's axis: a tube's cap and a pipette's finger hook
 * stick out to one side), at what fraction of its height it touches the bench (`foot`), and, as fractions of the
 * picture, where its liquid goes. The scene composer (shared/benchScenes.ts) places the pipette over the plate's wells
 * by the same numbers (wellAt), so the drawing and the timeline agree.
 */

/** A point as fractions of a picture: (0, 0) its top left, (1, 1) its bottom right. */
export type Frac = [number, number];

export type Art = {
  src: string;
  /** The box on the bench, in bench units (a rack's is its aspect only: it is as wide as the scene says). */
  w: number;
  h: number;
  cx: number;
  foot: number;
  /** The inside of a vessel, where liquid shows, as fractions of the picture. */
  liquid?: Frac[];
};

const picture = (name: string) => `/bench/${name}.png`;

/** The outer rim of the reservoir, seen from the front and above: left, back, right, front corners. */
const RESERVOIR_RIM: Frac[] = [
  [0.025, 0.2],
  [0.245, 0.015],
  [0.98, 0.59],
  [0.735, 0.775],
];

export const ART = {
  tube: {
    src: picture('tube'),
    w: 25.8,
    h: 54,
    cx: 0.565,
    foot: 0.995,
    liquid: [[0.28, 0.2], [0.85, 0.2], [0.85, 0.62], [0.8, 0.7], [0.72, 0.9], [0.64, 0.975], [0.5, 0.975], [0.41, 0.9], [0.3, 0.7], [0.28, 0.62]],
  },
  conical: {
    src: picture('conical'),
    w: 26,
    h: 112,
    cx: 0.495,
    foot: 0.995,
    liquid: [[0.09, 0.19], [0.9, 0.19], [0.9, 0.82], [0.76, 0.9], [0.66, 0.96], [0.55, 0.995], [0.44, 0.995], [0.33, 0.96], [0.23, 0.9], [0.09, 0.82]],
  },
  bottle: {
    src: picture('bottle'),
    w: 40.7,
    h: 89,
    cx: 0.5,
    foot: 0.995,
    liquid: [[0.18, 0.24], [0.82, 0.24], [0.95, 0.34], [1, 0.42], [1, 0.92], [0.93, 0.96], [0.8, 0.985], [0.2, 0.985], [0.07, 0.96], [0, 0.92], [0, 0.42], [0.05, 0.34]],
  },
  pipette: { src: picture('pipette'), w: 32.4, h: 142.5, cx: 0.675, foot: 0.995 },
  reservoir: { src: picture('reservoir'), w: 76, h: 44.8, cx: 0.5, foot: 0.99, liquid: shrink(RESERVOIR_RIM, 0.86) },
  plate: { src: picture('plate'), w: 184, h: 95.7, cx: 0.5, foot: 0.975 },
  rack: { src: picture('rack'), w: 448, h: 122, cx: 0.5, foot: 0.99 },
  dish: { src: picture('dish'), w: 112, h: 72.3, cx: 0.5, foot: 0.99 },
  flask: { src: picture('flask-base'), w: 90, h: 47.2, cx: 0.5, foot: 0.99 },
  beaker: {
    src: picture('beaker'),
    w: 49,
    h: 62,
    cx: 0.47,
    foot: 0.995,
    liquid: [[0.04, 0.16], [0.9, 0.16], [0.9, 0.88], [0.85, 0.94], [0.7, 0.985], [0.24, 0.985], [0.09, 0.94], [0.04, 0.88]],
  },
  washbottle: {
    src: picture('washbottle'),
    w: 48.5,
    h: 92,
    cx: 0.38,
    foot: 0.995,
    liquid: [[0.2, 0.33], [0.56, 0.33], [0.73, 0.42], [0.76, 0.5], [0.76, 0.92], [0.66, 0.98], [0.52, 0.995], [0.25, 0.995], [0.11, 0.98], [0, 0.92], [0, 0.5], [0.03, 0.42]],
  },
  incubator: { src: picture('incubator'), w: 89, h: 128, cx: 0.5, foot: 0.995 },
  reader: { src: picture('reader'), w: 126, h: 79.6, cx: 0.5, foot: 0.995 },
  centrifuge: { src: picture('centrifuge'), w: 88, h: 85, cx: 0.5, foot: 0.995 },
  microscope: { src: picture('microscope'), w: 102, h: 96, cx: 0.5, foot: 0.995 },
} satisfies Record<string, Art>;

/** The flask's medium, as a mask over the flask picture (white where the medium is): any colour can stand in it. */
export const FLASK_MEDIUM_MASK = picture('flask-medium-mask');

/** Where the rack's front face begins, as a fraction of its height: drawn again over the tubes standing in it. */
export const RACK_FRONT = 0.67;

/** A point of a picture on the bench, for the picture standing on its foot (sized `w` × `h` when not its own box). */
export function at(art: Art, fx: number, fy: number, w = art.w, h = art.h): [number, number] {
  return [(fx - art.cx) * w, (fy - art.foot) * h];
}

/** A polygon shrunk towards its centre: the inside of a rim. */
export function shrink(poly: Frac[], by: number): Frac[] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * by, cy + (y - cy) * by]);
}

/**
 * The plate: its top face's corners in the picture (back, right, front, left: it is seen from the front left, above),
 * and on it, drawn by the app rather than the picture (Muse Image drew 70 wells; a plate has 96), the wells. The
 * picture's own wells are covered first (`cover`), then the 96 stand in a frame inset on the face as on a real plate,
 * where A1 is the back-left corner: columns 1–12 run along the back edge to the right, rows A–H down the left edge to
 * the front.
 */
const PLATE_FACE: Frac[] = [
  [0.3375, 0.012],
  [0.975, 0.3925],
  [0.6825, 0.8625],
  [0.03, 0.4825],
];

export function plateFrame() {
  const art = ART.plate;
  const face = PLATE_FACE.map(([fx, fy]) => at(art, fx, fy));
  const cover = shrink(PLATE_FACE, 0.93).map(([fx, fy]) => at(art, fx, fy));
  const [back, right, , left] = shrink(PLATE_FACE, 0.82).map(([fx, fy]) => at(art, fx, fy)) as [number, number][];
  return { face, cover, back: back!, right: right!, left: left! };
}

/**
 * Where a plate's well is, for a plate standing at (0, 0): its centre, and the ellipse a round well is in this view
 * (a circle on the face, through the face's own slant). Rows and columns may run past the plate (-1: the labels).
 */
export function wellAt(row: number, col: number) {
  const { back, right, left } = plateFrame();
  const a = [(right[0] - back[0]) / 12, (right[1] - back[1]) / 12] as const;
  const b = [(left[0] - back[0]) / 8, (left[1] - back[1]) / 8] as const;
  const x = back[0] + (col + 0.5) * a[0] + (row + 0.5) * b[0];
  const y = back[1] + (col + 0.5) * a[1] + (row + 0.5) * b[1];
  // A circle of radius r on the face comes out with semi-axes r times the singular values of [a b].
  const m = [[a[0], b[0]], [a[1], b[1]]] as const;
  const p = m[0][0] ** 2 + m[1][0] ** 2, q = m[0][1] ** 2 + m[1][1] ** 2, s = m[0][0] * m[0][1] + m[1][0] * m[1][1];
  const d = Math.sqrt(Math.max(0, ((p - q) / 2) ** 2 + s ** 2));
  const r = 0.36;
  return { x, y, rx: r * Math.sqrt((p + q) / 2 + d), ry: r * Math.sqrt(Math.max(0, (p + q) / 2 - d)) };
}
