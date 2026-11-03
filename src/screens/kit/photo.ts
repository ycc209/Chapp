import type { Box, Point, TrackedBottles } from '../../../shared/ai.ts';
import { ANALYZE_MAX, squareOn } from '../../../shared/kit.ts';

/**
 * A photo of the kit, already made small enough to keep on the phone; `sweep` when it is a frame kept while the camera
 * swept past the bottles, `video` when it is a frame picked from a video the user chose.
 */
export type Shot = { id: string; src: string; width: number; height: number; sweep?: boolean; video?: boolean };

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

/** A video the user chose gives at most this many frames: each goes to the models as a photo would. */
export const VIDEO_FRAMES = 8;
/** …about one this many seconds apart, so a short clip gives a few. */
const VIDEO_EVERY_S = 2;
/**
 * SAM follows the bottles through a video this long at most (analysis.ts followBottles): about 600 frames, under a
 * minute for it. A longer one is read by its frames, as photos.
 */
export const FOLLOW_MAX_S = 20;
/** …and this big at most (the server's limit, server/kit.ts). */
export const FOLLOW_MAX_BYTES = 150 * 1024 * 1024;

/**
 * A sweep of the camera or a video the user chose: the frames kept from it, and the video itself when SAM can follow
 * the bottles through it (an MP4 or a MOV, short enough); else null, and the frames are the photos. A video played on
 * screen (Watch.tsx) comes with its player, still on the page (parkVideo), its following already asked for, what
 * frees the player once the frames SAM picked are taken from it, and `grab`: how the screen hands over the frame SAM
 * numbered `frame` (or the one it had on screen nearest it, `at`), taken from the player as it plays. Without one, the
 * frames are sought on the player, one at a time.
 */
export type Footage = {
  kind: 'sweep' | 'video';
  frames: Shot[];
  video: Blob | null;
  player?: HTMLVideoElement;
  tracked?: Promise<TrackedBottles>;
  /** A sweep's video sent ahead as it was recorded (events.ts sendAhead): the upload's id once all of it is there. */
  uploaded?: Promise<string | null>;
  release?: () => void;
  grab?: (frame: number) => Promise<{ shot: Shot; at: number } | null>;
};

/**
 * When to take a video's frames: spread evenly over it, each in the middle of its stretch, so neither the first nor
 * the last frame (where a phone is still being raised or lowered) is one. Pure, so it is tested.
 */
export function frameTimes(duration: number, every = VIDEO_EVERY_S, max = VIDEO_FRAMES): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const n = Math.max(1, Math.min(max, Math.round(duration / every)));
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * duration) / n);
}

/** Frames a second a video is taken to have when nothing says otherwise: a phone films at 30. */
const USUAL_FPS = 30;

/**
 * A followed video's frames by time, numbered as SAM numbers them: the frame showing at `t` seconds, and the time to
 * seek to for frame `f` (the middle of its stretch). By when each frame starts, read from the video itself
 * (TrackedBottles `times`); without that, `frames` spread evenly over `duration` (USUAL_FPS until SAM has counted them).
 * Pure, so it is tested.
 */
export function frameClock(duration: number, times?: number[] | null, frames?: number): { frameAt(t: number): number; timeOf(f: number): number } {
  if (times?.length) {
    const last = times.length - 1;
    const step = last > 0 ? times[last]! / last : 1 / USUAL_FPS;
    return {
      frameAt(t) {
        // The last frame starting by `t` (a hair early counts: the picture on screen at a frame's own time is that frame).
        let lo = 0;
        let hi = last;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (times[mid]! <= t + 1e-3) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      },
      timeOf(f) {
        const i = Math.max(0, Math.min(last, Math.round(f)));
        const end = i < last ? times[i + 1]! : Math.max(times[last]! + step, Number.isFinite(duration) ? Math.min(duration, times[last]! + 2 * step) : 0);
        return (times[i]! + end) / 2;
      },
    };
  }
  const known = Number.isFinite(duration) && duration > 0;
  const count = frames && frames > 0 ? frames : known ? Math.max(1, Math.round(duration * USUAL_FPS)) : 1;
  const fps = frames && frames > 0 && known ? frames / duration : USUAL_FPS;
  return {
    frameAt: t => Math.max(0, Math.min(count - 1, Math.floor(t * fps + 1e-3))),
    timeOf: f => (Math.max(0, f) + 0.5) / fps,
  };
}

/** A video at `src` (an object URL) ready to seek, its length known; closeVideo when done with it. */
export async function openVideo(src: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = src;
  try {
    await mediaEvent(video, 'loadedmetadata');
    // Safari decodes nothing of a video until it has played: a muted moment of it, stopped at once.
    await Promise.race([video.play().catch(() => {}), new Promise(done => setTimeout(done, 1500))]);
    video.pause();
    // A recording without its length in its header (a browser's MediaRecorder makes them) tells it once sought past its end.
    if (!Number.isFinite(video.duration)) {
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await mediaEvent(video, 'seeked').catch(() => {});
    }
    return video;
  } catch (error) {
    closeVideo(video);
    throw error;
  }
}

export function closeVideo(video: HTMLVideoElement) {
  video.removeAttribute('src');
  video.load();
}

/** The video's frame at `t` seconds, as a Shot carrying `mark`; null when there is no picture there. */
export async function frameAt(video: HTMLVideoElement, t: number, mark: Pick<Shot, 'sweep' | 'video'>): Promise<Shot | null> {
  video.currentTime = Math.max(0, Math.min(t, Number.isFinite(video.duration) ? video.duration : t));
  await mediaEvent(video, 'seeked');
  return video.videoWidth ? { ...frameToShot(video), ...mark } : null;
}

/**
 * Keeps a played video on the page, out of sight: an iPhone decodes a video only while it is in the page, and the
 * frames SAM picks are taken from it after it has left the screen. The caller removes it when done.
 */
export function parkVideo(video: HTMLVideoElement) {
  Object.assign(video.style, { position: 'fixed', left: '0', bottom: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none' });
  document.body.appendChild(video);
}

/** Whether SAM can follow the bottles through a video the user chose: short enough, small enough, MP4 or MOV. */
export const followable = (file: Blob & { name?: string }, duration: number) =>
  duration > 0 && duration <= FOLLOW_MAX_S && file.size <= FOLLOW_MAX_BYTES && /^video\/(?:mp4|quicktime)/.test(videoType(file));

/** What the server is told a video is: a MOV (an iPhone's) or else an MP4. */
export const videoType = (file: Blob & { name?: string }): 'video/mp4' | 'video/quicktime' =>
  file.type.includes('quicktime') || /\.mov$/i.test(file.name ?? '') ? 'video/quicktime' : 'video/mp4';

/**
 * The camera's stream recorded while it sweeps, for SAM to follow the bottles through: an MP4 (H.264), which iPhones
 * record; null where the browser records only WebM, which SAM does not take (the sweep's frames are read then). Each
 * piece goes to `onPiece` as it is recorded (a second's worth), to be sent ahead.
 */
export function recordSweep(stream: MediaStream, onPiece?: (piece: Blob) => void): { stop(): Promise<Blob | null> } | null {
  const type = typeof MediaRecorder === 'undefined' ? undefined : ['video/mp4;codecs=avc1', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) return null;
  const parts: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    recorder.ondataavailable = e => {
      if (!e.data.size) return;
      parts.push(e.data);
      onPiece?.(e.data);
    };
    recorder.start(1000);
  } catch {
    return null;
  }
  return {
    stop: () =>
      new Promise(done => {
        recorder.onstop = () => done(parts.length ? new Blob(parts, { type: 'video/mp4' }) : null);
        if (recorder.state === 'inactive') done(null);
        else recorder.stop();
      }),
  };
}

/** The media element's `name` event; its error, or silence for `ms` (a format the browser cannot play), fails. */
function mediaEvent(media: HTMLMediaElement, name: string, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = (ok: boolean) => () => {
      clearTimeout(timer);
      media.removeEventListener(name, yes);
      media.removeEventListener('error', no);
      if (ok) resolve();
      else reject(new Error('This video could not be opened.'));
    };
    const yes = end(true);
    const no = end(false);
    const timer = setTimeout(no, ms);
    media.addEventListener(name, yes);
    media.addEventListener('error', no);
  });
}

/** Whether a file the user chose is a video (a phone's .mov can come without its type). */
export const isVideo = (file: File) => file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name);

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
