import { useEffect, useState, type ReactNode } from 'react';
import type { BenchScene, Item } from '../../../shared/bench.ts';
import { BenchView, photoOf } from '../../components/bench/BenchView.tsx';
import { useCutout, type Cut } from '../../components/bench/cutout.ts';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../../components/ui/Sheet.tsx';
import { cn } from '../../lib/cn.ts';
import { CloseIcon, DocumentIcon } from './icons.tsx';

/**
 * A step's picture, enlarged (opened from its card): the step played from the start on the bench, again on Replay, and
 * the steps before and after it, the bench carrying on. A tap on anything says what it is and where it comes from:
 * the protocol (its field and page, its words) or drawn, and which of its looks are drawn rather than said. The kit
 * bottles the user photographed (`photos`, by component id) stand on the bench as theirs.
 */
export function BenchSheet({ scenes, at, onAt, onClose, photos }: { scenes: { n: number; scene: BenchScene }[]; at: number | null; onAt: (i: number) => void; onClose: () => void; photos?: Record<string, string> }) {
  const shown = at === null ? null : scenes[at];
  const [replay, setReplay] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [at]);
  const item = picked ? shown?.scene.items.find(it => it.id === picked) : undefined;

  return (
    <Sheet open={!!shown} onOpenChange={open => !open && onClose()}>
      <SheetContent side="bottom" className="h-[94%] gap-4 px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        {shown && (
          <>
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 grow flex-col gap-0.5">
                <span className="text-[13px] leading-[18px] font-semibold text-text tabular-nums">Step {shown.n}</span>
                <SheetTitle className="text-[20px] leading-[25px]">{shown.scene.title}</SheetTitle>
              </div>
              <SheetClose aria-label="Close" className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue">
                <CloseIcon />
              </SheetClose>
            </div>
            <div className="aspect-square w-full shrink-0 overflow-hidden rounded-[18px] bg-[linear-gradient(180deg,#f7f9fc_0%,#eef2f7_78%,#e4e9f0_100%)]">
              <BenchView key={at} scene={shown.scene} mode="play" replay={replay} picked={picked} onPick={setPicked} photos={photos} />
            </div>
            <p className="text-[15px] leading-[21px] text-ink">{shown.scene.caption.text}</p>
            <div className="min-h-0 grow overflow-y-auto">{item ? <About item={item} photo={photoOf(item, photos)} /> : <p className="text-[14px] leading-5 text-text">Tap anything on the bench to see what it is and where it comes from.</p>}</div>
            <div className="flex shrink-0 items-center gap-2">
              <Button disabled={at === 0} onClick={() => onAt(at! - 1)} label="Previous step">
                <Chevron left />
              </Button>
              <button
                type="button"
                onClick={() => setReplay(r => r + 1)}
                className="flex h-11 grow items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-semibold text-card outline-none focus-visible:ring-2 focus-visible:ring-blue"
              >
                <ReplayIcon />
                Replay
              </button>
              <Button disabled={at === scenes.length - 1} onClick={() => onAt(at! + 1)} label="Next step">
                <Chevron />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function About({ item, photo }: { item: Item; photo?: string }) {
  const s = item.source;
  const cut = useCutout(photo);
  // The user's own bottle is shown, not drawn: its drawn looks no longer apply.
  const own = cut?.ok ? cut : null;
  const drawn = own ? [] : Object.entries(item.drawn ?? {});
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-sunken p-3.5">
      <span className="text-[15px] leading-5 font-semibold text-ink">{item.represents}</span>
      {own && <YourBottle cut={own} />}
      {s.from === 'protocol' ? (
        <span className="flex items-start gap-1.5 text-[13px] leading-[18px] text-text">
          <span className="mt-[2px] shrink-0">
            <DocumentIcon size={13} />
          </span>
          <span>
            From the protocol{s.page ? `, page ${s.page}` : ''}
            {s.quote && <span className="mt-1 block text-ink italic">“{s.quote}”</span>}
          </span>
        </span>
      ) : (
        <span className="text-[13px] leading-[18px] text-text">Drawn: {s.why}</span>
      )}
      {(drawn.length > 0 || (cut && !cut.ok)) && (
        <ul className="flex flex-col gap-1 border-t border-line pt-2 text-[13px] leading-[18px] text-text">
          {cut && !cut.ok && (
            <li>
              <span className="font-semibold">Your photo</span> of it: {cut.why}, so the bottle is drawn.
            </li>
          )}
          {drawn.map(([what, why]) => (
            <li key={what}>
              <span className="font-semibold capitalize">{what}</span> drawn: {why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The user's own bottle as it stands on the bench, cut out of their kit photo. */
function YourBottle({ cut }: { cut: Cut }) {
  return (
    <span className="flex items-center gap-3">
      <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-card">
        <img src={cut.src} alt="" className="max-h-12 max-w-12 object-contain" />
      </span>
      <span className="flex flex-col text-[13px] leading-[18px] text-text">
        <span className="font-semibold text-ink">Your bottle</span>
        From the photo you took of the kit
      </span>
    </span>
  );
}

function Button({ disabled, onClick, label, children }: { disabled: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('flex size-11 shrink-0 items-center justify-center rounded-full bg-sunken text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue', disabled && 'opacity-35')}
    >
      {children}
    </button>
  );
}

const Chevron = ({ left }: { left?: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={left ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>
);

const ReplayIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
