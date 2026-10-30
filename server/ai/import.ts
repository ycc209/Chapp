import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportedProtocol, ProtocolIntro, Source } from '../../shared/ai.ts';
import { Protocol, Stage, problems as checkProblems, type Cite, type Note } from '../../shared/protocol.ts';
import { UpstreamError } from './provider.ts';
import { costOf, inputCost, meter, outputCost, usageLine } from './usage.ts';
import { convert, normalizeUnit, toMicroliters, unitKind } from '../../shared/units.ts';

/**
 * Reading a kit manual (PDF) into Chapp's protocol format (chapp.protocol/1, shared/protocol.ts) with Muse Spark.
 *
 * Strict json_schema is reliable only with flat objects whose fields are all required (see replyFormat in meta.ts),
 * so the model fills a flat, relational wire format: lists of rows that point at each other by id, unused fields ""
 * or 0, amounts, temperatures and citations as short text ("25 uL", "15-30", "p3: Cover the plate"). Writing is most
 * of a call's time, so the wire asks for as little as the protocol needs. Two reads run side by side:
 *
 * - the intro, on the PDF: what the kit is, the manual's at-a-glance lines, its main steps as printed and the kit's
 *   contents, so the Overview shows them within seconds (onIntro) while the rest is read;
 * - the deep read, on the manual's text: the inventory first (the document, the kit, its bottles, equipment, mixes,
 *   dilution tables and procedures, everything later rows point at), then three at once given its ids: the steps,
 *   the dilution tables' vials, and the notes.
 *
 * The rows are assembled here and checked with zod and problems(); a row that does not fit is dropped and reported,
 * never guessed. The intro's words become the protocol's title, summary and overview, so what the Overview said first
 * stays. Nothing here logs the key or the manual's words: only timings.
 */

export const IMPORT_MODEL = 'muse-spark-1.3';

/**
 * How hard each call thinks (minimal, low, medium, high…). Measured on the BCA manual on 2026-10-28 against the
 * hand-made protocol's 49 checks. Once units went over the wire as ASCII (toWire below), minimal stopped slipping
 * µ into m, and every call but the steps holds at minimal. The steps need low: at minimal 1 run in 5 took the 30 s
 * shake for the 37 °C incubation; at low 4 of 4 runs kept 47–48/49, the whole read in about 30 s (medium: 73–120 s,
 * also 48/49). More thinking did not help: high 46/49 in 96 s, xhigh 47/49 in 189 s, max 46/49 in 215 s.
 */
export const EFFORTS: Record<CallName, string> = { intro: 'minimal', inventory: 'minimal', steps: 'low', curves: 'minimal', notes: 'minimal' };

/**
 * The calls that read the manual as text (pdftotext, a third of the PDF's tokens, about twice as fast). The intro keeps
 * the PDF, so a summary drawn as a picture (Bradford's at-a-glance figure) still comes through.
 */
export const TEXT_CALLS: readonly CallName[] = ['inventory', 'steps', 'curves', 'notes'];

/** The largest manual Chapp reads (a vendor user guide is well under 5 MB). */
export const MAX_PDF = 20 * 1024 * 1024;

export type ImportOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Milliseconds per model call. */
  timeoutMs?: number;
  /** How hard Muse Spark thinks, per call (EFFORTS when not given). */
  efforts?: Partial<Record<CallName, string>>;
  /**
   * The calls that get the manual's text (pdftotext, page by page) instead of the PDF itself (TEXT_CALLS when not
   * given); every call gets the PDF when the text cannot be extracted (no pdftotext, or a scanned manual).
   */
  asText?: readonly CallName[];
  /** How the text is extracted (manualText); tests inject their own. */
  textOf?: (pdf: Uint8Array) => string | null;
  /** Hears what the kit is as soon as the intro is read, long before the protocol is. */
  onIntro?: (intro: ProtocolIntro) => void;
  /** Called with each call's raw reply, for keeping fixtures (scripts/import-protocol.ts). */
  record?: (call: CallName, reply: Json, seconds: number) => void;
  /** One line per stage, for a progress display. */
  onProgress?: (line: string) => void;
  now?: () => Date;
};

type Json = Record<string, any>;
export type CallName = 'intro' | 'inventory' | 'steps' | 'curves' | 'notes';

// ─── The wire format ─────────────────────────────────────────────────────────────────────────────────────────────

/** A field's kind: text, a number, yes/no, a list of text, one of a set (the first is the fallback), or several. */
type Kind = 'string' | 'integer' | 'number' | 'boolean' | 'strings' | readonly [string, ...string[]] | { many: readonly string[] };
type RowSpec = Record<string, Kind>;
export type Spec = Record<string, Kind | { rows: RowSpec }>;

type ValueOf<K> = K extends 'string' ? string
  : K extends 'integer' | 'number' ? number
  : K extends 'boolean' ? boolean
  : K extends 'strings' ? string[]
  : K extends readonly (infer E)[] ? E
  : K extends { many: readonly (infer E)[] } ? E[]
  : never;
type RowOf<R extends RowSpec> = { -readonly [k in keyof R]: ValueOf<R[k]> };
export type WireOf<S extends Spec> = { -readonly [k in keyof S]: S[k] extends { rows: infer R extends RowSpec } ? RowOf<R>[] : ValueOf<S[k]> };

const isRows = (k: Kind | { rows: RowSpec }): k is { rows: RowSpec } => typeof k === 'object' && 'rows' in k;

/**
 * Units go over the wire in plain ASCII ("uL", "ug/mL") and come back as µ. With the micro sign (U+00B5) in the enum,
 * Muse Spark at low effort often wrote "mL" for 25 µL and "mg/mL" for µg/mL (8 of 13 BCA runs on 2026-10-28): it
 * reaches for the Greek mu (U+03BC), which the strict enum doesn't allow, and the nearest choice left is m.
 */
const toWire = (option: string) => option.replace(/^µ/, 'u');
const fromWire = (value: string) => value.replace(/^[uμ](?=(?:L|g\/mL)$)/, 'µ');

function kindSchema(k: Kind): Json {
  if (k === 'strings') return { type: 'array', items: { type: 'string' } };
  if (typeof k === 'string') return { type: k };
  if ('many' in k) return { type: 'array', items: { type: 'string', enum: [...k.many] } };
  return { type: 'string', enum: k.map(toWire) };
}

function objectSchema(spec: Record<string, Kind | { rows: RowSpec }>): Json {
  const properties: Json = {};
  for (const [key, k] of Object.entries(spec)) properties[key] = isRows(k) ? { type: 'array', items: objectSchema(k.rows) } : kindSchema(k);
  return { type: 'object', additionalProperties: false, required: Object.keys(spec), properties };
}

/** The strict json_schema text format for one call. */
export const formatOf = (name: string, spec: Spec) => ({ type: 'json_schema', name, schema: objectSchema(spec), strict: true });

function readKind(k: Kind, v: unknown): unknown {
  if (k === 'string') return typeof v === 'string' ? v.trim() : '';
  if (k === 'integer') return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  if (k === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  if (k === 'boolean') return v === true;
  if (k === 'strings') return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [];
  if ('many' in k) return Array.isArray(v) ? [...new Set(v.filter(x => k.many.includes(x)))] : [];
  const value = typeof v === 'string' ? fromWire(v) : v;
  return typeof value === 'string' && k.includes(value) ? value : k[0];
}

/** A reply read against its spec: every field there, of its kind, whatever the model sent. */
export function readWire<S extends Spec>(spec: S, value: unknown): WireOf<S> {
  const src = value && typeof value === 'object' ? (value as Json) : {};
  const out: Json = {};
  for (const [key, k] of Object.entries(spec)) {
    out[key] = isRows(k) ? (Array.isArray(src[key]) ? src[key].map((row: unknown) => readWire(k.rows, row)) : []) : readKind(k, src[key]);
  }
  return out as WireOf<S>;
}

/**
 * The wire is kept short, because writing is most of a call's time (300–430 tokens/s): every row that is cited has one
 * `cite` text ("p2 table: Table 1", "p3: Cover the plate and incubate"), amounts are text with their unit ("25 uL",
 * "2 x 500 mL", "20-2000 ug/mL", "30 min"), timers are rows of their own for the few steps that have one, and what the
 * app never shows is not asked for (an equipment row's citation: it is the first step that uses it). parseCite and
 * the parse* helpers below turn it back into the protocol's own shapes.
 */

const STAGES = ['prepare', ...Stage.options.filter(s => s !== 'prepare')] as unknown as readonly [string, ...string[]];
/** Equipment pictures Chapp can draw; anything else is "other". */
export const ICONS = [
  'other', 'pipette', 'well-plate-96', 'plate-shaker', 'incubator', 'plate-reader', 'test-tube', 'water-bath', 'spectrophotometer',
  'microscope', 'centrifuge', 'vortex', 'syringe-filter', 'culture-dish', 'biosafety-cabinet', 'heat-block', 'freezer',
] as const;

export const INVENTORY = {
  docTitle: 'string', publisher: 'string', docId: 'string', revision: 'string', date: 'string', pages: 'integer',
  kitName: 'string', vendor: 'string', kitCite: 'string',
  variants: { rows: { catalog: 'string', scale: 'string' } },
  contents: { rows: { catalog: 'string', component: 'string', amount: 'string' } },
  components: {
    rows: { id: 'string', name: 'string', role: ['reagent', 'standard', 'diluent'], suppliedBy: ['kit', 'user'], concentration: 'string', storage: 'string', labels: 'strings' },
  },
  equipment: { rows: { id: 'string', name: 'string', icon: ICONS, setting: 'string' } },
  mixes: { rows: { id: 'string', name: 'string', short: 'string', cite: 'string' } },
  mixParts: { rows: { mix: 'string', component: 'string', parts: 'number' } },
  curves: { rows: { id: 'string', name: 'string', stock: 'string', diluent: 'string', range: 'string', cite: 'string' } },
  procedures: {
    rows: { id: 'string', name: 'string', format: ['microplate', 'tube', 'cells'], ratio: 'string', sample: 'string', mixPerSample: 'string', mix: 'string', curve: 'string', range: 'string' },
  },
} as const satisfies Spec;

export const STEPS = {
  steps: {
    rows: { procedureId: 'string', stepId: 'string', before: 'boolean', stage: STAGES, title: 'string', key: 'string', makes: 'string', equipment: 'strings', cite: 'string' },
  },
  timers: { rows: { stepId: 'string', label: 'string', time: 'string', temperature: 'string', covered: 'boolean' } },
  additions: { rows: { stepId: 'string', what: ['standards-and-samples', 'mix', 'component'], ref: 'string', volume: 'string', per: ['well', 'tube'] } },
  alternatives: { rows: { stepId: 'string', label: 'string', time: 'string', temperature: 'string', range: 'string', curve: 'string', cite: 'string' } },
  notes: { rows: { stepId: 'string', kind: ['info', 'expected', 'tip', 'caution'], text: 'string', cite: 'string' } },
} as const satisfies Spec;

export const CURVES = {
  points: { rows: { curve: 'string', id: 'string', diluent: 'string', from: 'string', take: 'string', concentration: 'string', blank: 'boolean' } },
} as const satisfies Spec;

export const NOTES = {
  title: 'string', summary: 'string',
  overviewProcedure: 'string', overviewSteps: 'strings', overviewExpected: 'strings', overviewCite: 'string',
  hasAnalysis: 'boolean', readout: 'number', acceptableMin: 'number', acceptableMax: 'number',
  fitPreferred: { many: ['4pl', 'best-fit'] }, fitByHand: ['', 'point-to-point'], fitAvoid: { many: ['linear'] }, analysisCite: 'string',
  notes: { rows: { on: 'string', kind: ['info', 'expected', 'tip', 'caution'], text: 'string', cite: 'string' } },
  defaultsProcedure: 'string', defaultsSamples: 'integer', defaultsReplicates: 'integer', defaultsCite: 'string',
} as const satisfies Spec;

/** The intro: what the Overview's top needs, read fast. */
export const INTRO = {
  kitName: 'string', vendor: 'string', catalogs: 'strings', docTitle: 'string', publisher: 'string', docId: 'string', revision: 'string',
  title: 'string', summary: 'string', overviewSteps: 'strings', overviewExpected: 'strings', overviewCite: 'string',
  procedureName: 'string', steps: { rows: { text: 'string', page: 'integer' } }, otherProcedures: 'strings',
  contents: { rows: { name: 'string', amount: 'string' } },
} as const satisfies Spec;

/**
 * Replies recorded in an earlier wire format, as today's: a bare "id" and "procedure" on steps (now stepId and
 * procedureId), page/quote/table/figure (now one cite), number-and-unit pairs (now text, the dilution tables' too),
 * timer fields on every step (now timer rows), curve and mix on a step (now makes). Today's replies pass through
 * unchanged.
 */
export function renameLegacy(call: CallName, json: unknown): unknown {
  if (!json || typeof json !== 'object') return json;
  const j = json as Json;
  const rows = (list: unknown, fn: (r: Json) => Json) => (Array.isArray(list) ? list.map(r => (r && typeof r === 'object' ? fn(r as Json) : r)) : list);
  const cited = (r: Json, prefix = '') => {
    const key = prefix ? `${prefix}Cite` : 'cite';
    const field = (name: string) => r[prefix ? `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}` : name];
    if (key in r || field('page') === undefined) return r;
    return { ...r, [key]: citeText({ page: field('page') ?? 0, quote: field('quote') ?? '', table: field('table') ?? '', figure: field('figure') ?? '' }) };
  };
  const amount = (value: unknown, unit: unknown) => (typeof value === 'number' && value > 0 && unit ? `${value} ${unit}` : '');
  const span = (min: unknown, max: unknown, unit: unknown) => (typeof max === 'number' && max > 0 && unit ? `${min}-${max} ${unit}` : '');
  if (call === 'intro') return cited(j, 'overview');
  if (call === 'curves') {
    const text = (value: unknown, unit: unknown) => (typeof value === 'number' ? (unit ? `${value} ${unit}` : String(value)) : value);
    return {
      ...j,
      points: rows(j.points, r =>
        'diluentUnit' in r ? { ...r, diluent: text(r.diluent, r.diluentUnit), take: text(r.take, r.takeUnit), concentration: text(r.concentration, r.concentrationUnit) } : r),
    };
  }
  if (call === 'notes') return { ...cited(cited(cited(j, 'overview'), 'analysis'), 'defaults'), notes: rows(j.notes, r => cited(r)) };
  if (call === 'inventory') {
    if ('kitCite' in j) return j;
    return {
      ...cited(j, 'kit'),
      contents: rows(j.contents, r => ('count' in r ? { ...r, amount: [r.count > 1 ? `${r.count} x` : '', amount(r.amount, r.unit) || (r.count ? `${r.count} vial` : '')].filter(Boolean).join(' ') } : r)),
      components: rows(j.components, r => (typeof r.concentration === 'number' ? { ...r, concentration: amount(r.concentration, r.concentrationUnit) } : r)),
      mixes: rows(j.mixes, r => cited(r)),
      curves: rows(j.curves, r => ('rangeMax' in r ? { ...cited(r), range: span(r.rangeMin, r.rangeMax, r.rangeUnit) } : r)),
      procedures: rows(j.procedures, r =>
        'sampleUnit' in r ? { ...r, sample: amount(r.sample, r.sampleUnit), mixPerSample: amount(r.mixPerSample, r.mixPerSampleUnit), range: span(r.rangeMin, r.rangeMax, r.rangeUnit) } : r),
    };
  }
  if (call !== 'steps' || 'timers' in j) return j;
  const rename = (r: Json, from: string, to: string) => (from in r && !(to in r) ? { ...r, [to]: r[from] } : r);
  const steps = rows(j.steps, r => {
    const step = rename(rename(r, 'procedure', 'procedureId'), 'id', 'stepId');
    return { ...cited(step), makes: step.makes ?? (step.curve || step.mix || '') };
  }) as Json[];
  const time = (value: unknown, unit: unknown) => (typeof value === 'number' && value > 0 && unit ? `${value} ${unit}` : '');
  return {
    steps,
    timers: (Array.isArray(steps) ? steps : [])
      .filter(r => typeof r.timerDuration === 'number' && r.timerDuration > 0)
      .map(r => ({ stepId: r.stepId, label: r.timerLabel ?? '', time: time(r.timerDuration, r.timerUnit), temperature: r.timerTemperature ?? '', covered: r.covered === true })),
    additions: rows(j.additions, r => {
      const a = rename(r, 'step', 'stepId');
      return typeof a.volume === 'number' ? { ...a, volume: amount(a.volume, a.unit) } : a;
    }),
    alternatives: rows(j.alternatives, r => {
      const a = cited(rename(r, 'step', 'stepId'));
      return typeof a.duration === 'number' ? { ...a, time: time(a.duration, a.unit), range: span(a.rangeMin, a.rangeMax, a.rangeUnit) } : a;
    }),
    notes: rows(j.notes, r => cited(rename(r, 'step', 'stepId'))),
  };
}

// ─── Reading the wire's text back ────────────────────────────────────────────────────────────────────────────────

/** A citation's parts: the page, and the manual's words or the name of a table or figure on it. */
export type CiteParts = { page: number; quote: string; table: string; figure: string };

/** Its wire text: "p3: Cover the plate", "p2 table: Table 1", "p1 figure: Fig. 1 Procedure summary", or "". */
export function citeText(c: CiteParts): string {
  const page = c.page > 0 ? `p${c.page}` : 'p1';
  if (c.quote) return `${page}: ${c.quote}`;
  if (c.table) return `${page} table: ${c.table}`;
  if (c.figure) return `${page} figure: ${c.figure}`;
  return c.page > 0 ? page : '';
}

/** "p3: Cover the plate" → page 3 and its words; "p2 table: Table 1" → a table; "p1 figure: Fig. 1" → a figure. */
export function parseCite(text: string): CiteParts {
  const out: CiteParts = { page: 0, quote: '', table: '', figure: '' };
  const m = /^\s*(?:p(?:age)?\.?\s*(\d+))?\s*([\s\S]*?)\s*$/i.exec(text ?? '');
  if (!m) return out;
  out.page = m[1] ? Number(m[1]) : 0;
  const rest = m[2] ?? '';
  const named = /^(table|figure|fig\.?)\s*:\s*(.+)$/i.exec(rest);
  const strip = (words: string) => words.replace(/^["“]|["”]$/g, '');
  if (named) {
    if (/^table/i.test(named[1]!)) out.table = named[2]!;
    else out.figure = named[2]!;
  } else if (/^(?:table|fig\.?|figure)\s+\S/i.test(rest) && rest.split(/\s+/).length <= 8) {
    // "p2 Table 1": a table or figure named without the colon.
    if (/^table/i.test(rest)) out.table = rest;
    else out.figure = rest;
  } else {
    const quote = strip(rest.replace(/^[:,–-]\s*/, ''));
    if (quote) out.quote = quote;
  }
  return out;
}

const number = (text: string) => Number(text.replace(/,(?=\d{3}\b)/g, ''));
/** An amount as printed, without a restatement after it: "0.03 mL (30 uL)" → "0.03 mL". */
const plain = (text: string) => (text ?? '').replace(/\s*\([^)]*\)\s*$/, '');
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)`;

/**
 * Text the app shows, with micro as µ again: the rules ask for "uL" in amounts, and the model sometimes writes it in
 * a key or an at-a-glance line too ("25 uL sample", "5 uM").
 */
export const micro = (text: string) => text.replace(/(\d\s?)[uμ](?=(?:L|g|M|mol|m)(?![a-zA-Z]))/g, '$1µ');

/**
 * The unit after a number: one word without digits, starting with a letter, µ, % or ° ("uL", "ng/mL", "%", "U/mL",
 * "cells/well"). Words after it ("10 mg/mL in water", "25 uL per well") are not part of the unit.
 */
const UNIT = String.raw`([A-Za-zµμ%°][^\d\s]{0,23})`;
/** "mg / mL" → "mg/mL", so a unit is one word. */
const joined = (text: string) => plain(text).replace(/\s*\/\s*/g, '/');

/**
 * "25 uL", "500 nL", "10 ng/mL", "5 uM", "0.5 %", "10 U/mL" → its number and its unit, the unit tidied for display
 * (shared/units.ts) and otherwise as printed; null when there is no number to read. Nothing is converted here: the
 * app converts only where it computes.
 */
export function parseQuantity(text: string): { value: number; unit: string } | null {
  const m = new RegExp(String.raw`^\s*${NUM}\s*${UNIT}(?:\s.*)?$`).exec(joined(text));
  // "2 x 10^6 cells", "2 × 500 mL": a multiplication, not an amount with the unit "x" (parseAmount reads the second).
  if (!m || /^[x×]$/i.test(m[2]!)) return null;
  return { value: number(m[1]!), unit: normalizeUnit(m[2]!) };
}

/** A volume as printed ("25 uL", "0.1 mL", "500 nL"); any unit is kept. */
export const parseVolume = parseQuantity;

/**
 * A diluent given as the volume topped up to ("adjust to 50 uL", "to a final volume of 50 uL with buffer") → the
 * volume added: the final volume less the take, when both are volumes on one scale. Null when it says no such thing.
 */
export function toppedUp(text: string, take: { value: number; unit: string } | null): { value: number; unit: string } | null {
  const m = new RegExp(String.raw`(?:\bto|\bup to|final|total)\b[^\d]{0,24}${NUM}\s*${UNIT}`, 'i').exec(joined(text));
  if (!m) return null;
  const final = { value: Number(m[1]!.replace(/,/g, '')), unit: normalizeUnit(m[2]!) };
  if (!take) return final;
  const f = toMicroliters(final), k = toMicroliters(take);
  if (f === null || k === null || f < k) return null;
  return { value: Number((f - k).toPrecision(12)), unit: 'µL' };
}

/** A concentration as printed ("2 mg/mL", "10 pg/mL", "5 uM", "0.5 %"); any unit is kept. */
export const parseConcentration = parseQuantity;

/** "2 x 500 mL", "10 × 1 mL", "25 mL", "1 vial", "100 tests" → how many and how much each, as printed. */
export function parseAmount(text: string): { count?: number; amount?: { value: number; unit: string } } {
  const t = plain(text).trim();
  const containers = /^(\d+)\s*(?:vials?|bottles?|tubes?|ampou?les?|kits?|packs?|plates?|each|pcs?)\b/i.exec(t);
  if (containers) return Number(containers[1]) > 0 ? { count: Number(containers[1]) } : {};
  const many = /^(\d+)\s*[x×]\s*(.+)$/i.exec(t);
  if (many && /^(?:vials?|bottles?|tubes?|ampou?les?|kits?|packs?|plates?)$/i.test(many[2]!.trim())) return { count: Number(many[1]) };
  const each = parseQuantity(many ? many[2]! : t);
  if (each) return { ...(many ? { count: Number(many[1]) } : {}), amount: each };
  const units = /^(\d+)\b/.exec(t);
  return units && Number(units[1]) > 0 ? { count: Number(units[1]) } : {};
}

/** "20-2000 ug/mL", "20–2,000 µg/mL", "5 to 250 ug/mL", "15.6-1000 pg/mL" → a working range, in its printed unit. */
export function parseRange(text: string): { min: number; max: number; unit: string } | null {
  const m = new RegExp(String.raw`^\s*${NUM}\s*(?:${UNIT}\s*)?(?:-|–|—|to)\s*${NUM}\s*${UNIT}(?:\s.*)?$`, 'i').exec(joined(text));
  if (!m) return null;
  const min = number(m[1]!), max = number(m[3]!);
  return max > min && min >= 0 ? { min, max, unit: normalizeUnit(m[4]!) } : null;
}

/** "30 min", "2 h", "30 s", "72 hours" → a timer's length. */
export function parseTime(text: string): { value: number; unit: 's' | 'min' | 'h' } | null {
  const m = new RegExp(String.raw`^\s*${NUM}\s*(s|sec|secs|seconds?|min|mins|minutes?|h|hr|hrs|hours?)\.?\s*$`, 'i').exec(plain(text));
  if (!m) return null;
  const u = m[2]!.toLowerCase();
  const value = number(m[1]!);
  return value > 0 ? { value, unit: u.startsWith('s') ? 's' : u.startsWith('m') ? 'min' : 'h' } : null;
}

export type Intro = WireOf<typeof INTRO>;
export type Inventory = WireOf<typeof INVENTORY>;
export type Steps = WireOf<typeof STEPS>;
export type Curves = WireOf<typeof CURVES>;
export type Notes = WireOf<typeof NOTES>;

// ─── What the model is told ──────────────────────────────────────────────────────────────────────────────────────

export const RULES = `You read a lab kit's manual (attached) into Chapp's protocol format, one part at a time. Chapp shows these facts to a scientist at the bench, so:
- Transcribe every number (volume, concentration, time, temperature, wavelength, ratio, count) exactly as the manual prints it, with its unit. Never compute, convert or guess one; when the manual does not give it, leave it "" or 0. The one exception: times take s, min or h, so write days as hours (3 days → 72 h).
- Amounts are text: the number and its unit exactly as printed, whatever the unit, with micro written as u: "25 uL", "0.1 mL", "2 x 500 mL", "2 mg/mL", "20-2000 ug/mL", "10 pg/mL", "5 uM", "0.5 %", "10 U/mL", "30 min". Keep micro (u), nano (n), pico (p) and milli (m) apart exactly as printed. In titles, keys and other text write µ (µL, µg/mL).
- cite says where a fact is, on the PDF page (1 = the file's first page): "p3: <the manual's own words, at most 12, enough to find the line>", or "p2 table: <the table's name>" or "p1 figure: <the figure's name>" when it sits in a table or figure.
- ids are lower-case words joined by hyphens ("reagent-a", "bsa", "microplate"), unique within their list.
- Fill every field: unused text "", unused numbers 0, unused lists [].`;

/** The at-a-glance summary is what the user does; what it says they will see or get is shown apart from it. */
const ONLY_DOING = `Only what the user does: a line that says what they will see or get ("Visible lipid droplets 7-10 days after differentiation medium", "Turns purple") goes in overviewExpected instead, as printed; [] when there is none.`;

/** Reagent prep, listed apart from the experiment's steps (shared/protocol.ts Procedure.prep). */
const BEFORE = `true for getting the kit's reagents ready ahead of the experiment, the manual's reagent preparation: reconstituting or dissolving a vial, warming or equilibrating reagents, making a working buffer or stock from a concentrate ("1X Wash Buffer from the 25X concentrate"), spinning tubes before opening. Chapp lists these apart as reagent prep. false for the experiment itself: the cells, the samples, the standards, and the mixes made for this run (working reagent, reaction mix)`;

/** What each kind of note is for: "expected" is a result to look for, not a rule. */
const KINDS = `"expected" only for what the user should see or get when it works ("the solution turns purple"); a rule about using, keeping or discarding something is a "caution" or "tip"`;

export const INTRO_TASK = `Say quickly what this kit is, for the first screen the scientist sees. Fill:
- kitName, vendor and its catalog numbers as printed; the document's title, publisher (the company), document id ("MAN0011430"; the catalog number when it has none) and revision or version.
- title: the assay's name as Chapp would say it ("Pierce BCA Protein Assay", "3T3-L1 Adipocyte Differentiation"), without "Kit" or trademark signs.
- summary: two or three sentences in Chapp's own words, as "<kind of method>: <what it measures and how it works>. <its readout, range or result>." For example "Colorimetric total-protein assay: standards and samples react with a green working reagent and turn purple; read at 562 nm. Working range 20–2,000 µg/mL."
- overviewSteps: the manual's own at-a-glance summary of its main procedure (a procedure-summary figure or box), its lines as printed, and overviewCite: that figure or box; if it has none, the main steps in a few words each, citing the page they start on. ${ONLY_DOING}
- steps: that main procedure's steps in order (with a microplate and a test-tube procedure, the microplate one), each one short line in the manual's own words with its numbers, and its page. Only what the user does: leave out what the manual says they will see, and getting the reagents ready beforehand (reconstituting, warming, making buffers), which Chapp lists apart. procedureName: that procedure's name; otherProcedures: the names of the others.
- contents: what the kit holds, one row per bottle: its name and its amount as printed ("2 x 500 mL", "1 vial"); for several kit sizes, the first.`;

export const INVENTORY_TASK = `Fill the inventory: everything the protocol's steps will point at.
- The document: its title, publisher (the company), document id ("MAN0011430"; the catalog number when it has none), revision or version, date as YYYY-MM-DD ("" when none is printed), and its number of pages.
- The kit: its name and vendor as printed, kitCite: where its contents are listed. variants: each catalog number with its scale ("500 tubes or 5,000 microplate assays"; "" if none). contents: one row per bottle per variant: catalog, component id, amount as printed ("2 x 500 mL", "10 mL", "1 vial").
- components: every bottle in the kit (suppliedBy "kit"), and each liquid the user supplies that a step or mix uses (suppliedBy "user"): the diluent for the standards, the medium or buffer a mix is made in. role "standard" for the standard's stock, "diluent" for what standards or mixes are diluted in, otherwise "reagent". concentration as printed ("2 mg/mL"), always for the standard's stock, "" when none is printed. storage: the °C as printed ("15-30", "-20", "2-8"; "" if none). labels: the names the bottle goes by in the manual.
- equipment: the instruments and consumables the steps use, each with the nearest icon ("other" if none fits) and the setting the manual gives for it ("37 °C", "562 nm", "30 s"; "" if none).
- mixes: what the user makes from parts ("Working Reagent", "differentiation medium"), with short: the manual's abbreviation ("WR") or a short one, and a cite. mixParts: each part's component and its share as printed (50 parts A to 1 part B: 50 and 1; 1 µL in 1 mL: 1 µL is 1 part, 1 mL is 1000).
- curves: each standard dilution table (stock and diluent component ids, its working range "20-2000 ug/mL", cite); none if the kit has no standard curve.
- procedures: each way to run the kit (a microplate and a test-tube version are two). Variants that change only the incubation (its time or temperature, and with it the working range or the standard table) are one procedure: they become alternatives of its incubation step. A smaller-sample option is a tip on its loading step, not a procedure. Phases done one after another (getting the cells ready, induction, maintenance) are steps of one procedure, not procedures of their own. format "microplate", "tube" or "cells" (cell culture). For an assay read against a standard curve, its ratio as printed ("1:8"), the sample and the mix per well or tube ("25 uL", "200 uL"), the mix id, the curve id and the working range ("20-2000 ug/mL"); for cells leave those "".`;

export const STEPS_TASK = `List every step of every procedure, in order, as rows. Use exactly the ids in the inventory below.
- A step is something the user does. What the manual says will happen or be seen ("the solution begins to turn blue", "lipid droplets will be visible 7-10 days after…") is never a step and never part of a key: it is a note of kind "expected" on the step whose result it is.
- steps: procedureId (the inventory's id of its procedure); stepId, unique across procedures (prefix it, "m-load", "t-load"); before (${BEFORE}); stage; title (Chapp's own short title); key (the one line said at the bench, in Chapp's own words, with the step's numbers; it is also shown alone in the step list, so it says what is done to what: "Make BSA standards A–I from the 2 mg/mL stock", never just "Make vials A–I"); makes (the curve id when the step makes the standards, the mix id when it makes a mix, else ""); equipment ids; cite.
- stage is one of: standards (make the standard dilutions), prepare (grow or ready the cells, reconstitute or warm reagents), mix (make a mix), load (put standards, samples or a reagent into wells or tubes), treat (add or replace medium or a treatment on cells), incubate (wait a set time at a temperature), wash, read (measure on an instrument; letting the plate or tubes reach room temperature first is part of it), observe (the manual tells the user to look, e.g. "examine the cells under a microscope"; a result it only says will be visible is an expected note, not a step), analyze (work out the result: one step).
- timers: one row per step that waits a set time: its stepId, label ("Incubate", "Shake"), time ("30 min", "30 s"), temperature in °C as printed ("37", "15-30"; "" if none), covered when the manual says to cover. A time limit ("read within 10 minutes") is not a timer: it belongs in the key.
- additions: what a step adds to each well or tube: "standards-and-samples" (ref ""), "mix" (ref: the mix id) or "component" (ref: the component id), with the volume as printed ("25 uL"). Leave a step out when the manual gives no volume.
- alternatives: the manual's other documented timings for a timed step ("2 hours for a stronger signal", "60°C for the enhanced range"), with their time and temperature, and the working range and curve id when they change those ("" otherwise), and a cite. They also hold the variants the inventory folded into one procedure ("Enhanced: 60°C for 30 minutes, working range 5–250 µg/mL" with that range and its standard table's curve id).
- notes: short lines shown next to a step. kind "expected", "tip", "caution" or "info" (${KINDS}); text: one sentence in Chapp's own words; cite keeps the manual's words.`;

export const CURVES_TASK = `For each standard curve below, list every standard in order, however the manual makes them: the curve id, the vial's letter or number alone ("A", "B", "1" as printed; number them 1, 2, 3… when the manual does not), the diluent volume ("125 uL"), where its standard comes from ("stock", the id of an earlier vial, or "" for the blank), the volume taken ("375 uL"), the final concentration ("1500 ug/mL", "500 pg/mL", "2 nmol/well"), and blank true for the one with no standard.
- A dilution table: one row per vial, as printed.
- Standards made in the wells ("add 0, 2, 4, 6, 8, 10 uL of the standard and adjust to 50 uL with buffer"): one row per well amount; take is the uL of standard, diluent the uL added, concentration the amount per well as the manual states it ("2 nmol/well").
- A working dilution the manual makes first ("dilute 10 uL of the 10 mM stock with 90 uL water to 1 mM"): a row of its own, in the unit the manual gives it, that the standards then come from.
Every volume and concentration exactly as the manual prints it, with its unit; never convert.`;

export const NOTES_TASK = `Using the inventory below, fill:
- title: the assay's name as Chapp would say it ("Pierce BCA Protein Assay", "3T3-L1 Adipocyte Differentiation"), without "Kit" or trademark signs.
- summary: two or three sentences in Chapp's own words, as "<kind of method>: <what happens>. <its range or result>." For example "Colorimetric total-protein assay: standards and samples react with a green working reagent and turn purple; read at 562 nm. Working range 20–2,000 µg/mL."
- overviewSteps: the manual's own at-a-glance summary of one procedure (a procedure-summary figure or box), its lines as printed, with overviewCite; if it has none, the default procedure's main steps in a few words each. overviewProcedure: that procedure's id. ${ONLY_DOING}
- analysis, when the kit is read on an instrument (hasAnalysis true): the readout wavelength in nm, the acceptable range if printed (0 and 0 if not), the curve fits the manual prefers ("4pl" for four-parameter, "best-fit"), "point-to-point" if it describes plotting by hand, "linear" in fitAvoid if it says a linear fit is less accurate, and analysisCite. A kit with nothing to read has hasAnalysis false.
- notes: the manual's notes worth hearing at the bench, each on what it is about: "general" (intended use, interfering substances, handling), "analysis" (how readings become results), or the id of the component or mix it is about (how to make, store or recognize it). kind "expected", "tip", "caution" or "info" (${KINDS}); text: one sentence in Chapp's own words; cite keeps the manual's words. Leave out notes about a single step.
- defaults: the procedure to start with (the overview's), and the number of unknown samples (not counting the standards or blanks) and of replicates when the manual works an example run (0 if not), with defaultsCite: that example.`;

/** The inventory's ids and names, for the calls that point at them. */
export function inventoryBrief(inv: Inventory): string {
  return JSON.stringify({
    components: inv.components.map(c => ({ id: c.id, name: c.name, role: c.role, suppliedBy: c.suppliedBy })),
    equipment: inv.equipment.map(e => ({ id: e.id, name: e.name })),
    mixes: inv.mixes.map(m => ({ id: m.id, name: m.name, parts: inv.mixParts.filter(p => p.mix === m.id).map(p => `${p.parts} ${p.component}`) })),
    curves: inv.curves.map(c => ({ id: c.id, name: c.name, stock: c.stock, diluent: c.diluent })),
    procedures: inv.procedures.map(p => ({ id: p.id, name: p.name, format: p.format, mix: p.mix, curve: p.curve })),
  });
}

// ─── Calling Muse Spark ──────────────────────────────────────────────────────────────────────────────────────────

/** The text of a Responses API reply's message (its output_text parts). */
export function replyText(r: Json): string {
  if (typeof r.output_text === 'string' && r.output_text) return r.output_text;
  const items: Json[] = Array.isArray(r.output) ? r.output : [];
  return items
    .filter(o => o.type === 'message' && o.phase !== 'commentary')
    .flatMap(o => (Array.isArray(o.content) ? o.content : []))
    .filter((c: Json) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c: Json) => c.text)
    .join('');
}

const scrub = (text: string, apiKey: string) => {
  let message = text;
  try {
    const body = JSON.parse(text);
    message = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : text);
  } catch {
    // Not JSON: keep the text.
  }
  return String(message).split(apiKey).join('***').replace(/\s+/g, ' ').trim().slice(0, 200);
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Pages in a PDF, counted from its page objects; null when they are packed where a plain scan cannot see them. */
export function countPages(pdf: Uint8Array): number | null {
  const text = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString('latin1');
  const n = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return n > 0 ? n : null;
}

export const isPdf = (bytes: Uint8Array) => bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';

// ─── Assembling the protocol ─────────────────────────────────────────────────────────────────────────────────────

/** "Pierce™ BCA Protein Assay" → "pierce-bca-protein-assay". */
export const slug = (text: string) =>
  text.replace(/[™®©]/g, '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

/** An °C as printed: "37" → 37, "15-30" or "15–30 °C" → 15 to 30, "-20" → −20; null for "" or words. */
export function parseTemperature(text: string): { value: number; max?: number; unit: '°C' } | null {
  const t = text.replace(/[−‒–—]/g, '-').replace(/\s+/g, '');
  const m = /^(-?\d+(?:\.\d+)?)(?:(?:-|to)(-?\d+(?:\.\d+)?))?(?:°|º)?C?$/i.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : undefined;
  return max !== undefined && max > value ? { value, max, unit: '°C' } : { value, unit: '°C' };
}

/** The deep read's four replies, and the intro's when it came back: its words are what the Overview said first. */
export type Parts = { inventory: Inventory; steps: Steps; curves: Curves; notes: Notes; intro?: Intro | null };

/** "Pierce™ BCA Protein Assay Kit" → "Pierce BCA Protein Assay". */
const cleanTitle = (title: string) => title.replace(/[™®]/g, '').replace(/\s+kit$/i, '').replace(/\s+/g, ' ').trim();

/** An intro worth showing: a name, what the kit is for and at least one at-a-glance line. */
const usable = (intro: Intro | null | undefined): intro is Intro => Boolean(intro && cleanTitle(intro.title || intro.kitName) && intro.summary && intro.overviewSteps.length);

/** The at-a-glance summary's expected results, when it gives some. */
const expectedOf = (lines: string[]) => (lines.length ? { expected: lines.map(micro) } : {});

/**
 * The intro → what the Overview shows first (shared/ai.ts ProtocolIntro), or null when it says too little. `url` is
 * the manual's address on the web; an upload has none until it is saved, so its source links nowhere yet.
 */
export function introOf(intro: Intro, url = ''): ProtocolIntro | null {
  if (!usable(intro)) return null;
  const said = parseCite(intro.overviewCite);
  const cite: ProtocolIntro['overview']['cite'] = { page: Math.max(1, said.page || 1) };
  if (said.quote) cite.quote = said.quote;
  if (said.table) cite.table = said.table;
  if (said.figure) cite.figure = said.figure;
  if (!cite.quote && !cite.table && !cite.figure) cite.figure = 'not quoted';
  return {
    title: cleanTitle(intro.title || intro.kitName),
    summary: micro(intro.summary),
    kit: { name: intro.kitName, vendor: intro.vendor, catalogs: intro.catalogs },
    source: { title: intro.docTitle || intro.kitName, publisher: intro.publisher || intro.vendor, docId: intro.docId, revision: intro.revision.replace(/^rev(?:ision)?\.?\s*/i, ''), url },
    overview: { steps: intro.overviewSteps.map(micro), ...expectedOf(intro.overviewExpected), cite },
    procedure: { name: intro.procedureName, steps: intro.steps.filter(x => x.text).map(x => ({ text: micro(x.text), page: Math.max(1, x.page || 1) })), others: intro.otherProcedures },
    contents: intro.contents.filter(x => x.name).map(x => ({ name: x.name, amount: micro(x.amount) })),
  };
}

export type Meta = {
  sha256: string;
  pages: number | null;
  /** The vendor's URL; an uploaded manual is served at /api/protocols/<id>/manual.pdf instead. */
  url?: string;
  fetchedAt: string;
  seconds: number;
};

/** The id-safe form of whatever the model wrote, so "Reagent A" and "reagent-a" point at the same thing. */
const ref = (text: string) => slug(text);

/** A vial's letter, however it was written: "B", "b", "Vial B", "bsa-standard-b" → "B". */
const letter = (text: string) => /(?:^|[^a-z])([a-z])$/i.exec(text.trim())?.[1]?.toUpperCase() ?? null;

/** A vial's label: its letter ("B"), or the manual's short name for it ("std1", "curve-std1" → "Std1"). */
function vialId(text: string): string | null {
  const t = text.trim();
  const l = letter(t);
  if (l) return l;
  const m = /(?:^|[-_\s])([A-Za-z]{0,4}\d{1,3})$/.exec(t);
  if (m) return m[1]![0]!.toUpperCase() + m[1]!.slice(1);
  // A named row ("colorimetric-working", "Std 1 mM"): its last word, when it is one the contract takes.
  const w = /([A-Za-z0-9]{1,8})$/.exec(t);
  return w ? w[1]![0]!.toUpperCase() + w[1]!.slice(1) : null;
}

/**
 * The four replies → a protocol, and what did not fit. Rows that cannot be used (a part without a mix, a vial without
 * a table, a citation with nothing to point at) are dropped with a sentence each; the protocol always validates.
 */
export function assemble(parts: Parts, meta: Meta): { protocol: Protocol; problems: string[] } {
  const { inventory: inv, steps: st, curves: cv, notes: nt } = parts;
  const dropped: string[] = [];

  const cite = (text: string, what: string): Cite | null => {
    const row = parseCite(text);
    const page = Math.max(1, Math.min(row.page || 1, meta.pages ?? inv.pages ?? 999));
    const c: Cite = { page };
    if (row.quote) c.quote = row.quote;
    if (row.table) c.table = row.table;
    if (row.figure) c.figure = row.figure;
    if (c.quote || c.table || c.figure) return c;
    dropped.push(`${what}: no citation`);
    return null;
  };
  // Things a protocol cannot do without keep a citation to their page, saying the manual's wording was not given.
  const citeOr = (text: string, what: string): Cite => cite(text, what) ?? { page: Math.max(1, parseCite(text).page || 1), figure: 'not quoted' };
  const unique = <T extends { id: string }>(list: T[], what: string): T[] => {
    const seen = new Set<string>();
    return list.filter(x => {
      if (!x.id) return dropped.push(`a ${what} without an id`), false;
      if (seen.has(x.id)) return dropped.push(`${what} ${x.id} listed twice`), false;
      seen.add(x.id);
      return true;
    });
  };
  const note = (row: { kind: string; text: string; cite: string }, where: string): Note | null => {
    if (!row.text) return null;
    const c = cite(row.cite, `${where} note`);
    return c ? { kind: row.kind as Note['kind'], text: micro(row.text), cite: c } : null;
  };

  // The bottles, gear and mixes.
  const components = unique(
    inv.components.map(c => {
      const storage = parseTemperature(c.storage);
      const parsed = parseConcentration(c.concentration);
      const conc = parsed && parsed.value > 0 ? parsed : undefined;
      const notes = nt.notes.filter(n => ref(n.on) === ref(c.id)).map(n => note(n, `component ${c.id}`)).filter((n): n is Note => n !== null);
      return {
        id: ref(c.id),
        name: c.name || c.id,
        role: c.role,
        suppliedBy: c.suppliedBy,
        ...(conc ? { concentration: conc } : {}),
        ...(storage ? { storage } : {}),
        ...(c.labels.length ? { label: c.labels } : {}),
        ...(notes.length ? { notes } : {}),
        // Not asked for (the app shows none): set below from where the kit lists it, or the table or mix it is used in.
        cite: { page: 1, figure: 'not quoted' } as Cite,
      };
    }),
    'component',
  );
  const componentIds = new Set(components.map(c => c.id));

  const equipment = unique(
    // Its citation is not asked for (the app shows none): set below from the first step that uses it.
    inv.equipment.map(e => ({ id: ref(e.id), name: e.name || e.id, icon: e.icon, ...(e.setting ? { setting: e.setting } : {}), cite: { page: 1, figure: 'not quoted' } as Cite })),
    'equipment',
  );

  const mixes = unique(
    inv.mixes.flatMap(m => {
      const id = ref(m.id);
      const parts = inv.mixParts.filter(p => ref(p.mix) === id && p.parts > 0).map(p => ({ component: ref(p.component), parts: p.parts }));
      if (parts.length < 2) {
        dropped.push(`mix ${id}: fewer than two parts`);
        return [];
      }
      const notes = nt.notes.filter(n => ref(n.on) === id).map(n => note(n, `mix ${id}`)).filter((n): n is Note => n !== null);
      return [{ id, name: m.name || id, short: m.short || m.name || id, parts, notes, cite: citeOr(m.cite, `mix ${id}`) }];
    }),
    'mix',
  );
  const mixIds = new Set(mixes.map(m => m.id));

  // The dilution tables, vial by vial.
  const standardCurves = unique(
    inv.curves.flatMap(c => {
      const id = ref(c.id);
      const r = parseRange(c.range) ?? undefined;
      const rows = cv.points.filter(p => ref(p.curve) === id);
      // The stock itself listed as a row ("Reconstitute the standard to 5,000 pg/mL") is not a vial; when the bottle
      // has no strength printed with it, this is where it is printed.
      const stockRow = rows.find(p => /^(?:.*[-_\s])?stock$/i.test(p.id.trim()));
      const stockStrength = stockRow ? parseConcentration(stockRow.concentration) : null;
      const stockPart = components.find(x => x.id === ref(c.stock));
      if (stockPart && !stockPart.concentration && stockStrength && stockStrength.value > 0) {
        Object.assign(stockPart, { concentration: stockStrength });
        dropped.push(`component ${stockPart.id}: strength from the dilution table, as printed`);
      }
      // Standards made in the wells are topped up to what a well holds ("adjust to 50 uL"): a row that says no
      // diluent gets the rest of that volume; one that says no concentration gets what its take of the working
      // dilution holds (2 uL of 1 mM is 2 nmol). What a well holds is the blank's volume, or else what the procedure
      // plating this table puts in each well ("Load 50 uL standards and samples"). All the manual's own numbers.
      const perWell = r ? /\/well$/i.test(normalizeUnit(r.unit)) : false;
      const blankRow = rows.find(p => p.blank || (p.from.trim() === '' && p !== stockRow));
      const plating = inv.procedures.find(pr => ref(pr.curve) === id);
      const wellVolume = (blankRow ? (parseVolume(blankRow.diluent) ?? toppedUp(blankRow.diluent, null)) : null) ?? (perWell && plating ? parseVolume(plating.sample) : null);
      const byId = new Map(rows.map(p => [vialId(p.id) ?? p.id.trim(), p]));
      const points = rows
        .filter(p => p !== stockRow)
        .flatMap(p => {
          const vial = vialId(p.id);
          // A zero needs no unit ("0" in a table): it takes its row's other volume's unit, or the range's. In the
          // blank, nothing is taken and there is no standard, so an empty take or concentration is that zero.
          const isBlank = p.blank || p.from.trim() === '';
          const zero = (text: string) => /^\s*0(?:\.0+)?\s*$/.test(text) || (isBlank && text.trim() === '');
          const printed = parseVolume(p.diluent);
          const t = parseVolume(p.take) ?? (zero(p.take) ? { value: 0, unit: printed?.unit ?? 'µL' } : null);
          // "adjust to 50 uL", "up to 50 uL with buffer": the final volume, so the diluent is what the take leaves. In
          // a well, an empty diluent is that too, the blank's included (nothing taken: the whole well of buffer).
          const d = printed ?? toppedUp(p.diluent, t) ?? (perWell && p.diluent.trim() === '' && t && wellVolume ? toppedUp(`to ${wellVolume.value} ${wellVolume.unit}`, t) : null);
          const volumeUnit = d?.unit ?? t?.unit ?? 'µL';
          const diluent = d ?? (zero(p.diluent) ? { value: 0, unit: volumeUnit } : null);
          const take = t;
          const source = byId.get(vialId(p.from) ?? p.from.trim());
          const working = source && !isBlank ? parseConcentration(source.concentration) : null;
          const held = perWell && p.concentration.trim() === '' && take && working ? convert(working, normalizeUnit(r!.unit), { perWell: toMicroliters(take) ?? undefined }) : null;
          const conc = parseConcentration(p.concentration) ?? (held !== null ? { value: held, unit: normalizeUnit(r!.unit) } : zero(p.concentration) && r ? { value: 0, unit: r.unit } : null);
          if (!vial || !diluent || !take || !conc) {
            dropped.push(`curve ${id} vial ${p.id || '?'}: not a whole row`);
            return [];
          }
          const from = p.from.trim() === '' ? null : /^(?:.*[-_\s])?stock$/i.test(p.from.trim()) ? 'stock' : (vialId(p.from) ?? p.from.trim());
          return [{ id: vial, diluent, from, take, concentration: conc, ...(p.blank || from === null ? { blank: true } : {}) }];
        });
      if (!r || points.length < 2) {
        dropped.push(`curve ${id}: ${r ? 'fewer than two vials' : 'no working range'}`);
        return [];
      }
      // A working dilution (in another kind of unit than the range: the stock at 1 mM for standards in nmol/well)
      // that later vials draw from is made, but is not a standard on the plate.
      const drawnFrom = new Set(points.map(pt => pt.from));
      const rangeKind = unitKind(r.unit);
      for (const pt of points) {
        if (drawnFrom.has(pt.id) && pt.concentration.value > 0 && rangeKind !== null && unitKind(pt.concentration.unit) !== rangeKind) Object.assign(pt, { intermediate: true });
      }
      return [{ id, name: c.name || id, stock: ref(c.stock), diluent: ref(c.diluent), range: r, points, cite: citeOr(c.cite, `curve ${id}`) }];
    }),
    'curve',
  );
  const curveIds = new Set(standardCurves.map(c => c.id));
  // A stock printed without its strength: the table's undiluted vial (stock, nothing added) says it.
  for (const curve of standardCurves) {
    const stock = components.find(c => c.id === curve.stock);
    const neat = curve.points.find(p => p.from === 'stock' && p.diluent.value === 0 && p.take.value > 0);
    if (stock && !stock.concentration && neat) {
      Object.assign(stock, { concentration: neat.concentration });
      dropped.push(`component ${stock.id}: no concentration given; taken from vial ${neat.id} of ${curve.id}, which is undiluted stock`);
    }
  }

  // The procedures and their steps.
  const stepRows = unique(st.steps.map(s => ({ ...s, id: ref(s.stepId), procedure: ref(s.procedureId) })), 'step');
  const procedureRows = inv.procedures.map(p => ({ ...p, id: ref(p.id) }));
  // A step whose procedure the model named differently goes to the only procedure there is.
  for (const s of stepRows) {
    if (!procedureRows.some(p => p.id === s.procedure) && procedureRows.length === 1) s.procedure = procedureRows[0]!.id;
  }
  const procedures = unique(
    procedureRows.flatMap(p => {
      const rows = stepRows.filter(s => s.procedure === p.id);
      const built = rows.map(s => {
        const add = st.additions
          .filter(a => ref(a.stepId) === s.id)
          .flatMap(a => {
            const v = parseVolume(a.volume);
            const target = ref(a.ref);
            if (!v || v.value <= 0) return dropped.push(`step ${s.id}: an addition without a volume`), [];
            if (a.what !== 'standards-and-samples' && !target) return dropped.push(`step ${s.id}: a ${a.what} addition without what it adds`), [];
            return [{ what: a.what, ...(a.what === 'standards-and-samples' ? {} : { ref: target }), volume: v, per: a.per }];
          });
        const alternatives = st.alternatives
          .filter(a => ref(a.stepId) === s.id)
          .flatMap(a => {
            const c = cite(a.cite, `step ${s.id} alternative`);
            const duration = parseTime(a.time);
            if (!c || !duration) return [];
            const temperature = parseTemperature(a.temperature);
            const r = parseRange(a.range);
            const curve = ref(a.curve);
            return [{
              label: a.label || 'Alternative',
              duration,
              ...(temperature ? { temperature } : {}),
              ...(r ? { range: r } : {}),
              ...(curve && curveIds.has(curve) ? { standardCurve: curve } : {}),
              cite: c,
            }];
          });
        const row = st.timers.find(t => ref(t.stepId) === s.id && parseTime(t.time));
        const temperature = row ? parseTemperature(row.temperature) : null;
        const timer = row
          ? {
              label: row.label || 'Timer',
              duration: parseTime(row.time)!,
              ...(temperature ? { temperature } : {}),
              ...(row.covered ? { covered: true } : {}),
              ...(alternatives.length ? { alternatives } : {}),
            }
          : undefined;
        if (!timer && alternatives.length) dropped.push(`step ${s.id}: alternatives without a timer`);
        const notes = st.notes.filter(n => ref(n.stepId) === s.id).map(n => note(n, `step ${s.id}`)).filter((n): n is Note => n !== null);
        const gear = s.equipment.map(ref).filter(Boolean);
        return {
          id: s.id,
          stage: s.stage as Protocol['procedures'][number]['steps'][number]['stage'],
          title: micro(s.title || s.key || s.id),
          key: micro(s.key || s.title),
          // What the step makes: a dilution table or a mix (the inventory's ids tell which).
          ...(curveIds.has(ref(s.makes)) ? { standardCurve: ref(s.makes) } : {}),
          ...(mixIds.has(ref(s.makes)) ? { mix: ref(s.makes) } : {}),
          ...(add.length ? { add } : {}),
          ...(timer ? { timer } : {}),
          ...(gear.length ? { equipment: gear } : {}),
          ...(notes.length ? { notes } : {}),
          cite: citeOr(s.cite, `step ${s.id}`),
        };
      });
      // Reagent prep apart from the experiment's steps; a procedure read as nothing but prep keeps it all as steps.
      let prep = built.filter((_, i) => rows[i]!.before);
      let steps = built.filter((_, i) => !rows[i]!.before);
      if (!steps.length && prep.length) {
        dropped.push(`procedure ${p.id}: every step was reagent prep; kept as its steps`);
        [steps, prep] = [prep, []];
      }
      if (!steps.length) {
        dropped.push(`procedure ${p.id}: no steps`);
        return [];
      }
      const assay = p.format !== 'cells';
      const sample = assay ? parseVolume(p.sample) : null;
      const mixPerSample = assay ? parseVolume(p.mixPerSample) : null;
      const r = assay ? parseRange(p.range) : null;
      return [{
        id: p.id,
        name: p.name || p.id,
        format: p.format,
        ...(assay && p.ratio ? { ratio: p.ratio } : {}),
        ...(sample && sample.value > 0 ? { sample } : {}),
        ...(mixPerSample && mixPerSample.value > 0 ? { mixPerSample } : {}),
        ...(assay && ref(p.mix) ? { mix: ref(p.mix) } : {}),
        ...(assay && curveIds.has(ref(p.curve)) ? { standardCurve: ref(p.curve) } : {}),
        ...(r ? { range: r } : {}),
        ...(prep.length ? { prep } : {}),
        steps,
        // Not asked for (the app shows none): the procedure's first step.
        cite: steps[0]!.cite,
      }];
    }),
    'procedure',
  );
  if (!procedures.length) throw new UpstreamError('Chapp could not find the steps in this manual');
  const procedureIds = new Set(procedures.map(p => p.id));
  const firstProcedure = procedures[0]!.id;

  // Citations the wire does not carry (the app shows none), from the facts they go with: a kit bottle where the kit
  // lists it, a bottle the user brings where a table or mix uses it, a piece of equipment at the first step using it.
  const kitCite = citeOr(inv.kitCite, 'kit');
  const allSteps = procedures.flatMap(p => [...(p.prep ?? []), ...p.steps]);
  for (const e of equipment) e.cite = allSteps.find(x => x.equipment?.includes(e.id))?.cite ?? kitCite;
  for (const c of components) {
    c.cite = c.suppliedBy === 'kit'
      ? kitCite
      : (standardCurves.find(x => x.diluent === c.id || x.stock === c.id)?.cite ??
        mixes.find(m => m.parts.some(p => p.component === c.id))?.cite ??
        allSteps.find(x => x.add?.some(a => a.ref === c.id))?.cite ??
        kitCite);
  }

  // The kit and its bottles, per catalog number.
  const contentRow = (c: Inventory['contents'][number]) => {
    const { count, amount } = parseAmount(c.amount);
    return { component: ref(c.component), ...(count && count > 0 ? { count } : {}), ...(amount && amount.value > 0 ? { amount } : {}) };
  };
  const variantRows = inv.variants.filter(v => v.catalog);
  const kitContents = components.filter(c => c.suppliedBy === 'kit').map(c => ({ component: c.id }));
  const variants = (variantRows.length ? variantRows : [{ catalog: inv.docId || 'kit', scale: '' }]).map(v => {
    const rows = inv.contents.filter(c => c.catalog === v.catalog && componentIds.has(ref(c.component)));
    // The contents table is often printed once for every size: then its rows hold for each.
    const shared = inv.contents.filter(c => componentIds.has(ref(c.component)) && (!c.catalog || variantRows.length === 1));
    const contents = rows.length ? rows.map(contentRow) : shared.length ? shared.map(contentRow) : kitContents;
    return { catalog: v.catalog, scale: v.scale, contents: contents.length ? contents : [{ component: components[0]!.id }] };
  });

  // The analysis, for a kit read on an instrument.
  const analysisNotes = nt.notes.filter(n => ref(n.on) === 'analysis').map(n => note(n, 'analysis')).filter((n): n is Note => n !== null);
  let analysis: Protocol['analysis'];
  if (nt.hasAnalysis && nt.readout > 0) {
    const preferred = nt.fitPreferred.length ? nt.fitPreferred : (['4pl'] as const);
    if (!nt.fitPreferred.length) dropped.push('analysis: the manual names no curve fit; Chapp fits a four-parameter curve');
    analysis = {
      readout: { value: nt.readout, unit: 'nm' },
      ...(nt.acceptableMin > 0 && nt.acceptableMax > nt.acceptableMin ? { acceptable: { value: nt.acceptableMin, max: nt.acceptableMax, unit: 'nm' as const } } : {}),
      fit: { preferred: [...preferred], ...(nt.fitByHand ? { byHand: nt.fitByHand as 'point-to-point' } : {}), avoid: [...nt.fitAvoid] },
      notes: analysisNotes,
      cite: citeOr(nt.analysisCite, 'analysis'),
    };
  }

  // Notes on anything else are the assay's own.
  const placed = new Set(['analysis', ...componentIds, ...mixIds]);
  const general = nt.notes.filter(n => !placed.has(ref(n.on))).map(n => note(n, 'general')).filter((n): n is Note => n !== null);

  const defaultsProcedure = procedureIds.has(ref(nt.defaultsProcedure)) ? ref(nt.defaultsProcedure) : firstProcedure;
  const example = nt.defaultsSamples > 0 && nt.defaultsReplicates > 0
    ? cite(nt.defaultsCite, 'defaults')
    : null;
  // What the Overview said first (the intro) stays; the deep read's own words fill in when there was no intro.
  const first = usable(parts.intro) ? parts.intro : null;
  const glance = first
    ? { steps: first.overviewSteps, expected: first.overviewExpected, cite: first.overviewCite }
    : { steps: nt.overviewSteps, expected: nt.overviewExpected, cite: nt.overviewCite };
  const overviewSteps = glance.steps.length ? glance.steps.map(micro) : procedures.find(p => p.id === defaultsProcedure)!.steps.map(s => s.key);

  const title = cleanTitle(first?.title || nt.title || inv.kitName || inv.docTitle);
  const id = slug(title) || slug(inv.kitName) || 'imported';
  const doc = {
    format: 'chapp.protocol/1',
    id,
    title,
    summary: micro(first?.summary || nt.summary || title),
    source: {
      title: inv.docTitle || inv.kitName,
      publisher: inv.publisher || inv.vendor,
      docId: inv.docId,
      // "Rev. D" is revision D.
      revision: inv.revision.replace(/^rev(?:ision)?\.?\s*/i, ''),
      date: inv.date,
      url: meta.url ?? manualPath(id),
      sha256: meta.sha256,
      pages: meta.pages ?? Math.max(1, inv.pages),
      fetchedAt: meta.fetchedAt,
    },
    kit: { name: inv.kitName || title, vendor: inv.vendor || inv.publisher, variants, cite: kitCite },
    overview: {
      procedure: procedureIds.has(ref(nt.overviewProcedure)) ? ref(nt.overviewProcedure) : defaultsProcedure,
      steps: overviewSteps,
      ...expectedOf(glance.expected),
      cite: citeOr(glance.cite, 'overview'),
    },
    components,
    equipment,
    mixes,
    standardCurves: standardCurves.filter(c => curveIds.has(c.id)),
    procedures,
    ...(analysis ? { analysis } : {}),
    defaults: {
      procedure: defaultsProcedure,
      ...(example ? { samples: nt.defaultsSamples, replicates: nt.defaultsReplicates, cite: example } : {}),
    },
    notes: general,
    imported: { at: meta.fetchedAt, model: IMPORT_MODEL, seconds: meta.seconds, problems: [] as string[] },
  };

  const parsed = Protocol.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new UpstreamError(`The manual did not read into a protocol (${issues})`);
  }
  const all = [...dropped, ...checkProblems(parsed.data)];
  parsed.data.imported!.problems = all;
  return { protocol: parsed.data, problems: all };
}

/** A protocol's own intro: what the Overview shows first, for a protocol read some other way (the mock's BCA). */
export function introFromProtocol(p: Protocol): ProtocolIntro {
  const { title, publisher, docId, revision, url } = p.source;
  const procedure = p.procedures.find(x => x.id === p.overview.procedure) ?? p.procedures[0]!;
  return {
    title: p.title,
    summary: p.summary,
    kit: { name: p.kit.name, vendor: p.kit.vendor, catalogs: p.kit.variants.map(v => v.catalog) },
    source: { title, publisher, docId, revision, url },
    overview: { steps: p.overview.steps, ...(p.overview.expected?.length ? { expected: p.overview.expected } : {}), cite: p.overview.cite },
    procedure: {
      name: procedure.name,
      steps: procedure.steps.map(x => ({ text: x.key, page: x.cite.page })),
      others: p.procedures.filter(x => x !== procedure).map(x => x.name),
    },
    contents: (p.kit.variants[0]?.contents ?? []).map(c => ({
      name: p.components.find(x => x.id === c.component)?.name ?? c.component,
      amount: [c.count && c.count > 1 ? `${c.count} ×` : '', c.amount ? `${c.amount.value} ${c.amount.unit}` : ''].filter(Boolean).join(' '),
    })),
  };
}

/** Where Chapp serves its copy of a manual that came without a URL (an upload). */
export const manualPath = (id: string) => `/api/protocols/${id}/manual.pdf`;

/** The same protocol under another id: its own manual's path follows. */
export function withId(protocol: Protocol, id: string): Protocol {
  const url = protocol.source.url === manualPath(protocol.id) ? manualPath(id) : protocol.source.url;
  return { ...protocol, id, source: { ...protocol.source, url } };
}

// ─── Reading a manual ────────────────────────────────────────────────────────────────────────────────────────────

/** The manual's text, page by page ("--- Page 2 ---"), from pdftotext -layout; null when that is not installed or fails. */
export function manualText(pdf: Uint8Array): string | null {
  try {
    const out = execFileSync('pdftotext', ['-q', '-layout', '-enc', 'UTF-8', '-', '-'], { input: pdf, timeout: 15_000, maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8');
    const pages = out.split('\f').filter((page, i, all) => page.trim() || i < all.length - 1);
    // A scanned manual has (almost) no text layer: read the PDF itself.
    return pages.join('').replace(/\s+/g, '').length >= 200 * pages.length ? pages.map((page, i) => `--- Page ${i + 1} ---\n${page.trimEnd()}`).join('\n\n') : null;
  } catch {
    return null;
  }
}

/** CHAPP_RECORD_IMPORTS=1 keeps each raw reply in data/smoke/import/<time>/ (git-ignored), to make test fixtures from. */
function recorder(at: Date): ImportOptions['record'] {
  if (!process.env.CHAPP_RECORD_IMPORTS) return undefined;
  const dir = fileURLToPath(new URL(`../../data/smoke/import/${at.toISOString().replace(/[:.]/g, '-')}/`, import.meta.url));
  return (call, reply, seconds) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${call}.json`), JSON.stringify({ seconds, reply }, null, 2));
  };
}

/**
 * A kit manual (PDF bytes) → a checked protocol. `source.url` is where the PDF came from, when it came from the web.
 * Throws UpstreamError when the model fails or the result cannot be a protocol; `problems` lists what was dropped or
 * does not add up.
 */
export async function importProtocol(pdf: Uint8Array, source: { url?: string; filename?: string } = {}, options: ImportOptions): Promise<ImportedProtocol> {
  const { apiKey, baseUrl = 'https://api.meta.ai/v1', log = (line: string) => console.log(line), timeoutMs = 180_000 } = options;
  const efforts = { ...EFFORTS, ...options.efforts };
  if (!apiKey) throw new Error('Reading a manual needs MODEL_API_KEY in .env (see .env.example).');
  if (!isPdf(pdf)) throw new UpstreamError('That file is not a PDF');
  if (pdf.length > MAX_PDF) throw new UpstreamError(`That PDF is too large (limit ${MAX_PDF / 1024 / 1024} MB)`);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const started = Date.now();
  const seconds = (from = started) => ((Date.now() - from) / 1000).toFixed(1);
  const textCalls = new Set(options.asText ?? TEXT_CALLS);
  const text = textCalls.size ? (options.textOf ?? manualText)(pdf) : null;
  const filename = source.filename?.replace(/[^\w.-]+/g, '_') || 'manual.pdf';
  const authorization = `Bearer ${apiKey}`;
  const record = options.record ?? recorder(options.now?.() ?? new Date());
  // Every call on this manual starts with the same rules and the same manual, so the API can reuse that start from
  // its cache; the key keeps the calls together (dev.meta.ai/docs/prompt-caching).
  const cacheKey = `chapp-manual-${sha256(pdf).slice(0, 16)}`;

  // A scanned manual (no text to read) goes to every call as the PDF: uploaded once (Files API, deleted again once
  // read, and expiring in an hour regardless) and named by its id. One call alone takes it inline.
  const pdfCalls = (['intro', 'inventory', 'steps', 'curves', 'notes'] as const).filter(c => !(text && textCalls.has(c)));
  const fileId = pdfCalls.length > 1 ? await uploadPdf(pdf, filename, { baseUrl, authorization, fetchFn, log }) : null;
  const pdfFile = fileId ? { type: 'input_file', file_id: fileId } : { type: 'input_file', filename, file_data: `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}` };
  const manual = (call: CallName) => (text && textCalls.has(call) ? { type: 'input_text', text: `The manual, page by page:\n\n${text}` } : pdfFile);
  const inputOf = (call: CallName, task: string) => [{ role: 'system', content: RULES }, { role: 'user', content: [manual(call), { type: 'input_text', text: task }] }];

  /**
   * With a daily cap set (usage.ts), the manual's tokens are counted before anything is read (one PDF call, one text
   * call, by the API's own count) and the read is refused when it would take the day past the cap.
   */
  async function withinCap() {
    if (!meter.cap()) return;
    const count = (call: CallName, task: string) => countTokens(inputOf(call, task), { baseUrl, authorization, fetchFn });
    const [pdfTokens, textTokens] = await Promise.all([count('intro', INTRO_TASK), text ? count('inventory', INVENTORY_TASK) : Promise.resolve(null)]);
    const textCount = 5 - pdfCalls.length;
    const input = (pdfTokens ?? 0) * pdfCalls.length + (textTokens ?? 0) * textCount;
    const estimate = inputCost(IMPORT_MODEL, input) + outputCost(IMPORT_MODEL, READ_OUTPUT_TOKENS);
    log(`[meta] import counted ${pdfTokens ?? '?'} tokens with the PDF, ${textTokens ?? '?'} with the text: about $${estimate.toFixed(3)}`);
    meter.check(estimate);
  }

  async function ask<S extends Spec>(call: CallName, spec: S, task: string, thinking = efforts[call]): Promise<WireOf<S>> {
    const name = `Chapp${call[0]!.toUpperCase()}${call.slice(1)}`;
    const body = JSON.stringify({
      model: IMPORT_MODEL,
      reasoning: { effort: thinking },
      input: inputOf(call, task),
      text: { format: formatOf(name, spec) },
      prompt_cache_key: cacheKey,
      prompt_cache_retention: '24h',
    });
    for (let attempt = 0; ; attempt++) {
      const from = Date.now();
      let text: string;
      try {
        const res = await fetchFn(`${baseUrl}/responses`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
        if (!res.ok) {
          log(`[meta] import ${call} failed after ${seconds(from)} s: ${res.status}`);
          if (res.status >= 500 && attempt === 0) continue;
          throw new UpstreamError(`Meta import (${call}) failed (${res.status}): ${scrub(text, apiKey)}`);
        }
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        log(`[meta] import ${call} ${timedOut ? 'timed out' : 'could not connect'} after ${seconds(from)} s`);
        throw new UpstreamError(timedOut ? `Meta import (${call}) timed out after ${Math.round(timeoutMs / 1000)} s` : 'Could not reach the Meta API to read the manual');
      }
      let reply: Json;
      try {
        reply = JSON.parse(text);
      } catch {
        throw new UpstreamError(`Meta import (${call}) answered with something that is not JSON`);
      }
      record?.(call, reply, (Date.now() - from) / 1000);
      meter.spend(costOf(IMPORT_MODEL, reply));
      const used = usageLine(IMPORT_MODEL, reply);
      log(`[meta] import ${call} ${seconds(from)} s${used ? ` · ${used}` : ''}`);
      if (reply.status === 'failed' || reply.error) throw new UpstreamError(`Meta import (${call}) failed: ${scrub(JSON.stringify(reply.error ?? {}), apiKey) || 'no reason given'}`);
      try {
        return readWire(spec, renameLegacy(call, JSON.parse(replyText(reply))));
      } catch {
        if (attempt === 0) continue; // One more try on a reply that is not the JSON asked for.
        throw new UpstreamError(`Meta import (${call}) did not answer in the format asked for`);
      }
    }
  }

  async function read(): Promise<ImportedProtocol> {
    options.onProgress?.('Reading the manual');
    // The intro runs beside the deep read and is heard as soon as it is back; without it the deep read still stands.
    const intro = ask('intro', INTRO, INTRO_TASK).then(
      wire => {
        const said = introOf(wire, source.url);
        log(`[meta] import intro heard after ${seconds()} s${said ? '' : ' (too little to show)'}`);
        if (said) options.onIntro?.(said);
        return wire;
      },
      (error: unknown) => {
        log(`[meta] import intro failed after ${seconds()} s${error instanceof UpstreamError ? '' : ' (not the model)'}`);
        return null;
      },
    );
    const inventory = await ask('inventory', INVENTORY, INVENTORY_TASK);
    options.onProgress?.('Turning it into steps');
    const brief = `\n\nThe inventory:\n${inventoryBrief(inventory)}`;
    const [steps, curves, notes] = await Promise.all([
      ask('steps', STEPS, STEPS_TASK + brief),
      inventory.curves.length ? ask('curves', CURVES, CURVES_TASK + `\n\nThe standard curves:\n${JSON.stringify(inventory.curves.map(c => ({ id: c.id, name: c.name })))}`) : Promise.resolve({ points: [] }),
      ask('notes', NOTES, NOTES_TASK + brief),
    ]);
    const now = options.now?.() ?? new Date();
    const { protocol, problems } = assemble(
      { inventory, steps, curves, notes, intro: await intro },
      { sha256: sha256(pdf), pages: countPages(pdf), ...(source.url ? { url: source.url } : {}), fetchedAt: now.toISOString(), seconds: Math.round((Date.now() - started) / 100) / 10 },
    );
    log(`[meta] import ${seconds()} s, ${problems.length} problem(s)`);
    const sources: Source[] = /^https?:\/\//.test(protocol.source.url) ? [{ url: protocol.source.url, title: protocol.source.title }] : [];
    return { protocol, problems, sources };
  }

  try {
    await withinCap();
    return await read();
  } finally {
    if (fileId) void deleteFile(fileId, { baseUrl, authorization, fetchFn, log });
  }
}

/** A whole read's output, for the estimate before it: the ATP manual's five calls wrote 13,193 tokens on 2026-10-30. */
const READ_OUTPUT_TOKENS = 15_000;

type Upstream = { baseUrl: string; authorization: string; fetchFn: typeof fetch; log?: (line: string) => void };

/** The PDF uploaded for this read (POST /files, purpose user_data, expiring in an hour); null when the upload fails. */
export async function uploadPdf(pdf: Uint8Array, filename: string, { baseUrl, authorization, fetchFn, log }: Upstream): Promise<string | null> {
  const started = Date.now();
  const form = new FormData();
  // The fields before the file, as the docs ask, so the upload is checked before its bytes arrive.
  form.append('purpose', 'user_data');
  form.append('expires_after[anchor]', 'created_at');
  form.append('expires_after[seconds]', '3600');
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
  try {
    const res = await fetchFn(`${baseUrl}/files`, { method: 'POST', headers: { authorization }, body: form, signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as Json;
    const id = res.ok && typeof body.id === 'string' ? body.id : null;
    log?.(`[meta] import upload ${id ? `${((Date.now() - started) / 1000).toFixed(1)} s` : `failed (${res.status}): the PDF goes inline`}`);
    return id;
  } catch {
    log?.('[meta] import upload could not connect: the PDF goes inline');
    return null;
  }
}

/** The uploaded PDF removed once read; the hour's expiry removes it anyway. */
async function deleteFile(id: string, { baseUrl, authorization, fetchFn, log }: Upstream): Promise<void> {
  try {
    const res = await fetchFn(`${baseUrl}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) log?.(`[meta] import file not deleted (${res.status}); it expires within the hour`);
  } catch {
    log?.('[meta] import file not deleted; it expires within the hour');
  }
}

/** The API's own count of a Responses input (POST /responses/input_tokens, nothing generated); null when it cannot. */
export async function countTokens(input: Json[], { baseUrl, authorization, fetchFn }: Upstream): Promise<number | null> {
  try {
    const res = await fetchFn(`${baseUrl}/responses/input_tokens`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ model: IMPORT_MODEL, input }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    const n = body.input_tokens ?? body.total_tokens;
    return res.ok && typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
