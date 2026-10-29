import { unitsProblem } from '../../../shared/calc.ts';
import { isAssay, type Note, type Procedure, type Protocol, type Step } from '../../../shared/protocol.ts';
import { temperatureText } from '../../components/lab/model.ts';
import { durationSeconds } from './model.ts';

/**
 * Following a protocol Chapp cannot plan (a cell protocol like 3T3-L1, or an assay whose amounts it cannot convert),
 * step by step: what to do, the step's timer, what the user should see when it works, and the manual's cautions and
 * tips. Nothing is computed: every number is the manual's, as printed. Pure, so it is checked without a browser.
 */

export type FollowStep = {
  id: string;
  title: string;
  /** What to do, in Chapp's words. */
  key: string;
  stage: string;
  timer: { label: string; seconds: number; temperature: string | null; covered: boolean } | null;
  /** What the user should see when it works: a result to look for, not part of what to do. */
  expected: string[];
  /** Cautions first, then tips, then the rest. */
  notes: { kind: Exclude<Note['kind'], 'expected'>; text: string }[];
  page: number;
};

const ORDER = { caution: 0, tip: 1, info: 2 } as const;

/** Every step of the procedure, the analysis too: with no Results screen, working it out is the user's step. */
export const followSteps = (proc: Procedure) => followItems(proc.steps);

/** The procedure's reagent prep, ticked off before step 1. */
export const prepItems = (proc: Procedure) => followItems(proc.prep ?? []);

function followItems(steps: Step[]): FollowStep[] {
  return steps.map(s => ({
    id: s.id,
    title: s.title,
    key: s.key,
    stage: s.stage,
    timer: s.timer
      ? {
          label: s.timer.label,
          seconds: durationSeconds(s.timer.duration),
          temperature: s.timer.temperature ? temperatureText(s.timer.temperature) : null,
          covered: s.timer.covered ?? false,
        }
      : null,
    expected: (s.notes ?? []).filter(n => n.kind === 'expected').map(n => n.text),
    notes: (s.notes ?? [])
      .filter((n): n is Note & { kind: keyof typeof ORDER } => n.kind !== 'expected')
      .map((n, i) => ({ n, i }))
      .sort((a, b) => ORDER[a.n.kind] - ORDER[b.n.kind] || a.i - b.i)
      .map(({ n }) => ({ kind: n.kind, text: n.text })),
    page: s.cite.page,
  }));
}

/** Why Chapp only follows this procedure, when there is something to say: an assay whose amounts it cannot work out. */
export function followNote(p: Protocol, proc: Procedure): string | null {
  if (!isAssay(proc)) return null;
  const why = unitsProblem(p, proc);
  return why ? `I can’t work out this run’s amounts (${why}), so every number here is the manual’s, as printed.` : null;
}

/** Time left: "24:37" within the hour, "47 h 12 min" or "3 h" past it (a cell protocol waits for days). */
export function leftText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** When a timer ends: "14:30" today, "Fri 14:30" on another day. */
export function endsText(endsAt: number, now = Date.now()): string {
  const end = new Date(endsAt);
  const time = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  return end.toDateString() === new Date(now).toDateString() ? time : `${end.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}
