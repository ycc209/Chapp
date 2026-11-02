import { useMemo, useState, type ReactNode } from 'react';
import type { BenchScene } from '../../../shared/bench.ts';
import { benchScenes, type Sized } from '../../../shared/benchScenes.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { BenchView } from '../../components/bench/BenchView.tsx';
import { BenchSheet, ReplayIcon } from '../protocol/BenchSheet.tsx';
import { EnlargeIcon } from '../protocol/Body.tsx';
import { procedureFor } from '../protocol/content.ts';

/**
 * The step pictures while the protocol plays (Run and Follow): the step's bench scene with the kit bottles the user
 * photographed standing in it as theirs (upright, and whole where Muse Image filled them in), and the run's own
 * numbers on it where the plan set them (`sized`: the amounts on the arrows, the wells, the incubation chosen), in
 * words big enough to read from arm's length (the scene laid out for them, and drawn big). Big, it plays the step
 * from the start as the step opens, and again on a tap, and carries the switch for the words under it (`words`:
 * what to do written out, by the user's choice); small, beside Chapp's line where a grid is the step, a tap opens it
 * big (BenchSheet), whose arrows go through the other steps' pictures without moving the run. `ids` are the run's
 * steps in order, by protocol step id.
 */
export function useStepPictures(p: Protocol, procedureId: string | null | undefined, ids: string[], photos: Record<string, string>, sized?: Sized, words?: Words) {
  const key = ids.join('\n');
  const scenes = useMemo(() => {
    let all: Map<string, BenchScene>;
    try {
      all = benchScenes(p, procedureFor(p, procedureId), { big: true, ...sized });
    } catch {
      all = new Map();
    }
    return key.split('\n').flatMap((id, i) => {
      const scene = all.get(id);
      return scene?.items.length ? [{ n: i + 1, scene }] : [];
    });
  }, [p, procedureId, key, sized]);
  const [open, setOpen] = useState<number | null>(null);
  /** The pictures of step `at` (from 0), or null when it has none. */
  const pictureOf = (at: number): { small: ReactNode; big: ReactNode } | null => {
    const k = scenes.findIndex(s => s.n === at + 1);
    if (k < 0) return null;
    const scene = scenes[k]!.scene;
    return { small: <Thumb scene={scene} photos={photos} onOpen={() => setOpen(k)} />, big: <Play key={at} scene={scene} photos={photos} words={words} /> };
  };
  const sheet = <BenchSheet scenes={scenes} at={open} onAt={setOpen} onClose={() => setOpen(null)} photos={photos} big />;
  return { pictureOf, sheet };
}

const BENCH_BG = 'bg-[linear-gradient(180deg,#f7f9fc_0%,#eef2f7_78%,#e4e9f0_100%)]';
const CORNER = 'flex size-9 cursor-pointer items-center justify-center rounded-full border-0 p-0 shadow-[0_1px_3px_rgba(17,17,19,0.15)] outline-none focus-visible:ring-2 focus-visible:ring-blue';

/** Whether the words under the picture are shown, and the switch. */
type Words = { on: boolean; set: (on: boolean) => void };

/** The step played, as big as the screen is wide; a tap plays it again. At its corners: the words on or off, and play again. */
function Play({ scene, photos, words }: { scene: BenchScene; photos: Record<string, string>; words?: Words }) {
  const [replay, setReplay] = useState(0);
  const again = () => setReplay(r => r + 1);
  return (
    <div className={`relative mb-5 aspect-square w-full shrink-0 overflow-hidden rounded-[18px] ${BENCH_BG}`}>
      <div className="size-full cursor-pointer" onClick={again}>
        <BenchView scene={scene} mode="play" replay={replay} photos={photos} big />
      </div>
      {words && (
        <button
          type="button"
          aria-pressed={words.on}
          aria-label={words.on ? 'Hide the words under the picture' : 'Show the words under the picture'}
          onClick={() => words.set(!words.on)}
          className={`${CORNER} absolute bottom-2.5 left-2.5 ${words.on ? 'bg-ink text-white' : 'bg-card/90 text-ink'}`}
        >
          <WordsIcon />
        </button>
      )}
      <button type="button" aria-label="Play this step again" onClick={again} className={`${CORNER} absolute right-2.5 bottom-2.5 bg-card/90 text-ink`}>
        <ReplayIcon />
      </button>
    </div>
  );
}

/** Lines of text: the words under the picture. */
const WordsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);

function Thumb({ scene, photos, onOpen }: { scene: BenchScene; photos: Record<string, string>; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="See this step on the bench"
      onClick={onOpen}
      className={`relative -mt-1 aspect-square w-[108px] shrink-0 cursor-pointer overflow-hidden rounded-[14px] border-0 ${BENCH_BG} p-0 shadow-soft outline-none focus-visible:ring-2 focus-visible:ring-blue`}
    >
      <BenchView scene={scene} mode="still" photos={photos} />
      <span className="absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-full bg-card/90 text-ink shadow-[0_1px_3px_rgba(17,17,19,0.15)]">
        <EnlargeIcon />
      </span>
    </button>
  );
}
