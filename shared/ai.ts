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
 *   POST /api/kit/packaging   FindPackagingRequest (≤ 8 MB)              → KitPackaging
 *   POST /api/kit/track       body: video/mp4 or video/quicktime (≤ 150 MB) → TrackedBottles
 *     with accept: text/event-stream, server-sent events instead: `video` { times } once its frames are counted,
 *     `stage` { stage } as it goes to SAM, `frame` FollowedFrame for each frame as SAM follows the bottles through it,
 *     then one `followed` TrackedBottles (without `seen`, sent frame by frame already), or `error` ApiError (TrackEvent)
 *   POST /api/kit/labels      ReadLabelsRequest (≤ 8 MB)                 → ReadLabels
 *   POST /api/kit/cap         BottleCapRequest (≤ 8 MB)                  → BottleCap
 *   POST /api/kit/whole       WholeBottleRequest (≤ 8 MB)                → WholeBottle
 *   GET  /api/health                                                    → Health
 *   POST /api/read-plate      ReadPlateRequest                          → PlateReading
 *   POST /api/import-protocol body: application/pdf (≤ 20 MB)             → ImportedProtocol (saved; open protocol.id)
 *   GET  /api/protocols/:id/manual.pdf                                  → the PDF an imported protocol was read from
 *   DELETE /api/protocols/:id                                           → { deleted }: an imported protocol, its manual and pictures go
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
  /** A viewed manual, separate from the active experiment identified by protocolId. */
  previewProtocolId?: string;
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
  shown?: { samples: number; replicates: number; standardReplicates?: number };
  /** This run's own length for a timed step, in seconds, where the user changed it (Run's choice, or a confirmed proposal). */
  lengths?: Record<string, number>;
  /** What changed on the plate during the run (src/components/lab/model.ts PlateEdits): wells moved, wells added. */
  edits?: { moved: Record<string, string>; added: { name: string; of?: string; wells: string[] }[] };
  /** Timers stopped part-way (the plate out of the incubator), by step id, with the whole seconds left. */
  paused?: { id: string; secondsLeft: number }[];
  /** The manual's own alternatives for a timed step ("30 min at 37 °C or 2 h at room temperature"), in seconds, by step id, while the user may still pick one. */
  options?: Record<string, number[]>;
  /** A question the app itself has just asked and waits on ("Stop the timer?"): the next thing said may be its answer. */
  pending?: string;
  /** The user set the plan (samples, replicates) for this run, so starting needs no start card. */
  planned?: boolean;
  /** The start card is up in the conversation, waiting for Start: a yes now starts the run (startRun with now). */
  startCard?: boolean;
  /** What the user did by hand on the screens since they last spoke ("Step 3 of 6 · Load the plate", "Timer started · 30 min"). */
  events?: string[];
  /** Timers running in other experiments, or in the run set aside: the kit, the step id, the whole seconds left (0 has rung). */
  elsewhere?: { experiment: string; step: string; secondsLeft: number }[];
  done?: Record<string, boolean>;
  readings?: Record<string, number>;
};

/** A turn of this conversation, oldest first: so "yes, find it" knows which kit was meant. */
export type ConverseTurn = { role: 'user' | 'chapp'; text: string };

export type ConverseRequest = {
  text: string;
  context: ConverseContext;
  history?: ConverseTurn[];
  /** The last reply's responseId: Meta keeps the conversation from there (and its reasoning carries on). */
  previousResponseId?: string;
  /** Earlier conversation retained when a stored model response is unavailable. */
  summary?: string;
  /** Opaque server ticket for returning the actual results of browser-side tools. */
  continuationToken?: string;
  toolResults?: { callId: string; ok: boolean; message: string }[];
};

/** Changes Chapp asks the app to make; the app applies them to its state (src/state/actions.ts). */
export type Action =
  | { type: 'navigate'; to: string }
  | { type: 'setSamples'; samples: number }
  | { type: 'setReplicates'; replicates: number; standardReplicates?: number }
  | { type: 'nextStep' }
  | { type: 'previousStep' }
  | { type: 'markDone'; id: string }
  | { type: 'startTimer'; id: string; seconds: number }
  /** This run's length for a timed step, requested directly or accepted from a prior proposal. */
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
  | { type: 'findProtocol'; query: string }
  /** A step's timer stopped part-way (the plate taken out), and started again from where it was. */
  | { type: 'stopTimer'; id: string }
  | { type: 'resumeTimer'; id: string }
  /** The user shows Chapp the plate reader's screen: the run screen opens the camera. */
  | { type: 'takePhoto' }
  /** The built-in sample readings instead of a plate, to try the app. */
  | { type: 'useSample' }
  /** Yes or no to the question the app asked (ConverseContext.pending). */
  | { type: 'answer'; yes: boolean }
  | { type: 'undo' }
  /** Adopt an already imported protocol only when the user asks to use it. */
  | { type: 'openProtocol'; protocolId: string }
  /**
   * Start the experiment (the user said "start", "let's begin", "開始實驗"): `protocolId` adopts that protocol first
   * when it is not the current one. The app decides: back to the run where it is once it has begun; the start card in
   * the conversation (the plan, Start or change it) while the plan was never set; into the run when it was, or `now`
   * (the user agreed to the card, or asked to start straight away).
   */
  | { type: 'startRun'; protocolId?: string; now?: boolean };

/** The app's receipt for a startRun that put the start card up rather than starting (confirm.ts says so in a line). */
export const START_CARD = 'Start card shown';

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
  /** Meta's id for this reply, sent back as the next turn's previousResponseId; absent from the mock. */
  responseId?: string;
  /** Execute in the browser, then resume with receipts; these are not completed actions. */
  pendingTools?: { callId: string; action: Action }[];
  continuationToken?: string;
  /** The latest prepared Overview snapshot; also streamed before the answer finishes. */
  protocolPreview?: ProtocolPreview;
};

/** A confirmed document being prepared for viewing, isolated from the active experiment. */
export type ProtocolPreview = {
  id: string;
  state: 'reading' | 'ready' | 'error';
  title?: string;
  source?: Source;
  intro?: ProtocolIntro;
  protocolId?: string;
  progress?: string[];
  error?: string;
};

export type ConverseLive = {
  onProtocol?: (preview: ProtocolPreview) => void;
  onText?: (delta: string) => void;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
};

export type ConverseEvent =
  | { event: 'protocol'; data: ProtocolPreview }
  | { event: 'text'; data: { delta: string } }
  | { event: 'progress'; data: { line: string } }
  | { event: 'reply'; data: ConverseReply }
  | { event: 'error'; data: ApiError };

export type FoundProtocol = {
  found: boolean;
  kit?: { vendor: string; catalog: string; name: string };
  /** The vendor document located by discovery; original-text reading is tracked separately by the evidence registry. */
  document?: { title: string; version?: string; url: string };
  /** Set when that document is a protocol on this machine (data/protocols/<id>.json): the one the app opens. */
  protocolId?: string;
  /** What Chapp said while it searched ("Looking for the manual…"), in order. */
  progress: string[];
  answer: string;
  sources: Source[];
  /** No manual of its own (a plain chemical, buffer or medium): the vendor product page located by discovery. */
  page?: string;
  /**
   * What the search itself read of that manual (its summary, main steps and bottles), shown while the manual is read,
   * until the manual's own intro replaces it (server/imports.ts findAndImport). Never saved with the protocol.
   */
  intro?: ProtocolIntro;
};

export interface AIProvider {
  transcribe(wav: Uint8Array): Promise<Transcript>;
  converse(request: ConverseRequest, live?: ConverseLive): Promise<ConverseReply>;
  /** `live.onProgress` hears each progress line as the search says it (POST /api/find-protocol as server-sent events). */
  findProtocol(query: string, live?: FindProtocolLive): Promise<FoundProtocol>;
  /** A step card's picture as SVG, drawn from the step's facts (server/ai/picture.ts). Optional: without it the card keeps its simple one. */
  drawStep?(facts: StepFacts): Promise<string>;
  /** Reads a plate reader's screen, printout or odd export (server/ai/plate.ts); the route parses ordinary files itself. */
  readPlate?(input: PlateInput): Promise<PlateReading>;
  /** Kit photos (KitVision, server/ai/vision.ts). Optional: a provider without them answers /api/kit/* with 501. */
  recognizeKit?: KitVision['recognizeKit'];
  segmentBottles?: KitVision['segmentBottles'];
  findPackaging?: KitVision['findPackaging'];
  trackBottles?: KitVision['trackBottles'];
  readLabels?: KitVision['readLabels'];
  capSide?: KitVision['capSide'];
  wholeBottle?: KitVision['wholeBottle'];
  /**
   * Reads a kit manual (PDF) into a protocol (server/ai/import.ts); `url` is where it came from on the web, and
   * `live.onProgress` hears each stage ("Turning it into steps") and `live.onIntro` what the kit is, within seconds.
   * The mock answers with the BCA document. Optional: without it /api/import-protocol answers 501.
   */
  importProtocol?(pdf: Uint8Array, source?: { url?: string; filename?: string }, live?: Pick<FindProtocolLive, 'onProgress' | 'onIntro' | 'signal'>): Promise<ImportedProtocol>;
}

/** For a search the user watches: its progress as it happens, and a way to stop it when they leave. */
export type FindProtocolLive = {
  onProgress?: (line: string) => void;
  /** When the found manual is new to Chapp and being read: what the kit is, long before its steps are ready. */
  onIntro?: (intro: ProtocolIntro) => void;
  /**
   * The search has named the vendor's manual and is still writing what the kit is: what it found so far, so the
   * manual can be downloaded and read meanwhile. Heard at most once, and only when it found a document.
   */
  onDocument?: (found: FoundProtocol) => void;
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
  /**
   * When the name was read on packaging the kit (or a part of it) came in, what it is in a word or two ("box", "bag",
   * "pouch"); absent when it was read only on a bottle's label. Such a photo can be the kit's cover.
   */
  packaging?: string;
};

/**
 * What SAM found on a photo, left to right: each bottle's box, and its mask as an outline (an SVG path of M/L/Z in
 * fractions of the photo). Asked about points or boxes, each comes with the prompt's number (`id`, 1 for the first), in order.
 */
export type SegmentedBottles = { bottles: { box: Box; score?: number; outline?: string; id?: number }[] };

/** A video of the kit, as the phone recorded or chose it. */
export type Video = { type: 'video/mp4' | 'video/quicktime'; data: Uint8Array };

/**
 * The bottles SAM 3.1 followed through a video, each once: how many frames the video has, when each starts (`times`,
 * seconds from the first, read from the video itself: so the phone finds a frame by its time, and the frame on screen
 * by the time it shows), the frames to take, each with the bottles to read on it (SAM's id for the bottle, its box on
 * that frame), and every sighting (`seen`: which bottle was where on each frame, its mask as an outline in fractions of
 * the frame), for a screen to draw the bottles followed as the video plays again, and for each bottle's photo to be cut
 * along. Each bottle is on one frame as its main picture (`main`: its photo and cut-out) and on up to two more, from
 * other moments, read with it.
 */
export type TrackedBottles = {
  frames: number;
  times?: number[];
  picks: { frame: number; bottles: { id: number; box: Box; main?: boolean }[] }[];
  seen: Sighting[];
};

/** One bottle on one frame of a video SAM followed: SAM's id for it (the same on every frame), its box, its outline. */
export type Sighting = { frame: number; id: number; box: Box; outline?: string };

/** The bottles SAM saw on one frame of a video, as it goes through it. */
export type FollowedFrame = { frame: number; bottles: Omit<Sighting, 'frame'>[] };

/**
 * How far a video is on its way to SAM: going into Meta's file store (`sending`; a video small enough goes in the
 * request itself), then with SAM, its first frames not out yet (`started`).
 */
export type TrackStage = 'sending' | 'started';

/**
 * Following a video as SAM goes: when each of its frames starts, how far it is on its way to SAM, each frame as SAM is
 * done with it, and giving up.
 */
export type TrackLive = {
  onVideo?: (video: { times?: number[] }) => void;
  onStage?: (stage: TrackStage) => void;
  onFrame?: (frame: FollowedFrame) => void;
  signal?: AbortSignal;
};

export type TrackEvent =
  | { event: 'video'; data: { times?: number[] } }
  | { event: 'stage'; data: { stage: TrackStage } }
  | { event: 'frame'; data: FollowedFrame }
  | { event: 'followed'; data: Omit<TrackedBottles, 'seen'> }
  | { event: 'error'; data: ApiError };

/**
 * A component of the run's protocol that a label can name: its id, name, role, who supplies it, its label's words and
 * the volumes the kit's sizes have it in ("25 mL"), which a label prints too.
 */
export type LabelTarget = { id: string; name: string; role: string; kit: boolean; labels: string[]; volumes?: string[] };

/**
 * How sure a label's match is. `read`: its label was read and names the component. `guess`: the label was not read and
 * the component is a guess from shape, size and colour, for the user to confirm. `other`: its label was read and names
 * nothing in this run. `none`: neither read nor guessed.
 */
export type LabelMatch = 'read' | 'guess' | 'other' | 'none';

/** Each crop's label, in the order asked: the words read ("" when none), what it looks like ("small vial"), its match. */
/** `bottle: false` when the picture shows no bottle, vial, tube or box at all (SAM took a cloth or a hand for one). */
export type ReadLabels = { labels: { text: string; looks: string; componentId: string | null; match: LabelMatch; bottle?: false }[] };

/** A photo inside a JSON body: base64, without the data: prefix. */
export type PhotoData = { type: Photo['type']; data: string };
export type RecognizeKitRequest = { photo: PhotoData };
/**
 * `points`: taps, one object under each. `boxes`: objects known to be there (a bottle SAM followed through a video),
 * outlined whole within each box, where a point at a bottle's middle can catch only a word of its label. `index` is the
 * photo's place in this round of photos (0 first); only the mock uses it, to answer with its drawn sample's bottles.
 */
export type SegmentBottlesRequest = { photo: PhotoData; points?: Point[]; boxes?: Box[]; index?: number };
/**
 * `views`: how many of the crops, in order, are pictures of each bottle (several views of one bottle from a video, read
 * together); without it each crop is a bottle of its own. Back, one label per bottle.
 */
export type ReadLabelsRequest = { crops: PhotoData[]; components: LabelTarget[]; views?: number[] };
/** A photo of the kit and what its packaging is ("bag"); back, where SAM found it, when big enough (null: not found). */
export type FindPackagingRequest = { photo: PhotoData; what: string };
export type KitPackaging = { box: Box | null };
/** Which side of a picture a bottle's cap points to. */
export type CapSide = 'up' | 'down' | 'left' | 'right';
/** A bottle's crop, as photographed; back, which way its cap points (null: Muse Spark could not tell). */
export type BottleCapRequest = { photo: PhotoData };
export type BottleCap = { cap: CapSide | null };
/** A bottle's crop, turned upright; back, Muse Image's picture of the same bottle whole, in the same frame. */
export type WholeBottleRequest = { photo: PhotoData };
export type WholeBottle = { photo: PhotoData };

export interface KitVision {
  recognizeKit(photo: Photo): Promise<RecognizedKit>;
  segmentBottles(photo: Photo, points?: Point[], index?: number, boxes?: Box[]): Promise<SegmentedBottles>;
  /** Where the kit's packaging is on `photo`, by SAM 3.1, asked for `what` Muse Spark said it is ("box", "bag"). */
  findPackaging(photo: Photo, what: string): Promise<KitPackaging>;
  /**
   * The bottles in a video, each once, by SAM 3.1 following them from frame to frame (a sweep, a video chosen); with
   * `live`, each frame as SAM is done with it.
   */
  trackBottles?(video: Video, live?: TrackLive): Promise<TrackedBottles>;
  readLabels(crops: Photo[], components: LabelTarget[], views?: number[]): Promise<ReadLabels>;
  /**
   * The bottle in the middle of `photo` (a crop, upright), drawn whole by Muse Image: what a hand, a box or the photo's
   * edge hid, filled in, on a plain background. The phone lays its own photo over it (bench/whole.ts).
   */
  wholeBottle?(photo: Photo): Promise<Photo>;
  /**
   * Which way the cap of the bottle in the middle of `photo` points, by Muse Spark: its shape cannot say (a vial's cap
   * is often wider than its rounded foot), its cap and label can. Null when it cannot tell.
   */
  capSide?(photo: Photo): Promise<CapSide | null>;
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
