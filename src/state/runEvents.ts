import { benchSteps, lengthText } from '../components/lab/model.ts';
import { applying } from './applying.ts';
import { useChatLog, type Exchange } from './conversationLog.ts';
import { loadedProtocol } from './protocol.ts';
import { useRun, type RunState } from './run.ts';
import { addToRunConversation, runIsOnScreen } from './threads.ts';

/**
 * What the user does by hand on the run (Next, a tick, a timer, the plan, Start), written into the experiment's
 * conversation as it happens, a small line among the exchanges, so the conversation keeps the whole run; and told to
 * Chapp with the next thing said (ConverseContext.events), the way MCP Apps and ElevenLabs pass what happened on screen
 * as context that asks for no answer. Chapp's own changes are not written here: its receipt already says what it did.
 */

/** Lines since the user last spoke, for the next turn's context. */
const sinceSpoken: string[] = [];
export const eventsSinceSpoken = () => sinceSpoken.slice(-12);
export const clearEvents = () => {
  sinceSpoken.length = 0;
};

const STEP = /^Step \d+/;
// Event exchanges count down from below zero, apart from the turns' ids (state/conversation.ts counts up).
let count = 0;
const TICKED = 'Ticked: ';

/**
 * One line, into the conversation it belongs to: the run's (`to: 'run'`, the default), or the one on screen. A step
 * moved again replaces the last step line, and ticks in a row gather on one line, so tapping through stays short.
 */
export function noteEvent(line: string, to: 'run' | 'screen' = 'run') {
  const merge = (lines: string[]): string[] => {
    const last = lines.at(-1);
    if (last && STEP.test(last) && STEP.test(line)) return [...lines.slice(0, -1), line];
    if (last?.startsWith(TICKED) && line.startsWith(TICKED)) return [...lines.slice(0, -1), `${last}, ${line.slice(TICKED.length)}`];
    return [...lines, line].slice(-40);
  };
  const into = (exchanges: Exchange[]): Exchange[] => {
    const last = exchanges.at(-1);
    if (last?.event) return [...exchanges.slice(0, -1), { ...last, done: merge(last.done) }];
    return [...exchanges, { id: -(Date.now() * 100 + (count++ % 100)), ask: '', phase: 'reply', say: '', done: [line], go: [], event: true }];
  };
  const onScreen = to === 'screen' || runIsOnScreen();
  if (onScreen) {
    useChatLog.setState(s => ({ exchanges: into(s.exchanges) }));
    const merged = merge(sinceSpoken);
    sinceSpoken.splice(0, sinceSpoken.length, ...merged);
  } else addToRunConversation(into);
}

function stepLine(s: RunState): string {
  const p = loadedProtocol(s.protocolId);
  let steps: { title: string }[] = [];
  try {
    steps = p ? benchSteps(p, s.procedure) : [];
  } catch {
    // A procedure the protocol does not have: the number alone.
  }
  return steps[s.step] ? `Step ${s.step + 1} of ${steps.length} · ${steps[s.step]!.title}` : `Step ${s.step + 1}`;
}

/** "tube:3" is the plate's fourth tube; a vial or a step goes by its id. */
const tickName = (id: string) => (/^tube:\d+$/.test(id) ? `tube ${Number(id.slice(5)) + 1}` : id);

/** What changed by hand between two states of the same run, in the conversation's words. */
export function changeLines(before: RunState, now: RunState): string[] {
  if (before.protocolId !== now.protocolId || !now.protocolId) return [];
  const lines: string[] = [];
  if (now.begun && !before.begun) lines.push('Started the experiment');
  if (now.step !== before.step) lines.push(stepLine(now));
  if (now.samples !== before.samples) lines.push(`Samples: ${now.samples}`);
  if (now.replicates !== before.replicates) lines.push(`Samples: ×${now.replicates}`);
  if (now.standardReplicates !== before.standardReplicates) lines.push(`Standards: ×${now.standardReplicates}`);
  const ticked = Object.keys(now.done).filter(id => now.done[id] && !before.done[id]);
  if (ticked.length) lines.push(`${TICKED}${ticked.map(tickName).join(', ')}`);
  for (const id of Object.keys(now.timers)) {
    if (before.timers[id] === undefined) lines.push(`Timer started · ${lengthText(Math.max(1, Math.round((now.timers[id]! - Date.now()) / 1000)))}`);
  }
  for (const id of Object.keys(before.timers)) {
    if (now.timers[id] === undefined && before.timers[id]! - Date.now() > 2000) lines.push('Timer stopped');
  }
  const read = Object.keys(now.readings).length;
  if (read && (Object.keys(before.readings).length === 0 || now.readingsFrom !== before.readingsFrom)) lines.push(`Readings in: ${read} wells${now.readingsFrom === 'sample' ? ' (sample data)' : ''}`);
  for (const [from, to] of Object.entries(now.edits.moved)) if (before.edits.moved[from] !== to) lines.push(`Well ${from} moved to ${to}`);
  for (const added of now.edits.added.slice(before.edits.added.length)) lines.push(`Added: ${added.name}`);
  return lines;
}

let watching = false;
/** Starts writing the user's own changes to the run into its conversation (once, from main). */
export function watchRun() {
  if (watching) return;
  watching = true;
  useRun.subscribe((now, before) => {
    if (applying()) return;
    for (const line of changeLines(before, now)) noteEvent(line);
  });
}
