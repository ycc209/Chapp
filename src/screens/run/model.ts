import { toMicroliters } from '../../../shared/calc.ts';
import { analysisOf, type Protocol } from '../../../shared/protocol.ts';
import { parsePlateText, readingOf, type PlanFit } from '../../../shared/plate.ts';
import {
  benchSteps,
  durationText,
  lengthText,
  runSetup,
  temperatureText,
  vialSay,
  type BenchStep,
  type PlatePlan,
  type ReagentPlan,
  type Series,
  type StandardVial,
} from '../../components/lab/model.ts';
import type { RunState } from '../../state/run.ts';

/**
 * The run screen's numbers and words, worked out from the protocol and the plan: pure functions, so the screen, the
 * voice and the tests agree. Nothing here is typed in by hand; amounts, wells and times all come from the protocol
 * (data/protocols/*.json) through shared/calc.ts and the lab parts' model.
 */

export type RunPlan = Pick<RunState, 'procedure' | 'samples' | 'replicates' | 'standardReplicates' | 'standards'> & { edits?: RunState['edits'] };

/** One way to incubate: the protocol's own time first, then its documented alternatives ("2 h for more signal"). */
export type IncubationOption = { seconds: number; label: string; standard: boolean };

export type Incubation = {
  /** The step's id, which is also its timer's key in useRun().timers. */
  id: string;
  /** "37 °C", when the protocol gives one. */
  temperature: string | null;
  covered: boolean;
  options: IncubationOption[];
};

export type Bench = {
  steps: BenchStep[];
  series: Series;
  /** The standards are already made (Plan-Ask's "Already made"): nothing to dilute. */
  ready: boolean;
  plate: PlatePlan;
  reagent: ReagentPlan;
  /** µL of each standard or sample per well. */
  load: number;
  /** The reagent step: µL per well, and the shake after it ("30 s"; null when the protocol has none). */
  add: { volume: number; shake: string | null };
  incubation: Incubation | null;
  readout: { value: number; unit: string };
};

const SECONDS = { s: 1, min: 60, h: 3600 } as const;
export const durationSeconds = (d: { value: number; unit: 's' | 'min' | 'h' }) => d.value * SECONDS[d.unit];

/**
 * Everything the six steps show, for this protocol and plan. The standards, the plate and the working reagent are
 * exactly what Plan drew (runSetup): the kit's table sized for the plate, halved from the top of the kit's range ("8
 * vials", or "five standards"), or the kit's table already made (nothing to dilute).
 */
export function benchFor(p: Protocol, plan: RunPlan): Bench {
  const steps = benchSteps(p, plan.procedure);
  const { series, plate, reagent } = runSetup(p, plan);
  const adds = steps.flatMap(s => s.step.add ?? []);
  const load = adds.find(a => a.what === 'standards-and-samples');
  const mixAdd = adds.find(a => a.what === 'mix');
  const addStep = steps.find(s => s.step.add?.some(a => a.what === 'mix'));
  const inc = steps.find(s => s.stage === 'incubate' && s.step.timer);
  const timer = inc?.step.timer;
  return {
    steps,
    series,
    ready: plan.standards === 'ready',
    plate,
    reagent,
    load: load ? toMicroliters(load.volume) : 0,
    add: { volume: mixAdd ? toMicroliters(mixAdd.volume) : reagent.perWell, shake: addStep?.step.timer ? durationText(addStep.step.timer.duration) : null },
    incubation:
      inc && timer
        ? {
            id: inc.id,
            temperature: timer.temperature ? temperatureText(timer.temperature) : null,
            covered: timer.covered ?? false,
            options: [
              { seconds: durationSeconds(timer.duration), label: lengthText(durationSeconds(timer.duration)), standard: true },
              ...(timer.alternatives ?? []).map(a => ({ seconds: durationSeconds(a.duration), label: lengthText(durationSeconds(a.duration)), standard: false })),
            ],
          }
        : null,
    readout: analysisOf(p).readout,
  };
}

/** "/run/3" → 2, "/run/all" → 'all'; anything else is the first step. */
export function stepFromParam(param: string | undefined, total: number): number | 'all' {
  if (param === 'all') return 'all';
  const n = Math.floor(Number(param));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, total) - 1 : 0;
}

// ─── Standards ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ticks a vial the way Run-Standards does: ticking one ticks every vial before it too (catching up), unticking one
 * unticks it and every vial after it. Returns the new tick for every vial.
 */
export function tickUpTo(vials: readonly { id: string }[], done: Record<string, boolean>, id: string, on: boolean): Record<string, boolean> {
  const at = vials.findIndex(v => v.id === id);
  return Object.fromEntries(vials.map((v, j) => [v.id, on ? j <= at || !!done[v.id] : j < at && !!done[v.id]]));
}

/** What Chapp says about the standards: how many are made and the next one, the last one (the blank), or all made. */
export type StandardsLine =
  | { kind: 'next' | 'last'; done: number; total: number; vial: StandardVial; say: [string, string] }
  | { kind: 'all'; total: number };

export function standardsLine(vials: readonly StandardVial[], done: Record<string, boolean>): StandardsLine {
  const at = vials.findIndex(v => !done[v.id]);
  if (at < 0) return { kind: 'all', total: vials.length };
  const vial = vials[at]!;
  return { kind: at === vials.length - 1 ? 'last' : 'next', done: vials.filter(v => done[v.id]).length, total: vials.length, vial, say: vialSay(vial) };
}

/** The same, as one plain sentence to read aloud. */
export function standardsText(line: StandardsLine, next: string | undefined): string {
  if (line.kind === 'all') return `All ${line.total} standards are ready.${next ? ` Next, ${next.toLowerCase()}.` : ''}`;
  if (line.kind === 'last') return `Last one, ${line.vial.id}: ${line.say[0]}, ${line.say[1]}.${line.vial.blank ? ' That’s the blank.' : ''}`;
  return `${line.done} of ${line.total} done. Next is ${line.vial.id}: ${line.say[0]} and ${line.say[1]}.`;
}

// ─── Loading the plate ───────────────────────────────────────────────────────────────────────────────────────────

/** A tube on the plate is ticked in useRun().done under this key, beside the vials (A–I) and the steps. */
export const tubeKey = (index: number) => `tube:${index}`;

/** The tube going in now: the first one not loaded; past the last when all are in. */
export const currentTube = (plate: PlatePlan, done: Record<string, boolean>) => {
  const at = plate.tubes.findIndex(t => !done[tubeKey(t.index)]);
  return at < 0 ? plate.tubes.length : at;
};

/** Tubes loaded so far, counted up to the one going in now (Run-List: "9 of 21 tubes"). */
export const tubesLoaded = (plate: PlatePlan, done: Record<string, boolean>) => currentTube(plate, done);

/** A vial to make again, and every vial made from it (a dilution of it, or of one of those): all made again. */
export function redoVials(vials: readonly StandardVial[], id: string): string[] {
  const again = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of vials)
      if (v.from && again.has(v.from) && !again.has(v.id)) {
        again.add(v.id);
        grew = true;
      }
  }
  return vials.filter(v => again.has(v.id)).map(v => v.id);
}

/** Loads tubes up to `index` (moving on), or takes `index` and those after it back off (going back to it). */
export function loadUpTo(plate: PlatePlan, done: Record<string, boolean>, index: number, on: boolean): Record<string, boolean> {
  return Object.fromEntries(plate.tubes.map(t => [tubeKey(t.index), on ? t.index <= index || !!done[tubeKey(t.index)] : t.index < index && !!done[tubeKey(t.index)]]));
}

/** "Tube 10 of 21. Sample 1 into B3 and B4, 25 µL in each." for reading aloud. */
export function tubeText(plate: PlatePlan, index: number, load: number): string {
  const t = plate.tubes[index];
  if (!t) return `All ${plate.wells} wells are loaded.`;
  return `Tube ${index + 1} of ${plate.tubes.length}. ${t.name} into ${listText(t.wells)}, ${load} µL in each.`;
}

/** "B3", "B3 and B4", "B3, B4 and B5". */
export function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// ─── The incubation timer ────────────────────────────────────────────────────────────────────────────────────────

/** Where the incubation stands: not started (choose a length), running, stopped part-way, or finished. */
export type TimerPhase = 'choose' | 'running' | 'stopped' | 'done';

export function timerPhase(endsAt: number | undefined, paused: number | undefined, now: number): TimerPhase {
  if (endsAt !== undefined) return endsAt <= now ? 'done' : 'running';
  return paused !== undefined && paused > 0 ? 'stopped' : 'choose';
}

// ─── What the user says at the bench ─────────────────────────────────────────────────────────────────────────────

/**
 * The run's own words, matched on the phone before anything goes to the server: the timer, the incubation length,
 * the photo of the reader, the sample export, yes or no, and "done" for a step with nothing to count; several vials
 * or tubes at once ("A B C D OK", "A 到 D 好了", "1 to 5 done"), one to do again ("redo B", "B 重做"), and a well that
 * went wrong ("B3 has a bubble, use H1", "B3 壞了，改到 H1"). The whole utterance has to be the command, as in
 * src/voice/commands.ts; "next", "back" and "C is OK" are matched there.
 */
export type RunCommand =
  | { type: 'timer'; what: 'start' | 'stop' | 'resume' }
  | { type: 'length'; seconds: number }
  | { type: 'photo' }
  | { type: 'sample' }
  | { type: 'answer'; yes: boolean }
  | { type: 'advance' }
  | { type: 'results' }
  /** Vials or tubes done, by ref ("A", "3"), as said. */
  | { type: 'done'; refs: string[] }
  /** Vials or tubes to do again. */
  | { type: 'redo'; refs: string[] }
  /** Wells that went wrong, and the well the user named for their contents (null: Chapp picks the next free one). */
  | { type: 'badWell'; wells: string[]; to: string | null };

const WELL = /\b([A-H](?:1[0-2]|[1-9]))\b/gi;
const DONE_END = /\s*(?:ok|okay|done|finished|ready|loaded|good|in|all set|好了|好|做好了|做好|完成了?|弄好了|加好了|加完了|都好了|ok了)[\s。.!！]*$/i;
const REDO = /\b(?:redo|re-do|remake|again|do (?:it|them) again|broke|broken|spilled|bad)\b|重做|重來|重新做|再做一次|再做|壞了|壞掉了|灑了|弄翻了|打翻了/i;
const BAD_WELL = /\b(?:bad|bubbles?|spill(?:ed)?|wrong|broke|contaminated|empty|missed)\b|壞|氣泡|灑|錯了|污染|漏|空的|沒加到/i;
const TO_WELL = /(?:改到|換到|移到|放到|改放|換成|改成|改用|用|\bmove (?:it |them )?to|\buse|\binstead|\bput (?:it |them )?in(?:to)?|\binto)\s*([A-H](?:1[0-2]|[1-9]))\b/i;

/**
 * The vials or tubes named in a few words: "A B C D", "ABCD", "A to D", "A 到 D", "1–5", "3 和 5" → their refs in the
 * order said, upper-case, ranges filled in. Null when anything else is in the words (left to Chapp to understand).
 */
export function refsSaid(words: string): string[] | null {
  const t = words
    .toUpperCase()
    .replace(/\s*(?:到|至|~|～|－|–|—|-|\bTO\b|\bTHROUGH\b|\bTHRU\b)\s*/g, '>')
    .replace(/\b(?:VIALS?|STANDARDS?|SAMPLES?|TUBES?|AND|ARE|IS|THE|ALSO|BOTH|ALL)\b|標準品|樣本|管|和|跟|還有|都|也|、|，|,|&|\+/g, ' ')
    .trim();
  if (!t) return null;
  const refs: string[] = [];
  const LETTERS = 'ABCDEFGHIJKLMNOP';
  for (const token of t.split(/\s+/)) {
    const range = /^([A-P]|\d{1,2})>([A-P]|\d{1,2})$/.exec(token);
    if (range) {
      const [a, b] = [range[1]!, range[2]!];
      if (/\d/.test(a) !== /\d/.test(b)) return null;
      const [from, to] = /\d/.test(a) ? [Number(a), Number(b)] : [LETTERS.indexOf(a), LETTERS.indexOf(b)];
      if (to < from || to - from > 24) return null;
      for (let i = from; i <= to; i++) refs.push(/\d/.test(a) ? String(i) : LETTERS[i]!);
    } else if (/^[A-P]+$/.test(token) && token.length <= 16) refs.push(...token);
    else if (/^\d{1,2}$/.test(token)) refs.push(String(Number(token)));
    else return null;
  }
  return refs.length ? [...new Set(refs)] : null;
}

/** Several vials or tubes done, one to do again, or a well gone wrong: the bench's own words for its items. */
function itemsCommand(text: string): RunCommand | null {
  const wells = [...text.matchAll(WELL)].map(m => m[1]!.toUpperCase());
  if (wells.length && BAD_WELL.test(text)) {
    const to = TO_WELL.exec(text)?.[1]?.toUpperCase() ?? null;
    const from = wells.filter(w => w !== to);
    return from.length ? { type: 'badWell', wells: [...new Set(from)], to } : null;
  }
  if (wells.length) return null;
  const redo = REDO.exec(text);
  if (redo) {
    const refs = refsSaid(text.replace(REDO, ' ').replace(/[。.!！]/g, ' '));
    return refs ? { type: 'redo', refs } : null;
  }
  const done = DONE_END.exec(text);
  if (done && done.index > 0) {
    const refs = refsSaid(text.slice(0, done.index));
    // One vial alone ("C is OK") stays src/voice/commands.ts's, which catches the vials before it up too.
    return refs && refs.length > 1 ? { type: 'done', refs } : null;
  }
  return null;
}

export function runCommand(text: string): RunCommand | null {
  if (/[?？]\s*$/.test(text)) return null;
  const items = itemsCommand(text.trim());
  if (items) return items;
  const said = strip(normalize(text));
  if (!said) return null;
  if (/^(?:start|go|begin|start it|start (?:the )?(?:timer|clock)|start timing|(?:the )?plate(?:'s| is) in|it's in)$/.test(said)) return { type: 'timer', what: 'start' };
  if (/^(?:stop|pause|stop it|pause it|(?:stop|pause) (?:the )?(?:timer|clock))$/.test(said)) return { type: 'timer', what: 'stop' };
  if (/^(?:resume|continue|resume it|resume (?:the )?(?:timer|clock)|start (?:it )?again|put it back)$/.test(said)) return { type: 'timer', what: 'resume' };
  const length = said.match(/^(?:make it |do |use |let's do |incubate (?:for )?|for )?(\S+(?: \S+)?) (minutes?|mins?|hours?|hrs?|h)$/);
  if (length) {
    const n = number(length[1]!);
    if (n !== null) return { type: 'length', seconds: n * (/^h/.test(length[2]!) ? 3600 : 60) };
  }
  if (/^(?:half an hour|(?:make it |do )?half an hour)$/.test(said)) return { type: 'length', seconds: 1800 };
  if (/^(?:photo|picture|camera|take (?:a|the) (?:photo|picture)|take it|show you|here it is|look at this|read (?:it|this|the plate)|scan (?:it|the plate))$/.test(said)) return { type: 'photo' };
  if (/\b(?:sample|example) (?:data|export|readings?|plate|values)\b|^use (?:the )?sample$/.test(said)) return { type: 'sample' };
  if (/^(?:results|(?:show|see) (?:me )?(?:the )?results|analy[sz]e(?: it)?)$/.test(said)) return { type: 'results' };
  if (/^(?:yes|yeah|yep|yup|sure|do it|confirm|ok|yes stop|stop it yes)$/.test(said)) return { type: 'answer', yes: true };
  if (/^(?:no|nope|cancel|keep going|never mind|don't)$/.test(said)) return { type: 'answer', yes: false };
  if (/^(?:done|all done|mixed|it's mixed|covered|it's covered|loaded|it's loaded|finished|got it|it's green)$/.test(said)) return { type: 'advance' };
  return null;
}

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\bokay\b/g, 'ok')
    .replace(/\s+/g, ' ')
    .trim();
}

function strip(said: string) {
  let out = said;
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(/^(?:ok|alright|all right|so|and|now|then|um|uh|hey chapp|chapp|please)\s+/, '').replace(/\s+(?:please|thanks|thank you|now|chapp)$/, '');
  }
  return out;
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, sixty: 60, ninety: 90 };
const number = (w: string): number | null => (/^\d+(?:\.\d+)?$/.test(w) ? Number(w) : (WORDS[w] ?? null));

// ─── Reading the plate ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Readings from a plate reader's text export (CSV, TSV, TXT or a pasted grid), by well id: shared/plate.ts's parser,
 * which reads the grid and well-list layouts with the readers' metadata around them. Null when the file has no plate.
 */
export function parsePlateExport(text: string, rows = 8, cols = 12): Record<string, number> | null {
  return parsePlateText(text, { rows, cols })?.values ?? null;
}

/**
 * Readings waiting on Run-Read for the user's look before Results uses them: read by a model (a photo, an odd file),
 * or from a file that leaves some of the plan's wells without a number. Kept for every well read, so the check
 * follows the plan if it changes; fitToPlan() picks the plan's wells.
 */
export type PlateCheck = {
  /** Where the numbers came from: a file read exactly, or a model's reading of a photo or an odd file. */
  by: 'file' | 'model';
  /** The file's name, or null for a photo. */
  name: string | null;
  /** Every well read, by id. */
  values: Record<string, number>;
  /** Wells whose cell held text instead of a number ("OVRFLW"). */
  odd: Record<string, string>;
  /** Wells the model was not sure of. */
  unsure: string[];
  /** One short line about what was read ("Results · 562"), or null. */
  note: string | null;
};

/** A file read as it is: every well of the plan has a number, and no model came in between. Results can take it. */
export const checkIsClean = (c: PlateCheck, fit: PlanFit) => c.by === 'file' && !fit.missing.length && !Object.keys(fit.odd).length;

/** "All 42 wells are readable." / "40 of 42 wells are readable." (Gloves-Photo). */
export function readableText(fit: PlanFit): string {
  const got = Object.keys(fit.readings).length;
  const total = got + fit.missing.length + Object.keys(fit.odd).length;
  return got === total ? `All ${total} wells are readable.` : `${got} of ${total} wells are readable.`;
}

/** The plan's wells that need a look: no number, text instead of one, or a digit the model was not sure of. */
export function needsLook(c: PlateCheck, fit: PlanFit): Set<string> {
  return new Set([...fit.missing, ...Object.keys(fit.odd), ...c.unsure.filter(w => w in fit.readings)]);
}

/** A well typed in by hand: its number (null clears it). It is then neither odd nor in doubt. */
export function editCheck(c: PlateCheck, well: string, value: number | null): PlateCheck {
  const values = { ...c.values };
  if (value === null) delete values[well];
  else values[well] = value;
  const odd = Object.fromEntries(Object.entries(c.odd).filter(([w]) => w !== well));
  return { ...c, values, odd, unsure: c.unsure.filter(w => w !== well) };
}

/** What the user typed into a well: "0.523", "0,523", ".523"; null when it is not a reading. */
export function typedReading(text: string): number | null {
  return readingOf(text.trim(), true);
}

// ─── Reading aloud ───────────────────────────────────────────────────────────────────────────────────────────────

/** Units written out, so the browser's voice reads "70 microliters", not "70 mu L". */
export function spoken(text: string): string {
  return text
    .replace(/µg\/mL/g, 'micrograms per milliliter')
    .replace(/(\d)\s*µL/g, '$1 microliters')
    .replace(/(\d)\s*mL/g, '$1 milliliters')
    .replace(/(\d)\s*°C/g, '$1 degrees')
    .replace(/(\d)\s*nm\b/g, '$1 nanometers')
    .replace(/(\d+)\s*min\b/g, (_, n: string) => `${n} minute${n === '1' ? '' : 's'}`)
    .replace(/(\d+(?:\.\d+)?)\s*h\b/g, (_, n: string) => `${n} hour${n === '1' ? '' : 's'}`)
    .replace(/(\d+)\s*s\b/g, '$1 seconds')
    .replace(/\s*·\s*/g, ', ')
    .replace(/\s*→\s*/g, ' into ');
}
