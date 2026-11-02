import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Expression } from '../../../shared/ai.ts';
import { r2Text } from '../../components/lab/model.ts';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { cn } from '../../lib/cn.ts';
import { useSession } from '../../state/session.ts';
import { PlusMenu } from '../home/PlusMenu.tsx';
import { TypingBar } from '../home/TypingBar.tsx';
import type { Travels } from './setup.ts';
import './share.css';

// Pieces Share-QR and Scan-Import draw alike (the two artboards share their type and their numbered list).

/** The scrolling page under Chapp: 196 px down to clear it, 126 px at the bottom to clear the bar. */
export const PAGE =
  'flex h-full min-h-0 flex-col overflow-y-auto px-5 pt-[calc(196px+var(--screen-top))] pb-[calc(92px+var(--screen-bottom))] [scrollbar-width:none]';

/** Where the "Sample data" tag sits when the results that travel are Chapp's example (as on Results). */
export const SAMPLE_TAG = 'absolute top-[calc(66px+var(--screen-top))] right-5 z-[6]';

/** Chapp's answer at the top of the page, and the other lines Chapp says (17/24 medium, ink). */
export const SAY = 'm-0 text-[17px] leading-6 font-medium text-ink';

/** Shows `face` on Chapp while the screen is open (Share-QR winks, Scan-Import is surprised). */
export function useFace(face: Expression) {
  useEffect(() => {
    useSession.getState().setExpression(face);
    return () => {
      if (useSession.getState().expression === face) useSession.getState().setExpression('neutral');
    };
  }, [face]);
}

/**
 * Chapp's answer, or while the user speaks the words as they are heard (settled in ink, still-changing in grey), so
 * what is said on this screen shows where Chapp answers it.
 */
export function Answer({ children }: { children: ReactNode }) {
  const voice = useSession(s => s.voice);
  const heard = useSession(s => s.heard);
  const interim = useSession(s => s.interim);
  // Held, the words show in the bar's own bubble.
  const hearing = voice !== 'idle' && voice !== 'holding' && (heard || interim);
  return (
    <div aria-label="Chapp's answer" aria-live="polite" className={cn(SAY, 'mb-6 shrink-0 px-1')}>
      {hearing ? (
        <>
          {heard}
          {interim && <span className="text-faint">{heard && !heard.endsWith(' ') ? ' ' : ''}{interim}</span>}
        </>
      ) : (
        children
      )}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;


/** Share-QR's "What travels" and Scan-Import's "You get": a yellow number, then what comes along. */
export function TravelList({ travels, reagent = false, appear = false }: { travels: Travels; reagent?: boolean; appear?: boolean }) {
  const lines: ReactNode[] = [
    <>
      The protocol, <b className="font-bold">{plural(travels.steps, 'step')}</b>
    </>,
  ];
  const { plan, results } = travels;
  if (plan) {
    lines.push(
      <>
        The plan: <b className="font-bold">{plural(plan.standards, 'standard')}</b> ×{plan.standardReplicates},{' '}
        <b className="font-bold">{plural(plan.samples, 'sample')}</b> ×{plan.replicates}
        {reagent && plan.reagentMl > 0 && (
          <>
            , <b className="font-bold">{plan.reagentMl} mL</b> working reagent
          </>
        )}
      </>,
    );
  }
  if (results) {
    lines.push(
      <>
        The results: <b className="font-bold">{plural(results.samples, 'sample')}</b>
        {results.r2 !== undefined && (
          <>
            , R² <b className="font-bold">{r2Text(results.r2)}</b>
          </>
        )}
      </>,
    );
  }
  if (travels.photos || travels.cover) {
    const what = [travels.photos ? plural(travels.photos, 'bottle') : '', travels.cover ? 'the kit' : ''].filter(Boolean).join(' and ');
    lines.push(
      <>
        Kit photos, <b className="font-bold">{what}</b>
      </>,
    );
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
      {lines.map((line, i) => (
        <li
          key={i}
          className={cn('grid grid-cols-[22px_minmax(0,1fr)] items-center gap-3 text-[17px] leading-6 font-medium text-ink', appear && 'share-appear')}
          style={appear ? { animationDelay: `${120 + i * 140}ms` } : undefined}
        >
          <span className="size-[22px] rounded-full bg-mark text-center text-xs leading-[22px] font-bold text-ink">{i + 1}</span>
          <span>{line}</span>
        </li>
      ))}
    </ol>
  );
}

/** The design's two pill buttons side by side (Save image / Add to library, Not now / Use this setup). */
export const PILL = 'flex min-h-[52px] items-center justify-center gap-2 rounded-full text-[17px] leading-[22px] font-[650] no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2 disabled:opacity-50';
export const PILL_LIGHT = cn(PILL, 'bg-white text-ink shadow-[inset_0_0_0_1.5px_#e6e6e3]');
export const PILL_DARK = cn(PILL, 'bg-ink text-white');

/**
 * The bar over the bottom of the page, as on every artboard: Tap to speak (or the message box while typing) and the
 * + menu. What is said or typed goes to `onUtterance`.
 */
export function ScreenBar({ onUtterance }: { onUtterance: (text: string) => void }) {
  const [plus, setPlus] = useState(false);
  const [typing, setTyping] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className="absolute inset-x-0 bottom-0 z-[6] px-5 pb-[var(--screen-bottom)]">
        {typing ? (
          <TypingBar
            plusOpen={plus}
            plusRef={plusRef}
            onPlus={() => setPlus(open => !open)}
            onSend={onUtterance}
            onClose={() => {
              setTyping(false);
              setPlus(false);
            }}
          />
        ) : (
          <BottomBar onPlus={() => setPlus(open => !open)} onKeyboard={() => setTyping(true)} onUtterance={onUtterance} />
        )}
      </div>
      <PlusMenu open={plus} onClose={() => setPlus(false)} coverPlus={!typing} plusRef={plusRef} />
    </>
  );
}
