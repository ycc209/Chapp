import { useEffect, useState } from 'react';
import type { FoundProtocol, ProtocolIntro } from '../../../shared/ai.ts';
import { otherCatalog } from '../../../shared/catalog.ts';
import { api } from '../../api/client.ts';
import { useSession } from '../../state/session.ts';

/**
 * Overview.dc.html's first time: what the user said, then Chapp finding the manual. Stages, each held at least 1.4 s
 * as in the design: 0 searching (until the server answers), 1 found (the answer), 2 turning it into steps (at a
 * glance), 3 done (the whole protocol). The line under Chapp's name follows them, its face thinks until the end.
 */
export type Stage = 0 | 1 | 2 | 3;

export type Finding = {
  stage: Stage;
  /**
   * What Chapp said while it searched (FoundProtocol.progress), or why it fell back to the copy on this phone. While
   * searching (stage 0) these arrive one by one as the search goes, the last one still under way.
   */
  progress: string[];
  /** The search found nothing: Chapp's answer, and no protocol to show. */
  notFound: string | null;
  /** The protocol on this machine the found manual is (FoundProtocol.protocolId), when the server knows it. */
  protocolId?: string;
  /** A manual found but not read into steps (not a PDF, or it would not download): the vendor's link to it. */
  manual?: string;
  /**
   * A manual new to Chapp: what the kit is, read within seconds while its steps are still being read (shared/ai.ts
   * ProtocolIntro). The Overview shows its answer and At a glance from it until the protocol is there.
   */
  intro?: ProtocolIntro;
  /** The catalog number the user said, when the kit found has another ("EEA 302" said, EEA032 found): shown as a check. */
  said?: { number: string; found: string };
};

const STEP_MS = 1400;
// The design's labels for the line under Chapp's name.
export const STAGE_STATUS = ['Searching the web', 'Found the official user guide', 'Turning it into steps'] as const;

const DONE: Finding = { stage: 3, progress: [], notFound: null };

// Exchanges whose search has been shown: coming back to the protocol later shows it without searching again.
const shown = new WeakSet<object>();

export function wasShown(exchange: object | null): boolean {
  return exchange !== null && shown.has(exchange);
}

/**
 * Runs the search for `ask` (null: nothing to find, the protocol shows at once). `hold` stops at a stage, for
 * reviewing one by address. `exchange` is marked shown once the whole protocol is on screen.
 */
export function useFinding(ask: string | null, hold: Stage | null, exchange: object | null): Finding {
  const [finding, setFinding] = useState<Finding>(() => (ask === null ? DONE : { stage: 0, progress: [], notFound: null }));

  useEffect(() => {
    if (ask === null) return;
    const session = useSession.getState();
    const abort = new AbortController();
    const timers: number[] = [];
    let live = true;
    const cap = (s: Stage): Stage => (hold === null ? s : (Math.min(s, hold) as Stage));
    const status = (stage: Stage) => {
      session.setStatus((STAGE_STATUS as readonly string[])[stage] ?? '');
      session.setExpression(stage < 3 ? 'thinking' : 'neutral');
    };

    setFinding({ stage: 0, progress: [], notFound: null });
    status(0);
    const started = performance.now();
    const after = (ms: number, fn: () => void) => timers.push(window.setTimeout(() => live && fn(), ms));

    // Set once the intro is on screen: the answer and At a glance are shown already, so the protocol comes in whole.
    let introduced = false;
    const reveal = (progress: string[], protocolId?: string) => {
      const go = (stage: Stage) => {
        const s = cap(stage);
        setFinding(f => ({ stage: s, progress, notFound: null, ...(protocolId ? { protocolId } : {}), ...(f.intro ? { intro: f.intro } : {}), ...(f.said ? { said: f.said } : {}) }));
        status(s);
        if (s === 3 && exchange) shown.add(exchange);
        if (s === stage && stage < 3) after(STEP_MS, () => go((stage + 1) as Stage));
      };
      if (introduced && protocolId) go(3);
      else after(Math.max(0, STEP_MS - (performance.now() - started)), () => go(1));
    };

    // Each line Chapp says while it searches is shown as it comes (server-sent events); the answer's list replaces them.
    const heard = (line: string) => live && setFinding(f => (f.stage === 0 ? { ...f, progress: [...f.progress, line] } : f));

    // What the kit is, while a manual new to Chapp is read: shown at once, and Chapp says it is turning it into steps.
    const told = (intro: ProtocolIntro) => {
      if (!live) return;
      introduced = true;
      setFinding(f => (f.stage === 0 ? { ...f, intro } : f));
      session.setStatus(STAGE_STATUS[2]);
    };

    api.findProtocolLive(ask, heard, abort.signal, told).then(
      (found: FoundProtocol) => {
        if (!live) return;
        // A number said that is not the kit found: kept with whatever is shown next.
        const number = found.found ? otherCatalog(`${useSession.getState().exchange?.ask ?? ''} ${ask}`, found.kit?.catalog) : null;
        if (number && found.kit) setFinding(f => ({ ...f, said: { number, found: found.kit!.catalog } }));
        if (!found.found) {
          setFinding({ stage: 1, progress: found.progress, notFound: found.answer || "I couldn't find that kit's manual." });
          session.setStatus('');
          session.setExpression('sad');
          return;
        }
        if (!found.protocolId) {
          // A manual Chapp could not read into steps: say so with its link, rather than show the run's other kit.
          const what = found.kit?.name || found.document?.title || 'the manual';
          setFinding({
            stage: 1,
            progress: found.progress,
            notFound: `I found ${what}, but I couldn't turn it into steps here. You can open the vendor's copy.`,
            ...(found.document?.url ? { manual: found.document.url } : {}),
            ...(number && found.kit ? { said: { number, found: found.kit.catalog } } : {}),
          });
          session.setStatus('');
          session.setExpression('neutral');
          return;
        }
        reveal(found.progress, found.protocolId);
      },
      () => {
        // No answer from the search: the manual already on this phone still holds, and Chapp says that is what it shows.
        if (live) reveal(["I couldn't search the web just now, so this is the copy of the user guide on this phone."]);
      },
    );

    return () => {
      live = false;
      abort.abort();
      timers.forEach(clearTimeout);
      const s = useSession.getState();
      if ((STAGE_STATUS as readonly string[]).includes(s.status)) s.setStatus('');
      if (s.expression === 'thinking' || s.expression === 'sad') s.setExpression('neutral');
    };
  }, [ask, hold, exchange]);

  return ask === null ? DONE : finding;
}
