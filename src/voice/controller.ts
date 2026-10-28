import { useSession } from '../state/session.ts';
import { BrowserEngine, recognitionClass } from './browser.ts';
import { AFTER_SPEAKING_MS, chooseEngine, PROBLEM_TEXT, type Engine, type EngineKind, type Mode, type Problem } from './engine.ts';
import { fixLabWords } from './labWords.ts';
import { ServerEngine } from './server.ts';
import { isSpeaking, stopSpeaking } from './speak.ts';

/**
 * The one microphone. Whichever bar is on screen starts and stops it; the session's `voice` says what it is doing,
 * `heard`/`interim` show the words so far, and each finished turn goes to the handler of the bar that is mounted.
 * Setting `voice` to 'idle' from anywhere closes the microphone.
 */

export type UtteranceHandler = (text: string) => void;

let engine: Engine | null = null;
let kind: EngineKind | null = null;
let mode: Mode | null = null;
/** Bumped for every engine, so events from one that was replaced are ignored. */
let generation = 0;
/**
 * The browser's recognizer could not work here (no service, no network, could not reach the microphone): use the
 * server from now on, which only needs getUserMedia. With no microphone at all it reports the same problem itself.
 */
let serverFromNowOn = false;
let unwatchSpeaking: (() => void) | null = null;
let resumeTimer = 0;
const handlers: UtteranceHandler[] = [];

const session = () => useSession.getState();

/** Our own writes to `voice`, which the watcher below must not mistake for someone else closing the microphone. */
let writing = false;
function setVoice(voice: 'idle' | 'listening' | 'talking') {
  writing = true;
  try {
    session().setVoice(voice);
  } finally {
    writing = false;
  }
}

if (typeof window !== 'undefined') {
  useSession.subscribe((state, before) => {
    if (!writing && state.voice === 'idle' && before.voice !== 'idle') close();
  });
}

/** tap: listen for one thing and send it · talk: back-and-forth until endConversation(). Call inside the user's tap. */
export function startListening(next: Mode) {
  close();
  // Speaking over Chapp interrupts it.
  stopSpeaking();
  clearProblem();
  mode = next;
  session().setHeard('', '');
  setVoice(next === 'tap' ? 'listening' : 'talking');
  // Before the engine starts: one that fails at once closes everything, this included.
  if (next === 'talk') unwatchSpeaking = isSpeaking.subscribe(onSpeaking);
  run(serverFromNowOn ? 'server' : chooseEngine(recognitionClass() !== null));
}

/** The user tapped while listening: send what was said now (or stop, if nothing was). */
export function finishListening() {
  if (engine && mode === 'tap') engine.finish();
  else endConversation();
}

/** Ends a conversation (or any listening) without sending the turn in progress. */
export function endConversation() {
  close();
  session().setHeard('', '');
  setVoice('idle');
}

/** Registers the mounted bar's handler; the latest one gets the turns. Returns the unregister function. */
export function attachHandler(handler: UtteranceHandler) {
  handlers.push(handler);
  return () => {
    const at = handlers.indexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
    // A screen change unmounts one bar and mounts the next in the same moment: only close if none came back.
    setTimeout(() => {
      if (!handlers.length && engine) endConversation();
    });
  };
}

function run(next: EngineKind) {
  const mine = ++generation;
  const live = () => mine === generation;
  const events = {
    heard: (settled: string, interim: string) => live() && session().setHeard(settled, interim),
    turn: (text: string) => live() && deliver(text),
    warn: (problem: Problem) => live() && showProblem(problem),
    end: (problem?: Problem) => live() && ended(problem),
  };
  kind = next;
  engine = next === 'browser' ? new BrowserEngine(mode ?? 'tap', events) : new ServerEngine(mode ?? 'tap', events);
  engine.start();
}

function deliver(heard: string) {
  const handler = handlers.at(-1);
  // Lab names put right first ("pierced BCA" is Pierce BCA), whichever recognizer heard them.
  const text = fixLabWords(heard);
  try {
    // The handler may be async; a failure there is the screen's, not the microphone's.
    const result: unknown = handler?.(text);
    if (result instanceof Promise) result.catch((e: unknown) => console.error(e));
  } catch (e) {
    console.error(e);
  }
  // The screen shows the answer next; the words were handed over.
  session().setHeard('', '');
  if (mode === 'tap') endConversation();
}

function ended(problem?: Problem) {
  const wasKind = kind;
  const wasMode = mode;
  if (wasKind === 'browser' && wasMode && (problem === 'unavailable' || problem === 'network' || problem === 'no-mic')) {
    serverFromNowOn = true;
    close();
    mode = wasMode;
    if (wasMode === 'talk') unwatchSpeaking = isSpeaking.subscribe(onSpeaking);
    run('server');
    return;
  }
  endConversation();
  if (problem) showProblem(problem);
}

/** Chapp talking: stop hearing until it is done (and a moment more, so its last word is not heard). */
function onSpeaking(speaking: boolean) {
  clearTimeout(resumeTimer);
  if (speaking) engine?.pause();
  else resumeTimer = window.setTimeout(() => engine?.resume(), AFTER_SPEAKING_MS);
}

function close() {
  generation++;
  engine?.abort();
  engine = null;
  kind = null;
  mode = null;
  unwatchSpeaking?.();
  unwatchSpeaking = null;
  clearTimeout(resumeTimer);
}

// --- The line under Chapp's name when something went wrong ---------------------------------------------------------

let shown = '';
let problemTimer = 0;

function showProblem(problem: Problem) {
  shown = PROBLEM_TEXT[problem];
  session().setStatus(shown);
  clearTimeout(problemTimer);
  problemTimer = window.setTimeout(clearProblem, 4000);
}

/** Clears our message, unless the screen has put its own line there since. */
function clearProblem() {
  clearTimeout(problemTimer);
  if (shown && session().status === shown) session().setStatus('');
  shown = '';
}
