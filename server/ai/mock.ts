import { CATALOG_ID, type A2uiMessage } from '../../shared/a2ui.ts';
import type { Action, AIProvider, ConverseContext, ConverseReply, FoundProtocol, ImportedProtocol, Source } from '../../shared/ai.ts';
import { MAX_REPLICATES, MAX_SAMPLES } from './schema.ts';
import { mockReadPlate } from './plate.ts';
import { createMockKitVision } from './vision.ts';
import { answerFromManual, bcaFacts, loadProtocol, localProtocolId, manualSources, runNumbers } from './protocols.ts';
import { UpstreamError } from './provider.ts';
import { introFromProtocol } from './import.ts';

/**
 * Fixed answers built from the BCA kit, so every screen and the whole voice loop work without a key or a network.
 * Converse understands a handful of things by keywords, in English and Chinese; everything else gets a suggestion of
 * what to say. Deterministic: the same request always gets the same reply.
 */

/** The sentence on the Listening artboard. */
export const MOCK_TRANSCRIPT = 'I just got a Pierce BCA protein assay kit. Help me run it';

const words: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

const isChinese = (text: string) => /[㐀-鿿]/.test(text);

/** "12 samples", "twelve samples", "12 個樣本" → 12. */
function samplesIn(text: string): number | undefined {
  const m = /(\d+|[a-z]+)\s*(?:samples?|unknowns?)\b/i.exec(text) ?? /(\d+)\s*(?:個|组|組)?\s*(?:樣本|樣品|样本|样品)/.exec(text);
  if (!m) return undefined;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
  return n || undefined;
}

/** "in triplicate", "duplicates", "3 replicates", "三重複" → 3, 2, 3, 3. */
function replicatesIn(text: string): number | undefined {
  if (/\btriplicates?\b|三重複|三重复|做三次|三個重複/i.test(text)) return 3;
  if (/\bduplicates?\b|兩重複|二重複|两重复|做兩次|兩個重複/i.test(text)) return 2;
  if (/\bquadruplicates?\b|四重複/i.test(text)) return 4;
  const m = /(\d+|[a-z]+)\s*replicates?\b/i.exec(text);
  if (!m) return undefined;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
  return n || undefined;
}

const reply = (say: string, extra: Partial<ConverseReply> = {}): ConverseReply => ({
  say, expression: 'neutral', actions: [], sources: [], ...extra,
});

/** The working reagent as Muse Spark draws it (A2UI v0.9, Chapp's ReagentCard): for the run, or for the samples asked about. */
export function reagentSurface(samples?: number): A2uiMessage[] {
  return [
    { version: 'v0.9', createSurface: { surfaceId: 'answer', catalogId: CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId: 'answer', components: [{ id: 'root', component: 'ReagentCard', ...(samples ? { samples } : {}) }] } },
  ];
}

function converse(text: string, context: ConverseContext): ConverseReply {
  const zh = isChinese(text);
  const bca = bcaFacts();
  const doc = loadProtocol(bca.id);
  const manual: Source = { url: bca.source.url, title: bca.source.title };
  const procedure = doc?.procedures.find(p => p.id === doc.defaults.procedure);

  // Short bench commands first: "next" must not be mistaken for anything else.
  if (/\bnext\b|下一步|下一個/i.test(text)) {
    const at = context.step === undefined ? undefined : context.step + 1;
    const step = at === undefined ? undefined : procedure?.steps[at];
    const say = step ? (zh ? `第 ${at! + 1} 步：${step.title}。` : `Step ${at! + 1}: ${step.title}.`) : zh ? '好，下一步。' : 'Next step.';
    return reply(say, { actions: [{ type: 'nextStep' }] });
  }
  if (/\b(previous|go back|back one)\b|上一步/i.test(text)) {
    return reply(zh ? '好，回到上一步。' : 'Going back a step.', { actions: [{ type: 'previousStep' }] });
  }

  // How much working reagent: a card the app works out (A2UI), and words that point at it.
  const open = context.protocolId ? loadProtocol(context.protocolId) : null;
  if (open && /working reagent|工作液/i.test(text) && /how much|enough|need|多少|夠/i.test(text)) {
    const asked = samplesIn(text);
    return reply(zh ? '要配的工作液在這裡，照你的計畫算好了。' : "Here's the working reagent to make, worked out for your plan.", {
      expression: 'happy',
      a2ui: reagentSurface(asked !== undefined && asked <= MAX_SAMPLES ? asked : undefined),
    });
  }

  // A question about the kit while its protocol is open, or at the bench something seen ("it turned cloudy when I
  // added B"): answered from the manual's own notes and steps, with the page it is on.
  const question = /[?？]\s*$|^\s*(?:what|why|how|when|where|which|who|is|are|can|could|should|do|does|did|will|would|may|must|if)\b/i.test(text);
  if (open && (question || /^run/i.test(context.screen))) {
    const answer = answerFromManual(open, text, { least: question ? 2 : 3 });
    if (answer) return reply(answer.say, { expression: answer.expression, sources: [answer.source] });
  }

  const samples = samplesIn(text);
  const replicates = replicatesIn(text);
  const tooMany = (samples ?? 0) > MAX_SAMPLES || (replicates ?? 0) > MAX_REPLICATES;
  const plan: Action[] = [];
  if (samples !== undefined && !tooMany) plan.push({ type: 'setSamples', samples });
  if (replicates !== undefined && !tooMany) plan.push({ type: 'setReplicates', replicates });

  if (/\bbca\b|\bpierce\b|protein assay|蛋白質?定量/i.test(text)) {
    return reply(
      zh ? '我找到 Thermo Fisher 的 Pierce BCA 說明書了，我們來看步驟。' : "I found Thermo Fisher's user guide for the Pierce BCA kit. Let's look at the protocol.",
      { expression: 'happy', actions: [{ type: 'navigate', to: '/protocol' }, ...plan], sources: [manual] },
    );
  }

  if (samples !== undefined || replicates !== undefined) {
    const n = samples ?? context.samples;
    const r = replicates ?? context.replicates;
    const run = !tooMany && doc && procedure && n && r ? runNumbers(doc, procedure.id, n, r) : undefined;
    if (tooMany || run === null) {
      // More wells than one plate holds: say so instead of changing the plan.
      return reply(zh ? '這樣一盤 96 孔放不下。要少一點樣本，還是改成兩重複？' : "That won't fit on one 96-well plate. Fewer samples, or duplicates instead?", { expression: 'thinking' });
    }
    const times = zh ? ['', '不重複', '兩重複', '三重複', '四重複'] : ['', 'once each', 'in duplicate', 'in triplicate', 'in quadruplicate'];
    const heard = zh
      ? `好，${[n ? `${n} 個樣本` : '', r ? times[r] : ''].filter(Boolean).join('、')}。`
      : `Got it, ${[n ? `${n} samples` : '', r ? times[r] : ''].filter(Boolean).join(' ')}.`;
    const numbers = run ? (zh ? `總共 ${run.wells} 孔，工作液 ${run.workingReagent}。` : ` That's ${run.wells} wells and ${run.workingReagent} of working reagent.`) : '';
    return reply(heard + numbers, { expression: 'happy', actions: plan, sources: run ? [manual] : [] });
  }

  if (/^\s*(hi|hello|hey|good (morning|afternoon|evening))\b|^\s*(你好|嗨|哈囉|哈啰|早安|午安|晚安)/i.test(text)) {
    if (context.protocolId && /^run/i.test(context.screen)) {
      return reply(zh ? '嗨！準備好就說「下一步」。' : 'Hi! Say "next" whenever you\'re ready for the next step.', { expression: 'happy' });
    }
    if (context.protocolId) {
      return reply(zh ? '嗨！要開始 BCA 了嗎？告訴我你有幾個樣本，要做幾重複。' : 'Hi! Ready to plan your BCA run? Tell me how many samples you have, and duplicates or triplicates.', { expression: 'happy' });
    }
    return reply(zh ? '嗨！告訴我你手上是哪一盒 kit，例如「Pierce BCA」，我去找說明書。' : 'Hi! Tell me which kit you\'re running, like "Pierce BCA", and I\'ll find its manual.', { expression: 'happy' });
  }

  return reply(
    zh ? '我可以帶你做 kit 實驗。試試說「我拿到一盒 Pierce BCA」，或「12 個樣本，三重複」。' : 'I can help you run a kit. Try "I got a Pierce BCA kit", or "12 samples in triplicate".',
    { expression: 'thinking' },
  );
}

function findProtocol(query: string): FoundProtocol {
  const bca = bcaFacts();
  const s = bca.source;
  const catalog = bca.catalogs.find(c => query.toUpperCase().includes(c)) ?? bca.catalogs[0];
  const version = `${s.docId} rev. ${s.revision}, ${s.date}`;
  const kit = { vendor: bca.vendor, catalog, name: bca.name };
  const document = { title: s.title, version, url: s.url };
  const protocolId = localProtocolId({ kit, document });
  return {
    found: true,
    kit,
    document,
    ...(protocolId ? { protocolId } : {}),
    progress: [
      `Looking for ${s.publisher}'s own manual for the ${bca.name}.`,
      `Found the user guide (${s.docId} rev. ${s.revision}). Opening it to check the steps.`,
    ],
    answer: `${s.title} (${version}), microplate procedure:\n${bca.overview.map((line, i) => `${i + 1}. ${line}`).join('\n')}`,
    sources: [{ url: s.url, title: s.title }],
  };
}

export function createMockProvider(): AIProvider {
  return {
    transcribe: async () => ({ transcript: MOCK_TRANSCRIPT }),
    converse: async ({ text, context }) => converse(text, context),
    findProtocol: async query => findProtocol(query),
    readPlate: mockReadPlate,
    ...createMockKitVision(),
    importProtocol: async (_pdf, _source, live) => {
      // Instant, but in the same order as the real reading: what the kit is first, then the protocol.
      const imported = mockImport();
      live?.onIntro?.(introFromProtocol(imported.protocol));
      return imported;
    },
  };
}

/** Any manual reads as the BCA document (data/protocols/pierce-bca.json), which is already on this machine. */
function mockImport(): ImportedProtocol {
  const protocol = loadProtocol(bcaFacts().id);
  if (!protocol) throw new UpstreamError('The mock reads every manual as the BCA protocol, which is not on this machine (data/protocols/)');
  return { protocol, problems: [], sources: manualSources(protocol) };
}
