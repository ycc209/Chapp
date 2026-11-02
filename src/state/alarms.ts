import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isPlannable } from '../../shared/calc.ts';
import type { Protocol } from '../../shared/protocol.ts';
import { benchSteps } from '../components/lab/model.ts';
import { procedureFor, shortName } from '../screens/protocol/content.ts';
import { useBench } from '../screens/run/bench.ts';
import { followSteps } from '../screens/run/follow.ts';
import { spoken } from '../screens/run/model.ts';
import { cancelPushTimer, pushTimer, pushWaiting, sentTimers, usePush } from '../screens/run/push.ts';
import { speak } from '../voice/speak.ts';
import { load, loadedProtocol } from './protocol.ts';
import { useRun } from './run.ts';
import { openThread, useThreads } from './threads.ts';

/**
 * Every timer on this phone rings, wherever the user is: the run under way's and those of every experiment waiting in
 * its own conversation (state/threads.ts), on any screen, and on the lock screen through the server's push
 * (screens/run/push.ts), each under its experiment's own key so two BCA runs never cancel each other. One watcher
 * for the whole app, not the run screen's: the run screen is often not the one open when an incubation ends.
 */

export type Alarm = {
  /** The experiment's conversation and the step: "c-…:m-incubate" ("run:…" before there are conversations). */
  key: string;
  /** The conversation the run belongs to, to go back to it. */
  owner: string | null;
  protocolId: string;
  procedure: string;
  stepId: string;
  endsAt: number;
  /** The run under way, rather than one waiting in its conversation. */
  live: boolean;
};
export type AlarmText = { title: string; body: string; url: string };
type Ringing = { alarm: Alarm; text: AlarmText };

/** Ended this long ago when Chapp opens again: past, not rung any more (the lock screen had it). */
const STALE = 6 * 3600_000;

export const useAlarms = create<{ ringing: Ringing | null; rung: Record<string, number> }>()(
  persist(() => ({ ringing: null as Ringing | null, rung: {} as Record<string, number> }), { name: 'chapp.alarms', partialize: s => ({ rung: s.rung }) }),
);

/** Every timer running on this phone (paused ones are not: they have no end), soonest first. */
export function runningTimers(): Alarm[] {
  const { threads, runThread } = useThreads.getState();
  const run = useRun.getState();
  const out: Alarm[] = [];
  if (run.protocolId) {
    for (const [stepId, endsAt] of Object.entries(run.timers)) out.push({ key: `${runThread ?? 'run'}:${stepId}`, owner: runThread, protocolId: run.protocolId, procedure: run.procedure, stepId, endsAt, live: true });
  }
  for (const t of threads) {
    if (t.id === runThread || !t.run?.protocolId) continue;
    for (const [stepId, endsAt] of Object.entries(t.run.timers ?? {})) out.push({ key: `${t.id}:${stepId}`, owner: t.id, protocolId: t.run.protocolId, procedure: t.run.procedure, stepId, endsAt, live: false });
  }
  return out.sort((a, b) => a.endsAt - b.endsAt);
}

/** The steps as that protocol's run screen numbers them: the bench's for a planned assay, every step to follow else. */
function stepsOf(p: Protocol, procedureId: string): { id: string; title: string; key: string }[] {
  const proc = procedureFor(p, procedureId);
  if (isPlannable(p, proc)) return benchSteps(p, proc.id).map(s => ({ id: s.id, title: s.title, key: s.step.key }));
  return followSteps(proc).map(s => ({ id: s.id, title: s.title, key: s.key }));
}

/** What Time's up says: the experiment and the step done, what comes next, and where it opens (the next step, in that experiment). */
export function alarmText(a: Alarm, p: Protocol): AlarmText {
  const steps = stepsOf(p, a.procedure);
  const i = steps.findIndex(s => s.id === a.stepId);
  const next = i >= 0 ? steps[i + 1] : undefined;
  const at = next ? i + 1 : Math.max(0, i);
  return {
    title: `${shortName(p)} · ${steps[i]?.title ?? 'Timer'} done`.slice(0, 120),
    body: (next ? `Next: ${next.key}` : 'That was the last step.').slice(0, 300),
    url: `/run/${at + 1}${a.owner ? `?experiment=${encodeURIComponent(a.owner)}` : ''}`,
  };
}

/** What the timers are called in the conversation's context and the sidebar: the kit, without loading anything. */
export const alarmName = (a: Alarm) => {
  const p = loadedProtocol(a.protocolId);
  return p ? shortName(p) : a.protocolId;
};

let wait: ReturnType<typeof setTimeout> | undefined;

/** Rings whatever is due, and waits for the next one. Called again whenever a timer, a conversation or the page changes. */
export function checkAlarms() {
  clearTimeout(wait);
  const { rung, ringing } = useAlarms.getState();
  const due = runningTimers().filter(a => rung[a.key] !== a.endsAt);
  const first = due[0];
  if (!first) return;
  const left = first.endsAt - Date.now();
  if (left > 0) {
    wait = setTimeout(checkAlarms, Math.min(left, 2 ** 31 - 1));
    return;
  }
  // One at a time: the next rings once this one is opened.
  if (!ringing) void ring(first);
}

async function ring(a: Alarm) {
  const now = Date.now();
  useAlarms.setState(s => ({
    rung: Object.fromEntries([...Object.entries(s.rung).filter(([, ends]) => now - ends < 3 * 24 * 3600_000), [a.key, a.endsAt]]),
  }));
  if (a.live) useBench.getState().announce(a.stepId, a.endsAt);
  if (now - a.endsAt > STALE) return checkAlarms();
  const p = await load(a.protocolId).catch(() => null);
  const text = p ? alarmText(a, p) : { title: 'Timer done', body: '', url: '/' };
  // The server pushes Time's up to the lock screen; where it does not, the page notifies from the background itself.
  try {
    if (!pushWaiting(a.key, a.endsAt) && document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted')
      new Notification(text.title, { body: text.body, icon: '/chapp/chapp.webp', tag: a.key });
  } catch {
    // Some phones only notify from a service worker.
  }
  navigator.vibrate?.([300, 120, 300]);
  void speak(spoken(`Time’s up. ${text.title}. ${text.body}`)).catch(() => {});
  useAlarms.setState({ ringing: { alarm: a, text } });
}

/** Time's up was seen: to the step after the timer, in its own experiment; then the next alarm, if one is due. */
export function openAlarm(navigate: (to: string) => void) {
  const r = useAlarms.getState().ringing;
  useAlarms.setState({ ringing: null });
  if (r) {
    if (r.alarm.owner) openThread(r.alarm.owner);
    navigate(r.text.url.replace(/\?experiment=[^&]*/, ''));
  }
  checkAlarms();
}

/** Time's up seen where it needs no screen (gloves on, the run speaking for itself): just the next one. */
export function quietAlarm() {
  useAlarms.setState({ ringing: null });
  checkAlarms();
}

/**
 * The lock screen: every running timer goes to the server under its experiment's key, and one stopped (no longer
 * running anywhere) is called off. One that only ended stays: its push is the one on the lock screen.
 */
async function syncPush() {
  const timers = runningTimers();
  const now = Date.now();
  for (const [key, endsAt] of Object.entries(sentTimers())) {
    const t = timers.find(a => a.key === key);
    // Stopped, or ended early by a tap on the time: no push at the old end.
    if (!t || (t.endsAt !== endsAt && t.endsAt - now <= 3000)) void cancelPushTimer(key);
  }
  if (usePush.getState().state !== 'ready') return;
  for (const a of timers) {
    if (a.endsAt - Date.now() <= 3000) continue;
    const p = await load(a.protocolId).catch(() => null);
    if (!p) continue;
    const { title, body, url } = alarmText(a, p);
    void pushTimer({ id: a.key, endsAt: a.endsAt, title, body, url });
  }
}

let watching = false;
/** Starts the watcher (once, from main). */
export function watchAlarms() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const changed = () => {
    checkAlarms();
    void syncPush();
  };
  useRun.subscribe((s, before) => s.timers !== before.timers && changed());
  useThreads.subscribe((s, before) => (s.threads !== before.threads || s.runThread !== before.runThread) && changed());
  usePush.subscribe((s, before) => s.state !== before.state && changed());
  // Timeouts sleep with a hidden page: coming back, whatever ended meanwhile rings.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkAlarms());
  changed();
}
