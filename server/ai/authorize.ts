import { vialRange } from '../../src/components/lab/model.ts';
import { numbersIn } from '../../shared/a2ui.ts';
import type { Action, ConverseContext } from '../../shared/ai.ts';

/**
 * What the model may change on its own word, checked against the user's. Muse Spark reads what was meant; this only
 * checks that the user's own words ask for that change, so a question ("is it time for the next step?"), a "not yet"
 * or a number the user never said does not move the run. A change they did not plainly ask for is not dropped: it
 * becomes a button, so a miss here costs a tap, never a change nobody asked for or a claim that it was made.
 *
 * Learned from BioMuse and Notos (server/assistant.mjs authorizes, server/commands.mjs authorizes), whose real
 * conversations went wrong mostly where the assistant said it had done what the app had not.
 */

export type Verdict = 'apply' | 'confirm' | 'drop';

/** A timed step of the protocol on screen: its id, its length in seconds, and the manual's alternatives where it gives some. */
export type TimedStep = { id: string; seconds: number; options?: readonly number[] };

export type Rules = {
  /** The protocol's step ids (a markDone may name one), and its timed steps. */
  steps: readonly string[];
  timed: readonly TimedStep[];
  /** The app has asked a question of its own ("Stop the timer?") and waits for yes or no. */
  pending?: boolean;
  /** The standards' vial ids ("A" … "I"). */
  vials: readonly string[];
  /** How many samples are on the plate (numbered from 1), samples added during the run included. */
  samples?: number;
  /** This run's own lengths, by step id, where the user changed one. */
  lengths?: Record<string, number>;
};

// "Can you start the timer?" asks for it; "is the timer running?" does not.
const ASKS = /可以|幫我|請|麻煩|能不能|可不可以|要不要幫|please|can you|could you|would you|will you|let'?s/i;
const QUESTION = /(?:[?？]|[嗎吗呢])\s*[。.!！]?\s*$/;
const NOT = /不要|不用|別|先不|還沒|不想|等一下|等等|don'?t|do not|not yet|no need|hold on|\bwait\b|never mind/i;

/** How the standards are made, said: "five standards", "the kit's nine", "halve from 2,000", "already made". */
const STANDARDS = /\bstandards?\b|\bvials?\b|\bkit'?s\b|\bhalv|\balready made\b|標準|標準品|稀釋|已經做好/i;
const NEXT = /\bnext\b|\bmove on\b|\bgo on\b|\bcontinue\b|下一步|下一個步驟|下個步驟|往下|繼續/i;
const PREVIOUS = /\bprevious\b|\bgo back\b|\bback (?:a|one) step\b|\bstep back\b|上一步|上一個步驟|回上|退回|回到前/i;
const DONE = /\b(?:done|finished|complete|completed|ready|added|ok|okay|good)\b|好了|做完|完成|加好|加完|弄好|做好|ok/i;
const TIMER = /\btimer\b|\bstart\b|\bbegin\b|\bcount ?down\b|\btime it\b|計時|開始|倒數|定時/i;
const REDO = /\bredo\b|\bre-do\b|\bremake\b|\bagain\b|\bbroke|\bspill|\bbad\b|重做|重來|重新|再做|再加|壞|灑|打翻|弄翻/i;
const BAD_WELL = /\bbad\b|\bbubbles?\b|\bspill|\bwrong\b|\bbroke|\bcontaminat|\bempty\b|\bmissed\b|\bmove\b|壞|氣泡|灑|錯|污染|漏|空的|沒加到|改到|換到|移到/i;
const ADD = /\badd\b|\bextra\b|\banother\b|\bone more\b|\bnew\b|多|加|新增|再一/i;
const STOP = /\bstop\b|\bpause\b|\bhold\b|\btake (?:it|the plate) out\b|停|暫停|拿出來/i;
const RESUME = /\bresume\b|\bcontinue\b|\bgo on\b|\bkeep going\b|\bput (?:it|the plate) back\b|\bstart (?:it )?again\b|\bback in\b|繼續|恢復|放回|再開始|接著/i;
const PHOTO = /\bphoto\b|\bpicture\b|\bcamera\b|\bscan\b|\bread\b|\blook\b|\bshow\b|\bhere\b|\bsee\b|拍|照|相機|掃|看|讀|給你/i;
const SAMPLE = /\bsample\b|\bexample\b|\bdemo\b|\btest data\b|範例|示範|樣本資料|例子|測試資料/i;

/** Whether the user's words name this vial, sample or well: on its own ("B", "3", "B3"), in a run ("ABCD") or a range ("A 到 D"). */
export function names(said: string, id: string): boolean {
  const ref = id.trim().toUpperCase();
  const text = said.toUpperCase();
  if (new RegExp(`(?:^|[^A-Z0-9])${ref}(?:[^A-Z0-9]|$)`).test(text)) return true;
  if (/^[A-P]$/.test(ref) && [...text.matchAll(/(?:^|[^A-Z])([A-P]{2,16})(?:[^A-Z]|$)/g)].some(m => m[1]!.includes(ref))) return true;
  const LETTERS = 'ABCDEFGHIJKLMNOP';
  for (const m of text.matchAll(/(?:^|[^A-Z0-9])([A-P]|\d{1,2})\s*(?:到|至|~|～|-|–|—|TO|THROUGH)\s*([A-P]|\d{1,2})(?:[^A-Z0-9]|$)/g)) {
    const [a, b] = [m[1]!, m[2]!];
    const pos = (x: string) => (/\d/.test(x) ? Number(x) : LETTERS.indexOf(x));
    if (/\d/.test(a) === /\d/.test(ref) && /\d/.test(b) === /\d/.test(ref) && pos(a) <= pos(ref) && pos(ref) <= pos(b)) return true;
  }
  return false;
}

/** Replicates named in words, in the user's language. */
const PLICATES: [RegExp, number][] = [
  [/singlicate|once each|just once|單次|一重複|不用重複/i, 1],
  [/duplicate|twice|in pairs|二重複|兩重複|雙重複|重複兩次|做兩次|兩次/i, 2],
  [/triplicate|three times|三重複|重複三次|做三次|三次/i, 3],
  [/quadruplicate|four times|四重複|重複四次|做四次|四次/i, 4],
];

// A Latin unit ends its word, so "30 mL" is not 30 minutes nor "30 samples" 30 seconds.
const UNIT_SECONDS: [RegExp, number][] = [
  [/^(?:days?\b|天)/i, 86400],
  [/^(?:h\b|hrs?\b|hours?\b|小時|鐘頭)/i, 3600],
  [/^(?:m\b|mins?\b|minutes?\b|分鐘|分(?!之))/i, 60],
  [/^(?:s\b|secs?\b|seconds?\b|秒)/i, 1],
];
const NUMBER_WORD = /(\d+(?:\.\d+)?|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -])?[a-z]+|[零〇一二兩两三四五六七八九十百]+)(半)?\s*/gi;

/** "24" → 24, "twenty four" → 24, "二十四" → 24; null when it is not a number. */
function numberOf(words: string): number | null {
  const ns = numbersIn(words, true);
  if (ns.length === 2 && ns[0]! >= 20 && ns[1]! < 10) return ns[0]! + ns[1]!;
  return ns.length === 1 ? ns[0]! : null;
}

/**
 * The lengths of time in what the user said, in seconds: "24 hours", "30 min", "二十四小時", "一個半小時", "半小時",
 * "two hours". Only a number followed by a unit counts.
 */
export function durationsSaid(said: string): number[] {
  const out: number[] = [];
  if (/(?:^|[^一二兩两三四五六七八九十\d個])半(?:個)?(?:小時|鐘頭)/.test(said)) out.push(1800);
  for (const m of said.matchAll(NUMBER_WORD)) {
    const n = numberOf(m[1]!);
    if (n === null || n <= 0) continue;
    let rest = said.slice(m.index + m[0].length);
    // "一個半小時": the half sits between the number and its unit.
    const half = Boolean(m[2]) || /^個半/.test(rest);
    rest = rest.replace(/^個半|^個(?=小時|鐘頭)/, '');
    const unit = UNIT_SECONDS.find(([re]) => re.test(rest));
    if (unit) out.push(Math.round((n + (half ? 0.5 : 0)) * unit[1]));
  }
  return [...new Set(out)];
}

// "直接開始", "用預設", "just start": start without looking at the plan first.
const AT_ONCE = /直接|馬上|立刻|現在就|就用|預設|照這樣|不用(?:改|看|調)|right away|straight away|straight in|immediately|as it is|with the defaults?|just start/i;

/**
 * startRun's `now` skips the start card. It holds only when the card is up and the user answers it (startCard), or the
 * user said to start at once; a "好" in front of "let's start" is not that, so the card comes first, whatever the
 * model read into it (Alexa collects what a request needs before acting; Apple asks before going on in the app).
 */
export function startWhenAsked(action: Action, said: string, context: ConverseContext): Action {
  if (action.type !== 'startRun' || !action.now || context.startCard || AT_ONCE.test(said)) return action;
  const { now: _now, ...rest } = action;
  return rest;
}

/** Whether these words could be a request at all: not a plain question, not a "not yet". */
function plainAsk(said: string): boolean {
  if (NOT.test(said)) return false;
  return !QUESTION.test(said.trim()) || ASKS.test(said);
}

/**
 * The verdict on one change the model asked for, and the change as the app should make it (a timer's length is the
 * step's, never the model's own number).
 */
export function authorize(action: Action, said: string, rules: Rules): { verdict: Verdict; action: Action } {
  const plain = plainAsk(said);
  const numbers = new Set(numbersIn(said, true));
  const verdict = (asked: boolean): Verdict => (asked && plain ? 'apply' : 'confirm');
  switch (action.type) {
    case 'navigate':
    case 'findProtocol':
      // Going somewhere is a button in the conversation, and a search changes nothing.
      return { verdict: 'apply', action };
    case 'setSamples':
      return { verdict: verdict(numbers.has(action.samples)), action };
    case 'setReplicates': {
      const named = PLICATES.some(([re, n]) => n === action.replicates && re.test(said));
      return { verdict: verdict(named || numbers.has(action.replicates)), action };
    }
    case 'setStandards':
      return { verdict: verdict(STANDARDS.test(said)), action };
    case 'nextStep':
      return { verdict: verdict(NEXT.test(said)), action };
    case 'previousStep':
      return { verdict: verdict(PREVIOUS.test(said)), action };
    case 'markDone': {
      const tube = /^\d{1,2}$/.test(action.id) && Number(action.id) >= 1 && Number(action.id) <= (rules.samples ?? 0);
      if (tube) return { verdict: verdict(DONE.test(said) && names(said, action.id)), action };
      // "B to E are done": a range of the run's vials (vialRange) counts as naming each of them.
      if (vialRange(action.id, rules.vials.map(id => ({ id })))) return { verdict: verdict(DONE.test(said)), action };
      if (!rules.steps.includes(action.id) && !rules.vials.includes(action.id.toUpperCase())) return { verdict: 'drop', action };
      const id = rules.vials.includes(action.id.toUpperCase()) ? action.id.toUpperCase() : action.id;
      return { verdict: verdict(DONE.test(said)), action: { ...action, id } };
    }
    case 'startTimer': {
      const step = rules.timed.find(s => s.id === action.id);
      if (!step) return { verdict: 'drop', action };
      // The run's length for this step (the user's choice), else the protocol's; a length the user names now wins.
      const named = durationsSaid(said);
      const seconds = named.length === 1 ? named[0]! : (rules.lengths?.[step.id] ?? step.seconds);
      return { verdict: verdict(TIMER.test(said)), action: { ...action, seconds } };
    }
    case 'redo': {
      const id = action.id.trim().toUpperCase();
      const known = rules.vials.includes(id) || (/^\d{1,2}$/.test(id) && Number(id) >= 1 && Number(id) <= (rules.samples ?? 0));
      if (!known) return { verdict: 'drop', action };
      return { verdict: verdict(REDO.test(said) && names(said, id)), action: { ...action, id } };
    }
    case 'moveWell': {
      // A well the user named going wrong; the well it goes to only when they named it too, else the app picks.
      const to = action.to && names(said, action.to) ? action.to : undefined;
      return { verdict: verdict(BAD_WELL.test(said) && names(said, action.from)), action: { type: 'moveWell', from: action.from, ...(to ? { to } : {}) } };
    }
    case 'addWell': {
      const well = action.well && names(said, action.well) ? action.well : undefined;
      return { verdict: verdict(ADD.test(said)), action: { type: 'addWell', what: action.what, ...(well ? { well } : {}) } };
    }
    case 'addCondition':
      return { verdict: verdict(ADD.test(said)), action };
    case 'setStepTime': {
      // Only a length the user said: one they named, or the one that matches. One of the manual's own alternatives
      // for the step ("30 min or 2 h") is their pick, made at once; any other length is the user's tap.
      const step = rules.timed.find(s => s.id === action.id);
      const named = durationsSaid(said);
      const seconds = named.includes(action.seconds) ? action.seconds : named.length === 1 ? named[0]! : null;
      if (!step || seconds === null) return { verdict: 'drop', action };
      if (step.options?.includes(seconds)) return { verdict: verdict(true), action: { ...action, seconds } };
      return { verdict: 'confirm', action: { ...action, seconds } };
    }
    case 'stopTimer':
    case 'resumeTimer': {
      if (!rules.timed.some(s => s.id === action.id)) return { verdict: 'drop', action };
      return { verdict: verdict((action.type === 'stopTimer' ? STOP : RESUME).test(said)), action };
    }
    case 'takePhoto':
      return { verdict: verdict(PHOTO.test(said)), action };
    case 'useSample':
      return { verdict: verdict(SAMPLE.test(said)), action };
    case 'answer':
      // Only an answer to a question the app itself asked; which answer it was is the model's reading of the words.
      return { verdict: rules.pending ? 'apply' : 'drop', action };
    // Legacy reply replay only; the live conversation validates actions as tools, without phrase matching.
    case 'undo':
    case 'openProtocol':
    case 'startRun':
      return { verdict: 'confirm', action };
  }
}

// Words that say a change was made: "I've set", "started the timer", "改好了", "已經幫你設定".
const CLAIMS = [
  /\bI(?:'ve| have)?\s+(?:just\s+)?(?:set|started|changed|updated|moved|marked|switched|added|adjusted|reset)\b/i,
  /\b(?:has|have)\s+been\s+(?:set|changed|updated|started|marked|moved|adjusted)\b/i,
  /\b(?:is|are)\s+now\s+(?:set|running|marked|at)\b/i,
  /\btimer(?:'s| is)?\s+(?:running|started|on)\b/i,
  /已(?:經)?(?:幫你|為你|替你)?(?:設定|設好|改|更新|開始|啟動|標記|切換|跳到|移到|調整|記錄)/,
  /(?:改|設|調|換|弄)好了/,
  /(?:幫你|為你|替你)(?:改|設|調|換)(?:成|到|好)/,
  /計時(?:器)?(?:已經)?(?:開始|在跑)/,
];

/** Whether a sentence says Chapp changed something. */
export const claimsChange = (sentence: string) => CLAIMS.some(re => re.test(sentence));
