import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { ForwardIcon, PhotosIcon } from '../protocol/icons.tsx';
import { fileToShot, frameToShot, isVideo, recordSweep, type Footage, type Shot } from './photo.ts';

type CameraProps = {
  shots: Shot[];
  onShots: (shots: Shot[]) => void;
  /** A sweep (analysis.ts followBottles); onDone follows. */
  onFootage: (footage: Footage) => void;
  /** A video chosen from the library, to play on screen while the models look at it (Watch.tsx). */
  onVideo: (video: File) => void;
  /** Done: on to matching the bottles. */
  onDone: () => void;
};

type Lens = 'starting' | 'live' | 'none';
type Mode = 'photo' | 'sweep';

/** A sweep's length: long enough to pass the camera over a kit's bottles, short enough to hold steady. */
export const SWEEP_SECONDS = 12;
/**
 * While sweeping, a frame is kept this often, and the last one when it stops: the photos when SAM cannot follow the
 * bottles through the recording itself, and the first may show the kit's packaging.
 */
const SWEEP_EVERY_MS = 2500;
/** The sweep button's ring: its radius and length, for the progress drawn around it. */
const RING_R = 36;
const RING = 2 * Math.PI * RING_R;

const ROUND = 'flex size-11 shrink-0 items-center justify-center rounded-full bg-white/12 text-white outline-none focus-visible:ring-2 focus-visible:ring-white';

/**
 * Camera.dc.html: one photo of the kit or several. The phone's back camera fills the viewfinder; the shutter keeps
 * the frame (made small, SHOT_MAX px). Without a camera (a computer, or permission refused) the viewfinder and the
 * shutter open the photo library instead, as the button at the top left always does.
 *
 * Sweep: the camera passed slowly over the bottles for up to SWEEP_SECONDS, a ring filling around the button. It is
 * recorded (an MP4, where the browser can) for SAM to follow the bottles through, frames kept along the way in case it
 * cannot, and the sweep goes straight on to matching, so the next screen is what was found. A video chosen from the
 * library plays on screen while SAM follows the bottles through it (Watch.tsx), then matching.
 */
export function Camera({ shots, onShots, onFootage, onVideo, onDone }: CameraProps) {
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [lens, setLens] = useState<Lens>('starting');
  const flash = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<Mode>('photo');
  const [sweep, setSweep] = useState<{ started: number } | null>(null);
  const [now, setNow] = useState(0);
  const frames = useRef<Shot[]>([]);
  const sweeping = useRef(false);
  const recording = useRef<ReturnType<typeof recordSweep>>(null);

  useEffect(() => {
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
  }, []);

  const shoot = () => {
    const v = video.current;
    if (lens !== 'live' || !v || !v.videoWidth) {
      file.current?.click();
      return;
    }
    onShots([frameToShot(v)]);
    flash.current?.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' });
  };

  const keepFrame = () => {
    const v = video.current;
    if (v?.videoWidth) frames.current.push({ ...frameToShot(v), sweep: true });
  };

  const startSweep = () => {
    if (lens !== 'live' || !video.current?.videoWidth) {
      file.current?.click();
      return;
    }
    frames.current = [];
    sweeping.current = true;
    recording.current = recordSweep(video.current.srcObject as MediaStream);
    const started = Date.now();
    setNow(started);
    setSweep({ started });
  };

  // Stopped by a tap or by the time running out: the last frame too and the recording, then on to what was found.
  const finishSweep = () => {
    if (!sweeping.current) return;
    sweeping.current = false;
    keepFrame();
    const kept = frames.current;
    frames.current = [];
    const recorder = recording.current;
    recording.current = null;
    setSweep(null);
    if (!kept.length) return void recorder?.stop();
    void (recorder?.stop() ?? Promise.resolve(null)).then(clip => {
      onFootage({ kind: 'sweep', frames: kept, video: clip });
      onDone();
    });
  };
  const finish = useRef(finishSweep);
  finish.current = finishSweep;

  useEffect(() => {
    if (!sweep) return;
    const every = window.setInterval(keepFrame, SWEEP_EVERY_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 100);
    const end = window.setTimeout(() => finish.current(), SWEEP_SECONDS * 1000);
    return () => {
      window.clearInterval(every);
      window.clearInterval(tick);
      window.clearTimeout(end);
    };
  }, [sweep]);

  const elapsed = sweep ? Math.min(SWEEP_SECONDS, (now - sweep.started) / 1000) : 0;
  const left = Math.max(0, Math.ceil(SWEEP_SECONDS - elapsed));

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    const chosen = [...files];
    const video = chosen.find(isVideo);
    const picked = await Promise.allSettled(chosen.filter(f => !isVideo(f)).map(fileToShot));
    const ok = picked.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
    if (ok.length) onShots(ok);
    if (ok.length < picked.length) toast(`${picked.length - ok.length} picture${picked.length - ok.length === 1 ? '' : 's'} could not be opened.`);
    // One video at a time: it plays, and then on to what was found.
    if (video) onVideo(video);
  };

  const last = shots.slice(-2);
  return (
    <div className="flex h-full flex-col gap-[18px] bg-[#0b0b0c] px-5 pt-[calc(56px+var(--screen-top))] pb-[calc(6px+var(--screen-bottom))] text-white">
      <div className={cn('flex items-center justify-between gap-2', sweep && 'invisible')}>
        <button type="button" aria-label="Choose from your photos" onClick={() => file.current?.click()} className={ROUND}>
          <PhotosIcon />
        </button>
        <Link to="/protocol" aria-label="Back to the protocol" className={ROUND}>
          <ForwardIcon />
        </Link>
      </div>

      <div className="relative min-h-0 grow overflow-hidden rounded-[24px] bg-[#1b1b1d]">
        <video
          ref={video}
          muted
          playsInline
          autoPlay
          aria-label="Camera view"
          className={cn('absolute inset-0 size-full object-cover', lens !== 'live' && 'hidden')}
        />
        {lens !== 'live' && (
          <button
            type="button"
            onClick={() => lens === 'none' && file.current?.click()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 outline-none"
          >
            <span className="text-[14px] leading-[18px] font-semibold text-faint">{lens === 'none' ? 'No camera here' : 'Camera view'}</span>
            {lens === 'none' && (
              <span className="flex min-h-11 items-center rounded-full bg-white px-4 text-[15px] leading-5 font-semibold text-ink">
                Choose from your photos
              </span>
            )}
          </button>
        )}
        <Corner className="top-[18px] left-[18px] rounded-tl-[10px] border-t-[3px] border-l-[3px]" />
        <Corner className="top-[18px] right-[18px] rounded-tr-[10px] border-t-[3px] border-r-[3px]" />
        <Corner className="bottom-[18px] left-[18px] rounded-bl-[10px] border-b-[3px] border-l-[3px]" />
        <Corner className="right-[18px] bottom-[18px] rounded-br-[10px] border-r-[3px] border-b-[3px]" />
        <span ref={flash} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-white opacity-0" />
        {mode === 'sweep' && lens === 'live' && (
          <p
            role="status"
            className="absolute top-[30px] left-1/2 m-0 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-[14px] leading-[18px] font-semibold whitespace-nowrap text-white backdrop-blur-sm"
          >
            {sweep ? (
              <>
                <span aria-hidden="true" className="size-2.5 shrink-0 animate-pulse rounded-full bg-[#ff3b30]" />
                <span className="tabular-nums">0:{String(left).padStart(2, '0')}</span>
                <span className="font-medium text-white/80">Labels facing you</span>
              </>
            ) : (
              'Sweep slowly, labels facing you'
            )}
          </p>
        )}
      </div>

      <div role="radiogroup" aria-label="Camera mode" className={cn('flex gap-1 self-center rounded-full bg-white/12 p-1', sweep && 'invisible')}>
        {(['photo', 'sweep'] as const).map(m => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'min-h-8 rounded-full px-4 text-[14px] leading-[18px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white',
              mode === m ? 'bg-white text-ink' : 'text-white/75',
            )}
          >
            {m === 'photo' ? 'Photo' : 'Sweep'}
          </button>
        ))}
      </div>

      <div className="grid min-h-[76px] grid-cols-3 items-center">
        <div className="justify-self-start">
          {last.length > 0 && (
            <span aria-hidden="true" className="relative block size-[50px]">
              {last.length > 1 && (
                <img src={last[0].src} alt="" className="absolute top-0 left-1.5 size-11 rounded-[10px] bg-[#2a2a2e] object-cover shadow-[0_0_0_1.5px_rgba(255,255,255,0.35)]" />
              )}
              <img
                src={last[last.length - 1].src}
                alt=""
                className="absolute top-1.5 left-0 size-11 rounded-[10px] bg-[#3a3a3f] object-cover shadow-[0_0_0_2px_#ffffff]"
              />
            </span>
          )}
        </div>
        {mode === 'photo' ? (
          <button
            type="button"
            aria-label="Take a photo"
            onClick={shoot}
            className="flex size-[76px] items-center justify-center justify-self-center rounded-full border-4 border-white outline-none focus-visible:ring-2 focus-visible:ring-blue active:scale-95"
          >
            <span className="size-[60px] rounded-full bg-white" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={sweep ? 'Stop sweeping' : `Sweep for ${SWEEP_SECONDS} seconds`}
            onClick={sweep ? finishSweep : startSweep}
            className="relative flex size-[76px] items-center justify-center justify-self-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue active:scale-95"
          >
            <svg aria-hidden="true" viewBox="0 0 76 76" className="absolute inset-0 -rotate-90">
              <circle cx="38" cy="38" r={RING_R} fill="none" stroke={sweep ? 'rgba(255,255,255,0.3)' : '#ffffff'} strokeWidth="4" />
              {sweep && (
                <circle cx="38" cy="38" r={RING_R} fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - elapsed / SWEEP_SECONDS)} />
              )}
            </svg>
            <span className={cn('bg-[#ff3b30] transition-all duration-200', sweep ? 'size-7 rounded-[8px]' : 'size-[60px] rounded-full')} />
          </button>
        )}
        <div className={cn('justify-self-end', sweep && 'invisible')}>
          {shots.length > 0 && (
            <button
              type="button"
              aria-label={`Done, ${shots.length} photo${shots.length === 1 ? '' : 's'}`}
              onClick={onDone}
              className="flex min-h-11 items-center gap-2 rounded-[22px] bg-white pr-2 pl-[18px] text-[15px] leading-5 font-[650] text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              Done
              <span className="h-7 min-w-7 rounded-[14px] bg-ink px-2 text-center text-[14px] leading-7 font-bold text-white tabular-nums">
                {shots.length}
              </span>
            </button>
          )}
        </div>
      </div>

      <input
        ref={file}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        tabIndex={-1}
        onChange={e => {
          void pick(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function Corner({ className }: { className: string }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute size-[37px] border-white', className)} />;
}
