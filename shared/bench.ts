import { z } from 'zod';

/**
 * A step drawn as a bench scene, BioRender-like: real lab items (src/components/bench/Items.tsx) placed on a 240 × 240
 * bench, each with how full it is, what colour, what its label says, and a timeline of what happens (the pipette
 * moves, drops fall, wells fill, a colour turns). The local composer (shared/benchScenes.ts) writes it from the
 * protocol; a model could write the same, checked here (BenchScene), so the drawing never runs anything it sends.
 *
 * Every item says where it comes from: the protocol (field, page, its words) or drawn (why), and which of its looks
 * are drawn rather than said (a colour the protocol never gives is drawn pale, and marked).
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,63}$/i);
const Colour = z.string().regex(/^#[0-9a-f]{6}$/i);

export const Source = z.discriminatedUnion('from', [
  z.object({ from: z.literal('protocol'), field: z.string(), page: z.number().int().positive().optional(), quote: z.string().max(400).optional() }),
  z.object({ from: z.literal('drawn'), why: z.string().max(300) }),
]);
export type Source = z.infer<typeof Source>;

export const ItemKind = z.enum([
  'tube', // 1.5 mL microcentrifuge tube
  'conical', // 15 mL conical tube
  'bottle', // reagent bottle
  'pipette', // micropipette, tip down (seen side on, a multichannel looks the same)
  'reservoir', // reagent trough
  'plate', // 96-well plate
  'rack', // tube rack
  'dish', // culture dish of cells
  'flask', // culture flask
  'beaker',
  'washbottle',
  'incubator',
  'reader', // plate reader
  'centrifuge',
  'microscope',
  'timer',
  'thermometer',
  'arrow',
  'chart', // a standard curve
]);
export type ItemKind = z.infer<typeof ItemKind>;

/** What an item looks like now; an action changes some of it. */
export const Look = z.object({
  x: z.number(),
  y: z.number(),
  scale: z.number().positive().optional(),
  /** A rack's width. */
  width: z.number().positive().optional(),
  rotate: z.number().optional(),
  hidden: z.boolean().optional(),
  /** How full (0–1), and with what. */
  level: z.number().min(0).max(1).optional(),
  liquid: Colour.optional(),
  /** A cap's colour, or a pipette's button (which also says its range). */
  cap: Colour.optional(),
  open: z.boolean().optional(),
  /** Filled wells of a plate, by name ("A1"), and their colour. */
  wells: z.record(z.string().regex(/^[A-H](?:[1-9]|1[0-2])$/), Colour).optional(),
  /** Text on the item: a bottle's label, a display ("37 °C"), a tube's name under it. */
  label: z.string().max(40).optional(),
  text: z.string().max(24).optional(),
  /** An arrow's end, and its label. */
  to: z.tuple([z.number(), z.number()]).optional(),
  /** A timer's progress (0–1). */
  progress: z.number().min(0).max(1).optional(),
  /** A chart's points (x, y), 0–1 each. */
  points: z.array(z.tuple([z.number(), z.number()])).max(24).optional(),
});
export type Look = z.infer<typeof Look>;

export const Item = Look.extend({
  id: Id,
  kind: ItemKind,
  represents: z.string().max(200),
  source: Source,
  /** Looks drawn, not said by the protocol ("colour", "vessel", "layout"), with why. */
  drawn: z.record(z.string(), z.string().max(200)).optional(),
});
export type Item = z.infer<typeof Item>;

export const Action = z.object({
  /** When (ms from the start of the step) and how long it takes. */
  at: z.number().int().min(0).max(60000),
  ms: z.number().int().min(0).max(10000),
  id: Id,
  set: Look.partial().optional(),
  /** A drop falling from (x, y1) to y2. */
  drop: z.object({ x: z.number(), y1: z.number(), y2: z.number(), colour: Colour }).optional(),
});
export type Action = z.infer<typeof Action>;

export const BenchScene = z.object({
  title: z.string().max(120),
  caption: z.object({ text: z.string().max(300), source: Source }),
  items: z.array(Item).max(80),
  actions: z.array(Action).max(400),
});
export type BenchScene = z.infer<typeof BenchScene>;

/** The contract as JSON Schema, for a model's structured output. */
export const benchSceneJsonSchema = () => z.toJSONSchema(BenchScene, { io: 'input' });

/** "A1" … "H12": row letters, column numbers. */
export const wellName = (row: number, col: number) => `${String.fromCharCode(65 + row)}${col + 1}`;
