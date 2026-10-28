import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SampleDataTag } from '../../components/lab/index.ts';
import { cn } from '../../lib/cn.ts';
import { fileToShot, frameToShot, loadImage } from '../kit/photo.ts';

/** Where reading the photo stands: being read, read (with "All 42 wells are readable."), the sample, or not read. */
export type PhotoStatus = { phase: 'reading' } | { phase: 'read'; line: string } | { phase: 'sample' } | { phase: 'failed'; line: string };

export type PhotoProps = {
  /** "Heard “photo”" at the top, when the camera was opened by voice. */
  heard: string | null;
  /** Keep the photo: a small JPEG data URL to keep on the phone, and a large one to read the numbers from. */
  onPhoto: (shot: { src: string; big: string }) => void;
  /** How reading it goes, from the screen (null until the photo is taken). */
  status: PhotoStatus | null;
  /** After the photo: on to checking the numbers (or to the results, for the sample readings). */
  onResults: () => void;
  /** Not read: the photo is dropped and the countdown starts again. */
  onRetake: () => void;
  onClose: () => void;
  /** For design review by address: hold the countdown at 2, or show the photo taken, without the camera. */
  review?: 'photo' | 'taken' | null;
  /** The listening bar the screen draws at the bottom (gloves on). */
  children?: ReactNode;
};

type Lens = 'starting' | 'live' | 'none';

const COUNT_FROM = 3;
/** The photo sent to be read is this big on its long side: 96 small numbers need more than the kept 720 px. */
const READ_MAX = 2048;

/** `source` at most READ_MAX on its long side, as a JPEG data URL. */
function readShot(source: CanvasImageSource, width: number, height: number): string {
  const scale = Math.min(1, READ_MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

/**
 * Gloves-Photo, "the photo, 3-2-1": the back camera on the plate reader's screen, a countdown so a gloved hand does
 * not have to find the shutter, then the photo read (Muse Spark through /api/read-plate): "Got it. All 42 wells are
 * readable." The numbers are the user's to check before the curve is fit, so the next tap opens them on Run-Read.
 * With the mock AI, the sample plate-reader export stands in, said so in words and with the Sample data tag. Without
 * a camera (a computer, or permission refused) the viewfinder opens a picture from the files instead.
 */
export function PhotoView({ heard, onPhoto, status, onResults, onRetake, onClose, review, children }: PhotoProps) {
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [lens, setLens] = useState<Lens>(review ? 'none' : 'starting');
  const [count, setCount] = useState(review === 'photo' ? 2 : COUNT_FROM);
  const [shot, setShot] = useState<string | null>(null);
  /** Goes up for each new try, which starts the camera again. */
  const [round, setRound] = useState(0);
  const taken = review === 'taken' || shot !== null;
  const counting = review === 'photo' || (lens === 'live' && !taken);

  useEffect(() => {
    if (review) return;
    let stream: MediaStream | null = null;
    let live = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setLens('none');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false })
      .then(s => {
        if (!live) return s.getTracks().forEach(t => t.stop());
        stream = s;
        const v = video.current;
        if (!v) return;
        v.srcObject = s;
        return v.play().then(() => live && setLens('live'));
      })
      .catch(() => live && setLens('none'));
    return () => {
      live = false;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [review, round]);

  const keep = (src: string, big: string) => {
    setShot(src);
    onPhoto({ src, big });
    const v = video.current;
    (v?.srcObject as MediaStream | null)?.getTracks().forEach(t => t.stop());
  };

  const shoot = () => {
    if (taken || review) return;
    const v = video.current;
    if (lens === 'live' && v?.videoWidth) keep(frameToShot(v).src, readShot(v, v.videoWidth, v.videoHeight));
    else file.current?.click();
  };

  const again = () => {
    setShot(null);
    setCount(COUNT_FROM);
    setLens('starting');
    setRound(r => r + 1);
    onRetake();
  };
  const phase = status?.phase ?? (review === 'taken' ? 'read' : 'reading');

  // 3, 2, 1, then the shutter.
  useEffect(() => {
    if (!counting || review) return;
    if (count === 0) {
      shoot();
      return;
    }
    const t = setTimeout(() => setCount(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [counting, count, review]);

  const corners = (
    <>
      <span aria-hidden="true" className="absolute top-[18px] left-[18px] size-[34px] rounded-tl-[10px] border-t-[3px] border-l-[3px] border-white" />
      <span aria-hidden="true" className="absolute top-[18px] right-[18px] size-[34px] rounded-tr-[10px] border-t-[3px] border-r-[3px] border-white" />
      <span aria-hidden="true" className="absolute bottom-[18px] left-[18px] size-[34px] rounded-bl-[10px] border-b-[3px] border-l-[3px] border-white" />
      <span aria-hidden="true" className="absolute right-[18px] bottom-[18px] size-[34px] rounded-br-[10px] border-r-[3px] border-b-[3px] border-white" />
    </>
  );
  const frame = 'relative flex min-h-0 w-full grow items-center justify-center overflow-hidden rounded-[24px] border-0 bg-[#1b1b1d] p-0 font-[inherit] text-white outline-none focus-visible:ring-2 focus-visible:ring-white';

  return (
    <div role="dialog" aria-label="Photo of the plate reader" className="absolute inset-0 z-[8] bg-[#0b0b0c]">
      <div className="flex h-full flex-col gap-[18px] px-5 pt-[calc(56px+var(--screen-top))] pb-[calc(90px+var(--screen-bottom))] text-white">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <button
            type="button"
            aria-label="Close the camera"
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/12 text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          {heard ? (
            <p className="m-0 flex items-center gap-2 rounded-full bg-white/12 px-3.5 py-2 text-[14px] leading-[18px] font-semibold">
              <span aria-hidden="true" className="size-2 rounded-full bg-mark" />
              Heard “{heard}”
            </p>
          ) : (
            <span />
          )}
          <span aria-hidden="true" className="size-11 shrink-0" />
        </div>

        {taken ? (
          <button
            type="button"
            aria-label={phase === 'failed' ? 'Take the photo again' : phase === 'reading' ? 'Reading the wells' : phase === 'sample' ? 'See the results' : 'Check the readings'}
            aria-disabled={phase === 'reading'}
            onClick={() => (phase === 'failed' ? again() : phase === 'reading' ? undefined : onResults())}
            className={cn(frame, phase === 'reading' ? 'cursor-default' : 'cursor-pointer')}
          >
            {shot && <img src={shot} alt="Your photo of the plate reader" className="absolute inset-0 size-full object-cover opacity-70" />}
            {corners}
            {phase === 'read' || phase === 'sample' ? (
              <span aria-hidden="true" className="absolute flex size-[132px] items-center justify-center rounded-full bg-mark text-ink">
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              </span>
            ) : (
              <span aria-hidden="true" className="absolute flex size-[132px] items-center justify-center rounded-full bg-[rgba(11,11,12,0.62)] text-white shadow-[0_0_0_3px_#ffe863]">
                {phase === 'failed' ? (
                  <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                ) : (
                  <span className="flex gap-2">
                    {[0, 1, 2].map(i => (
                      <span key={i} className="size-3 animate-pulse rounded-full bg-white" style={{ animationDelay: `${i * 0.2}s` }} />
                    ))}
                  </span>
                )}
              </span>
            )}
          </button>
        ) : (
          <button type="button" aria-label={lens === 'live' ? 'Take the photo now' : 'Choose a photo of the reader’s screen'} onClick={shoot} className={cn(frame, 'cursor-pointer')}>
            <video ref={video} muted playsInline className={cn('absolute inset-0 size-full object-cover', lens === 'live' ? 'opacity-100' : 'opacity-0')} />
            {corners}
            {counting ? (
              <span
                aria-hidden="true"
                className="absolute flex size-[132px] items-center justify-center rounded-full bg-[rgba(11,11,12,0.62)] text-[72px] leading-none font-[800] text-white tabular-nums shadow-[0_0_0_3px_#ffe863]"
              >
                {count}
              </span>
            ) : lens === 'none' ? (
              <span className="relative flex flex-col items-center gap-2 px-8 text-center">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-4.5-4.5L5 21" />
                </svg>
                <span className="text-[17px] leading-6 font-semibold">Choose a photo</span>
              </span>
            ) : null}
          </button>
        )}

        <div aria-live="polite" className="flex shrink-0 flex-col gap-1.5 px-1">
          {taken && phase === 'reading' ? (
            <p className="m-0 text-[20px] leading-[26px] font-bold">Got the photo. Reading the wells…</p>
          ) : taken && phase === 'read' ? (
            <>
              <p className="m-0 text-[20px] leading-[26px] font-bold">Got it. {status?.phase === 'read' ? status.line : 'All the wells are readable.'}</p>
              <p className="m-0 text-[15px] leading-5 font-medium text-white/78">Check the numbers, then I fit the curve.</p>
            </>
          ) : taken && phase === 'failed' ? (
            <>
              <p className="m-0 text-[20px] leading-[26px] font-bold">I couldn’t read the wells.</p>
              <p className="m-0 text-[15px] leading-5 font-medium text-white/78">
                {status?.phase === 'failed' ? `${status.line} ` : ''}Tap the photo to take it again.
              </p>
            </>
          ) : taken ? (
            <>
              <p className="m-0 text-[20px] leading-[26px] font-bold">Got the photo.</p>
              <p className="m-0 text-[15px] leading-5 font-medium text-white/78">The results use the sample plate-reader export.</p>
              <SampleDataTag className="mt-1.5 self-start" />
            </>
          ) : counting ? (
            <p className="m-0 text-[20px] leading-[26px] font-bold">Hold still. Taking it in {count}…</p>
          ) : lens === 'none' ? (
            <p className="m-0 text-[20px] leading-[26px] font-bold">No camera here. Choose a photo of the reader’s screen.</p>
          ) : (
            <p className="m-0 text-[20px] leading-[26px] font-bold">Opening the camera…</p>
          )}
        </div>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        tabIndex={-1}
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const url = URL.createObjectURL(f);
          void Promise.all([fileToShot(f), loadImage(url)])
            .then(([s, img]) => keep(s.src, readShot(img, img.naturalWidth, img.naturalHeight)), () => {})
            .finally(() => URL.revokeObjectURL(url));
        }}
      />
      {children}
    </div>
  );
}
