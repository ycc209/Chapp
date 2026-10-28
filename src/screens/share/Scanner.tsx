import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { shareIdFrom } from '../../../shared/share.ts';

type Source = HTMLVideoElement | ImageBitmap;
type Reader = (source: Source) => Promise<string | null>;

// The camera's frames are read at this width at most: plenty for a code that fills part of the frame, and cheap.
const READ_WIDTH = 720;
const EVERY_MS = 150;

/**
 * Reads QR codes: the browser's BarcodeDetector where it has one (Chrome on Android), otherwise jsQR on a canvas
 * (iPhone Safari has no BarcodeDetector), loaded only then.
 */
async function qrReader(): Promise<Reader> {
  const Detector = (window as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (Detector && (await Detector.getSupportedFormats?.().catch(() => [] as string[]))?.includes('qr_code')) {
    const detector = new Detector({ formats: ['qr_code'] });
    return async source => (await detector.detect(source).catch(() => []))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  return async source => {
    const [w, h] = source instanceof HTMLVideoElement ? [source.videoWidth, source.videoHeight] : [source.width, source.height];
    if (!w || !h) return null;
    const scale = Math.min(1, READ_WIDTH / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    g.drawImage(source, 0, 0, canvas.width, canvas.height);
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

type BarcodeDetectorClass = {
  new (options: { formats: string[] }): { detect(source: Source): Promise<{ rawValue: string }[]> };
  getSupportedFormats?: () => Promise<string[]>;
};

type Camera = 'starting' | 'on' | 'denied' | 'none';

const CAMERA_NOTE: Record<Camera, string> = {
  starting: '',
  on: '',
  denied: 'The camera is off for Chapp. Allow it in Settings, or choose a photo of the code.',
  none: 'No camera here. Choose a photo or a screenshot of the code.',
};

/**
 * The + menu's QR code: the camera, looking for a labmate's Chapp code (no artboard; it wears the Camera artboard's
 * dark viewfinder). A Chapp code opens what was shared (/import?s=<id>); any other code says so. Without a camera, or
 * with it refused, a photo or screenshot of the code works the same way.
 */
export function Scanner() {
  const navigate = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const reader = useRef<Promise<Reader> | null>(null);
  const [camera, setCamera] = useState<Camera>('starting');
  const [note, setNote] = useState('');
  const done = useRef(false);

  const read = () => (reader.current ??= qrReader());

  /** What a code said: a Chapp share opens; anything else is named and the scan goes on. */
  const found = (text: string) => {
    const id = shareIdFrom(text);
    if (id) {
      done.current = true;
      navigate(`/import?s=${id}`, { replace: true });
      return true;
    }
    const note = "That code isn't a Chapp setup.";
    setNote(note);
    // Said once; when the camera moves on, the hint comes back.
    setTimeout(() => setNote(now => (now === note ? '' : now)), 2500);
    return false;
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setCamera('none');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (error) {
        const name = (error as { name?: string }).name;
        return setCamera(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'none');
      }
      if (stopped || !video.current) return stream.getTracks().forEach(t => t.stop());
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      setCamera('on');
      const decode = await read();
      const tick = async () => {
        if (stopped || done.current) return;
        const v = video.current;
        const text = v && v.readyState >= 2 ? await decode(v) : null;
        if (text && found(text)) return;
        timer = window.setTimeout(tick, EVERY_MS);
      };
      void tick();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const fromPhoto = async (picked: File) => {
    setNote('');
    try {
      const bitmap = await createImageBitmap(picked);
      const text = await (await read())(bitmap);
      bitmap.close();
      if (!text) return setNote('No code in that picture. Try one where the code fills more of it.');
      found(text);
    } catch {
      setNote("I couldn't open that picture.");
    }
  };

  const message = CAMERA_NOTE[camera];
  return (
    <div className="flex h-full flex-col gap-[18px] bg-[#0b0b0c] px-5 pt-[calc(56px+var(--screen-top))] pb-[calc(6px+var(--screen-bottom))] text-white">
      <div className="flex items-center justify-between gap-2">
        <button type="button" aria-label="Choose from your photos" onClick={() => file.current?.click()} className={ROUND}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </button>
        <Link to="/" aria-label="Close" className={ROUND}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </Link>
      </div>

      <div className="relative flex grow items-center justify-center overflow-hidden rounded-[24px] bg-[#1b1b1d]">
        <video
          ref={video}
          muted
          playsInline
          aria-label="Camera view"
          className="absolute inset-0 size-full object-cover"
          style={{ opacity: camera === 'on' ? 1 : 0 }}
        />
        <Corner className="top-[18px] left-[18px] rounded-tl-[10px] border-t-[3px] border-l-[3px]" />
        <Corner className="top-[18px] right-[18px] rounded-tr-[10px] border-t-[3px] border-r-[3px]" />
        <Corner className="bottom-[18px] left-[18px] rounded-bl-[10px] border-b-[3px] border-l-[3px]" />
        <Corner className="right-[18px] bottom-[18px] rounded-br-[10px] border-r-[3px] border-b-[3px]" />
        {message && <p className="relative m-0 max-w-[260px] text-center text-sm leading-[18px] font-semibold text-faint">{message}</p>}
      </div>

      <div className="flex min-h-[76px] flex-col items-center justify-center gap-1 text-center">
        <p className="m-0 text-[17px] leading-[22px] font-semibold text-white">Scan a labmate's Chapp code</p>
        <p aria-live="polite" className="m-0 min-h-5 text-[15px] leading-5 font-medium text-faint">
          {note || (camera === 'on' ? 'Hold it inside the frame' : '')}
        </p>
      </div>

      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        tabIndex={-1}
        onChange={e => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (picked) void fromPhoto(picked);
        }}
      />
    </div>
  );
}

const ROUND =
  'flex size-11 shrink-0 items-center justify-center rounded-full bg-white/12 text-white outline-none focus-visible:ring-2 focus-visible:ring-white';

function Corner({ className }: { className: string }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute size-[34px] border-white ${className}`} />;
}
