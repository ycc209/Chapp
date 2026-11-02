import { fileURLToPath } from 'node:url';
import type { Action, ConverseContext, ConverseRequest } from '../../shared/ai.ts';
import { procedureFor } from '../../src/screens/protocol/content.ts';
import { actionFromArguments } from './conversationTools.ts';
import { loadProtocol } from './protocols.ts';

/**
 * The embedding fast path. The few things said most often at the bench ("下一步", "next step", "開始計時") are
 * matched by sentence embedding against example phrasings, on the server, before the front assistant is called: a
 * sentence both close to one command and clearly closer to it than to any question, refusal or chat is performed
 * at once (the app still checks it, carries it out and reports back; a failure goes to the model to explain), and
 * anything else goes to the model as before. Only reversible operations are routed this way, only on the run screen,
 * only for short sentences. The model is multilingual-e5-small, run here by Transformers.js (about 20 ms a sentence
 * after it has loaded; the first start downloads it into data/models/). Aurelio's semantic-router does the same job
 * for chatbots.
 */

export type Embed = (texts: string[]) => Promise<number[][]>;
export type Router = {
  /** The one bench operation the sentence plainly asks for, or null: the model's turn. Never throws, never waits for the model to load. */
  route: (request: ConverseRequest) => Promise<Action | null>;
  /** How close the sentence is to each command and to the rest, for tuning (scripts/bench/router-check.ts). */
  score: (text: string) => Promise<Scores>;
  /** Loads the embedding model and the examples now rather than at the first command. */
  warm: () => Promise<void>;
};
export type Scores = { best: { kind: Kind; score: number }; other: number; routed: boolean };

type Kind = 'nextStep' | 'previousStep' | 'startTimer' | 'stopTimer' | 'resumeTimer';
type Route = { kind: Kind | 'other'; examples: string[] };

const MODEL = 'Xenova/multilingual-e5-small';
/**
 * Calibrated with scripts/bench/router-check.ts on 2026-10-31. This model's similarities crowd towards 1 ("下一步" is
 * 0.98 from "下一步要做什麼"), so a sentence is performed when it is all but one of the examples (SURE), or close to one
 * and clearly closer to it than to any question, refusal or chat (THRESHOLD and MARGIN).
 */
export const SURE = 0.99;
export const THRESHOLD = 0.9;
export const MARGIN = 0.025;
/** Longer sentences say more than a bare command: the model hears them. */
const MAX_CHARS = 24;

const ROUTES: Route[] = [
  { kind: 'nextStep', examples: ['下一步', '好 下一步', '好，下一步', '下一步吧', '好了，下一步', 'OK 下一步', '繼續下一步', '換下一步', '下一個步驟', '到下一步', 'next', 'next step', 'ok next', 'go on', 'go to the next step', 'move on', 'next one'] },
  { kind: 'previousStep', examples: ['上一步', '回上一步', '回到上一步', '前一步', '退回上一步', '回去上一步', 'previous step', 'go back a step', 'back one step', 'go back one', 'back to the previous step'] },
  { kind: 'startTimer', examples: ['開始計時', '計時開始', '幫我計時', '開始倒數', '按計時器', '計時器開始', '開始計時器', 'start the timer', 'start timer', 'timer start', 'begin the countdown', 'time it', 'start the clock'] },
  { kind: 'stopTimer', examples: ['暫停計時', '先停計時', '計時暫停', '停一下計時器', '把計時器停掉', '計時先停', 'pause the timer', 'stop the timer', 'hold the timer', 'pause the clock'] },
  { kind: 'resumeTimer', examples: ['繼續計時', '計時繼續', '恢復計時', '計時器繼續', '接著計時', 'resume the timer', 'continue the timer', 'restart the timer where it was', 'timer resume'] },
  { kind: 'other', examples: [
    '下一步要做什麼', '下一步是什麼', '下一步要加多少', '為什麼要下一步', '等一下', '先不要', '不要下一步', '還不要下一步', '先不要計時', '不要計時', '不用計時',
    '下一步嗎', '下一步呢', '可以下一步嗎', '下一步了嗎', '上一步呢', '什麼時候要下一步', '什麼時候開始計時', '什麼時候要計時', '何時計時', '現在要計時嗎', '要計時嗎',
    '這一步要做多久', '計時器剩多久', '還剩多少時間', '計時到了嗎', '上一步做了什麼', '上一步是什麼', '這步要幾分鐘', '下一步要等多久',
    'what is the next step', 'what comes next', "what's next", 'how long is this step', 'how much time is left', "don't go to the next step", 'not yet', 'wait',
    'why the next step', 'is the timer done', 'what was the previous step', 'should I start the timer', 'when do I start the timer',
    '你好', '謝謝', '好', '嗯', 'hello', 'thanks', 'ok', 'B 做完了', '12 個樣本', '加一個對照組', 'A B C 好了',
    '開始實驗', '開始做實驗', '我們開始吧', 'start the experiment', "let's start the experiment",
  ] },
];

const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

export function createRouter(options: { embed?: Embed; log?: (line: string) => void; cacheDir?: string; model?: string } = {}): Router {
  const log = options.log ?? (line => console.log(line));
  const model = options.model ?? MODEL;
  let embed: Embed | undefined = options.embed;
  let examples: { route: Route; vector: number[] }[] | null = null;
  let loading: Promise<void> | null = null;
  let retryAfter = 0;

  async function loadEmbed(): Promise<Embed> {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = options.cacheDir ?? fileURLToPath(new URL('../../data/models/', import.meta.url));
    const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
    return async texts => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      return out.tolist() as number[][];
    };
  }

  const load = () => loading ??= (async () => {
    const started = Date.now();
    try {
      embed ??= await loadEmbed();
      const flat = ROUTES.flatMap(route => route.examples.map(text => ({ route, text })));
      const vectors = await embed(flat.map(x => `query: ${x.text}`));
      examples = flat.map((x, i) => ({ route: x.route, vector: vectors[i]! }));
      log(`[route] ready in ${((Date.now() - started) / 1000).toFixed(1)} s (${model}, ${flat.length} examples)`);
    } catch (error) {
      retryAfter = Date.now() + 60_000;
      log(`[route] unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loading = null;
    }
  })();

  async function score(text: string): Promise<Scores> {
    if (!examples) await load();
    if (!examples || !embed) throw new Error('The router is not loaded.');
    const [vector] = await embed([`query: ${text.trim()}`]);
    let best = { kind: 'nextStep' as Kind, score: -1 }, other = -1;
    for (const example of examples) {
      const s = dot(vector!, example.vector);
      if (example.route.kind === 'other') other = Math.max(other, s);
      else if (s > best.score) best = { kind: example.route.kind, score: s };
    }
    return { best, other, routed: best.score >= SURE || (best.score >= THRESHOLD && best.score - other >= MARGIN) };
  }

  async function route(request: ConverseRequest): Promise<Action | null> {
    const text = request.text.trim();
    if (request.continuationToken || request.context.screen !== 'run' || !text || text.length > MAX_CHARS) return null;
    if (!examples) {
      if (!loading && Date.now() >= retryAfter) void load();
      return null;
    }
    const started = Date.now();
    try {
      const { best, other, routed } = await score(text);
      const action = routed ? actionFor(best.kind, request.context) : null;
      log(`[route] ${action ? action.type : `model (nearest ${best.kind})`} ${best.score.toFixed(2)} vs ${other.toFixed(2)} · ${Date.now() - started} ms`);
      return action;
    } catch (error) {
      log(`[route] failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return { route, score, warm: () => load() };
}

/** The operation, with the ids the run gives it, when the run is in a state where it makes sense; null otherwise. */
export function actionFor(kind: Kind, context: ConverseContext): Action | null {
  if (kind === 'nextStep' || kind === 'previousStep') return actionFromArguments({ type: kind }, context);
  const running = context.timers?.filter(t => t.secondsLeft > 0) ?? [];
  const paused = context.paused ?? [];
  if (kind === 'stopTimer') return running.length === 1 ? actionFromArguments({ type: kind, target: running[0]!.id }, context) : null;
  if (kind === 'resumeTimer') return paused.length === 1 ? actionFromArguments({ type: kind, target: paused[0]!.id }, context) : null;
  // startTimer: this step's own timer, when it has one and it is not already running.
  const protocol = context.protocolId ? loadProtocol(context.protocolId) : null;
  const step = protocol && typeof context.step === 'number' ? procedureFor(protocol, context.procedure).steps[context.step] : undefined;
  if (!step?.timer || running.some(t => t.id === step.id) || paused.some(t => t.id === step.id)) return null;
  const action = actionFromArguments({ type: 'startTimer', target: step.id }, context);
  return action.type === 'startTimer' && typeof action.seconds === 'number' ? action : null;
}
