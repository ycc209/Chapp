/**
 * Small, metered live acceptance run for the conversational assistant.
 *
 * Preview without a key or network:
 *   node scripts/bench/assistant-check.ts --dry-run
 * Run selected conversations (writes only data/bench/assistant/):
 *   node --env-file-if-exists=.env scripts/bench/assistant-check.ts --only chat,science
 *
 * This exercises the production provider. Browser actions run against a synthetic context here, never the user's
 * actual experiment. Offline client tests cover applying receipts to the real state. Automated checks establish
 * tool/state behavior; the saved answers and rubrics still require a human review of scientific correctness.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Action, ConverseContext, ConverseLive, ConverseReply, ConverseTurn } from '../../shared/ai.ts';
import { readEvents } from '../../shared/sse.ts';
import { createMetaProvider } from '../../server/ai/meta.ts';
import { UpstreamError } from '../../server/ai/provider.ts';
import { costOf, meter, PER, usageOf } from '../../server/ai/usage.ts';

type Json = Record<string, any>;
type Case = { id: string; context: ConverseContext; turns: string[]; review: string[] };
const home: ConverseContext = { screen: 'chat' };
const run: ConverseContext = { screen: 'plan', protocolId: 'pierce-bca', procedure: 'microplate', samples: 12, replicates: 2, standardReplicates: 2, standards: 'kit' };

const cases: Case[] = [
  {
    id: 'chat', context: home,
    turns: ['今天做什麼都卡卡的，先陪我聊一下好嗎？我現在不想討論實驗。'],
    review: ['Respond naturally to the mood without forcing a kit, protocol, or task.', 'Do not search the web or change a run.'],
  },
  {
    id: 'chat_repair', context: home,
    turns: ['今天只想聊點輕鬆的，幫我給窗邊那盆植物取兩個不同風格的名字。先別提工作。', '我偏愛第二個，不過名字換成阿葉，其他先照你剛才那個風格。', '最後選的是哪個名字？只回答名字。'],
    review: ['Offer two different naming styles without bringing up work or experiments.', 'Resolve the second option from the actual preceding answer, preserving its style while changing the name to 阿葉.', 'The last answer should contain only the final name 阿葉.', 'Do not search the web or alter an experiment.'],
  },
  {
    id: 'chat_weekend', context: home,
    turns: ['我們來編一個不用真的出門的週末小旅行：星期六去虛構的雲朵鎮看海，星期日在家看電影。幫這趟想像旅行取兩個不同風格的名字，不用找真實景點。', '我喜歡第二個名字的感覺，但旅行改叫慢慢號；行程也對調，星期六在家看電影，星期日才去雲朵鎮看海。', '最後旅行叫什麼？星期六和星期日各做什麼？照剛剛改好的版本，簡短回答。'],
    review: ['Continue a playful fictional conversation without searching for real travel recommendations or introducing experiments.', 'Preserve the selected second naming style while applying the explicit name change to 慢慢號.', 'Resolve both corrections: Saturday is movies at home; Sunday is the imaginary seaside visit to 雲朵鎮.', 'Do not alter a real experiment.'],
  },
  {
    id: 'science', context: home,
    turns: ['為什麼標準曲線的 R² 很漂亮，樣本濃度還是可能不可靠？請分成幾個原因，解釋背後的機制，不要只給結論。', '你剛剛提到的第二個原因，可以用一個容易理解的例子說明嗎？'],
    review: ['Distinguish calibration fit from accuracy, range, interference and handling without treating R² as proof.', 'Resolve “the second reason” from the actual prior answer.', 'No unnecessary brand/catalog-number question or run mutation.'],
  },
  {
    id: 'science_challenge', context: home,
    turns: ['樣本稀釋 1:2、1:4、1:8，校正回原濃度是 200／140／90，這能直接判定是基質抑制嗎？如果標準母液整批比標示低 30%，用同一批標準回算抓得出來嗎？請解釋推論的限制與怎麼獨立驗證，先不要修改實驗。'],
    review: ['Do not infer matrix suppression solely from the declining dilution-corrected values; distinguish observations from possible causes and acknowledge missing assay details.', 'Explain why fitting or back-calculating the same biased calibrators cannot independently establish their true concentration.', 'Propose an independent reference or check, with appropriate qualifications and real supporting sources.', 'Do not silently change an experiment or fabricate measured evidence.'],
  },
  {
    id: 'science_purity', context: home,
    turns: ['DNA 的 A260/A280 是 1.8，為什麼 PCR 還是可能擴不出來？請解釋原因，別只給結論。', '所以光看那個比值就能排除抑制物了，對嗎？'],
    review: ['Explain why a purity ratio does not by itself establish PCR suitability, with relevant mechanisms and uncertainty rather than a diagnosis from the ratio alone.', 'Correct the follow-up misconception: that ratio alone cannot exclude PCR inhibitors.', 'Review the actual source relevance and scientific claims manually; source presence alone does not establish correctness.', 'Do not change an experiment.'],
  },
  {
    id: 'science_qpcr', context: home,
    turns: ['qPCR 陰性對照也晚晚出現訊號，是不是一定污染？SYBR 和 probe 判讀有什麼不同？請引用能查到原文的資料，分清楚證據、可能原因和你的推論。', '所以只要 Ct 大於 35 就直接當陰性嗎？'],
    review: ['Do not infer contamination solely from late negative-control amplification; explain competing possibilities and what further evidence would distinguish them.', 'Keep SYBR dye-based detection and probe-based detection distinct; describe relevant control or curve information without treating a possibility as an established diagnosis.', 'Reject a universal Ct > 35 negative rule. Interpret the assay using its validated conditions, controls and stated limits rather than a shared cutoff for every method.', 'Review the actual original-text support for each important claim and clearly separate evidence from inference; source presence alone is not proof of correctness.', 'Do not change the current experiment.'],
  },
  {
    id: 'protocol', context: { ...run, screen: 'run', step: 2 },
    turns: ['幫我上網找 Thermo Scientific Pierce Bradford Protein Assay Kit 的原廠說明書，附原廠來源。我現在只是想看看，別切換或改動正在做的 BCA。'],
    review: ['Actually use web search and cite an original manufacturer source.', 'Identify which product/document was found; do not mix different Bradford products.', 'Keep the active BCA run and its plan unchanged.'],
  },
  {
    id: 'protocol_alt', context: { ...run, screen: 'run', step: 2 },
    turns: ['我手上是 NEB Q5 High-Fidelity 2X Master Mix，M0492。幫我找原廠 PCR protocol，給我連結；我只是比較，不要動目前 BCA。'],
    review: ['Actually search and provide an original NEB protocol link for Q5 High-Fidelity 2X Master Mix, M0492.', 'Verify the exact product and format rather than substituting another Q5 product.', 'Keep the active BCA protocol, run progress and plan unchanged.'],
  },
  {
    id: 'protocol_qiagen', context: { ...run, screen: 'run', step: 2 },
    turns: ['幫我找 QIAGEN DNeasy Blood & Tissue Kit，貨號 69504 的官方 handbook，給我原廠原文連結，並確認它適用這個 kit。我只是比較，不要切換或改動目前的 BCA。'],
    review: ['Find and read the original QIAGEN handbook appropriate for DNeasy Blood & Tissue Kit, catalog 69504.', 'Provide the official original-text link and distinguish an actual document read from a search snippet or product-page listing.', 'Keep the active BCA protocol, run progress and plan unchanged.'],
  },
  {
    id: 'followup', context: home,
    turns: ['我們先約定一下：樣本 A 的暱稱是海星，樣本 B 叫月亮。這只是聊天裡的代稱，不要修改任何實驗。', '我剛剛說的後者叫什麼？只告訴我名稱就好。'],
    review: ['Remember that the latter sample was B, called 月亮.', 'Do not turn a conversational naming convention into a run edit.'],
  },
  {
    id: 'actions', context: run,
    turns: ['每份樣本改做三次會占多少孔？先替我算算，我還沒決定，別動現在的安排。', '好，我選剛剛那個三次的安排，幫我套用。'],
    review: ['First turn calculates a hypothetical plan without applying it.', 'Second turn resolves the prior option and changes replicates after synthetic execution succeeds.', 'Never claim successful mutation before a receipt.'],
  },
  {
    id: 'actions_repair', context: run,
    turns: ['原本十二份有一份取消，幫我改成十一份；每份仍做兩次，標準品別動。', '剛剛我講反了，取消的是備用管，正式樣本其實還是十二份，幫我改回；其餘照舊。'],
    review: ['Apply eleven samples first, then resolve the correction and restore twelve samples.', 'Keep sample and standard replicates at two throughout, preserving every unrelated run field.', 'Claim completion only after the synthetic browser returns the actual execution result.'],
  },
  {
    id: 'actions_count_repair', context: run,
    turns: ['十二份裡有兩份這次先不做，幫我改成十份，每份仍做兩次；標準品維持原本兩次，其他安排別動。', '我剛確認那兩份也要一起做，正式樣本改回十二份；其餘完全照舊。'],
    review: ['Apply ten samples, then resolve the correction and restore twelve samples, using successful execution receipts.', 'Keep sample and standard replicates at two throughout and preserve every unrelated run field.', 'Accept a valid undo or explicit count correction when its receipt and final state match the requested result.'],
  },
  {
    id: 'parallel', context: run,
    turns: ['請分別讀目前實驗的狀態，以及這份 kit 的原廠 protocol；這兩件可以一起查。接著告訴我目前的重複數、文件版本和出處，先不要更動設定。'],
    review: ['Read state and protocol through tools; combine both results and their sources.', 'Record whether multiple independent function calls were requested in the same response.', 'Absence of parallel calls is an observation, not a claim that the API cannot do it.'],
  },
];

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
};
const selectedNames = flag('--only', cases.map(c => c.id).join(',')).split(',');
const selected = cases.filter(c => selectedNames.includes(c.id));
const budget = Number(flag('--budget', '0.25'));
const maxCalls = Number(flag('--max-calls', '14'));
const stream = args.includes('--stream');
if (!selected.length || selectedNames.some(id => !cases.some(c => c.id === id))) throw new Error(`Unknown or empty case selection. Use ${cases.map(c => c.id).join(',')}.`);
if (!(budget > 0 && budget <= 0.5) || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 14) throw new Error('Use a budget up to $0.50 and at most 14 responses calls.');

if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ budgetUsd: budget, maxResponsesCalls: maxCalls, stream, cases: selected }, null, 2));
  process.exit(0);
}

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is required for the live run. --dry-run needs no key.');
const redact = (text: string) => text.split(apiKey).join('[redacted]');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = fileURLToPath(new URL(`../../data/bench/assistant/${stamp}/`, import.meta.url));
mkdirSync(directory, { recursive: true });

type RecordedCall = { caseId: string; turn: number; model: string; request: Json; response?: Json; error?: string; seconds: number; usage: ReturnType<typeof usageOf>; estimatedCostUsd: number };
const calls: RecordedCall[] = [];
const recordings: Promise<void>[] = [];
const results: Json[] = [];
let active = { caseId: '', turn: 0 };
let spent = 0;
let reserved = 0;
let startedCalls = 0;
meter.setCap(budget);

async function responseBody(raw: string, contentType: string): Promise<Json> {
  if (!contentType.includes('text/event-stream')) {
    try { return JSON.parse(raw) as Json; } catch { return { unparsed: raw.slice(0, 1000) }; }
  }
  let last: Json = {};
  for await (const event of readEvents(new Response(raw).body!)) {
    if (event.data === '[DONE]') continue;
    try {
      const item = JSON.parse(event.data) as Json;
      if (item.response) last = item.response;
    } catch { /* The provider itself validates an incomplete stream. */ }
  }
  return last;
}

/** Observe program-produced evidence outputs; progress text alone never establishes that a source was read. */
function evidenceObservations(turnCalls: RecordedCall[], allCalls: RecordedCall[]) {
  const names = new Map<string, string>();
  for (const call of allCalls) for (const item of call.response?.output ?? []) if (item.type === 'function_call') names.set(item.call_id, item.name);
  const snapshots: Json[] = [], failures: Json[] = [], reviews: Json[] = [];
  const parse = (value: unknown): Json | null => {
    if (typeof value !== 'string') return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
  };
  const snapshot = (data: Json | null, origin: Json) => {
    if (!data) return;
    if (Array.isArray(data.sources) && Array.isArray(data.excerpts)) snapshots.push({ ...origin,
      sources: data.sources.map((s: Json) => ({ id: s.id, title: s.title, status: s.status, format: s.format, fetchedAt: s.fetchedAt, truncated: s.truncated })),
      excerpts: data.excerpts.map((e: Json) => ({ id: e.id, sourceId: e.sourceId, page: e.page, characters: typeof e.text === 'string' ? e.text.length : 0 })),
    });
    for (const failure of data.readFailures ?? []) failures.push({ ...origin, ...failure });
    if (data.original?.status === 'unread') failures.push({ ...origin, sourceId: data.document?.sourceId, reason: data.original.reason });
    if (data.ok === false && ['read_source', 'research_science', 'find_protocol'].includes(origin.tool)) failures.push({ ...origin, reason: data.error });
    if (data.original && typeof data.original === 'object') snapshot(data.original, origin);
  };
  for (const call of turnCalls) {
    for (const input of Array.isArray(call.request.input) ? call.request.input : []) if (input.type === 'function_call_output') snapshot(parse(input.output), { tool: names.get(input.call_id), callId: input.call_id });
    if (call.request.text?.format?.name === 'evidence_review') {
      snapshot(parse(call.request.input)?.evidence ?? null, { tool: 'evidence_review', responseId: call.response?.id });
      const text = (call.response?.output ?? []).filter((i: Json) => i.type === 'message' && i.phase !== 'commentary').flatMap((i: Json) => i.content ?? []).filter((p: Json) => p.type === 'output_text').map((p: Json) => p.text).join('\n');
      const reviewed = parse(text);
      reviews.push({ responseId: call.response?.id, status: call.response?.status, parsed: Boolean(reviewed),
        paragraphs: reviewed?.paragraphs?.map((p: Json) => ({ id: p.id, kind: p.kind })),
        citations: reviewed?.citations?.map((c: Json) => ({ paragraphId: c.paragraphId, ref: c.ref, quote: c.quote })),
      });
    }
  }
  return { snapshots, readFailures: failures, reviews, observationLimit: 'These record source reads and review outputs, not scientific entailment. Original excerpts and exact requests remain in calls.json for manual review.' };
}

const meteredFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== 'https://api.meta.ai/v1/responses') throw new UpstreamError('This acceptance run permits only Meta Responses requests.');
  if (startedCalls >= maxCalls) throw new UpstreamError(`Acceptance call cap reached (${maxCalls}).`);
  const body = JSON.parse(String(init?.body)) as Json;
  body.max_output_tokens = Math.min(body.max_output_tokens ?? 6000, 6000);
  body.max_tool_calls = Math.min(body.max_tool_calls ?? 3, 3);
  const model = body.model as string;
  if (model !== 'muse-spark-1.3') throw new UpstreamError('This small acceptance run uses only muse-spark-1.3.');
  const searches = body.tools?.some((t: Json) => t.type === 'web_search') ? body.max_tool_calls : 0;
  // Reserve conservatively for request bytes, maximum output, and retrieved text. This is a spend guard based on
  // estimated tokens, not a billing guarantee; every finished response replaces its reservation with actual usage.
  const reserve = Buffer.byteLength(JSON.stringify(body), 'utf8') * 1.25 / 1e6 + body.max_output_tokens * 4.25 / 1e6 + searches * (PER.search + 16_000 * 1.25 / 1e6);
  // A provider can consume response.completed just before the cloned recording reaches EOF.
  // If its still-held reservation is the only obstruction, settle recorded calls before
  // deciding whether another call fits. This waits only when the reservation cap is full.
  if (spent + reserved + reserve > budget && reserved > 0) await Promise.allSettled(recordings);
  // Independent searches can reach this check together; recheck the call cap after waiting.
  if (startedCalls >= maxCalls) throw new UpstreamError(`Acceptance call cap reached (${maxCalls}).`);
  if (spent + reserved + reserve > budget) throw new UpstreamError(`Acceptance budget guard stopped before another request ($${spent.toFixed(4)} spent, $${reserved.toFixed(4)} reserved, next request estimate $${reserve.toFixed(4)}, $${budget.toFixed(2)} limit).`);
  reserved += reserve;
  startedCalls++;
  const record: RecordedCall = { ...active, model, request: body, seconds: 0, usage: null, estimatedCostUsd: 0 };
  calls.push(record);
  const start = performance.now();
  const finish = () => {
    reserved -= reserve;
    record.seconds = (performance.now() - start) / 1000;
    writeFileSync(`${directory}/calls.json`, redact(JSON.stringify(calls, null, 2)));
  };
  try {
    const response = await fetch(url, { ...init, body: JSON.stringify(body) });
    // A separate stream branch records usage while the provider receives bytes immediately.
    // Reading the whole body here would turn a streaming run into a false latency measurement.
    const copy = response.clone();
    const recording = (async () => {
      try {
        const raw = await copy.text();
        record.response = await responseBody(raw, copy.headers.get('content-type') ?? '');
        record.usage = usageOf(record.response);
        record.estimatedCostUsd = costOf(model, record.response);
        spent += record.estimatedCostUsd;
      } catch (error) {
        record.error = redact(error instanceof Error ? error.message : String(error));
      } finally {
        finish();
      }
    })();
    recordings.push(recording);
    return response;
  } catch (error) {
    record.error = redact(error instanceof Error ? error.message : String(error));
    finish();
    throw error;
  }
}) as typeof fetch;

const provider = createMetaProvider({ apiKey, fetch: meteredFetch, log: line => console.log(redact(line)), timeouts: { converse: 90_000, attempt: 60_000, findProtocol: 60_000 } });

function simulate(action: Action, context: ConverseContext, undoStack: ConverseContext[]): { ok: boolean; message: string } {
  if (action.type === 'undo') {
    const previous = undoStack.pop();
    if (!previous) return { ok: false, message: 'Synthetic browser has no preceding simulated change to undo; the context is unchanged.' };
    for (const key of Object.keys(context)) Reflect.deleteProperty(context, key);
    Object.assign(context, structuredClone(previous));
    return { ok: true, message: `Synthetic browser restored the preceding simulated state: samples=${context.samples}, sample replicates=${context.replicates}, standard replicates=${context.standardReplicates}.` };
  }
  if (action.type === 'setSamples') {
    const previous = structuredClone(context);
    context.samples = action.samples;
    if (JSON.stringify(previous) !== JSON.stringify(context)) undoStack.push(previous);
    return { ok: true, message: `Synthetic browser applied samples=${action.samples}.` };
  }
  if (action.type === 'setReplicates') {
    const previous = structuredClone(context);
    const previousStandards = context.standardReplicates ?? context.replicates;
    context.replicates = action.replicates;
    context.standardReplicates = action.standardReplicates ?? previousStandards;
    if (JSON.stringify(previous) !== JSON.stringify(context)) undoStack.push(previous);
    return { ok: true, message: `Synthetic browser applied sample replicates=${action.replicates}; standard replicates=${context.standardReplicates}.` };
  }
  return { ok: false, message: `Synthetic browser declined ${action.type}; no actual user run is available in this acceptance harness.` };
}

try {
  for (const sample of selected) {
    const context = structuredClone(sample.context);
    // Each conversation owns its simulated undo history. Unsupported actions and no-ops
    // cannot hide a real change or create a checkpoint from another acceptance case.
    const undoStack: ConverseContext[] = [];
    const history: ConverseTurn[] = [];
    let previousResponseId: string | undefined;
    const record: Json = { id: sample.id, review: sample.review, syntheticBrowser: true, turns: [] };
    results.push(record);
    for (const [index, text] of sample.turns.entries()) {
      active = { caseId: sample.id, turn: index + 1 };
      const firstCall = calls.length;
      const before = structuredClone(context);
      const start = performance.now();
      const turn: Json = { text, before, pending: [], applied: [], progress: [], streamedText: '' };
      record.turns.push(turn);
      const live: ConverseLive = stream ? {
        onText: delta => {
          turn.firstTextSeconds ??= (performance.now() - start) / 1000;
          turn.streamedText += delta;
        },
        onProgress: line => turn.progress.push({ seconds: (performance.now() - start) / 1000, line }),
      } : {};
      let reply: ConverseReply = await provider.converse({ text, context, history, previousResponseId }, live);
      for (let round = 0; reply.pendingTools?.length; round++) {
        if (round >= 3) throw new Error('More than three browser continuations for one turn.');
        turn.pending.push(structuredClone(reply));
        const toolResults = reply.pendingTools.map(t => {
          const outcome = simulate(t.action, context, undoStack);
          turn.applied.push({ action: t.action, ...outcome });
          return { callId: t.callId, ...outcome };
        });
        reply = await provider.converse({ text, context, history, previousResponseId: reply.responseId, continuationToken: reply.continuationToken, toolResults }, live);
      }
      turn.reply = reply;
      turn.after = structuredClone(context);
      turn.seconds = (performance.now() - start) / 1000;
      await Promise.all(recordings);
      const turnCalls = calls.slice(firstCall);
      turn.evidence = evidenceObservations(turnCalls, calls);
      turn.searches = turnCalls.reduce((sum, c) => sum + (c.response?.output ?? []).filter((o: Json) => o.type === 'web_search_call').length, 0);
      turn.maxFunctionsInOneResponse = Math.max(0, ...turnCalls.map(c => (c.response?.output ?? []).filter((o: Json) => o.type === 'function_call').length));
      turn.checks = { nonemptyAnswer: reply.say.trim().length > 0, noLegacyActions: reply.actions.length === 0 };
      const allowsRunChange = sample.id === 'actions_repair' || sample.id === 'actions_count_repair' || (sample.id === 'actions' && index === 1);
      if (!allowsRunChange) turn.checks.noRunChange = JSON.stringify(before) === JSON.stringify(context) && turn.applied.length === 0;
      if (sample.id === 'chat' || sample.id === 'chat_repair' || sample.id === 'chat_weekend') turn.checks.noUnneededSearch = turn.searches === 0;
      if (sample.id === 'chat_repair' && index === 2) turn.checks.resolvedRenamedChoice = reply.say.trim() === '阿葉';
      if (sample.id === 'chat_weekend' && index === 2) turn.checks.retainedFinalTripName = reply.say.includes('慢慢號');
      if (sample.id.startsWith('science')) {
        turn.sourceEvidence = { hasSources: reply.sources.length > 0, count: reply.sources.length, quotedSourceCount: reply.sources.filter(s => Boolean(s.quote)).length, manualScientificReviewRequired: true };
      }
      if (sample.id === 'protocol' || sample.id === 'protocol_alt' || sample.id === 'protocol_qiagen') {
        turn.checks.didSearch = turn.searches > 0;
        turn.checks.manufacturerCitation = reply.sources.some(s => {
          try {
            const url = new URL(s.url);
            if (url.protocol !== 'https:') return false;
            if (sample.id === 'protocol_alt') return url.hostname === 'neb.com' || url.hostname.endsWith('.neb.com');
            if (sample.id === 'protocol_qiagen') return url.hostname === 'qiagen.com' || url.hostname.endsWith('.qiagen.com');
            return url.hostname === 'thermofisher.com' || url.hostname.endsWith('.thermofisher.com') || url.hostname === 'assets.fishersci.com';
          } catch { return false; }
        });
      }
      if (sample.id === 'followup' && index === 1) turn.checks.resolvedReference = reply.say.includes('月亮');
      if (sample.id === 'actions' && index === 1) {
        turn.checks.appliedChosenPlan = context.replicates === 3 && turn.applied.some((a: Json) => a.ok && a.action.type === 'setReplicates');
        turn.checks.preservedStandardReplicates = context.standardReplicates === 2;
      }
      if (sample.id === 'actions_repair' || sample.id === 'actions_count_repair') {
        const reducedSamples = sample.id === 'actions_count_repair' ? 10 : 11;
        const expectedSamples = index === 0 ? reducedSamples : 12;
        turn.checks.correctStartingSamples = before.samples === (index === 0 ? 12 : reducedSamples);
        turn.checks.correctSampleCount = context.samples === expectedSamples;
        turn.checks.confirmedStateChange = turn.applied.some((a: Json) => a.ok);
        turn.checks.preservedSampleReplicates = context.replicates === 2;
        turn.checks.preservedStandardReplicates = context.standardReplicates === 2;
        turn.checks.noUnrelatedChanges = JSON.stringify(context) === JSON.stringify({ ...before, samples: expectedSamples });
      }
      previousResponseId = reply.responseId;
      history.push({ role: 'user', text }, { role: 'chapp', text: reply.say });
      console.log(`${sample.id}/${index + 1}: ${turn.seconds.toFixed(1)} s, ${turnCalls.length} call(s), ${turn.searches} search(es), ${JSON.stringify(turn.checks)}`);
      console.log(reply.say);
      writeFileSync(`${directory}/conversations.json`, redact(JSON.stringify(results, null, 2)));
    }
  }
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error));
  results.push({ stopped: message });
  console.error(message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(recordings);
  const failed = results.flatMap(r => r.turns ?? []).filter((t: Json) => t.checks && Object.values(t.checks).some(v => v === false));
  const stopped = results.filter(r => r.stopped).map(r => r.stopped);
  const incompleteResponses = calls.filter(c => c.response?.status === 'incomplete').length;
  const unfinishedTurns = results.flatMap(r => r.turns ?? []).filter((t: Json) => !t.reply).length;
  const succeeded = !failed.length && !stopped.length && !incompleteResponses && !unfinishedTurns;
  if (!succeeded) process.exitCode = 1;
  const summary = { at: new Date().toISOString(), maxCalls, calls: startedCalls, stream, budgetUsd: budget, estimatedSpentUsd: spent, succeeded, automatedFailures: failed.length, stopped, incompleteResponses, unfinishedTurns, manualReviewRequired: true, directory };
  writeFileSync(`${directory}/conversations.json`, redact(JSON.stringify(results, null, 2)));
  writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
