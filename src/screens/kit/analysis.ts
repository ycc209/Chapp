import type { Box, PhotoData, Point, ReadLabels, RecognizedKit, Sighting, TrackedBottles } from '../../../shared/ai.ts';
import type { TrackHeard } from '../../api/events.ts';
import { area, labelCrop, overlap, squareOn } from '../../../shared/kit.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { api } from '../../api/client.ts';
import { toast } from '../../components/ui/Toaster.tsx';
import { load } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { offerCover } from './cover.ts';
import { contentsTarget, contentsTargets, groupLabels, labelTargets, planFound, sameBottles, targetOf, type ReadTarget, type Seen } from './found.ts';
import { cantLook, isContents, noneFound, recognized, takenOf, type Pick, type Thing } from './matching.ts';
import { analysisSrc, closeVideo, cropFrom, frameAt, frameClock, loadImage, openVideo, videoType, type Footage, type Shot } from './photo.ts';
import { findProtocol, prefetchFinding } from '../protocol/prefetch.ts';
import { roundNow, useKit, type Look } from './store.ts';

/**
 * The models on the kit photos, as the user takes them: each photo goes to SAM 3.1 as soon as it is taken (its bottles
 * show on the strip, and a photo of the kit's box or bag becomes the kit's cover: cover.ts); a sweep or a video, SAM
 * follows through, so each bottle in it is found once (followBottles). Once the user is done
 * the bottles' crops go to Muse Spark together, which reads their labels.
 * What comes back lands in the kit store (useKit): read bottles as matches, the rest as things Chapp asks about. When
 * the models are away, the photos simply stay with the user's taps.
 */

/** Labels read in one call at most; more bottles than this are read in several calls at once. */
const LABELS_PER_CALL = 12;

/** A data: URL → what /api/kit/* takes. */
export function photoData(src: string): PhotoData {
  const type = /^data:(image\/(?:jpeg|png|webp))/.exec(src)?.[1] as PhotoData['type'] | undefined;
  return { type: type ?? 'image/jpeg', data: src.slice(src.indexOf(',') + 1) };
}

/**
 * Which kit the first photo shows, when the camera was opened from Home's + (the storyboard's other scene ②: "press +
 * and photograph the kit box, and Chapp tells which kit it is"): see tellKit. Returns where to go next, if anywhere.
 */
export async function whichKit(shot: Shot): Promise<string | null> {
  const read = await readKit(shot).catch(() => null);
  return tellKit(read ? [read] : []) === 'search' ? '/protocol' : null;
}

/** What telling the kit came to: Chapp has its protocol (now the run's), is finding its manual, or could not tell. */
export type KitTold = 'known' | 'search' | 'none';

/** A reading of a photo that says which kit it is: one Chapp has the protocol of, or one to look the manual up by. */
const tells = (r: RecognizedKit | null): r is RecognizedKit => !!r?.found && !!r.kit && !!(r.protocolId || r.query);

/** A reading that settles which kit at once (kitReads): a kit Chapp has, or one read on its box or bag. */
export const settles = (r: RecognizedKit | null) => tells(r) && !!(r.protocolId || r.packaging);

/**
 * The reading that best says which kit some photos (a video's frames) show: one of a kit Chapp has the protocol of,
 * else one read on the kit's packaging, else one read on a bottle's label. Null when none says. Pure, so it is tested.
 */
export function bestKitRead(reads: (RecognizedKit | null)[]): RecognizedKit | null {
  const told = reads.filter(tells);
  return told.find(r => r.protocolId) ?? told.find(r => r.packaging) ?? told[0] ?? null;
}

/**
 * Acts on which kit photos show (bestKitRead). A kit Chapp has a manual for becomes the run's kit and the bottles are
 * matched against it; any other goes to the Overview, which finds its manual on the web (and reads it in): the
 * exchange carries what to look it up by, which is what makes the Overview search. Photos that show no kit change
 * nothing.
 */
export function tellKit(reads: (RecognizedKit | null)[]): KitTold {
  const found = bestKitRead(reads);
  if (!found) return 'none';
  const name = found.kit!.name || found.kit!.catalog;
  if (found.protocolId) {
    const run = useRun.getState();
    if (found.protocolId !== run.protocolId) run.setProtocol(found.protocolId);
    // A search asked before (another video, kept across a reload) is not this kit's: the Overview must not run it again.
    if (useSession.getState().exchange?.query) useSession.getState().setExchange(null);
    toast(`That's the ${name}. I have its manual; now the bottles.`);
    return 'known';
  }
  // A new run, of the kit found: the last kit's protocol is not this kit's, and the labels must not be read against it
  // meanwhile (the Overview sets the run's protocol once the manual is read; until then nothing is read).
  const run = useRun.getState();
  if (run.protocolId) run.setProtocol(null);
  // What the Overview shows as asked, and searches for; the search starts now (a video still playing), the Overview
  // shows it as it goes.
  useSession.getState().setExchange({ ask: `Find the manual for the ${found.query}`, say: '', query: found.query });
  prefetchFinding(found.query!);
  hearContents(found.query!);
  return 'search';
}

/**
 * What a kit new to Chapp holds, as soon as the first read of its manual says (ProtocolIntro.contents, seconds into
 * reading it): the bottles' labels are read against that (readInBackground), not once its steps are written too. Once
 * the manual is read its protocol is the run's (as the Overview would make it), and what the labels matched moves to
 * its bottles. A manual that lists nothing, or none found, leaves the contents empty: nothing to wait for. Only while
 * the round and the search are still the ones it was asked for.
 */
function hearContents(query: string) {
  const round = roundNow();
  const mine = () => roundNow() === round && useSession.getState().exchange?.query === query;
  const settle = () => {
    if (mine() && useKit.getState().contents === null) useKit.getState().setContents([]);
  };
  findProtocol(query, () => {}, undefined, intro => {
    if (mine() && intro.contents.length && !useKit.getState().contents?.length) useKit.getState().setContents(contentsTargets(intro.contents));
  }).then(found => {
    if (mine() && found.protocolId && found.protocolId !== useRun.getState().protocolId) useRun.getState().setProtocol(found.protocolId);
    settle();
  }, settle);
}

/** How many of a video's first frames are read for which kit it is (at once, as they are taken). */
export const KIT_READS = 4;

/**
 * The readings of a video's frames as soon as they say which kit it is: a frame read as a kit Chapp has the protocol
 * of, or read on its box or bag (whose name says it best), settles it at once, so its manual's search starts then (the
 * rest need not be waited for, 4 to 8 s each); otherwise every reading, for bestKitRead to pick from. `onRead` says
 * each time one comes in.
 */
export function kitReads(reads: Promise<RecognizedKit | null>[], onRead?: (done: number) => void): Promise<(RecognizedKit | null)[]> {
  return new Promise(resolve => {
    // By frame, null where a frame was not read (yet): a caller finds the frame a reading came from.
    const all: (RecognizedKit | null)[] = reads.map(() => null);
    let done = 0;
    reads.forEach((read, i) => {
      void read.then(r => {
        all[i] = r;
        done++;
        onRead?.(done);
        if (settles(r) || done === reads.length) resolve([...all]);
      });
    });
    if (!reads.length) resolve(all);
  });
}

/** Which kit a frame shows, read once a frame (the cover reads the same frames): null when it cannot be read. */
export const readKitOf = (shot: Shot) => readKit(shot).catch(() => null);

/** Which kit Muse Spark reads on a photo, and on what, asked once a photo: whichKit and the cover both want it. */
const reads = new Map<string, Promise<RecognizedKit>>();
function readKit(shot: Shot): Promise<RecognizedKit> {
  let read = reads.get(shot.id);
  if (!read) {
    read = api.recognizeKit({ photo: photoData(analysisSrc(shot)) });
    reads.set(shot.id, read);
    read.catch(() => reads.delete(shot.id));
  }
  return read;
}

/** Sends every photo the models have not seen yet, each as soon as it can: for its bottles, and for the kit's packaging. */
export function findBottles() {
  const kit = useKit.getState();
  if (kit.sample) return;
  // This round of photos, by its first: a later round's photo of the packaging replaces the cover this one gave.
  const round = kit.shots[0]?.id ?? '';
  kit.shots.forEach((shot, index) => {
    if (kit.seen[shot.id]) return;
    kit.look(shot.id, { state: 'finding', boxes: [] });
    api
      .segmentBottles({ photo: photoData(analysisSrc(shot)), index })
      .then(r => useKit.getState().look(shot.id, { state: 'found', boxes: r.bottles.map(b => b.box), outlines: r.bottles.map(b => b.outline) }))
      .catch(() => useKit.getState().look(shot.id, { state: 'failed', boxes: [] }));
    lookForCover(shot, round);
  });
}

/**
 * The kit's own packaging on a photo, whatever it is (a box, a bag): Muse Spark says what it is and which kit, SAM
 * where it is, and the photo becomes that kit's cover (cover.ts). Nothing is said either way.
 */
function lookForCover(shot: Shot, round: string) {
  const gen = roundNow();
  readKit(shot)
    .then(async read => {
      if (!read.found || !read.packaging) return;
      const found = await api.findPackaging({ photo: photoData(analysisSrc(shot)), what: read.packaging }).catch(() => ({ box: null }));
      // The round was taken back (the protocol's ×) while the models looked: no cover from it.
      if (roundNow() === gen) await offerCover(shot, found.box, round, read);
    })
    .catch(() => {});
}

/**
 * The other views of the bottles on a followed video's photos, as label crops, by photo and the bottle's place on it:
 * read with each bottle's main picture (readFound). Only in memory: after a reload a bottle is read from its photo alone.
 */
const moreViews = new Map<string, PhotoData[][]>();

/** How long the phone waits for SAM to follow a video's bottles (about 25 s for a 12 s sweep) before reading its frames. */
const FOLLOW_WAIT_MS = 170_000;

/**
 * SAM follows the bottles through `video` (asked as soon as a video starts playing on screen: Watch.tsx, which hears
 * each frame as SAM is done with it through `live`).
 */
export const startFollowing = (video: Blob, signal?: AbortSignal, live?: TrackHeard) =>
  api.trackBottles(video, videoType(video), AbortSignal.any([AbortSignal.timeout(FOLLOW_WAIT_MS), ...(signal ? [signal] : [])]), live);

/**
 * A sweep or a video the user chose. SAM follows the bottles through the video, so each counts once however many
 * frames show it; the few frames that show them all well (server/ai/vision.ts framesToRead) become this round's photos,
 * each bottle outlined there as SAM outlined it on that frame (the frame found by its time, read from the video), and
 * Muse Spark reads their labels as for any photo. Without a video SAM can take (a browser that
 * records only WebM; a video too long or big), or when following fails, the frames kept along the way are the photos.
 */
export async function followBottles(footage: Footage) {
  const kit = useKit.getState();
  if (kit.sample || !footage.video) {
    footage.release?.();
    return kit.addShots(footage.frames);
  }
  const round = kit.shots[0]?.id ?? footage.frames[0]?.id ?? '';
  const gen = roundNow();
  kit.follow(footage.kind);
  const placed = await framesFollowed(footage)
    .catch(() => null)
    .finally(() => footage.release?.());
  // The round was taken back (the protocol's ×) or ended while SAM followed: nothing to add to.
  if (roundNow() !== gen) return;
  const now = useKit.getState();
  now.follow(null);
  if (!placed?.shots.length) return now.addShots(footage.frames);
  now.addLooked(placed.shots, placed.looks);
  // The packaging may be on the frames read, or on the first the camera kept.
  for (const shot of [footage.frames[0], ...placed.shots]) if (shot) lookForCover(shot, round);
}

/** The frames SAM picked from a video, as photos with each bottle on them outlined; null when it followed none. */
async function framesFollowed({ kind, video, player: played, tracked: asked, grab }: Footage): Promise<{ shots: Shot[]; looks: Look[] } | null> {
  const tracked: TrackedBottles = await (asked ?? startFollowing(video!));
  if (!tracked.frames || !tracked.picks.length) return null;
  // The video played on screen is still on the page; else it is opened here.
  const url = played ? null : URL.createObjectURL(video!);
  try {
    const player = played ?? (await openVideo(url!));
    try {
      // SAM numbers the frames; the phone finds them by when each starts, as the video itself says.
      const clock = frameClock(player.duration, tracked.times, tracked.frames);
      const mark = kind === 'sweep' ? { sweep: true } : { video: true };
      // Sought one at a time on the one player, unless the screen hands the frames over as it plays them (Watch.tsx).
      let queue: Promise<unknown> = Promise.resolve();
      const seek = (frame: number) => {
        const got = queue.then(() => frameAt(player, clock.timeOf(frame), mark)).then(shot => (shot ? { shot, at: frame } : null));
        queue = got.catch(() => null);
        return got;
      };
      // Every frame asked for at once: a screen playing the video takes each as it passes, while the last is outlined.
      const takes = tracked.picks.map(p => (grab ?? seek)(p.frame));
      takes.forEach(t => t.catch(() => {}));
      // Where each bottle SAM followed is on every frame, and its outline there: a frame taken next to the one picked
      // has its own.
      const where = new Map<string, Sighting>((tracked.seen ?? []).map(s => [`${s.frame}:${s.id}`, s]));
      const shots: Shot[] = [];
      const looks: Look[] = [];
      // A bottle's other views, as label crops, by SAM's id; and where its main picture landed (photo, place on it).
      const others = new Map<number, PhotoData[]>();
      const mainAt = new Map<number, { shot: string; index: number }>();
      for (const [k, pick] of tracked.picks.entries()) {
        const got = await takes[k]!.catch(() => null);
        if (!got) continue;
        const { shot, at } = got;
        // The bottle as SAM saw it on the frame taken; one it did not see there, where it was on the frame picked.
        const onFrame = (b: { id: number; box: Box }): { box: Box; outline?: string } => where.get(`${at}:${b.id}`) ?? { box: b.box };
        const extra = pick.bottles.filter(b => !b.main).map(b => ({ ...b, box: onFrame(b).box }));
        if (extra.length) {
          const img = await loadImage(analysisSrc(shot));
          for (const b of extra) others.set(b.id, [...(others.get(b.id) ?? []), labelCropOf(img, b.box)]);
        }
        // A frame of other views only is no photo of the round.
        // Each bottle cut along SAM's outline of it on this frame: its mask from the video, not asked for again. Without
        // one (SAM was unsure of it there), the phone cuts it out by its own means, whose checks say whether it came out
        // whole.
        const mains = pick.bottles.filter(b => b.main).map(b => ({ ...b, ...onFrame(b) }));
        if (!mains.length) continue;
        const boxes: Box[] = [];
        const outlines: (string | undefined)[] = [];
        const ids: number[] = [];
        for (const b of mains) {
          // Two sightings of one bottle (SAM followed its cap apart, say): it counts once.
          if (boxes.some(o => overlap(o, b.box) >= 0.85 * Math.min(area(o), area(b.box)))) continue;
          mainAt.set(b.id, { shot: shot.id, index: boxes.length });
          boxes.push(b.box);
          outlines.push(b.outline);
          ids.push(b.id);
        }
        shots.push(shot);
        looks.push({ state: 'found', boxes, outlines, ids });
      }
      for (const [id, at] of mainAt) {
        const crops = others.get(id);
        if (!crops?.length) continue;
        const onShot = moreViews.get(at.shot) ?? [];
        onShot[at.index] = crops;
        moreViews.set(at.shot, onShot);
      }
      return { shots, looks };
    } finally {
      if (!played) closeVideo(player);
    }
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Off the kit screen (a video from Home's Upload, the protocol on screen after it), the photos are looked at and their
 * labels read as the kit screen would do it, for the run's protocol, until every photo is read or the round is over.
 * A kit new to Chapp has no protocol yet: its labels are read against what its manual says it holds (useKit
 * contents), and what they matched moves to the protocol's bottles once it is read.
 */
export function readInBackground() {
  const step = (s: ReturnType<typeof useKit.getState>) => {
    findBottles();
    const id = useRun.getState().protocolId;
    if (id)
      void load(id)
        .then(protocol => {
          adoptContents(protocol);
          return readFound(targetOf(protocol));
        })
        .catch(() => {});
    else if (s.contents?.length) void readFound(contentsTarget(s.contents));
    return !s.following && s.shots.length > 0 && !s.contents?.length && Object.values(s.seen).every(l => l.state === 'read' || l.state === 'failed');
  };
  const stopKit = useKit.subscribe((s, before) => {
    if (s.seen === before.seen && s.shots === before.shots && s.following === before.following && s.contents === before.contents) return;
    if (step(s) || (before.shots.length > 0 && !s.shots.length)) stop();
  });
  // The run's protocol can come after the photos: a kit whose manual was found and read once the video ended.
  const stopRun = useRun.subscribe((s, before) => {
    if (s.protocolId !== before.protocolId && step(useKit.getState())) stop();
  });
  const stop = () => {
    stopKit();
    stopRun();
  };
  if (step(useKit.getState())) stop();
}

/** How long a tap waits for SAM before the square around it is used instead. */
const TAP_WAIT_MS = 8000;

/**
 * What SAM outlines under a tap where it had found no bottle (a tube, an ampule, two bottles touching): its box,
 * added to the photo's bottles with its outline, so the bottle is cut out along it like any other. Null when SAM
 * finds nothing there or cannot be asked; the tap's square is used then.
 */
export async function bottleAt(shot: Shot, at: Point): Promise<Box | null> {
  try {
    const r = await api.segmentBottles({ photo: photoData(analysisSrc(shot)), points: [at] }, AbortSignal.timeout(TAP_WAIT_MS));
    const b = r.bottles[0];
    if (!b) return null;
    const look = useKit.getState().seen[shot.id];
    const boxes = look?.boxes ?? [];
    const outlines = look?.outlines ?? boxes.map(() => undefined);
    useKit.getState().look(shot.id, { state: look?.state ?? 'read', boxes: [...boxes, b.box], outlines: [...outlines, b.outline] });
    return b.box;
  } catch {
    return null;
  }
}

/** True while the models still have something to say: a photo with SAM, or bottles whose labels are not read yet. */
export const analyzing = (seen: Record<string, { state: string }>) => Object.values(seen).some(l => l.state === 'finding' || l.state === 'found' || l.state === 'reading');

let reading = false;

/**
 * What the labels matched among a kit's contents, moved to its protocol's bottles once it is read (found.ts
 * sameBottles); after the labels being read, which the next step brings here again.
 */
function adoptContents(protocol: Protocol) {
  const kit = useKit.getState();
  if (reading || !kit.contents?.length) return;
  kit.adopt(sameBottles(kit.contents, labelTargets(protocol)));
}

/**
 * Reads the labels of every bottle found but not yet read, once SAM is done with all the photos, against the run's
 * bottles (found.ts targetOf) or a new kit's contents (contentsTarget), and adds what it learns to the session.
 * Chapp's line says what came of it.
 */
export async function readFound(target: ReadTarget) {
  const kit = useKit.getState();
  if (reading || kit.sample || kit.following || Object.values(kit.seen).some(l => l.state === 'finding')) return;
  // The contents were read against before, and the protocol has them now.
  if (target.needs.some(n => isContents(n.id)) && !kit.contents?.length) return;
  const shots = kit.shots.filter(s => kit.seen[s.id]?.state === 'found');
  if (!shots.length) return;
  reading = true;
  for (const s of shots) kit.look(s.id, { ...kit.seen[s.id], state: 'reading' });
  const { needs, components } = target;
  const done = (state: 'read' | 'failed') => {
    const now = useKit.getState();
    for (const s of shots) now.look(s.id, { ...now.seen[s.id], state });
  };
  try {
    const images = new Map(await Promise.all(shots.map(async s => [s.id, await loadImage(analysisSrc(s))] as const)));
    const bottles = shots.flatMap(s => kit.seen[s.id].boxes.map((box, i) => ({ shot: s.id, box, more: moreViews.get(s.id)?.[i] ?? [] })));
    // Each bottle's pictures: its photo's crop, then its other views from a video (read together, one label for all).
    const groups = bottles.map(({ shot, box, more }) => [labelCropOf(images.get(shot)!, box), ...more]);
    const several = groups.some(g => g.length > 1);
    const calls = labelCalls(groups);
    const reads = await Promise.all(calls.map(c => api.readLabels({ crops: c.crops, components, ...(several ? { views: c.views } : {}) })));
    const labels: ReadLabels['labels'] = reads.flatMap(r => r.labels);
    const all: Seen[] = bottles.map(({ shot, box }, i) => ({ shot, box, label: labels[i] ?? { text: '', looks: 'bottle', componentId: null, match: 'none' } }));
    const now = useKit.getState();
    // The round ended while the labels were read (Done, or a review): nothing to add to.
    if (!shots.every(s => now.shots.includes(s))) return;
    for (const s of shots) moreViews.delete(s.id);
    // What Muse Spark says is no bottle at all (a cloth SAM took for one) leaves its photo: not counted, not asked about.
    const seen = all.filter(b => b.label.bottle !== false);
    for (const s of shots) {
      const drop = all.filter(b => b.shot === s.id && b.label.bottle === false).map(b => b.box);
      if (!drop.length) continue;
      const look = now.seen[s.id]!;
      now.look(s.id, { ...look, boxes: look.boxes.filter(b => !drop.includes(b)), outlines: look.outlines?.filter((_, i) => !drop.includes(look.boxes[i]!)) });
    }
    let n = now.things.length;
    const plan = planFound(groupLabels(seen), needs, now, () => `thing-${Date.now().toString(36)}-${(n++).toString(36)}`);
    const square = (shot: string, box: Box) => {
      const img = images.get(shot)!;
      return cropFrom(img, img.naturalWidth, img.naturalHeight, squareOn(box, img.naturalWidth, img.naturalHeight));
    };
    const picks: Record<string, Pick> = Object.fromEntries(Object.entries(plan.picks).map(([id, p]) => [id, { ...p, crop: square(p.shot, p.box) }]));
    const things: Thing[] = plan.things.map(t => ({ ...t, crop: square(t.shot, t.box) }));
    done('read');
    const after = useKit.getState();
    const read = Object.values({ ...after.picks, ...picks }).filter(p => p.how === 'read').length;
    const unsure = after.things.length + things.length;
    const found = Object.values(after.seen).reduce((n, l) => n + l.boxes.length, 0);
    const said = read + unsure ? recognized(found, takenOf(after.shots), read, unsure) : noneFound(takenOf(after.shots), needs.length);
    after.found(picks, things, said);
  } catch {
    done('failed');
    const now = useKit.getState();
    if (!Object.keys(now.picks).length && !now.things.length) now.say(cantLook(needs.length));
  } finally {
    reading = false;
  }
  // Photos SAM finished while these labels were being read: their turn now.
  const later = useKit.getState();
  if (later.shots.some(s => later.seen[s.id]?.state === 'found')) void readFound(target);
}

/**
 * The calls that read the bottles' labels: each bottle's pictures together, up to LABELS_PER_CALL pictures a call (a
 * bottle with more goes alone), the calls about as full as each other. Pure, so it is tested.
 */
export function labelCalls<T>(groups: T[][], most = LABELS_PER_CALL): { crops: T[]; views: number[] }[] {
  const total = groups.reduce((n, g) => n + g.length, 0);
  const each = Math.ceil(total / Math.max(1, Math.ceil(total / most)));
  const calls: { crops: T[]; views: number[] }[] = [];
  for (const g of groups) {
    const last = calls.at(-1);
    if (last && last.crops.length + g.length <= each) {
      last.crops.push(...g);
      last.views.push(g.length);
    } else calls.push({ crops: [...g], views: [g.length] });
  }
  return calls;
}

/** A bottle's crop for reading its label: its box and a margin, sized for the model (shared/kit.ts labelCrop). */
function labelCropOf(img: HTMLImageElement, box: Box): PhotoData {
  const c = labelCrop(box, img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = c.width;
  canvas.height = c.height;
  canvas.getContext('2d')!.drawImage(img, c.sx, c.sy, c.sw, c.sh, 0, 0, c.width, c.height);
  return photoData(canvas.toDataURL('image/jpeg', 0.85));
}
