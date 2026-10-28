import type { Box, PhotoData, ReadLabels } from '../../../shared/ai.ts';
import { labelCrop, squareOn } from '../../../shared/kit.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { api } from '../../api/client.ts';
import { toast } from '../../components/ui/Toaster.tsx';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { groupLabels, labelTargets, planFound, type Seen } from './found.ts';
import { cantLook, needsOf, noneFound, recognized, type Pick, type Thing } from './matching.ts';
import { analysisSrc, cropFrom, loadImage, type Shot } from './photo.ts';
import { useKit } from './store.ts';

/**
 * The models on the kit photos, as the user takes them: each photo goes to SAM 3.1 as soon as it is taken (its bottles
 * show on the strip), and once the user is done the bottles' crops go to Muse Spark together, which reads their labels.
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
 * and photograph the kit box, and Chapp tells which kit it is"). A kit Chapp has a manual for becomes the run's kit and
 * the bottles are matched against it; any other goes to the Overview, which finds its manual on the web (and reads it
 * in). A photo that shows no kit changes nothing. Returns where to go next, if anywhere.
 */
export async function whichKit(shot: Shot): Promise<string | null> {
  let found: Awaited<ReturnType<typeof api.recognizeKit>>;
  try {
    found = await api.recognizeKit({ photo: photoData(analysisSrc(shot)) });
  } catch {
    return null;
  }
  if (!found.found || !found.kit) return null;
  const name = found.kit.name || found.kit.catalog;
  if (found.protocolId) {
    const run = useRun.getState();
    if (found.protocolId !== run.protocolId) run.setProtocol(found.protocolId);
    toast(`That's the ${name}. I have its manual; now the bottles.`);
    return null;
  }
  if (!found.query) return null;
  // What the Overview shows as asked, and searches for.
  useSession.getState().setExchange({ ask: `Find the manual for the ${found.query}`, say: '' });
  return '/protocol';
}

/** Sends every photo SAM has not seen yet, each as soon as it can. */
export function findBottles() {
  const kit = useKit.getState();
  if (kit.sample) return;
  kit.shots.forEach((shot, index) => {
    if (kit.seen[shot.id]) return;
    kit.look(shot.id, { state: 'finding', boxes: [] });
    api
      .segmentBottles({ photo: photoData(analysisSrc(shot)), index })
      .then(r => useKit.getState().look(shot.id, { state: 'found', boxes: r.bottles.map(b => b.box) }))
      .catch(() => useKit.getState().look(shot.id, { state: 'failed', boxes: [] }));
  });
}

/** True while the models still have something to say: a photo with SAM, or bottles whose labels are not read yet. */
export const analyzing = (seen: Record<string, { state: string }>) => Object.values(seen).some(l => l.state === 'finding' || l.state === 'found' || l.state === 'reading');

let reading = false;

/**
 * Reads the labels of every bottle found but not yet read, once SAM is done with all the photos, and adds what it
 * learns to the session. Chapp's line says what came of it.
 */
export async function readFound(protocol: Protocol) {
  const kit = useKit.getState();
  if (reading || kit.sample || Object.values(kit.seen).some(l => l.state === 'finding')) return;
  const shots = kit.shots.filter(s => kit.seen[s.id]?.state === 'found');
  if (!shots.length) return;
  reading = true;
  for (const s of shots) kit.look(s.id, { ...kit.seen[s.id], state: 'reading' });
  const needs = needsOf(protocol);
  const done = (state: 'read' | 'failed') => {
    const now = useKit.getState();
    for (const s of shots) now.look(s.id, { ...now.seen[s.id], state });
  };
  try {
    const images = new Map(await Promise.all(shots.map(async s => [s.id, await loadImage(analysisSrc(s))] as const)));
    const bottles = shots.flatMap(s => kit.seen[s.id].boxes.map(box => ({ shot: s.id, box })));
    const crops = bottles.map(({ shot, box }) => labelCropOf(images.get(shot)!, box));
    const batches = Math.ceil(crops.length / LABELS_PER_CALL);
    const size = Math.ceil(crops.length / Math.max(1, batches));
    const components = labelTargets(protocol);
    const reads = await Promise.all(Array.from({ length: batches }, (_, i) => api.readLabels({ crops: crops.slice(i * size, (i + 1) * size), components })));
    const labels: ReadLabels['labels'] = reads.flatMap(r => r.labels);
    const seen: Seen[] = bottles.map((b, i) => ({ ...b, label: labels[i] ?? { text: '', looks: 'bottle', componentId: null, match: 'none' } }));
    const now = useKit.getState();
    // The round ended while the labels were read (Done, or a review): nothing to add to.
    if (!shots.every(s => now.shots.includes(s))) return;
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
    const said = read + unsure ? recognized(read + unsure, after.shots.length, unsure) : noneFound(after.shots.length, needs.length);
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
  if (later.shots.some(s => later.seen[s.id]?.state === 'found')) void readFound(protocol);
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
