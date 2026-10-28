import type { Box, Point } from '../../../shared/ai.ts';
import { ANALYZE_MAX, squareOn } from '../../../shared/kit.ts';

/** One photo of the kit, already made small enough to keep on the phone. */
export type Shot = { id: string; src: string; width: number; height: number };

/** Photos are kept at most this many pixels on their long side: plenty to see a label, small enough for storage. */
export const SHOT_MAX = 720;
/** A bottle's crop: this share of the photo's short side, square, around where the user tapped. */
export const CROP_SIDE = 0.4;
/** Crops are stored this big: three times the 56 px thumbnails they fill. */
export const CROP_PX = 240;

/** The square of `side` × the short side centred on `at`, slid back inside the photo where it would overhang. */
export function squareAround(at: Point, width: number, height: number, side = CROP_SIDE): Box {
  const s = Math.min(width, height) * side;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const x = clamp(at.x * width - s / 2, width - s);
  const y = clamp(at.y * height - s / 2, height - s);
  return { x: x / width, y: y / height, width: s / width, height: s / height };
}

/** Where `box` (fractions of a photo) lands on a thumbnail that shows the photo with object-fit: cover. */
export function boxOnCover(box: Box, photo: { width: number; height: number }, thumb: { width: number; height: number }) {
  const scale = Math.max(thumb.width / photo.width, thumb.height / photo.height);
  const w = photo.width * scale;
  const h = photo.height * scale;
  const ox = (thumb.width - w) / 2;
  const oy = (thumb.height - h) / 2;
  return { left: ox + box.x * w, top: oy + box.y * h, width: box.width * w, height: box.height * h };
}

let next = 0;
const newId = () => `shot-${Date.now().toString(36)}-${(next++).toString(36)}`;

/**
 * Each photo as the models get it, up to ANALYZE_MAX: the kept SHOT_MAX copy is too small for a vial's label. Only in
 * memory (a few hundred kB each); after a reload the kept copy stands in.
 */
const analysisCopies = new Map<string, string>();

/** The photo to send to the models: the large copy while this page has it, else the kept one. */
export const analysisSrc = (shot: Shot) => analysisCopies.get(shot.id) ?? shot.src;

function jpeg(source: CanvasImageSource, width: number, height: number, max: number, quality: number) {
  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { src: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
}

/** Draws `source` at most SHOT_MAX on its long side and keeps it as a JPEG; a larger copy goes to analysisCopies. */
export function toShot(source: CanvasImageSource, width: number, height: number): Shot {
  const shot = { id: newId(), ...jpeg(source, width, height, SHOT_MAX, 0.8) };
  if (Math.max(width, height) > SHOT_MAX) analysisCopies.set(shot.id, jpeg(source, width, height, ANALYZE_MAX, 0.85).src);
  return shot;
}

/** The camera's current frame. */
export function frameToShot(video: HTMLVideoElement): Shot {
  return toShot(video, video.videoWidth, video.videoHeight);
}

/** A picture from the phone's library. Browsers turn it upright by its EXIF orientation when they decode it. */
export async function fileToShot(file: File): Promise<Shot> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return toShot(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This picture could not be opened.'));
    img.src = src;
  });
}

/** Cuts `box` out of an image already in memory (a decoded photo or a canvas) as a CROP_PX square JPEG. */
export function cropFrom(source: CanvasImageSource, width: number, height: number, box: Box): string {
  const canvas = document.createElement('canvas');
  canvas.width = CROP_PX;
  canvas.height = CROP_PX;
  const g = canvas.getContext('2d')!;
  g.drawImage(source, box.x * width, box.y * height, box.width * width, box.height * height, 0, 0, CROP_PX, CROP_PX);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * A tap on `shot` as a bottle's picture: the bottle SAM found there (`bottle`), cut as a square around it from the
 * large copy, or else the square around the tap.
 */
export async function cropAt(shot: Shot, at: Point, bottle?: Box | null): Promise<{ crop: string; box: Box }> {
  if (bottle) {
    const img = await loadImage(analysisSrc(shot));
    return { crop: cropFrom(img, img.naturalWidth, img.naturalHeight, squareOn(bottle, img.naturalWidth, img.naturalHeight)), box: bottle };
  }
  const img = await loadImage(shot.src);
  const box = squareAround(at, shot.width, shot.height);
  return { crop: cropFrom(img, shot.width, shot.height, box), box };
}
