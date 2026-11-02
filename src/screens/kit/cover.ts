import type { Box, RecognizedKit } from '../../../shared/ai.ts';
import { area } from '../../../shared/kit.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { kitCover, rememberCover, type Cover } from '../../state/library.ts';
import { loadImage, type Shot } from './photo.ts';
import { noteAdded } from './store.ts';

/**
 * The kit's cover: a whole photo the user took of the kit's own packaging, whatever it is (a box, a bag, a pouch). On
 * each photo of the kit (analysis.ts) Muse Spark reads which kit it shows and whether that was printed on packaging or
 * only on a bottle's label; SAM 3.1 then finds the packaging, so a thumbnail can show it. The photo, made small,
 * becomes that kit's cover (state/library.ts), shown on Library's card, the protocol, the sidebar and a share. A
 * component's own box (the Albumin Standard's) is not the kit's: its number is another kit's. Within a round of photos
 * the one whose packaging SAM found biggest wins; a later round's photo of the packaging replaces it. Packaging of a
 * kit Chapp has no protocol for yet waits until its manual becomes one (claimCover).
 */

/** Covers are kept this big on their long side: enough for the protocol's 64 px picture, small in the phone's storage. */
export const COVER_MAX = 480;

type Waiting = { cover: Cover; kit: NonNullable<RecognizedKit['kit']> };
let waiting: Waiting | null = null;

/** How much of its photo a cover's packaging fills; 0 when SAM could not find it. */
const size = (c: Pick<Cover, 'box'>) => (c.box ? area(c.box) : 0);

/** The kit's cover is now `cover`, unless this round already gave it a photo whose packaging is as big. */
export function putCover(protocolId: string, cover: Cover) {
  const had = kitCover(protocolId);
  if (had && had.round === cover.round && size(had) >= size(cover)) return;
  rememberCover(protocolId, cover);
  noteAdded({ cover: protocolId });
}

/**
 * A photo Muse Spark read a kit on its packaging, with where SAM found that packaging (null: nowhere, and the photo
 * stays centred): that kit's cover, now or once Chapp has it.
 */
export async function offerCover(shot: Shot, box: Box | null, round: string, read: RecognizedKit) {
  if (!read.found || !read.kit || !read.packaging) return;
  if (!read.protocolId && waiting?.cover.round === round && size(waiting.cover) >= size({ box: box ?? undefined })) return;
  const cover: Cover = { src: await small(shot.src), round, ...(box ? { box } : {}) };
  if (read.protocolId) putCover(read.protocolId, cover);
  else waiting = { cover, kit: read.kit };
}

/** The protocol on screen: packaging photographed before Chapp had its kit (Home's +, a manual then found) is its cover. */
export function claimCover(protocol: Pick<Protocol, 'id' | 'kit'>) {
  if (!waiting || !sameKit(protocol, waiting.kit)) return;
  putCover(protocol.id, waiting.cover);
  waiting = null;
}

/**
 * Whether the kit read on packaging is the protocol's: one of its catalog numbers, else its name with or without the
 * vendor's in front (as server/ai/vision.ts matches a kit to the protocols it has). Pure, so it is tested.
 */
export function sameKit(protocol: Pick<Protocol, 'kit'>, kit: { vendor: string; catalog: string; name: string }): boolean {
  const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code(kit.catalog) && protocol.kit.variants.some(v => code(v.catalog) === code(kit.catalog))) return true;
  const plain = (s: string) => s.toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9µ]+/g, ' ').trim();
  const name = plain(kit.name);
  return name !== '' && [name, name.replace(plain(kit.vendor), '').trim()].includes(plain(protocol.kit.name));
}

/** The photo at most COVER_MAX on its long side, as a JPEG data URL. */
async function small(src: string): Promise<string> {
  const img = await loadImage(src);
  const scale = Math.min(1, COVER_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * Where a cover's thumbnail centres it (CSS object-position): on the packaging, so a small square shows the kit, not
 * the bench around it; the middle when SAM did not find it.
 */
export const coverFocus = (box?: Box) => (box ? `${Math.round((box.x + box.width / 2) * 100)}% ${Math.round((box.y + box.height / 2) * 100)}%` : '50% 50%');
