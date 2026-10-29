import { z } from 'zod';

/**
 * A setup shared by QR code (`chapp.share/1`): what a labmate's phone needs to run the same kit the same way.
 *
 * The phone POSTs it to /api/share, the server keeps it in data/shares/<id>.json (nothing leaves the Mac), and the code
 * holds only the link `<origin>/import?s=<id>`, short enough for the iPhone camera to open directly.
 *
 * What travels follows the Share-QR and Scan-Import artboards: the protocol (by id, since both phones read it from this
 * server; the procedure is part of it: "The protocol, 7 steps"), the plan, and the results. Replying trims it
 * ("Without the results", "Just the protocol"), and a trimmed share is a new share, so what was left out never
 * reaches the server. The kit travels as its labels, with the user's kit photos (the kit screen's small crops) unless
 * they choose "Without the photos" (10/28: photos go by default; the artboard kept them on the phone).
 */

export const SHARE_FORMAT = 'chapp.share/1';

/** The largest body POST /api/share takes: room for a few downscaled photos, far more than labels and readings need. */
export const MAX_SHARE_BYTES = 3 * 1024 * 1024;

/** The share's id in its link: 10 letters and digits, without the ones that read alike (l, o, 0, 1). */
export const SHARE_ID = /^[a-km-np-z2-9]{10}$/;

/** all: protocol, plan and results · noresults: protocol and plan · protocol: just the protocol. */
export const ShareScope = z.enum(['all', 'noresults', 'protocol']);

const Id = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower-case words joined by hyphens');

/** A plate well, A1 to P24 (a 384-well plate at most). */
const Well = z.string().regex(/^[A-P](?:[1-9]|1\d|2[0-4])$/, 'a well such as A1');

/** A photo as a data URL; the phone downscales it first (about 512 px), so one stays well under a megabyte. */
const Photo = z
  .string()
  .max(1024 * 1024)
  .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'a JPEG, PNG or WebP data URL');

/** One bottle of the kit as the sharer's phone knows it. */
export const SharedComponent = z
  .object({
    /** The protocol's component id. */
    id: Id,
    /** What the bottle is called on the sharer's bench ("BCA Reagent A", "PBS"). */
    label: z.string().trim().min(1).max(80),
    /** The line beside it ("BSA · 2 mg/mL"). */
    detail: z.string().trim().max(80).optional(),
    photo: Photo.optional(),
  })
  .strict();

export const SharedPlan = z
  .object({
    samples: z.number().int().min(1).max(96),
    /** Replicates for the samples. */
    replicates: z.number().int().min(1).max(6),
    /** Replicates for the standards; a share without it ran them like the samples. */
    standardReplicates: z.number().int().min(1).max(6).optional(),
    /** How the standards were made (useRun().standards); a share without it used the kit's table. */
    standards: z.enum(['kit', 'halve', 'five', 'ready']).optional(),
    /**
     * What changed on the plate during the run (src/components/lab/model.ts PlateEdits): a well that went wrong and
     * where its contents went, wells added. The readings are where these put things, so they travel together.
     */
    edits: z
      .object({
        moved: z.record(Well, Well),
        added: z.array(z.object({ name: z.string().trim().min(1).max(60), of: z.string().max(10).optional(), wells: z.array(Well).min(1).max(8) }).strict()).max(48),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SharedResults = z
  .object({
    /** Plate-reader values by well. */
    readings: z
      .record(Well, z.number().finite())
      .refine(r => Object.keys(r).length > 0, 'results need at least one reading')
      .refine(r => Object.keys(r).length <= 384, 'at most 384 readings'),
    /** The readings are Chapp's built-in example, which every screen showing them must label "Sample data". */
    sampleData: z.boolean().optional(),
    /** The standard curve's R², as the sharer's results screen showed it. */
    r2: z.number().min(0).max(1).optional(),
  })
  .strict();

const fields = {
  format: z.literal(SHARE_FORMAT),
  scope: ShareScope,
  /** Who shared it, when the phone knows ("CJ Yu shared a Pierce BCA run"). */
  from: z.string().trim().min(1).max(40).optional(),
  protocolId: Id,
  /** The protocol's procedure the plan is for ("microplate"). */
  procedure: Id,
  kit: z.array(SharedComponent).max(40),
  plan: SharedPlan.optional(),
  results: SharedResults.optional(),
};

/** What the scope promises: the plan travels unless it is just the protocol, the results only with everything. */
function consistent(s: { scope: ShareScope; kit: SharedComponent[]; plan?: SharedPlan; results?: SharedResults }, ctx: z.RefinementCtx) {
  const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
  if (s.scope !== 'protocol' && !s.plan) issue('a share with the plan needs the plan', 'plan');
  if (s.scope === 'protocol' && s.plan) issue('just the protocol leaves the plan out', 'plan');
  if (s.scope !== 'all' && s.results) issue('this share leaves the results out', 'results');
  if (new Set(s.kit.map(c => c.id)).size !== s.kit.length) issue('each bottle once', 'kit');
}

/** What the phone sends to POST /api/share. */
export const SharedSetup = z.object(fields).strict().superRefine(consistent);

/** What GET /api/share/:id answers: the setup as sent, with its id and when the server received it. */
export const StoredShare = z
  .object({ ...fields, id: z.string().regex(SHARE_ID), sharedAt: z.iso.datetime() })
  .strict()
  .superRefine(consistent);

export type ShareScope = z.infer<typeof ShareScope>;
export type SharedComponent = z.infer<typeof SharedComponent>;
export type SharedPlan = z.infer<typeof SharedPlan>;
export type SharedResults = z.infer<typeof SharedResults>;
export type SharedSetup = z.infer<typeof SharedSetup>;
export type StoredShare = z.infer<typeof StoredShare>;

/** The link the QR code holds. */
export const shareLink = (origin: string, id: string) => `${origin.replace(/\/+$/, '')}/import?s=${id}`;

/**
 * The share id in what a QR code says, or null when it is not a Chapp share link. Any host is accepted (a labmate's
 * code may name another address of this server); only the id is used, and the app fetches it from its own server.
 */
export function shareIdFrom(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !/\/import\/?$/.test(url.pathname)) return null;
  const id = url.searchParams.get('s');
  return id && SHARE_ID.test(id) ? id : null;
}
