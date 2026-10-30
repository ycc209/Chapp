/**
 * What the app asks of the AI. Every call goes through the server (the key never reaches the phone), and the server
 * answers with whichever provider AI_PROVIDER picks: `mock` (fixed answers from the BCA kit) or `meta` (Meta's models).
 *
 * HTTP routes, all JSON unless noted:
 *   POST /api/voice           body: audio/wav (mono 16-bit PCM, 16 kHz)  → Transcript
 *   POST /api/converse        ConverseRequest                            → ConverseReply
 *   POST /api/find-protocol   { query: string }                          → FoundProtocol
 *     with accept: text/event-stream, server-sent events instead: `progress` { line } as the search goes, `intro`
 *     ProtocolIntro when a manual new to Chapp is being read, then one `found` FoundProtocol, or `error` ApiError
 *     (FindProtocolEvent)
 *   POST /api/kit/recognize   RecognizeKitRequest (≤ 8 MB)               → RecognizedKit
 *   POST /api/kit/segment     SegmentBottlesRequest (≤ 8 MB)             → SegmentedBottles
 *   POST /api/kit/labels      ReadLabelsRequest (≤ 8 MB)                 → ReadLabels
 *   GET  /api/health                                                    → Health
 *   POST /api/read-plate      ReadPlateRequest                          → PlateReading
 *   POST /api/import-protocol body: application/pdf (≤ 20 MB)             → ImportedProtocol (saved; open protocol.id)
 *   GET  /api/protocols/:id/manual.pdf                                  → the PDF an imported protocol was read from
 * A non-2xx answer carries ApiError.
 */
import type { StepFacts } from './stepFacts.ts';
import type { A2uiMessage } from './a2ui.ts';
import type { Protocol } from './protocol.ts';

/** Chapp's faces. Each has a picture in public/chapp/ (neutral is chapp.webp); all but listen are clips in the 3D model. */
export type Expression = 'neutral' | 'happy' | 'thinking' | 'excited' | 'surprised' | 'sad' | 'wink' | 'sleepy' | 'listen';

/** Where a statement comes from: a page of a document on the web, with the words it rests on when there are some. */
export type Source = { url: string; title?: string; quote?: string; page?: number };

export type Transcript = { transcript: string };

/** What the app is showing when the user speaks, so Chapp can answer about it. */
export type ConverseContext = {
  screen: string;
  protocolId?: string | null;
  /** The protocol's procedure the run follows ("microplate"). */
  procedure?: string;
  /** The run's step, from 0, and its title as the run screen shows it ("Add the reagent"). */
  step?: number;
  stepTitle?: string;
  samples?: number;
  replicates?: number;
  /** Replicates for the standards, and how they are made (RunState.standards: the kit's table, halving, five, ready). */
  standardReplicates?: number;
  standards?: 'kit' | 'halve' | 'five' | 'ready';
  /** Timers running now, by id (a step id), with the whole seconds left; 0 has rung. */
  timers?: { id: string; secondsLeft: number }[];
  /** Where the plate readings came from: 'sample' is the built-in example export, which must be called sample data. */
  readingsFrom?: 'sample' | 'plate' | null;
  /**
   * The plan on the card the user last changed by hand under an answer (samples × replicates), when it is not the run's:
   * what "is that enough?" is about. The server works its numbers out like the run's.
   */
  shown?: { samples: number; replicates: number };
  /** This run's own length for a timed step, in seconds, where the user changed it (Run's choice, or a confirmed proposal). */
  lengths?: Record<string, number>;
  /** What changed on the plate during the run (src/components/lab/model.ts PlateEdits): wells moved, wells added. */
  edits?: { moved: Record<string, string>; added: { name: string; of?: string; wells: string[] }[] };
};

/** A turn of this conversation, oldest first: so "yes, find it" knows which kit was meant. */
export type ConverseTurn = { role: 'user' | 'chapp'; text: string };

export type ConverseRequest = { text: string; context: ConverseContext; history?: ConverseTurn[] };

/** Changes Chapp asks the app to make; the app applies them to its state (src/state/actions.ts). */
export type Action =
  | { type: 'navigate'; to: string }
  | { type: 'setSamples'; samples: number }
  | { type: 'setReplicates'; replicates: number }
  | { type: 'nextStep' }
  | { type: 'previousStep' }
  | { type: 'markDone'; id: string }
  | { type: 'startTimer'; id: string; seconds: number }
  /** This run's length for a timed step ("make step 4 24 hours"): only ever from the user's tap on Chapp's proposal. */
  | { type: 'setStepTime'; id: string; seconds: number }
  /** A vial or tube to do again (a vial with the vials made from it: src/state/benchEdits.ts). */
  | { type: 'redo'; id: string }
  /** A well gone wrong: what it held goes into `to`, or the next free well. */
  | { type: 'moveWell'; from: string; to?: string }
  /** One more well: of a tube on the plate ("sample 3", "B") or something new, named; in `well` or the next free one. */
  | { type: 'addWell'; what: string; well?: string }
  /** One more condition: a new sample, named, with the run's replicates. */
  | { type: 'addCondition'; name: string }
  /** Look for a kit's manual on the web (and read it in): the app opens the Overview, which searches for `query`. */
  | { type: 'findProtocol'; query: string };

export type ConverseReply = {
  /** What Chapp says, shown under the user's words. It never says it changed something: the app shows what it did. */
  say: string;
  expression?: Expression;
  /** Changes the user asked for in so many words: the app makes them at once, each with a line saying so. */
  actions: Action[];
  /**
   * Changes that wait for the user's tap: a step's new length (always), and anything the user's words did not ask for
   * plainly ("is it time for the next step?"), each shown as a button (server/ai/authorize.ts).
   */
  confirm?: Action[];
  /**
   * What Chapp draws under its answer: A2UI v0.9 messages for one surface (createSurface, then updateComponents), which
   * the model wrote and the server checked (shared/a2ui.ts). Values are bound to the data model the app fills; absent
   * when words are enough.
   */
  a2ui?: A2uiMessage[];
  sources: Source[];
};

export type FoundProtocol = {
  found: boolean;
  kit?: { vendor: string; catalog: string; name: string };
  /** The vendor's own document the answer is read from. */
  document?: { title: string; version?: string; url: string };
  /** Set when that document is a protocol on this machine (data/protocols/<id>.json): the one the app opens. */
  protocolId?: string;
  /** What Chapp said while it searched ("Looking for the manual…"), in order. */
  progress: string[];
  answer: string;
  sources: Source[];
  /** No manual of its own (a plain chemical, buffer or medium): the vendor's product page `answer` was read from. */
  page?: string;
};

export interface AIProvider {
  transcribe(wav: Uint8Array): Promise<Transcript>;
  converse(request: ConverseRequest): Promise<ConverseReply>;
  /** `live.onProgress` hears each progress line as the search says it (POST /api/find-protocol as server-sent events). */
  findProtocol(query: string, live?: FindProtocolLive): Promise<FoundProtocol>;
  /** A step card's picture as SVG, drawn from the step's facts (server/ai/picture.ts). Optional: without it the card keeps its simple one. */
  drawStep?(facts: StepFacts): Promise<string>;
  /** Reads a plate reader's screen, printout or odd export (server/ai/plate.ts); the route parses ordinary files itself. */
  readPlate?(input: PlateInput): Promise<PlateReading>;
  /** Kit photos (KitVision, server/ai/vision.ts). Optional: a provider without them answers /api/kit/* with 501. */
  recognizeKit?: KitVision['recognizeKit'];
  segmentBottles?: KitVision['segmentBottles'];
  readLabels?: KitVision['readLabels'];
  /**
   * Reads a kit manual (PDF) into a protocol (server/ai/import.ts); `url` is where it came from on the web, and
   * `live.onProgress` hears each stage ("Turning it into steps") and `live.onIntro` what the kit is, within seconds.
   * The mock answers with the BCA document. Optional: without it /api/import-protocol answers 501.
   */
  importProtocol?(pdf: Uint8Array, source?: { url?: string; filename?: string }, live?: Pick<FindProtocolLive, 'onProgress' | 'onIntro'>): Promise<ImportedProtocol>;
}

/** For a search the user watches: its progress as it happens, and a way to stop it when they leave. */
export type FindProtocolLive = {
  onProgress?: (line: string) => void;
  /** When the found manual is new to Chapp and being read: what the kit is, long before its steps are ready. */
  onIntro?: (intro: ProtocolIntro) => void;
  signal?: AbortSignal;
};

/** One server-sent event of a streamed find-protocol: its `event:` name and its `data:` JSON. */
export type FindProtocolEvent =
  | { event: 'progress'; data: { line: string } }
  | { event: 'intro'; data: ProtocolIntro }
  | { event: 'found'; data: FoundProtocol }
  | { event: 'error'; data: ApiError };

/** GET /api/health. `provider` is what answers /api/* right now; `metaModelApi` says whether the server has a Meta key. */
export type Health = { ok: boolean; provider: 'mock' | 'meta'; metaModelApi: boolean };

export type FindProtocolRequest = { query: string };

/** The body of every non-2xx answer from /api/*: a short message fit to show the user. */
export type ApiError = { error: string };

// Later phases. Signatures only: no route serves these yet, and neither provider implements them.

/** A photo from the phone's camera. */
export type Photo = { type: 'image/jpeg' | 'image/png' | 'image/webp'; data: Uint8Array };

/** A rectangle on a photo, as fractions of its width and height (0–1), from the top-left corner. */
export type Box = { x: number; y: number; width: number; height: number };

/** A point the user tapped on a photo, as fractions of its width and height. */
export type Point = { x: number; y: number };

/** A vendor manual read into Chapp's protocol format; `problems` are what shared/protocol.ts's checks found. */
export type ImportedProtocol = { protocol: Protocol; problems: string[]; sources: Source[] };

/**
 * What a manual is, read fast (server/ai/import.ts's intro, the model thinking as little as it can): what the
 * Overview shows first, its answer and At a glance, while the steps are still being read. The same words become the
 * protocol's title, summary and overview. `source.url` is "" for an upload not yet saved.
 */
export type ProtocolIntro = Pick<Protocol, 'title' | 'summary'> & {
  kit: { name: string; vendor: string; catalogs: string[] };
  source: Pick<Protocol['source'], 'title' | 'publisher' | 'docId' | 'revision' | 'url'>;
  overview: Pick<Protocol['overview'], 'steps' | 'expected' | 'cite'>;
  /**
   * The main procedure's steps as the manual words them, with their pages, for the Overview's Steps until the checked
   * steps are read; `others` names the kit's other procedures. Empty when the intro could not list them.
   */
  procedure: { name: string; steps: { text: string; page: number }[]; others: string[] };
  /** What the kit holds, as printed ("Albumin Standard", "10 × 1 mL"), for In the kit until the checked list is read. */
  contents: { name: string; amount: string }[];
};

// Kit photos, served by /api/kit/* (server/kit.ts → KitVision in server/ai/vision.ts).

/** What Muse Spark read on a kit's box. */
export type RecognizedKit = {
  found: boolean;
  kit?: { vendor: string; catalog: string; name: string };
  /** Set when Chapp already has this kit's protocol. */
  protocolId?: string | null;
  /** When it has not: what to look the kit up by (POST /api/find-protocol). */
  query?: string;
};

/** The bottles SAM 3.1 found on a photo, left to right. */
/** What SAM found: each bottle's box, and its mask as an outline (an SVG path of M/L/Z in fractions of the photo). */
export type SegmentedBottles = { bottles: { box: Box; score?: number; outline?: string }[] };

/** A component of the run's protocol that a label can name: its id, name, role, who supplies it and its label's words. */
export type LabelTarget = { id: string; name: string; role: string; kit: boolean; labels: string[] };

/**
 * How sure a label's match is. `read`: its label was read and names the component. `guess`: the label was not read and
 * the component is a guess from shape, size and colour, for the user to confirm. `other`: its label was read and names
 * nothing in this run. `none`: neither read nor guessed.
 */
export type LabelMatch = 'read' | 'guess' | 'other' | 'none';

/** Each crop's label, in the order asked: the words read ("" when none), what it looks like ("small vial"), its match. */
export type ReadLabels = { labels: { text: string; looks: string; componentId: string | null; match: LabelMatch }[] };

/** A photo inside a JSON body: base64, without the data: prefix. */
export type PhotoData = { type: Photo['type']; data: string };
export type RecognizeKitRequest = { photo: PhotoData };
/** `index` is the photo's place in this round of photos (0 first); only the mock uses it, to answer with its drawn sample's bottles. */
export type SegmentBottlesRequest = { photo: PhotoData; points?: Point[]; index?: number };
export type ReadLabelsRequest = { crops: PhotoData[]; components: LabelTarget[] };

export interface KitVision {
  recognizeKit(photo: Photo): Promise<RecognizedKit>;
  segmentBottles(photo: Photo, points?: Point[], index?: number): Promise<SegmentedBottles>;
  readLabels(crops: Photo[], components: LabelTarget[]): Promise<ReadLabels>;
}

/** Plate-reader values by well id ("A1"). `sampleData` marks the built-in example readings, which the app must label. */
export type PlateReading = {
  readings: Record<string, number>;
  sampleData: boolean;
  /** Wells whose cell held text instead of a number, as written ("OVRFLW"). */
  odd?: Record<string, string>;
  /** Who read the numbers: the file itself (exact), a model (the user confirms them first), or the built-in sample. */
  by?: 'file' | 'model' | 'sample';
  /** Wells the model could not read with certainty. */
  unsure?: string[];
  /** One short line about what was read ("Read 1:562", "No plate table in the photo"). */
  note?: string;
};

/**
 * POST /api/read-plate (JSON, ≤ 12 MB): a photo of the reader's screen or printout as a data URL, or its export file
 * as text (CSV, TSV, TXT) or as base64 (.xlsx, UTF-16 text) → PlateReading. Server: server/ai/plate.ts.
 */
export type ReadPlateRequest = {
  photo?: string;
  file?: { name: string; text?: string; base64?: string };
  rows?: number;
  cols?: number;
  /** The protocol's wavelength (nm): picks that read when the file or the screen shows several. */
  wavelength?: number;
};

/** What a provider's readPlate gets: a photo, or an export the local parser found no plate in. */
export type PlateInput = ({ photo: Photo } | { file: { name: string; text: string } }) & { rows: number; cols: number; wavelength?: number };

export type EquipmentImage = { name: string; url: string };

export interface PlannedAIProvider {
  drawEquipment(name: string): Promise<EquipmentImage>;
}
