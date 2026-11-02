/**
 * A2UI v0.9 (https://a2ui.org/specification/v0.9-a2ui/), the subset Chapp speaks: Muse Spark writes the messages for
 * one surface under its answer, the server checks them here (checkA2ui), and the phone draws them with its own
 * renderer (src/components/a2ui/), filling the data model from the protocol and the run's plan. The model never writes
 * a number of its own: values come from the data model by binding ({"path": "/reagent/make"}).
 *
 *   {"version":"v0.9","createSurface":{"surfaceId":"answer","catalogId":"chapp"}}
 *   {"version":"v0.9","updateComponents":{"surfaceId":"answer","components":[{"id":"root","component":"Card","child":"t"}, …]}}
 */

export const A2UI_VERSION = 'v0.9';
export const CATALOG_ID = 'chapp';

/** A property bound to the data model, by JSON pointer. */
export type Binding = { path: string };
/** One component of the flat list: its id, its type, and its properties (literals or bindings). */
export type A2uiComponent = { id: string; component: string; [prop: string]: unknown };

export type A2uiMessage =
  | { version: 'v0.9'; createSurface: { surfaceId: string; catalogId: string } }
  | { version: 'v0.9'; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: 'v0.9'; updateDataModel: { surfaceId: string; path: string; value: unknown } }
  | { version: 'v0.9'; deleteSurface: { surfaceId: string } };

/**
 * The basic components (A2UI's standard catalog, the part Chapp draws). A ChoicePicker's tap answers at once: the
 * label picked is sent as what the user says next.
 */
export const BASIC = ['Column', 'Row', 'List', 'Card', 'Text', 'Divider', 'ChoicePicker'] as const;
/**
 * Chapp's own: the run's working reagent, plate, standards, a step, its timer, "is what I have enough", and a question
 * about the plan the app fills in with this run's values (Ask).
 */
export const CHAPP = ['ReagentCard', 'PlateCard', 'StandardsCard', 'StepCard', 'TimerCard', 'Compare', 'Ask'] as const;
export type ComponentType = (typeof BASIC)[number] | (typeof CHAPP)[number];

/** The properties each component takes, besides id and component. */
const PROPS: Record<ComponentType, readonly string[]> = {
  Column: ['children', 'justify', 'align'],
  Row: ['children', 'justify', 'align'],
  List: ['children'],
  Card: ['child'],
  Text: ['text', 'variant'],
  Divider: ['axis'],
  ChoicePicker: ['options', 'variant'],
  ReagentCard: ['samples', 'replicates', 'standardReplicates'],
  PlateCard: ['samples', 'replicates', 'standardReplicates'],
  StandardsCard: ['samples', 'replicates', 'standardReplicates'],
  StepCard: ['stepId'],
  TimerCard: ['stepId'],
  Compare: ['need', 'have', 'samples', 'replicates', 'standardReplicates'],
  Ask: ['fields'],
};
/** What an Ask may ask about, filled in with the run's values. */
export const ASK_FIELDS = ['samples', 'replicates', 'standards'] as const;
export type AskField = (typeof ASK_FIELDS)[number];
/** A ChoicePicker's option: what it says, and what it stands for (the label, when the model gave none). */
export type Choice = { label: string; value: string };
export const TEXT_VARIANTS = ['h3', 'body', 'caption'] as const;

/** The volumes in the data model, which a Compare may weigh what the user has against. */
export const VOLUME_PATHS = ['/reagent/make', '/reagent/need', '/reagent/partA', '/reagent/partB', '/standards/stock', '/standards/diluent'];

/**
 * Every path of the data model the app fills (src/components/a2ui/data.ts), for a protocol's steps: the plan, the
 * working reagent, the standards, and each step's title and key line (with its time and temperature when timed).
 */
export function dataPaths(steps: readonly { id: string; timer?: unknown }[]): string[] {
  return [
    '/plan/samples', '/plan/replicates', '/plan/wells',
    '/reagent/make', '/reagent/need', '/reagent/partA', '/reagent/partB', '/reagent/ratio',
    '/standards/vials', '/standards/stock', '/standards/diluent',
    ...steps.flatMap(s => [`/steps/${s.id}/title`, `/steps/${s.id}/key`, ...(s.timer ? [`/steps/${s.id}/time`, `/steps/${s.id}/temp`] : [])]),
  ];
}

export const isBinding = (v: unknown): v is Binding => typeof v === 'object' && v !== null && typeof (v as Binding).path === 'string';

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const ZH_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_RUN = /[零〇一二兩两三四五六七八九十百]+/g;
// A single digit character counts in Chapp's own words only before a unit ("五毫升"): "一起", "一下", "第一步" are words.
const ZH_UNIT = /^(?:個|份|次|分鐘|分|小時|鐘頭|秒|天|毫升|微升|升|度|孔|管|倍)/;

/** "二十四" → 24, "一百二十" → 120, "十二" → 12, "兩" → 2. */
export function zhNumber(run: string): number {
  let total = 0;
  let digit = 0;
  for (const ch of run) {
    if (ch === '十') {
      total += (digit || 1) * 10;
      digit = 0;
    } else if (ch === '百') {
      total += (digit || 1) * 100;
      digit = 0;
    } else digit = ZH_DIGITS[ch] ?? 0;
  }
  return total + digit;
}

/**
 * The numbers in a text: digits ("1,500" is 1500, "0.5" stays) and Chinese numerals that are clearly numbers ("三十",
 * "五毫升"). With `words` (what the user said), English number words and every Chinese numeral too: what the user may
 * have meant is let through, what Chapp writes is held to more.
 */
export function numbersIn(text: string, words = false): number[] {
  const digits = (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => Number(n.replace(/,(?=\d{3}\b)/g, '').replace(/,/g, '')));
  const spelled = words ? (text.toLowerCase().match(/[a-z]+/g) ?? []).flatMap(w => (WORDS[w] === undefined ? [] : [WORDS[w]!])) : [];
  const zh = [...text.matchAll(ZH_RUN)].flatMap(m => {
    const run = m[0];
    const clear = words || run.length > 1 || ((run !== '一' && ZH_UNIT.test(text.slice(m.index + run.length))));
    return clear ? [zhNumber(run)] : [];
  });
  return [...digits, ...spelled, ...zh].filter(Number.isFinite);
}

/** The amount with its unit where the user said this number ("only 15 mL left" → "15 mL"), else null. */
function amountSaid(said: string, n: number): string | null {
  if (!Number.isFinite(n)) return null;
  for (const m of said.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([pnuµμm]?l|ml|µl)\b/gi)) if (Number(m[1]!.replace(/,/g, '')) === n) return m[0];
  return null;
}

export type A2uiRules = {
  /** The steps of the protocol on screen: a StepCard or TimerCard must name one (a TimerCard, a timed one). */
  steps: readonly { id: string; timer?: unknown }[];
  /** What the user said: the only numbers the model may write itself. */
  said: string;
  /** A kit is open. Without one there is no data model: only words and a choice are drawn. */
  kit?: boolean;
};

// An amount with its unit ("30 min", "5 mL", "37 °C", "×3"): a lab quantity, which only the user's words may carry.
const QUANTITY = /(?:[×x]\s*\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*(?:[pnuµμm]?l\b|[pnuµμm]?g\b|[pnuµμm]?M\b|%|°|℃|min\b|h\b|hours?\b|s\b|sec|x\b|rpm|毫升|微升|分鐘|小時|秒|度|倍))/gi;

/**
 * The model's A2UI (a JSON string or the parsed array) → messages the phone can draw, and what was put right or dropped
 * on the way (kinds only, for the log). The version is set on every message; a createSurface is put first when it is
 * missing; updateDataModel and deleteSurface are dropped (the app fills the data model). A component is dropped when
 * its type is unknown, a binding points outside the data model, its words carry a number the user did not say, or a
 * step it names is not the protocol's; then children that are gone are unlinked, and only what hangs from "root" is
 * kept. No root left, no surface: [].
 */
/**
 * The model's A2UI string as JSON, forgiving how it was wrapped: one message per line (A2UI's own stream form), a
 * code fence around it, or words before and after. Undefined when there is no JSON in it.
 */
function parseLoose(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const tries = [
    text,
    `[${text.replace(/}\s*[\r\n]+\s*{/g, '},{')}]`,
    text.slice(Math.min(...['[', '{'].map(c => text.indexOf(c)).filter(i => i >= 0)), Math.max(text.lastIndexOf(']'), text.lastIndexOf('}')) + 1),
  ];
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      // The next way of reading it.
    }
  }
  return undefined;
}

export function checkA2ui(raw: unknown, rules: A2uiRules): { messages: A2uiMessage[]; dropped: string[] } {
  const dropped: string[] = [];
  let list: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { messages: [], dropped };
    const parsed = parseLoose(raw);
    // For the log, its shape only: every letter and digit masked, so no words are kept.
    if (parsed === undefined) return { messages: [], dropped: [`a2ui not JSON (${raw.length} chars: ${raw.replace(/[\p{L}\p{N}]+/gu, 'x').slice(0, 240)})`] };
    list = parsed;
  }
  if (list && !Array.isArray(list) && typeof list === 'object') list = [list];
  if (!Array.isArray(list) || !list.length) return { messages: [], dropped: Array.isArray(list) ? [] : ['a2ui not a list'] };

  let surfaceId = '';
  const found: Record<string, unknown>[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') continue;
    if (m.version !== A2UI_VERSION) dropped.push('version fixed');
    const create = m.createSurface as { surfaceId?: unknown } | undefined;
    const update = m.updateComponents as { surfaceId?: unknown; components?: unknown } | undefined;
    if (create && typeof create.surfaceId === 'string') surfaceId ||= create.surfaceId;
    if (update) {
      if (typeof update.surfaceId === 'string') surfaceId ||= update.surfaceId;
      if (Array.isArray(update.components)) found.push(...(update.components as Record<string, unknown>[]));
    }
    if (m.updateDataModel) dropped.push('updateDataModel');
    if (m.deleteSurface) dropped.push('deleteSurface');
  }
  surfaceId = /^[\w-]{1,40}$/.test(surfaceId) ? surfaceId : 'answer';

  const paths = new Set(dataPaths(rules.steps));
  const said = new Set(numbersIn(rules.said, true));
  const ownWords = (text: string) => numbersIn(text).every(n => said.has(n));
  const step = (id: unknown) => rules.steps.find(s => s.id === id);

  // A choice's words may carry a catalog number ("EEA032"), not an amount the user did not say.
  const choiceWords = (text: string) => [...text.matchAll(QUANTITY)].every(m => numbersIn(m[0]).every(n => said.has(n)));
  const kit = rules.kit ?? true;

  const kept = new Map<string, A2uiComponent>();
  for (const c of found) {
    const id = typeof c?.id === 'string' ? c.id : '';
    const type = c?.component as ComponentType;
    if (!id || kept.has(id) || !(type in PROPS)) {
      dropped.push(!id ? 'component without id' : kept.has(id) ? 'duplicate id' : `unknown ${String(c?.component)}`);
      continue;
    }
    if (!kit && (CHAPP as readonly string[]).includes(type)) {
      dropped.push(`${type} ${id} (no kit)`);
      continue;
    }
    const out: A2uiComponent = { id, component: type };
    // A Compare's need written as "bound" (as the prompt names a binding) is its need.
    if (type === 'Compare' && c.need === undefined && c.bound !== undefined) {
      c.need = c.bound;
      delete c.bound;
    }
    // The properties that were wrong, which drop the component (named in the log).
    const bad: string[] = [];
    for (const [key, raw] of Object.entries(c)) {
      if (key === 'id' || key === 'component') continue;
      if (!PROPS[type].includes(key)) {
        dropped.push(`${type}.${key}`);
        continue;
      }
      // A Compare's need written as a bare path ("/reagent/make") is the binding it means.
      const value = key === 'need' && typeof raw === 'string' && raw.startsWith('/') ? { path: raw } : raw;
      if (isBinding(value)) {
        // Only words and amounts may be bound; a structure (children, a step) is the model's to write.
        if (kit && paths.has(value.path) && ['text', 'need'].includes(key)) out[key] = { path: value.path };
        else bad.push(key);
        continue;
      }
      switch (key) {
        case 'children':
          if (Array.isArray(value) && value.every(v => typeof v === 'string')) out.children = value;
          else bad.push(key);
          break;
        case 'child':
          if (typeof value === 'string') out.child = value;
          else bad.push(key);
          break;
        case 'text':
          if (typeof value === 'string' && value.trim() && ownWords(value)) out.text = value.trim();
          else bad.push(key);
          break;
        case 'variant':
          // A ChoicePicker picks one, whatever its variant says.
          if (type === 'Text') out.variant = (TEXT_VARIANTS as readonly unknown[]).includes(value) ? value : /^h[1-5]$/.test(String(value)) ? 'h3' : 'body';
          break;
        case 'options': {
          const options = Array.isArray(value)
            ? value.flatMap((o): Choice[] => {
                const label = typeof o === 'string' ? o : typeof o?.label === 'string' ? o.label : '';
                const v = typeof o?.value === 'string' && o.value.trim() ? o.value.trim() : label.trim();
                return label.trim() && label.length <= 60 && choiceWords(label) ? [{ label: label.trim(), value: v.slice(0, 60) }] : [];
              })
            : [];
          const unique = options.filter((o, i) => options.findIndex(p => p.label === o.label) === i).slice(0, 4);
          if (unique.length >= 2) out.options = unique;
          else bad.push(key);
          break;
        }
        case 'fields': {
          const fields = Array.isArray(value) ? [...new Set(value.filter((f): f is AskField => (ASK_FIELDS as readonly unknown[]).includes(f)))] : [];
          if (fields.length) out.fields = fields;
          else bad.push(key);
          break;
        }
        case 'samples':
        case 'replicates':
        case 'standardReplicates': {
          const n = Number(value);
          const max = key === 'samples' ? 96 : 4;
          // Numbers the user named ("what if 30 samples"); any other is dropped and the card shows the run's plan.
          if (Number.isInteger(n) && n >= 1 && n <= max && said.has(n)) out[key] = n;
          else if (value !== 0 && value !== null && value !== '') dropped.push(`${type}.${key}`);
          break;
        }
        case 'stepId':
          if (type === 'TimerCard' ? step(value)?.timer : step(value)) out.stepId = value;
          else bad.push(key);
          break;
        case 'have': {
          // What the user has, as they said it; a bare number ("15") takes its unit from their words ("15 mL").
          const have = typeof value === 'number' || (typeof value === 'string' && !/[a-zµμ]/i.test(value)) ? amountSaid(rules.said, Number(String(value).replace(/,/g, ''))) : value;
          if (typeof have === 'string' && numbersIn(have).length && ownWords(have)) out.have = have.trim();
          else bad.push(key);
          break;
        }
        case 'justify':
        case 'align':
        case 'axis':
          if (typeof value === 'string') out[key] = value;
          break;
        default:
          bad.push(key);
      }
    }
    // What each component cannot do without.
    if (type === 'Text' && out.text === undefined && !bad.includes('text')) bad.push('no text');
    if (type === 'ChoicePicker' && out.options === undefined && !bad.includes('options')) bad.push('no options');
    if (type === 'Ask' && out.fields === undefined && !bad.includes('fields')) bad.push('no fields');
    if ((type === 'StepCard' || type === 'TimerCard') && out.stepId === undefined && !bad.includes('stepId')) bad.push('no stepId');
    if (type === 'Compare' && out.need !== undefined && !VOLUME_PATHS.includes((out.need as Binding).path)) bad.push('need not a volume');
    if (type === 'Compare' && (out.need === undefined || out.have === undefined) && !bad.length) bad.push(out.need === undefined ? 'no need' : 'no have');
    if (bad.length) dropped.push(`${type} ${id} (${bad.join(', ')})`);
    else kept.set(id, out);
  }

  // Unlink what is gone, until nothing changes: a Card whose child went, a Column left empty, go too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, c] of kept) {
      if (Array.isArray(c.children)) {
        const children = (c.children as string[]).filter(ref => kept.has(ref) && ref !== id);
        if (children.length !== c.children.length) c.children = children;
        if (!children.length) {
          kept.delete(id);
          changed = true;
        }
      } else if (c.component === 'Card' && (typeof c.child !== 'string' || !kept.has(c.child) || c.child === id)) {
        kept.delete(id);
        changed = true;
      }
    }
  }
  if (!kept.has('root')) {
    if (found.length) dropped.push('no root');
    return { messages: [], dropped };
  }

  // Only what hangs from root, each once (a component reached twice, or a loop, is not drawn twice).
  const reached: A2uiComponent[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    const c = kept.get(id);
    if (!c || seen.has(id)) return;
    seen.add(id);
    reached.push(c);
    for (const ref of [...((c.children as string[] | undefined) ?? []), ...(typeof c.child === 'string' ? [c.child] : [])]) walk(ref);
  };
  walk('root');
  if (reached.length < kept.size) dropped.push('unreached');
  for (const c of reached) if (Array.isArray(c.children)) c.children = (c.children as string[]).filter(ref => seen.has(ref));

  return {
    messages: [
      { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: CATALOG_ID } },
      { version: A2UI_VERSION, updateComponents: { surfaceId, components: reached.slice(0, 40) } },
    ],
    dropped,
  };
}

/** The surface's components by id, from its messages (the last updateComponents for an id wins). */
export function componentsOf(messages: readonly A2uiMessage[]): Map<string, A2uiComponent> {
  const out = new Map<string, A2uiComponent>();
  for (const m of messages) if ('updateComponents' in m) for (const c of m.updateComponents.components) out.set(c.id, c);
  return out;
}
