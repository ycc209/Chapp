import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { ForwardIcon, PhotosIcon } from '../protocol/icons.tsx';
import { fileToShot, frameToShot, type Shot } from './photo.ts';

type CameraProps = {
  shots: Shot[];
  onShots: (shots: Shot[]) => void;
  /** Done: on to matching the bottles. */
  onDone: () => void;
};

type Lens = 'starting' | 'live' | 'none';

const ROUND = 'flex size-11 shrink-0 items-center justify-center rounded-full bg-white/12 text-white outline-none focus-visible:ring-2 focus-visible:ring-white';

/**
 * Camera.dc.html: one photo of the kit or several. The phone's back camera fills the viewfinder; the shutter keeps
 * the frame (made small, SHOT_MAX px). Without a camera (a computer, or permission refused) the viewfinder and the
 * shutter open the photo library instead, as the button at the top left always does.
 */
export function Camera({ shots, onShots, onDone }: CameraProps) {
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [lens, setLens] = useState<Lens>('starting');
  const flash = useRef<HTMLSpanElement>(null);

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

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    const picked = await Promise.allSettled([...files].map(fileToShot));
    const ok = picked.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
    if (ok.length) onShots(ok);
    if (ok.length < picked.length) toast(`${picked.length - ok.length} picture${picked.length - ok.length === 1 ? '' : 's'} could not be opened.`);
  };

  const last = shots.slice(-2);
  return (
    <div className="flex h-full flex-col gap-[18px] bg-[#0b0b0c] px-5 pt-[calc(56px+var(--screen-top))] pb-[calc(6px+var(--screen-bottom))] text-white">
      <div className="flex items-center justify-between gap-2">
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
        <button
          type="button"
          aria-label="Take a photo"
          onClick={shoot}
          className="flex size-[76px] items-center justify-center justify-self-center rounded-full border-4 border-white outline-none focus-visible:ring-2 focus-visible:ring-blue active:scale-95"
        >
          <span className="size-[60px] rounded-full bg-white" />
        </button>
        <div className="justify-self-end">
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
        accept="image/*"
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
