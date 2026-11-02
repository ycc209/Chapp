import { z } from 'zod';
import { comparable, knownUnits, normalizeUnit, toMicroliters } from './units.ts';

/**
 * Chapp protocol format, version 1 (`chapp.protocol/1`): one JSON document per kit protocol.
 *
 * Everything the app shows at the bench (amounts, dilution tables, timers) is read from this
 * document. Numbers that depend on the user's run (working reagent for N samples, a plate layout)
 * are computed by shared/calc.ts, never written by a model. Every fact carries a citation into the
 * source document, so the app can show where it came from and anyone can check it.
 */

const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower-case words joined by hyphens');

/**
 * A unit as the manual prints it ("µL", "500 nL"'s "nL", "ng/mL", "µM", "%", "U/mL"), tidied for display (u and the
 * Greek mu become µ, "ml" becomes "mL"). The app converts only where it computes, through shared/units.ts.
 */
const Unit = z.string().trim().min(1).max(24).transform(normalizeUnit);

export const Volume = z.object({ value: z.number().nonnegative(), unit: Unit });
export const Concentration = z.object({ value: z.number().nonnegative(), unit: Unit });
export const Duration = z.object({ value: z.number().positive(), unit: z.enum(['s', 'min', 'h']) });
/** One temperature (`value`) or a range (`value` to `max`). */
export const Temperature = z.object({ value: z.number(), max: z.number().optional(), unit: z.literal('°C') });
export const Wavelength = z.object({ value: z.number().positive(), max: z.number().positive().optional(), unit: z.literal('nm') });
export const Range = z.object({ min: z.number().nonnegative(), max: z.number().positive(), unit: Unit });

/** Where a fact comes from: a page, plus a verbatim quote or the name of a table or figure on it. */
export const Cite = z
  .object({
    page: z.number().int().positive(),
    quote: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    figure: z.string().min(1).optional(),
  })
  .refine(c => c.quote || c.table || c.figure, 'a citation needs a quote, a table or a figure');

/**
 * A short line shown next to a step. `text` is Chapp's own wording; `cite` points at the original. `expected` is what
 * the user should see or get when it works ("the solution turns blue", "lipid droplets by day 7–10"): never a step of
 * its own, it goes with the step whose result it is.
 */
export const Note = z.object({
  kind: z.enum(['expected', 'tip', 'caution', 'info']),
  text: z.string().min(1),
  cite: Cite,
});

export const Source = z.object({
  title: z.string(),
  publisher: z.string(),
  docId: z.string(),
  revision: z.string(),
  date: z.string(),
  /** The vendor's URL, or for a manual the user uploaded, the path Chapp serves its copy at. */
  url: z.union([z.url(), z.string().regex(/^\/api\/protocols\/[a-z0-9-]+\/manual\.pdf$/)]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pages: z.number().int().positive(),
  fetchedAt: z.string(),
});

export const KitVariant = z.object({
  catalog: z.string(),
  scale: z.string(),
  /** `amount` is left out when the source gives none ("1 vial"). */
  contents: z.array(z.object({ component: Id, count: z.number().int().positive().optional(), amount: Volume.optional() })).min(1),
});

export const Kit = z.object({ name: z.string(), vendor: z.string(), variants: z.array(KitVariant).min(1), cite: Cite });

export const Component = z.object({
  id: Id,
  name: z.string(),
  role: z.enum(['reagent', 'standard', 'diluent']),
  suppliedBy: z.enum(['kit', 'user']),
  concentration: Concentration.optional(),
  storage: Temperature.optional(),
  /** Words expected on the bottle's label, used when matching kit photos to components. */
  label: z.array(z.string()).optional(),
  /** Set by kit recognition: the user's own photo of this bottle. */
  photo: z.string().optional(),
  notes: z.array(Note).optional(),
  cite: Cite,
});

export const Equipment = z.object({ id: Id, name: z.string(), icon: Id, setting: z.string().optional(), cite: Cite });

export const Mix = z.object({
  id: Id,
  name: z.string(),
  short: z.string(),
  /** Each part's share, and the amount as the manual prints it ("44 µL", "1 mL", "50 parts") when it gives one. */
  parts: z.array(z.object({ component: Id, parts: z.number().positive(), amount: z.string().max(40).optional() })).min(2),
  notes: z.array(Note),
  cite: Cite,
});

/** One vial of a dilution series: `take` of `from` ('stock', an earlier vial, or null for the blank) plus `diluent`. */
export const StandardPoint = z.object({
  /** The vial's label as the manual prints it: a letter (BCA's A–I) or a short name ("Std1"). */
  id: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
  diluent: Volume,
  from: z.string().nullable(),
  take: Volume,
  concentration: Concentration,
  blank: z.boolean().optional(),
  /** A working dilution later vials draw from ("dilute the stock to 1 mM"), not a standard that goes on the plate. */
  intermediate: z.boolean().optional(),
});

export const StandardCurve = z.object({
  id: Id,
  name: z.string(),
  stock: Id,
  diluent: Id,
  range: Range,
  points: z.array(StandardPoint).min(2),
  cite: Cite,
});

export const Addition = z
  .object({
    what: z.enum(['standards-and-samples', 'mix', 'component']),
    ref: Id.optional(),
    volume: Volume,
    per: z.enum(['well', 'tube']),
  })
  .refine(a => a.what === 'standards-and-samples' || a.ref, 'a mix or component addition needs ref');

export const Timer = z.object({
  label: z.string(),
  duration: Duration,
  temperature: Temperature.optional(),
  covered: z.boolean().optional(),
  alternatives: z
    .array(
      z.object({
        label: z.string(),
        duration: Duration,
        temperature: Temperature.optional(),
        range: Range.optional(),
        standardCurve: Id.optional(),
        cite: Cite,
      }),
    )
    .optional(),
});

/**
 * What a step does. An assay (BCA) runs standards → mix → load → incubate → read → analyze; other kits also prepare
 * (grow cells, reconstitute), treat (add or replace something on cells), wash and observe (look under a microscope).
 */
export const Stage = z.enum(['standards', 'prepare', 'mix', 'load', 'treat', 'incubate', 'wash', 'read', 'observe', 'analyze']);

export const Step = z.object({
  id: Id,
  stage: Stage,
  title: z.string(),
  /** The one line read at the bench, in Chapp's own words. */
  key: z.string(),
  /** The step walks through this dilution table, vial by vial. */
  standardCurve: Id.optional(),
  /** The step prepares this mix; amounts come from calc.ts. */
  mix: Id.optional(),
  add: z.array(Addition).optional(),
  timer: Timer.optional(),
  equipment: z.array(Id).optional(),
  notes: z.array(Note).optional(),
  cite: Cite,
});

/**
 * One way to run the kit. An assay (microplate or tube) reads samples against a standard curve with a mixed reagent and
 * has every field; a cell protocol (`cells`) has only its steps. `isAssay()` tells them apart.
 */
export const Procedure = z.object({
  id: Id,
  name: z.string(),
  format: z.enum(['microplate', 'tube', 'cells']),
  /** Sample : working reagent, as printed. */
  ratio: z.string().optional(),
  sample: Volume.optional(),
  mixPerSample: Volume.optional(),
  mix: Id.optional(),
  standardCurve: Id.optional(),
  range: Range.optional(),
  /**
   * Reagent prep: getting the kit's reagents ready before the experiment, as the manual's reagent preparation says
   * (reconstitute or dissolve a vial, warm or equilibrate, make a working buffer from a concentrate, spin the tubes).
   * Done ahead, often once per kit, so it is kept apart from `steps`, which are the experiment itself.
   */
  prep: z.array(Step).optional(),
  steps: z.array(Step).min(1),
  cite: Cite,
});

export const Analysis = z.object({
  readout: Wavelength,
  acceptable: Wavelength.optional(),
  fit: z.object({
    preferred: z.array(z.enum(['4pl', 'best-fit'])).min(1),
    byHand: z.enum(['point-to-point']).optional(),
    avoid: z.array(z.enum(['linear'])),
  }),
  notes: z.array(Note),
  cite: Cite,
});

export const Protocol = z.object({
  format: z.literal('chapp.protocol/1'),
  id: Id,
  title: z.string(),
  summary: z.string(),
  source: Source,
  kit: Kit,
  /**
   * The source's own at-a-glance summary of one procedure: what the user does (`steps`), and apart from them what it
   * says they will see or get (`expected`: "Visible lipid droplets 7–10 days after differentiation medium").
   */
  overview: z.object({ procedure: Id, steps: z.array(z.string()).min(1), expected: z.array(z.string()).optional(), cite: Cite }),
  components: z.array(Component).min(1),
  equipment: z.array(Equipment),
  mixes: z.array(Mix),
  standardCurves: z.array(StandardCurve),
  /**
   * Units the manual defines in its own words ("1 U = 0.5 µg of X"), as the model read them, each with why and its
   * page; the app converts with them (shared/units.ts knownUnits) and nothing else.
   */
  units: z.array(z.object({ unit: z.string().min(1), equals: z.object({ value: z.number().positive(), unit: Unit }), why: z.string(), cite: Cite })).default([]),
  procedures: z.array(Procedure).min(1),
  /** How the reading becomes a number; none for a kit with nothing to read (a cell protocol). */
  analysis: Analysis.optional(),
  /** The starting conditions; samples and replicates only when the source gives an example. */
  defaults: z.object({ procedure: Id, samples: z.number().int().positive().optional(), replicates: z.number().int().positive().optional(), cite: Cite.optional() }),
  notes: z.array(Note),
  /** Set when Chapp read the document from the vendor's manual itself (server/ai/import.ts), not by hand. */
  imported: z.object({ at: z.string(), model: z.string(), seconds: z.number().nonnegative(), problems: z.array(z.string()) }).optional(),
});

export type Volume = z.infer<typeof Volume>;
export type Concentration = z.infer<typeof Concentration>;
export type Cite = z.infer<typeof Cite>;
export type Note = z.infer<typeof Note>;
export type Component = z.infer<typeof Component>;
export type Mix = z.infer<typeof Mix>;
export type StandardCurve = z.infer<typeof StandardCurve>;
export type StandardPoint = z.infer<typeof StandardPoint>;
export type Step = z.infer<typeof Step>;
export type Procedure = z.infer<typeof Procedure>;
export type Analysis = z.infer<typeof Analysis>;
export type Protocol = z.infer<typeof Protocol>;

/** A protocol as Library lists it (GET /api/protocols): its card and what a search looks in. `updated` in ms. */
/** A protocol as Library lists it; `imported` ones were read from a manual by Chapp and can be deleted (DELETE /api/protocols/:id). */
export type ProtocolSummary = { id: string; title: string; kit: string; catalogs: string[]; procedure: string; steps: number; updated: number; imported?: boolean };

// The sample : reagent ratio is printed by some kits and not others (ATP's 50 µL + 50 µL): the volumes say it.
const ASSAY = ['sample', 'mixPerSample', 'mix', 'standardCurve', 'range'] as const;

/** A procedure read against a standard curve with a mixed reagent (BCA): everything Plan, the plate and Results need. */
export type AssayProcedure = Procedure & Required<Pick<Procedure, (typeof ASSAY)[number]>>;

export const isAssay = (proc: Procedure): proc is AssayProcedure => ASSAY.every(k => proc[k] !== undefined);

/** The procedure as an assay; throws for one that is not (a cell protocol has no standards, plate or reagent to plan). */
export function assayOf(proc: Procedure): AssayProcedure {
  if (!isAssay(proc)) throw new Error(`procedure "${proc.id}" has no standard curve and reagent to plan`);
  return proc;
}

/** The protocol's analysis; throws for a protocol with nothing to read. */
export function analysisOf(p: Protocol): Analysis {
  if (!p.analysis) throw new Error(`protocol "${p.id}" has no readout`);
  return p.analysis;
}

/** A take and a diluent on one scale (µL, or as printed when both have the same unit); null when they cannot be. */
function volumes(take: Volume, diluent: Volume): [number, number] | null {
  const t = toMicroliters(take), d = toMicroliters(diluent);
  if (t !== null && d !== null) return [t, d];
  if (take.unit === diluent.unit) return [take.value, diluent.value];
  // A zero needs no unit to be added up ("0" in a table).
  if (take.value === 0 || diluent.value === 0) return [take.value, diluent.value];
  return null;
}

/**
 * What the schema alone cannot check: every id points at something that exists, and each
 * dilution series adds up (source concentration × take ÷ (take + diluent) = stated concentration). A dilution in units
 * the app cannot put on one scale is not checked rather than reported: an unfamiliar unit is not a problem.
 * Returns one sentence per problem; an empty list means the document is consistent.
 */
export function problems(p: Protocol): string[] {
  const out: string[] = [];
  const ids = (list: { id: string }[]) => new Set(list.map(x => x.id));
  const components = ids(p.components), mixes = ids(p.mixes), curves = ids(p.standardCurves);
  const equipment = ids(p.equipment), procedures = ids(p.procedures);
  const need = (set: Set<string>, id: string | undefined, where: string) => {
    if (id && !set.has(id)) out.push(`${where} refers to unknown id "${id}"`);
  };

  for (const v of p.kit.variants) for (const c of v.contents) need(components, c.component, `kit ${v.catalog}`);
  for (const m of p.mixes) for (const part of m.parts) need(components, part.component, `mix ${m.id}`);
  need(procedures, p.overview.procedure, 'overview');
  need(procedures, p.defaults.procedure, 'defaults');

  for (const curve of p.standardCurves) {
    need(components, curve.stock, `curve ${curve.id} stock`);
    need(components, curve.diluent, `curve ${curve.id} diluent`);
    const stock = p.components.find(c => c.id === curve.stock)?.concentration;
    if (!stock) { out.push(`curve ${curve.id}: stock has no concentration`); continue; }
    const made = new Map<string, Concentration>();
    for (const point of curve.points) {
      const where = `curve ${curve.id} vial ${point.id}`;
      const { take, diluent, concentration: stated } = point;
      if (point.from === null) {
        if (!point.blank || take.value !== 0 || stated.value !== 0) out.push(`${where}: a vial without a source must be a blank with nothing taken`);
        made.set(point.id, stated);
        continue;
      }
      const source = point.from === 'stock' ? stock : made.get(point.from);
      if (source === undefined) { out.push(`${where}: source "${point.from}" is not the stock or an earlier vial`); continue; }
      made.set(point.id, stated);
      const v = volumes(take, diluent), c = comparable(source, stated, knownUnits(p.units ?? []));
      if (!v || !c || v[0] + v[1] <= 0) continue;
      const [t, d] = v, [from, want] = c;
      const expected = (from * t) / (t + d);
      if (Math.abs(expected - want) > Math.max(0.005 * want, 1e-9 * from, want === 0 ? 1e-12 : 0)) {
        const shown = want > 0 ? +(stated.value * (expected / want)).toPrecision(4) : +expected.toPrecision(4);
        out.push(`${where}: ${take.value} ${take.unit} of ${point.from} + ${diluent.value} ${diluent.unit} diluent gives ${shown} ${stated.unit}, not ${stated.value}`);
      }
    }
  }

  for (const proc of p.procedures) {
    const missing = ASSAY.filter(k => proc[k] === undefined);
    if (missing.length && missing.length < ASSAY.length) out.push(`procedure ${proc.id} is part assay: no ${missing.join(', ')}`);
    if (isAssay(proc) && !p.analysis) out.push(`procedure ${proc.id} is an assay but the protocol has no analysis`);
    need(mixes, proc.mix, `procedure ${proc.id}`);
    need(curves, proc.standardCurve, `procedure ${proc.id}`);
    for (const step of [...(proc.prep ?? []), ...proc.steps]) {
      const where = `step ${step.id}`;
      need(curves, step.standardCurve, where);
      need(mixes, step.mix, where);
      for (const e of step.equipment ?? []) need(equipment, e, where);
      for (const a of step.add ?? []) need(a.what === 'mix' ? mixes : components, a.ref, where);
      for (const alt of step.timer?.alternatives ?? []) need(curves, alt.standardCurve, `${where} timer`);
    }
  }
  return out;
}
