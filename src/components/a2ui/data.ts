import { isBinding } from '../../../shared/a2ui.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { toMicroliters } from '../../../shared/units.ts';
import { procedureFor } from '../../screens/protocol/content.ts';
import { amountText, runSetup, type RunPlan } from '../lab/model.ts';

/**
 * A2UI's data model, filled by the app: every value a surface may bind to (shared/a2ui.ts dataPaths), worked out from
 * the protocol and a plan (the run's, or the samples and replicates the user asked about) with the same functions the
 * plan and run screens use. Values are as shown ("10 mL", "50 : 1", "37 °C"); a plan the kit cannot lay out (too many
 * wells, no plate) leaves its numbers out, and anything bound to them is not drawn.
 */
export type DataModel = {
  plan: { samples: string; replicates: string; wells?: string };
  reagent?: { make: string; need: string; partA?: string; partB?: string; ratio: string };
  standards?: { vials: string; stock: string; diluent: string };
  steps: Record<string, { title: string; key: string; time?: string; temp?: string }>;
};

export function dataModel(protocol: Protocol, plan: RunPlan): DataModel {
  const model: DataModel = { plan: { samples: `${plan.samples}`, replicates: `${plan.replicates}` }, steps: {} };
  try {
    const { plate, reagent, series } = runSetup(protocol, plan);
    model.plan.wells = `${plate.wells}`;
    model.reagent = {
      make: amountText(reagent.make),
      need: amountText(reagent.need),
      ...(reagent.parts[0] ? { partA: amountText(reagent.parts[0].volume) } : {}),
      ...(reagent.parts[1] ? { partB: amountText(reagent.parts[1].volume) } : {}),
      ratio: reagent.ratio,
    };
    model.standards = { vials: `${series.vials.length}`, stock: amountText(series.stock), diluent: amountText(series.diluent) };
  } catch {
    // A plan this kit can't lay out: no plan numbers.
  }
  for (const s of procedureFor(protocol, plan.procedure).steps) {
    const t = s.timer;
    model.steps[s.id] = {
      title: s.title,
      key: s.key,
      ...(t ? { time: `${t.duration.value} ${t.duration.unit}` } : {}),
      ...(t?.temperature ? { temp: t.temperature.max === undefined ? `${t.temperature.value} °C` : `${t.temperature.value}–${t.temperature.max} °C` } : {}),
    };
  }
  return model;
}

/** The value at a JSON pointer ("/reagent/make"), or undefined. */
export function valueAt(model: unknown, path: string): unknown {
  let at: unknown = model;
  for (const key of path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** A property as drawn: a literal as it is, a binding as the data model's value there (undefined when it has none). */
export const resolve = (value: unknown, model: DataModel): unknown => (isBinding(value) ? valueAt(model, value.path) : value);

/** "15 mL", "15ml", "15000 µL" → µL; null when there is no volume in it. */
export function volumeIn(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*([pnuµμm]?l)\b/i.exec(text.replace(/,(?=\d{3}\b)/g, ''));
  return m ? toMicroliters({ value: Number(m[1]), unit: m[2]! }) : null;
}
