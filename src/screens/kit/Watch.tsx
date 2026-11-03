import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Box, FollowedFrame, Point, RecognizedKit, TrackedBottles, TrackStage } from '../../../shared/ai.ts';
import { api } from '../../api/client.ts';
import { Shimmer } from '../../components/ui/Shimmer.tsx';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { bottles, splitName } from '../protocol/content.ts';
import { PlayIcon } from '../protocol/icons.tsx';
import { ModelTag } from './ModelTag.tsx';
import { agreed, bestKitRead, followBottles, KIT_READS, kitReads, otherKitRead, photoData, readInBackground, readKitOf, startFollowing, tellKit, type KitTold } from './analysis.ts';
import { gotIt } from './matching.ts';
import { analysisSrc, cropAt, followable, frameAt, frameClock, frameTimes, frameToShot, parkVideo, type Shot } from './photo.ts';
import { colourOf, foundBottles, kitProgress, labelGroups, trackMatches, type FoundBottle, type Model } from './progress.ts';
import { outlineAt, useAdded, useKit } from './store.ts';

type WatchProps = {
  video: File;
  /** Opened from Home: its first frames say which kit it is (analysis.ts tellKit), and where to go after. */
  identify?: boolean;
  /**
   * Off the kit screen (Home's Upload): once the kit is told, the photos are read in the background (readInBackground),
   * and the end of the video waits for that, so the protocol opens with the bottles in it.
   */
  background?: boolean;
  /** The video ended (both passes, or skipped), and what telling the kit came to ('none' when not asked to tell it). */
  onEnd: (told: KitTold) => void;
};

/** How long the end of the video waits at most for its frames to say which kit it is. */
const KIT_WAIT_MS = 20_000;
/** …and for SAM to come back with the bottles, so the video can play again with them outlined. */
const TRACK_WAIT_MS = 45_000;
/**
 * …and, after both passes, for the bottles' labels to be read, so the protocol opens with them: for a kit new to
 * Chapp, its manual found and what it holds read first. Only a safety net; the button goes on at any time.
 */
const FINISH_WAIT_MS = 90_000;
/** Once all of it is done, how long the bottles stay named on the last frame, ticked off below, before going on. */
const SHOWN_MS = 1500;
/** In the highlights of a video that shows the bottles one at a time, how long each bottle's moment holds. */
const HOLD_MS = 1300;
/**
 * Playing again while SAM is still going through the video, the picture keeps behind the last frame SAM is done with
 * (SAM goes through a phone's video at about 22 frames a second, a little slower than it plays): slower the closer it
 * gets, held this many frames behind, and going on once SAM is this far ahead again.
 */
const HOLD_LEAD = 4;
const GO_LEAD = 14;
/** A frame SAM picked is taken off the player as it plays it, up to this many frames late (one the browser skipped). */
const TAKE_SLACK = 3;
/** Once the video has played again this long, the kit's card shrinks to a chip, off the bottles. */
const CARD_SMALL_MS = 3000;
/** A bottle the user taps that SAM missed goes under an id of its own, from this one up (SAM's own are small)… */
const TAPPED_IDS = 1000;
/** …once SAM finds it under the finger, within this long. */
const TAP_WAIT_MS = 10_000;
/** A bottle shown from the list under the video: how long its outline flashes on the frame it is sought on. */
const PULSE_MS = 1600;

type State = 'loading' | 'playing' | 'stopped' | 'replaying' | 'finishing';
/** The one line over the video: what is under way, and the model doing it (named in its tag, the line going on from it). */
type Status = { by?: Model; text: string };
/** Where the picture sits in its frame: the video's own shape, as big as fits, in the middle. */
type Fit = { left: number; top: number; width: number; height: number };
/**
 * The kit as read on a frame of the video, for the card over the video: the frame, the kit, and where it was read;
 * `from`, how far the middle of the video is from the card's place, which it arrives from.
 */
type Card = { src: string; name: string; catalog: string; on: string | null; from: { x: number; y: number }; other?: string };
/** Where the video's picture lands inside its box (object-contain), in px of the box, and the frame on screen. */
type View = { at: number; left: number; top: number; width: number; height: number };

/** An outline's points (an SVG path of M/L/Z in fractions of the frame, samMask.ts). */
function pointsOf(outline: string): [number, number][] {
  const n = (outline.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) points.push([n[i]!, n[i + 1]!]);
  return points;
}

/** The outline as a path in px of a picture `w` × `h`: drawn in its own pixels, so its line keeps its width. */
const pathIn = (outline: string, w: number, h: number, left = 0, top = 0, scale = 1) =>
  `M${pointsOf(outline).map(([x, y]) => `${((x - left) * w * scale).toFixed(1)},${((y - top) * h * scale).toFixed(1)}`).join('L')}Z`;

/** Whether `p` is inside the outline's points (even-odd), or inside a box. */
function inside(points: [number, number][], p: Point): boolean {
  let yes = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}
const within = (b: Box, p: Point) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
/** "Reading the labels" said of a model: "reading the labels". */
const lower = (line: string) => line.charAt(0).toLowerCase() + line.slice(1);

/**
 * A video of the kit the user chose (Home's Upload, or the camera's photo library), played twice. The first time,
 * Chapp watches: its first frames (KIT_READS, read as they are taken) say which kit it is, at once when one is a kit
 * Chapp has or is read on its box or bag, else the best reading of them all (one read on a bottle; never a kit it is
 * not), shown on a card over the video, and its manual's search starts then. SAM follows the bottles through the whole
 * video from the start, frame by frame, and says how many it has found so far. Once the video ends it plays again from
 * the start with each bottle outlined as SAM outlined it on each frame, named once its label is read: while SAM is
 * still going, just behind the last frame SAM is done with (slowing, or held, so it never gets ahead of SAM). The
 * frames SAM picked for the bottles' photos are taken off this player as it plays them (analysis.ts followBottles,
 * Footage.grab): an iPhone gives a second, hidden player's first frame for any frame
 * asked of it, and seeks reliably only a player it has shown playing. The end waits for what is still under way (the
 * labels), so the protocol opens with the bottles in it; Skip goes on now, any frame not yet played sought on this
 * player. An iPhone decodes a video only while it is in the page, so the player stays on the page until done.
 */
export function Watch({ video, identify, background, onEnd }: WatchProps) {
  const root = useRef<HTMLDivElement>(null);
  /** The room the picture has, and the picture in it (the video's own shape, rounded), the video's player inside. */
  const space = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  /** Placed once already: from then on the picture eases to its new place (the list under it arriving). */
  const fitted = useRef(false);
  const [state, setState] = useState<State>('loading');
  const [played, setPlayed] = useState(0);
  /** Once the frames are being read for the kit: how many have said, of those read. */
  const [frames, setFrames] = useState({ read: 0, of: 0 });
  const [card, setCard] = useState<Card | null>(null);
  const [tracked, setTracked] = useState<TrackedBottles | null>(null);
  /** The bottles on each frame SAM is done with, as they come, and the last frame it is done with (-1: none yet). */
  const followed = useRef(new Map<number, FollowedFrame['bottles']>());
  const [front, setFront] = useState(-1);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  /** The video's frames in all, once known: how far SAM is through them, on the bar under the video. */
  const [total, setTotal] = useState(0);
  /** How the video is getting to SAM: how much of it has gone up from the phone (0–1), then where it is. */
  const [toSam, setToSam] = useState<{ sent: number; stage: TrackStage | null }>({ sent: 0, stage: null });
  /** Playing again, the picture is held for SAM to get ahead. */
  const [holding, setHolding] = useState(false);
  /** Bottles the user tapped that SAM missed, followed since (their ids); where SAM is looking for one now. */
  const [added, setAdded] = useState<number[]>([]);
  const [looking, setLooking] = useState<Point | null>(null);
  /** The bottle the user tapped to name (its id on the video). */
  const [naming, setNaming] = useState<number | null>(null);
  /** The kit's bottle the user chose in the list under the video to show on it: the next tap on the picture is that one. */
  const [assigning, setAssigning] = useState<string | null>(null);
  /** A bottle shown from the list under the video, flashing on the frame it was sought on (its id; n, each time anew). */
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);
  /** The kit's card, once the video has played again a moment: one card with the line over the video, off the bottles. */
  const [cardSmall, setCardSmall] = useState(false);
  /**
   * The video has played again and stays still (the bottles' frames all taken): on its last frame, or wherever the user
   * drags it to; a tap is for the frame on screen.
   */
  const [still, setStill] = useState(false);
  /** A tap on the picture, and what becomes of the bottle there when it is for one of the kit's (`then`, its id). */
  const tap = useRef<(at: Point, then?: (id: number) => void) => void>(() => {});
  /** The still video put at a share of its length (the bar dragged), and on the frame where a bottle shows best. */
  const scrub = useRef<(share: number) => void>(() => {});
  const show = useRef<(id: number) => boolean>(() => false);
  const [view, setView] = useState<View | null>(null);
  const [waiting, setWaiting] = useState<'kit' | 'sam' | 'labels' | null>(null);
  /** What telling the kit came to, once it has. */
  const [kind, setKind] = useState<KitTold | null>(null);
  /** SAM is following the bottles through the video and has not come back yet. */
  const [scanning, setScanning] = useState(false);
  const skip = useRef<() => void>(() => {});
  /** The other kit the frames were read as just as surely (Card's `other`), told instead when the user taps it. */
  const toOther = useRef<() => void>(() => {});
  const player = useRef<HTMLVideoElement | null>(null);
  const done = useRef(onEnd);
  done.current = onEnd;

  const following = useKit(s => s.following);
  const kitShots = useKit(s => s.shots);
  const kitSeen = useKit(s => s.seen);
  const kitPicks = useKit(s => s.picks);
  const kitThings = useKit(s => s.things);
  const kitSample = useKit(s => s.sample);
  const contents = useKit(s => s.contents);
  const protocolId = useRun(s => s.protocolId);
  const { protocol } = useProtocol(protocolId);
  // A kit new to Chapp: its contents as its manual lists them, until its protocol is read.
  const components = useMemo(
    () => (protocol ? bottles(protocol).map(c => ({ id: c.id, name: splitName(c.name).name })) : (contents ?? []).map(c => ({ id: c.id, name: c.name }))),
    [protocol, contents],
  );
  const matches = useMemo(() => trackMatches({ picks: kitPicks, seen: kitSeen }, components), [kitPicks, kitSeen, components]);
  const found = useMemo(() => foundBottles({ shots: kitShots, seen: kitSeen, picks: kitPicks, things: kitThings }, components), [kitShots, kitSeen, kitPicks, kitThings, components]);
  const inKit = useMemo(() => (protocol ? protocol.components.filter(c => c.suppliedBy === 'kit').map(c => c.id) : (contents ?? []).map(c => c.id)), [protocol, contents]);
  const work = useMemo(
    () => kitProgress({ shots: kitShots, seen: kitSeen, picks: kitPicks, following, sample: kitSample }, inKit),
    [kitShots, kitSeen, kitPicks, following, kitSample, inKit],
  );
  // For the end of the video, which waits for the user while one of the kit's bottles is not seen.
  const inKitNow = useRef(inKit);
  inKitNow.current = inKit;
  /**
   * The bottles SAM kept once done (flickers, and a cap followed apart from its bottle, dropped), with those the user
   * tapped; every one until then.
   */
  const kept = useMemo(() => (tracked ? new Set([...tracked.picks.flatMap(p => p.bottles.map(b => b.id)), ...added]) : null), [tracked, added]);
  /** Every bottle on the frame on screen while the video plays again, as SAM outlined it there, named once read. */
  const onScreen = view
    ? (followed.current.get(view.at) ?? []).filter(b => !kept || kept.has(b.id)).map(b => {
        const m = matches.get(b.id);
        return { ...b, ...(m ? { name: m.name, colour: colourOf(m.component, components) } : {}) };
      })
    : [];

  // Once the video has played again a moment, the kit's card shrinks to a chip, off the bottles.
  useEffect(() => {
    if (state !== 'replaying') return;
    const t = setTimeout(() => setCardSmall(true), CARD_SMALL_MS);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    const url = URL.createObjectURL(video);
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.className = 'absolute inset-0 size-full object-contain';
    el.src = url;
    box.current!.appendChild(el);
    player.current = el;
    // The picture in the video's own shape, as big as its room allows: no bars beside or under it, its corners round.
    const fitIn = () => {
      const room = space.current;
      if (!room || !el.videoWidth || !el.videoHeight) return;
      const scale = Math.min(room.clientWidth / el.videoWidth, room.clientHeight / el.videoHeight);
      const width = Math.round(el.videoWidth * scale);
      const height = Math.round(el.videoHeight * scale);
      setFit({ left: Math.round((room.clientWidth - width) / 2), top: Math.round((room.clientHeight - height) / 2), width, height });
    };
    const resized = new ResizeObserver(fitIn);
    resized.observe(space.current!);
    el.addEventListener('loadedmetadata', fitIn);
    el.addEventListener('resize', fitIn);
    const controller = new AbortController();
    const frames: Shot[] = [];
    let times: number[] = [];
    const reads: Promise<RecognizedKit | null>[] = [];
    /** What each of those said, as it comes in. */
    const heard: (RecognizedKit | null)[] = [];
    let decided: Promise<KitTold> | null = null;
    let told: KitTold | null = null;
    let asked: Promise<TrackedBottles> | undefined;
    let result: TrackedBottles | null = null;
    let failed = false;
    // SAM's frames as they come: when each starts (read from the video), the last one SAM is done with, and whether
    // the picture is held for SAM to get ahead again.
    let starts: number[] | null = null;
    let last = -1;
    let held = false;
    let painting = 0;
    followed.current = new Map();
    setFront(-1);
    setTotal(0);
    setToSam({ sent: 0, stage: null });
    setAdded([]);
    // Bottles the user tapped that SAM missed (their ids), and SAM looking for them (stopped if the screen goes).
    const tapped: number[] = [];
    let asks = 0;
    const looks = new AbortController();
    // The user took over at the end (tapped the picture): Chapp no longer goes on by itself.
    let stay: () => void = () => {};
    let pass: 1 | 2 = 1;
    let ended = false;
    let finishing = false;
    let left = false;
    let raf = 0;
    let hurry: () => void = () => {};
    // A bottle's moment held in the highlights, and what cuts it short (Skip).
    let wake: () => void = () => {};
    const nap = (ms: number) =>
      new Promise<void>(resolve => {
        const t = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    // The player goes once nothing needs it: this screen, and the bottles' frames still to be taken off it.
    let holders = 1;
    const drop = () => {
      if (--holders > 0) return;
      cancelAnimationFrame(raf);
      el.remove();
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
    };

    // The frames SAM picked, as followBottles asks for them (Footage.grab): taken as the video plays again, the one on
    // screen when the playhead reaches each; once it has stopped, sought on it. `at` is the frame actually taken. A
    // frame already played past (SAM came back while the video played again) is sought too.
    type Got = { shot: Shot; at: number } | null;
    const wanted = new Map<number, ((got: Got) => void)[]>();
    let seeking = false;
    /** SAM's frame showing at a time, and the time to seek a frame at: by when each starts, as the video says. */
    const clock = () => frameClock(el.duration, starts ?? result?.times, result?.frames);
    const takeNow = (at: number) => {
      const due = [...wanted.keys()].filter(f => f <= at && f >= at - TAKE_SLACK);
      if (!due.length || !el.videoWidth) return;
      const shot: Shot = { ...frameToShot(el), video: true };
      for (const f of due) {
        wanted.get(f)!.forEach(give => give({ shot, at }));
        wanted.delete(f);
      }
    };
    const seekWanted = async () => {
      if (seeking || !wanted.size) return;
      seeking = true;
      setStill(false);
      while (wanted.size && !left) {
        const [f, gives] = wanted.entries().next().value!;
        wanted.delete(f);
        const shot = await frameAt(el, clock().timeOf(f), { video: true }).catch(() => null);
        gives.forEach(give => give(shot ? { shot, at: f } : null));
      }
      seeking = false;
      // The last frame back on screen, the bottles on it outlined.
      if (pass === 2 && !left) {
        el.currentTime = el.duration;
        if (finishing) setStill(true);
      }
    };
    const grab = (frame: number) =>
      new Promise<Got>(give => {
        wanted.set(frame, [...(wanted.get(frame) ?? []), give]);
        if (finishing) void seekWanted();
      });

    /** Which kit: told as soon as two frames agree on it (analysis.ts agreed), else once every frame read says. */
    const decide = () => {
      if (decided || !identify) return;
      if (!reads.length) {
        told = 'none';
        decided = Promise.resolve(told);
        return;
      }
      setFrames({ read: 0, of: reads.length });
      const read = kitReads(reads, n => setFrames(f => ({ ...f, read: n })));
      decided = Promise.race([read, new Promise<(RecognizedKit | null)[]>(resolve => setTimeout(() => resolve([]), KIT_WAIT_MS))]).then(all => {
        if (left) return 'none';
        told = tellKit(all);
        setKind(told);
        const best = bestKitRead(all);
        // Another kit read just as surely: the card asks which (the user's tap tells that one instead).
        const other = otherKitRead(all);
        const cardOf = (r: RecognizedKit, from: Card['from'], alt?: RecognizedKit | null): Card => ({
          src: (frames[all.indexOf(r)] ?? frames[0])!.src,
          name: r.kit!.name || r.kit!.catalog,
          catalog: r.kit!.catalog,
          on: r.packaging ?? null,
          from,
          ...(alt?.kit ? { other: alt.kit.name || alt.kit.catalog } : {}),
        });
        if (best?.kit) {
          // The card (about 260 px wide, 60 tall, at 14, 66) comes from the middle of the picture.
          const b = box.current?.getBoundingClientRect();
          const from = b ? { x: b.width / 2 - (14 + Math.min(260, b.width - 28) / 2), y: b.height / 2 - 96 } : { x: 0, y: 0 };
          setCard(cardOf(best, from, other));
          toOther.current = () => {
            if (!other || left) return;
            told = tellKit([other]);
            setKind(told);
            setCard(cardOf(other, { x: 0, y: 0 }));
            if (background && told !== 'none') readInBackground();
          };
        }
        // The bottles are read against the kit the video shows, never another.
        if (background && told !== 'none') readInBackground();
        return told;
      });
    };
    const keep = () => {
      while (times.length && el.currentTime >= times[0]! - 0.05) {
        times.shift();
        if (!el.videoWidth) continue;
        const shot: Shot = { ...frameToShot(el), video: true };
        frames.push(shot);
        if (identify && !decided && reads.length < KIT_READS) {
          const read = readKitOf(shot);
          const at = reads.push(read) - 1;
          // Two frames that agree on the kit (on its box or bag, or a kit Chapp has) settle it now, and its manual's
          // search starts.
          void read.then(r => {
            heard[at] = r;
            if (agreed(heard)) decide();
          });
          if (reads.length === KIT_READS) decide();
        }
      }
      if (el.duration) setPlayed(Math.min(1, el.currentTime / el.duration));
    };
    /** One render a screen refresh, however many of SAM's frames came in it. */
    const paint = () => {
      if (painting) return;
      painting = requestAnimationFrame(() => {
        painting = 0;
        setFront(last);
        repaint();
      });
    };
    /** A frame SAM is done with: drawn once the picture gets there. */
    const frameDone = (f: FollowedFrame) => {
      if (left) return;
      followed.current.set(f.frame, f.bottles);
      last = Math.max(last, f.frame);
      paint();
      // The video ended before SAM's first frames: it plays again now, behind SAM.
      if (ended && pass === 1 && !finishing && !result) replay();
    };
    const onMeta = () => {
      // The very start too: where a video of a kit usually begins, on its box.
      times = [Math.min(0.3, el.duration / 10), ...frameTimes(el.duration)];
      if (!followable(video, el.duration)) return;
      asked = startFollowing(video, controller.signal, {
        onUpload: sent => setToSam(t => ({ ...t, sent })),
        onVideo: v => {
          starts = v.times ?? null;
          if (v.times) setTotal(v.times.length);
        },
        // The server has all of it by then.
        onStage: stage => setToSam({ sent: 1, stage }),
        onFrame: frameDone,
      });
      setScanning(true);
      asked.then(
        r => {
          if (left) return;
          setScanning(false);
          result = r;
          setTracked(r);
          setTotal(r.frames);
          // Playing again behind SAM: at its own pace from here.
          el.playbackRate = 1;
          if (held) {
            held = false;
            setHolding(false);
            if (pass === 2 && !finishing) el.play().catch(() => {});
          }
          // The bottles' frames are taken off this player as it plays them again; the frames kept are the cover's.
          holders++;
          void followBottles({ kind: 'video', frames, video, player: el, tracked: Promise.resolve(r), grab, release: drop });
          if (ended && pass === 1 && !finishing) again();
        },
        () => {
          if (left) return;
          setScanning(false);
          failed = true;
          if (pass === 2 && !finishing && !result) {
            // SAM gave up while the video played again behind it: the frames kept are the photos.
            setView(null);
            return fallBack();
          }
          if (ended && pass === 1 && !finishing) fallBack();
        },
      );
    };
    /** No bottles followed: the frames kept are the photos. */
    const fallBack = () => {
      void followBottles({ kind: 'video', frames, video: null });
      end();
    };
    const frameNow = () => clock().frameAt(el.currentTime);
    /**
     * Playing again while SAM is still going: slower the closer the picture gets to the last frame SAM is done with,
     * held just behind it until SAM is well ahead again. Once SAM is done, at its own pace.
     */
    const keepBehind = (at: number) => {
      if (result || failed || finishing || pass !== 2) return;
      const ahead = last - at;
      if (held) {
        if (ahead < GO_LEAD) return;
        held = false;
        setHolding(false);
        el.play().catch(() => {});
      } else if (ahead <= HOLD_LEAD && !el.paused) {
        held = true;
        setHolding(true);
        el.pause();
        return;
      }
      const rate = Math.max(0.5, Math.min(1, Math.round(((ahead - HOLD_LEAD) / (2 * GO_LEAD)) * 10) / 10));
      if (el.playbackRate !== rate) el.playbackRate = rate;
    };
    /**
     * The bottles SAM followed drawn over the frame on screen, laid over the picture as it is now (the screen's list
     * below takes room once it ends); with `take`, the bottles' frames taken off the player as it plays them.
     */
    const overlay = (take: boolean) => {
      cancelAnimationFrame(raf);
      let drawn = '';
      // The frame the browser has just put on screen, where it can say (the playhead runs ahead of the picture), while
      // it plays; when it is held or sought, the frame at the playhead.
      const rvfc = 'requestVideoFrameCallback' in el;
      let presented = -1;
      const frameShown = () => (rvfc && presented >= 0 && !el.paused ? presented : frameNow());
      const tick = () => {
        const b = box.current?.getBoundingClientRect();
        if (b && el.videoWidth) {
          const scale = Math.min(b.width / el.videoWidth, b.height / el.videoHeight);
          const width = el.videoWidth * scale;
          const height = el.videoHeight * scale;
          const next = { at: frameShown(), left: (b.width - width) / 2, top: (b.height - height) / 2, width, height };
          const key = Object.values(next).join(',');
          if (key !== drawn) {
            drawn = key;
            setView(next);
          }
        }
        keepBehind(frameNow());
        if (take && !rvfc && !finishing) takeNow(frameNow());
        raf = requestAnimationFrame(tick);
      };
      const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (left || finishing) return;
        presented = clock().frameAt(meta.mediaTime);
        if (take) takeNow(presented);
        el.requestVideoFrameCallback(onVideoFrame);
      };
      if (rvfc) el.requestVideoFrameCallback(onVideoFrame);
      tick();
    };
    /** The second pass of a video with the bottles together: the whole of it again, from the start, outlined. */
    const replay = () => {
      pass = 2;
      ended = false;
      el.currentTime = 0;
      setState('replaying');
      setWaiting(null);
      // Not allowed to play (Low Power Mode, say): a tap on the video plays it. Held behind SAM at once is no stop.
      el.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState('stopped');
      });
      overlay(true);
    };
    /**
     * The second pass of a video that shows the bottles one at a time (their main pictures on different frames,
     * framesToRead): not the whole of it again, but each bottle's moment in turn, held a while with it outlined, the
     * frames its other views come from passed on the way. Each frame is taken off this player as it shows it.
     */
    const highlights = async () => {
      pass = 2;
      ended = false;
      el.pause();
      setState('replaying');
      setWaiting(null);
      overlay(false);
      const mains = result!.picks.filter(p => p.bottles.some(b => b.main)).map(p => p.frame);
      const order = result!.picks.map(p => p.frame).sort((a, b) => a - b);
      seeking = true;
      // followBottles asks for its frames once it has started, a moment after SAM came back.
      await new Promise(resolve => setTimeout(resolve, 0));
      for (const f of order) {
        if (left || finishing) break;
        const main = mains.includes(f);
        const shot = await frameAt(el, clock().timeOf(f), { video: true }).catch(() => null);
        const gives = wanted.get(f);
        wanted.delete(f);
        gives?.forEach(give => give(shot ? { shot, at: f } : null));
        if (main && !left && !finishing) await nap(HOLD_MS);
      }
      seeking = false;
      if (left) return;
      if (!finishing) return end();
      // Skipped: the frames not reached yet are sought now, then the last frame is back on screen.
      if (wanted.size) void seekWanted();
      else {
        el.currentTime = el.duration;
        setStill(true);
      }
    };
    /** Its highlights for a video that shows the bottles one at a time, else the whole of it again. */
    const again = () => {
      if (new Set(result!.picks.filter(p => p.bottles.some(b => b.main)).map(p => p.frame)).size > 1) void highlights();
      else replay();
    };
    /** The first pass is over: play again with the bottles once SAM has them, or wait for SAM, or go on without. */
    const firstPassOver = () => {
      if (ended) return;
      ended = true;
      keep();
      if (!frames.length && el.videoWidth) frames.push({ ...frameToShot(el), video: true });
      el.pause();
      decide();
      if (!asked || failed) return fallBack();
      if (result) return again();
      // SAM is still going through the video: it plays again now, behind SAM.
      if (last >= 0) return replay();
      setState('finishing');
      setWaiting('sam');
      // SAM may not have started on a video by the time it ends (it is still on its way to SAM): the last frame stays
      // until SAM's first frames come, then the video plays again; if none come, its frames are the photos.
      setTimeout(() => {
        if (!result && last < 0 && !left && pass === 1 && !finishing) fallBack();
      }, TRACK_WAIT_MS);
    };
    /** Both passes are over: what is still under way is waited for (Skip goes on now), then whoever opened this goes on. */
    const end = () => {
      if (finishing) return;
      finishing = true;
      ended = true;
      el.pause();
      player.current = null;
      setState('finishing');
      // After the second pass the last frame stays, the bottles on it outlined and named as their labels are read (once
      // the highlights, still seeking, are done with the player); otherwise the picture goes, the player kept on the page
      // for the frames.
      if (pass === 2) {
        if (!seeking) el.currentTime = el.duration;
        if (!seeking && !wanted.size) setStill(true);
      } else {
        cancelAnimationFrame(raf);
        parkVideo(el);
        setView(null);
      }
      // Frames the replay did not reach (skipped, or SAM back after the video ended): sought on this player now.
      void seekWanted();
      if (!identify) {
        drop();
        return done.current('none');
      }
      if (!decided) decide();
      setWaiting(told === null ? 'kit' : 'labels');
      const settled = decided!.then(t => {
        if (!background) return t;
        setWaiting('labels');
        // The labels, read in the background: until none of the kit's work is under way, or long enough.
        return new Promise<KitTold>(resolve => {
          const isDone = () => {
            const s = useKit.getState();
            if (kitProgress({ shots: s.shots, seen: s.seen, picks: s.picks, following: s.following, sample: s.sample }, []).busy) return false;
            if (asked && !result && !failed) return false;
            // Followed, the photos are still to come (a moment between SAM done and the photos added).
            if (result && !s.shots.length) return false;
            // A kit Chapp has: its bottles' labels are read against it, after they are found (a moment in between). A
            // kit new to Chapp: against what its manual says it holds, once it says; a manual that says nothing of it, or
            // none found, is not waited for (its protocol, once read, has them read on the Overview).
            const read = s.shots.every(sh => ['read', 'failed'].includes(s.seen[sh.id]?.state ?? ''));
            return t === 'known' || useRun.getState().protocolId || s.contents?.length ? read : s.contents !== null;
          };
          const stop = useKit.subscribe(() => isDone() && finished());
          const timer = setTimeout(finishNow, FINISH_WAIT_MS);
          let shown = 0;
          let touched = false;
          function finished() {
            if (shown || touched) return;
            // One of the kit's bottles not seen (or not sure of): the user shows it on the video, or goes on with the
            // button; nothing goes on by itself.
            const picks = useKit.getState().picks;
            if (inKitNow.current.some(id => !picks[id])) return stay();
            shown = window.setTimeout(finishNow, SHOWN_MS);
          }
          // Tapped: the user goes on with the button, once done naming or adding bottles.
          stay = () => {
            touched = true;
            clearTimeout(shown);
            clearTimeout(timer);
          };
          function finishNow() {
            stop();
            clearTimeout(timer);
            clearTimeout(shown);
            resolve(t);
          }
          hurry = finishNow;
          if (isDone()) finished();
        });
      });
      void settled.then(t => {
        drop();
        if (!left) done.current(t);
      });
    };
    /** The bottles kept on the video: SAM's, once it is done, and those the user tapped. */
    const keptIds = () => new Set([...(result?.picks.flatMap(p => p.bottles.map(b => b.id)) ?? []), ...tapped]);
    /**
     * A bottle SAM missed, where the user tapped it on the frame on screen: SAM outlines what is under the finger on
     * that frame (a point prompt), it is drawn there, and the frame becomes its photo, its label read like any other's.
     * Only on that frame: asked to follow a point back through a video, SAM's API fails (a 500, 2026-11-02). Tapped as
     * one of the kit's bottles (`then`), it is that one, not read.
     */
    const lookFor = async (frame: number, at: Point, then?: (id: number) => void) => {
      const id = TAPPED_IDS + asks++;
      setLooking(at);
      try {
        const shot: Shot = { ...frameToShot(el), video: true };
        const r = await api.segmentBottles({ photo: photoData(analysisSrc(shot)), points: [at] }, AbortSignal.any([looks.signal, AbortSignal.timeout(TAP_WAIT_MS)]));
        if (left) return;
        const b = r.bottles[0];
        if (!b) return void toast('SAM couldn’t find a bottle there. Tap right on it.');
        tapped.push(id);
        setAdded([...tapped]);
        followed.current.set(frame, [...(followed.current.get(frame) ?? []), { id, box: b.box, ...(b.outline ? { outline: b.outline } : {}) }]);
        paint();
        useKit.getState().addLooked([shot], [{ state: then ? 'read' : 'found', boxes: [b.box], outlines: [b.outline], ids: [id] }]);
        if (then) return then(id);
        // Its label is read like the others' (they may all be read by now).
        if (background) readInBackground();
      } catch {
        if (!left) toast('SAM couldn’t look there just now. Try again in a moment.');
      } finally {
        if (!left) setLooking(null);
      }
    };
    /** Whether the video is still for the user to look through: played again, SAM done, no frame being sought. */
    const free = () => finishing && pass === 2 && !seeking && Boolean(result) && !left;
    /**
     * A tap on the still video, once it has played again: the bottle there is named (as the kit's bottle chosen below,
     * `then`, or asked), or one SAM missed looked for.
     */
    tap.current = (at, then) => {
      if (!free()) return;
      stay();
      const frame = frameNow();
      const shown = (followed.current.get(frame) ?? []).filter(b => keptIds().has(b.id));
      const hit = shown.find(b => (b.outline ? inside(pointsOf(b.outline), at) : within(b.box, at))) ?? shown.find(b => within(b.box, at));
      if (hit) return then ? then(hit.id) : setNaming(hit.id);
      void lookFor(frame, at, then);
    };
    // Dragged along the bar: one seek at a time, the latest wanted once the one under way is done.
    let wantAt: number | null = null;
    const seekStill = (t: number) => {
      if (el.seeking) wantAt = t;
      else el.currentTime = t;
    };
    el.addEventListener('seeked', () => {
      if (wantAt === null || !free()) return;
      const t = wantAt;
      wantAt = null;
      el.currentTime = t;
    });
    scrub.current = share => {
      if (!free() || !Number.isFinite(el.duration)) return;
      stay();
      setPlayed(share);
      seekStill(Math.max(0, Math.min(1, share)) * el.duration);
    };
    /**
     * A bottle chosen in the list under the video: the still video put on the frame SAM picked to read it on (its main
     * one first), else the frame it is biggest on. Whether there is one.
     */
    show.current = id => {
      if (!free()) return false;
      const on = (p: TrackedBottles['picks'][number]) => p.bottles.find(b => b.id === id);
      let at = [...result!.picks].filter(on).sort((a, b) => Number(Boolean(on(b)!.main)) - Number(Boolean(on(a)!.main)))[0]?.frame;
      if (at === undefined) {
        let most = 0;
        for (const [f, bottles] of followed.current) {
          const b = bottles.find(x => x.id === id);
          if (b && b.box.width * b.box.height > most) {
            most = b.box.width * b.box.height;
            at = f;
          }
        }
      }
      if (at === undefined) return false;
      stay();
      const t = clock().timeOf(at);
      setPlayed(el.duration ? t / el.duration : 0);
      seekStill(t);
      return true;
    };
    skip.current = () => {
      wake();
      if (finishing) return hurry();
      if (pass === 2 || ended) return end();
      // Skipped while SAM is still following: the video does not play again; the bottles are still read from it.
      firstPassOver();
      if (!result && !finishing) end();
    };

    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', keep);
    el.addEventListener('ended', () => (pass === 1 ? firstPassOver() : end()));
    el.addEventListener('error', () => (pass === 1 ? firstPassOver() : end()));
    el.play().then(
      () => setState('playing'),
      // No autoplay here (Low Power Mode, say): a tap on the video plays it.
      () => setState('stopped'),
    );
    return () => {
      // Left before it ended (back, or React trying the effect twice in development): nothing goes on.
      left = true;
      resized.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(painting);
      looks.abort();
      wake();
      hurry();
      for (const gives of wanted.values()) gives.forEach(give => give(null));
      wanted.clear();
      if (!finishing) {
        controller.abort();
        drop();
      }
    };
  }, [video, identify, background]);

  const play = () => {
    void player.current?.play().then(() => setState(s => (s === 'stopped' ? 'playing' : s)));
  };
  // Placed once: from now on the picture eases to a new place.
  useEffect(() => {
    if (fit) fitted.current = true;
  }, [fit]);
  // A bottle shown from the list flashes a moment.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), PULSE_MS);
    return () => clearTimeout(t);
  }, [flash]);

  // The bottles' labels are read on this screen (opened from Home, its kit told), and some are not read yet.
  const unread = kitShots.length === 0 || kitShots.some(sh => !['read', 'failed'].includes(kitSeen[sh.id]?.state ?? ''));
  const reading = Boolean(background) && kind !== null && kind !== 'none' && unread;
  // How the video is getting to SAM, before its first frames: going up from the phone, into Meta's store, opening; then
  // SAM going through it.
  const sent = Math.round(toSam.sent * 100);
  const toSamLine =
    front >= 0 ? 'is looking for the bottles'
    : toSam.stage === 'started' ? 'is opening your video'
    : toSam.sent > 0 && toSam.sent < 1 && !toSam.stage ? `is receiving your video · ${sent}%`
    : 'is receiving your video';
  // One line over the video, the model doing the work named in its tag: SAM's, once the video is on its way to it.
  const status: Status =
    state === 'replaying' ? { by: 'SAM 3.1', text: tracked ? 'has outlined the bottles' : 'is outlining the bottles' }
    : state === 'finishing' ?
      looking ? { by: 'SAM 3.1', text: 'is finding the bottle you tapped' }
      : waiting === 'sam' ? { by: 'SAM 3.1', text: toSamLine }
      : waiting === 'kit' ? { text: 'Chapp is working out which kit this is' }
      : work.busy ? { by: work.by.at(-1), text: `is ${lower(work.lines.at(-1)!)}` }
      : kind === 'search' && contents === null && !protocol ? { text: 'Chapp is finding the kit’s manual' }
      : reading ? { text: 'Chapp is finishing up' }
      : { text: 'Here’s what Chapp found' }
    : scanning && (toSam.sent > 0 || toSam.stage !== null || front >= 0) ? { by: 'SAM 3.1', text: toSamLine }
    : { text: 'Chapp is watching your video' };
  // The labels on the frame on screen: one over bottles side by side that carry the same one, left to right, once read
  // (until then their outlines say so). None on a bottle the picture's side cuts off (it is not the one filmed: its own
  // moment names it, and the list below).
  const groups = labelGroups(onScreen).filter(g => g.box.x > 0.01 && g.box.x + g.box.width < 0.99 && g.bottles[0]!.name);
  // How far SAM is through the video, on the bar under it, ahead of the picture as it plays again behind SAM.
  const samShare = tracked ? 1 : total > 0 && front >= 0 ? Math.min(1, (front + 1) / total) : 0;
  // The still video is the user's, once SAM is done and it has played again: a tap names a bottle or finds one SAM
  // missed, the bar takes it to any moment, a bottle in the list below shows on it.
  const tappable = state === 'finishing' && Boolean(background) && view !== null && tracked !== null && still;

  /** Which bottle followed through the video a box on a photo is. */
  const idOf = (shot: string, box: Box) => {
    const look = kitSeen[shot];
    const k = look?.boxes.findIndex(b => sameBox(b, box)) ?? -1;
    return k >= 0 ? look?.ids?.[k] : undefined;
  };
  // Every label read (or none to read): what is still matched to nothing was not seen, or Chapp is not sure of it.
  const labelsDone = !unread && !work.busy && !following;
  /**
   * The kit's bottles, under the video once it is over, in its colours: each with the bottle matched to it (its photo
   * on its frame), looked for while the labels are read, or not seen; and the user's own bottles the video showed.
   */
  const slots = components
    .filter(c => inKit.includes(c.id) || kitPicks[c.id])
    .map(c => {
      const pick = kitPicks[c.id];
      const shot = pick ? kitShots.find(s => s.id === pick.shot) : undefined;
      const bottle = pick && shot ? { shot, box: pick.box, outline: outlineAt(kitSeen[shot.id], pick.box) } : undefined;
      return { ...c, colour: colourOf(c.id, components), bottle, track: bottle ? idOf(bottle.shot.id, bottle.box) : undefined };
    });
  // Bottles Chapp is not sure of, once every label is read, for the user to name.
  const unsure = labelsDone ? found.filter(b => !b.component && b.unsure) : [];
  const chosen = slots.find(s => s.id === assigning);

  // The bottle being named: on the frame on screen, lit; what Muse Spark read on its label, or guessed it is.
  const [spot, setSpot] = useState<{ x: number; y: number; w: number; h: number; W: number; H: number } | null>(null);
  useLayoutEffect(() => {
    if (naming === null || !view || !picture.current || !root.current) return setSpot(null);
    const r = root.current.getBoundingClientRect();
    const p = picture.current.getBoundingClientRect();
    setSpot({ x: p.left - r.left + view.left, y: p.top - r.top + view.top, w: view.width, h: view.height, W: r.width, H: r.height });
  }, [naming, view]);
  const named = naming === null ? undefined : onScreen.find(b => b.id === naming);
  const readAs = naming === null ? undefined : matches.get(naming)?.component;
  const thing =
    naming === null ? undefined : (
      kitThings.find(t => {
        const k = kitSeen[t.shot]?.ids?.indexOf(naming) ?? -1;
        const box = k >= 0 ? kitSeen[t.shot]!.boxes[k] : undefined;
        return box !== undefined && [t.box, ...(t.boxes ?? [])].some(b => sameBox(b, box));
      })
    );
  const guess = !readAs && (thing?.match === 'guess' || thing?.match === 'mismatch') ? (thing.component ?? undefined) : undefined;
  const first = readAs ?? guess;
  const choices = [
    ...components.filter(c => c.id === first),
    ...components.filter(c => c.id !== first && !kitPicks[c.id]),
    ...components.filter(c => c.id !== first && kitPicks[c.id]),
  ];
  const nameOf = (id: string | undefined) => components.find(c => c.id === id)?.name;
  const hole =
    spot && named ?
      named.outline ?
        `M${pointsOf(named.outline).map(([x, y]) => `${(spot.x + x * spot.w).toFixed(1)},${(spot.y + y * spot.h).toFixed(1)}`).join('L')}Z`
      : `M${spot.x + named.box.x * spot.w},${spot.y + named.box.y * spot.h}h${named.box.width * spot.w}v${named.box.height * spot.h}h${-named.box.width * spot.w}Z`
    : '';

  /**
   * The bottle the user tapped and named: its photo (the frame it was read from) matched to `component`, or to none.
   * Undone from the note it leaves: the round's matches, and what they put in the run's kit, as they were.
   */
  const nameBottle = async (id: number, component: string | null) => {
    setNaming(null);
    setAssigning(null);
    const s = useKit.getState();
    for (const shot of s.shots) {
      const look = s.seen[shot.id];
      const k = look?.ids?.indexOf(id) ?? -1;
      if (!look || k < 0) continue;
      const box = look.boxes[k]!;
      const { crop } = await cropAt(shot, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, box);
      const name = nameOf(component ?? undefined);
      const now = useKit.getState();
      const before = { kit: { picks: now.picks, things: now.things, skipped: now.skipped, said: now.said }, photos: useRun.getState().photos, added: useAdded.getState() };
      useKit.getState().name({ shot: shot.id, box, crop }, component, name ? gotIt(name, 0) : 'Okay, not for this run.');
      toast(name ? `That’s the ${name}` : 'Left out of this run', {
        action: {
          label: 'Undo',
          onClick: () => {
            useKit.setState(before.kit);
            useRun.setState({ photos: before.photos });
            useAdded.setState(before.added);
          },
        },
      });
      return;
    }
    toast('Chapp has no photo of that bottle yet. Tap it again in a moment.');
  };
  /** A bottle in the list under the video shown on it, flashing; with `ask`, asked about too. */
  const showBottle = (id: number | undefined, ask = false) => {
    if (id === undefined || !tappable || !show.current(id)) return;
    setFlash(f => ({ id, n: (f?.n ?? 0) + 1 }));
    if (ask) setNaming(id);
  };
  const seekBar = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    scrub.current(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };

  const line = (
    <>
      <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full bg-[#ff3b30]', state !== 'stopped' && 'animate-pulse')} />
      {status.by && <ModelTag dark>{status.by}</ModelTag>}
      <span className="min-w-0 truncate">{status.text}</span>
    </>
  );

  return (
    <div ref={root} className="relative flex h-full flex-col gap-[18px] bg-[#0b0b0c] px-5 pt-[calc(56px+var(--screen-top))] pb-[calc(20px+var(--screen-bottom))] text-white">
      <div ref={space} className="relative min-h-0 grow">
        <div
          ref={picture}
          className="absolute overflow-hidden rounded-[24px] bg-[#1b1b1d]"
          style={fit ? { ...fit, transition: fitted.current ? 'left 0.3s, top 0.3s, width 0.3s, height 0.3s' : undefined } : { inset: 0 }}
        >
          <div ref={box} className="absolute inset-0" />
          {view && (state === 'replaying' || state === 'finishing') && (
            <div aria-hidden="true" className="pointer-events-none absolute" style={{ left: view.left, top: view.top, width: view.width, height: view.height }}>
              {/* Each bottle as SAM outlined it on this frame, traced round as it first appears: its mask's edge over a
                  dark halo, so it shows on a pale bench as on a dark one; a light running round it while its label is
                  read; in its own colour once its label names it. */}
              <svg className="absolute inset-0 size-full overflow-visible" width={view.width} height={view.height}>
                {onScreen.map(s => {
                  if (!s.outline) return null;
                  const d = pathIn(s.outline, view.width, view.height);
                  const trace = { animation: 'chapp-trace 0.7s cubic-bezier(0.3, 0.7, 0.4, 1) both' };
                  return (
                    <g key={s.id}>
                      <path d={d} className="chapp-anim" fill={s.colour ? `${s.colour}33` : 'rgba(255,255,255,0.16)'} style={{ animation: 'chapp-fade-in 0.3s 0.4s ease-out both', transition: 'fill 0.4s' }} />
                      <path d={d} className="chapp-anim" pathLength={1} strokeDasharray={1} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={4} strokeLinejoin="round" style={trace} />
                      <path d={d} className="chapp-anim" pathLength={1} strokeDasharray={1} fill="none" stroke={s.colour ?? 'rgba(255,255,255,0.95)'} strokeWidth={2} strokeLinejoin="round" style={{ ...trace, transition: 'stroke 0.4s' }} />
                      {reading && tracked && !s.name && (
                        <path d={d} className="chapp-anim" pathLength={1} strokeDasharray="0.12 0.88" fill="none" stroke="#fff" strokeWidth={3.5} strokeLinecap="round" style={{ animation: 'chapp-trace 1.6s linear infinite' }} />
                      )}
                      {flash?.id === s.id && (
                        <path key={flash.n} d={d} className="chapp-anim" fill="none" stroke={s.colour ?? '#fff'} strokeWidth={9} strokeOpacity={0.7} strokeLinejoin="round" style={{ animation: 'chapp-tap-flash 0.8s ease-out 2' }} />
                      )}
                    </g>
                  );
                })}
              </svg>
              {/* A bottle SAM gave no outline on this frame: its box. */}
              {onScreen
                .filter(s => !s.outline)
                .map(s => (
                  <span
                    key={s.id}
                    className={cn('chapp-anim absolute rounded-[8px] border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]', reading && tracked && !s.name && 'animate-pulse')}
                    style={{ left: `${s.box.x * 100}%`, top: `${s.box.y * 100}%`, width: `${s.box.width * 100}%`, height: `${s.box.height * 100}%`, borderColor: s.colour ?? 'rgba(255,255,255,0.9)', animation: 'chapp-pop 0.35s ease-out both' }}
                  />
                ))}
              {groups.map((g, i) => {
                const name = g.bottles[0]!.name!;
                const colour = g.bottles[0]!.colour;
                // Where its label goes, inside the picture: bottles filmed up close (taller than half of it) have it
                // inside their top edge, clear of the line and the kit's card over the top of the picture; groups side by
                // side would have theirs on top of each other, so from left to right every other one's goes under them
                // (or, up close, lower down), unless that is off the picture's foot. Near the picture's side, it keeps
                // to that side.
                const close = g.box.height > 0.5;
                const odd = i % 2 === 1;
                const under = !close && odd && g.box.y + g.box.height < 0.88;
                const below = Math.max(8, (card ? (cardSmall ? 76 : 134) : 60) - (view.top + g.box.y * view.height)) + (odd ? 28 : 0);
                const middle = g.box.x + g.box.width / 2;
                const side = middle < 0.2 ? 'left-0' : middle > 0.8 ? 'right-0' : 'left-1/2 -translate-x-1/2';
                return (
                  <span key={g.bottles.map(b => b.id).join(',')} className="absolute" style={{ left: `${g.box.x * 100}%`, top: `${g.box.y * 100}%`, width: `${g.box.width * 100}%`, height: `${g.box.height * 100}%` }}>
                    <span className={cn('absolute flex justify-center', side, !close && (under ? 'top-full mt-1.5' : 'bottom-full mb-1.5'))} style={close ? { top: below } : undefined}>
                      <span
                        key={name}
                        className="chapp-anim flex max-w-[140px] items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-[12px] leading-4 font-semibold whitespace-nowrap text-white shadow-[0_1px_4px_rgba(0,0,0,0.35)]"
                        style={{ background: colour, animation: 'chapp-pop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2) both' }}
                      >
                        <Tick />
                        <span className="truncate">{name}</span>
                      </span>
                    </span>
                  </span>
                );
              })}
            </div>
          )}
          {/* The still video, once SAM is done: a tap on a bottle names it, a tap where SAM saw none has it look there. */}
          {tappable && view && (
            <button
              type="button"
              aria-label={chosen ? `Tap the ${chosen.name}` : 'Tap a bottle to name it, or a bottle SAM missed'}
              className="absolute cursor-pointer outline-none"
              style={{ left: view.left, top: view.top, width: view.width, height: view.height }}
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect();
                const which = assigning;
                tap.current({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, which ? id => void nameBottle(id, which) : undefined);
              }}
            />
          )}
          {/* Where SAM is looking for the bottle the user tapped. */}
          {looking && view && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)] animate-ping"
              style={{ left: view.left + looking.x * view.width, top: view.top + looking.y * view.height }}
            />
          )}
          {tappable && !looking && naming === null && (
            chosen ? (
              <span className="absolute bottom-3.5 left-1/2 flex max-w-[calc(100%-28px)] -translate-x-1/2 items-center gap-2 rounded-full bg-black/65 py-1 pr-1 pl-3 text-[12px] leading-4 font-semibold whitespace-nowrap text-white backdrop-blur-sm animate-in fade-in duration-300">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: chosen.colour }} />
                <span className="min-w-0 truncate">Tap the {chosen.name}</span>
                <button type="button" onClick={() => setAssigning(null)} className="shrink-0 rounded-full bg-white/15 px-2.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-white">
                  Cancel
                </button>
              </span>
            ) : (
              <span className="pointer-events-none absolute bottom-3.5 left-1/2 w-max max-w-[calc(100%-28px)] -translate-x-1/2 rounded-[14px] bg-black/55 px-3 py-1 text-center text-[12px] leading-4 font-semibold text-white/90 backdrop-blur-sm animate-in fade-in duration-300">
                Tap a bottle to name it, or one SAM missed
              </span>
            )
          )}
          {/* SAM looking at the video: a line of light sweeping down it, until SAM comes back with the bottles, and while
              the video playing again waits for SAM to get ahead. Its bright edge leads, a blue glow trailing it, so it
              shows on a pale bag as on a dark bench. */}
          {((scanning && (state === 'playing' || state === 'finishing')) || (holding && state === 'replaying')) && (
            <div
              aria-hidden="true"
              className="chapp-anim pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'linear-gradient(to bottom, transparent 36%, rgba(48,128,255,0.10) 43%, rgba(48,128,255,0.38) 49.3%, rgba(240,248,255,0.95) 50%, transparent 50.7%)',
                backgroundSize: '100% 250%',
                animation: 'chapp-scan 2.6s ease-in-out infinite',
              }}
            />
          )}
          {/* The kit, as read on the video: a card arriving from the middle of the picture under the line of what is
              under way; once the video has played again a moment, one card with that line, in its corner, off the
              bottles. */}
          {card && cardSmall ? (
            <div role="status" className="chapp-anim absolute top-3.5 left-3.5 flex max-w-[calc(100%-28px)] items-center gap-2.5 rounded-[16px] bg-black/55 p-1.5 pr-3.5 backdrop-blur-sm" style={{ animation: 'chapp-fade-in 0.3s ease-out both' }}>
              <img src={card.src} alt="" className="size-9 shrink-0 rounded-[10px] object-cover" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[12px] leading-4 font-semibold text-white/70">{card.name}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] font-semibold whitespace-nowrap">{line}</span>
              </span>
            </div>
          ) : (
            <>
              <p
                role="status"
                className="absolute top-[18px] left-1/2 m-0 flex max-w-[calc(100%-28px)] -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-[14px] leading-[18px] font-semibold whitespace-nowrap text-white backdrop-blur-sm"
              >
                {line}
              </p>
              {card && (
                <div
                  className="chapp-anim absolute top-[66px] left-[14px] flex max-w-[calc(100%-28px)] items-center gap-2.5 rounded-[16px] bg-black/55 p-2 pr-3.5 backdrop-blur-sm"
                  style={{ '--from-x': `${card.from.x}px`, '--from-y': `${card.from.y}px`, animation: 'chapp-arrive 0.75s cubic-bezier(0.2, 0.8, 0.2, 1) both' } as CSSProperties}
                >
                  <img src={card.src} alt="" className="size-11 shrink-0 rounded-[10px] object-cover" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[14px] leading-[18px] font-semibold">{card.name}</span>
                    <span className="truncate text-[12px] leading-4 text-white/70">
                      {card.on ? `Read on the ${card.on}` : 'Read on a bottle’s label'}
                      {card.catalog && card.catalog !== card.name ? ` · ${card.catalog}` : ''}
                    </span>
                    {card.other && (
                      <button
                        type="button"
                        onClick={() => toOther.current()}
                        className="mt-1.5 self-start truncate rounded-full bg-white px-3 py-1 text-[13px] leading-[18px] font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-white"
                      >
                        Or the {card.other}?
                      </button>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
          {state === 'stopped' && (
            <button
              type="button"
              aria-label="Play the video"
              onClick={play}
              className="absolute inset-0 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span className="flex size-16 items-center justify-center rounded-full bg-white text-ink">
                <PlayIcon />
              </span>
            </button>
          )}
        </div>
      </div>
      {/* Under the video once it is over (not over its picture, where the bottles are): the kit's bottles, each with the
          one the video showed, lit along its outline in its colour, or not seen; then any Chapp is not sure of. Before
          the kit's bottles are known, every bottle found. A video that shows them one at a time ends on the last one
          alone. */}
      {state === 'finishing' && background && (slots.length > 0 || found.length > 0) && (
        <div className="-my-1.5 animate-in fade-in duration-300">
          <p className="m-0 mb-2 text-[12px] leading-4 font-semibold text-white/70">{slots.length ? 'In the kit' : 'Found in your video'}</p>
          <ul aria-label={slots.length ? 'The kit’s bottles' : 'Bottles found in your video'} className="m-0 -mx-1 flex list-none gap-1.5 overflow-x-auto p-0 px-1 pt-0.5 [scrollbar-width:none]">
            {slots.length ?
              <>
                {slots.map(s => (
                  <KitSlot
                    key={s.id}
                    name={s.name}
                    colour={s.colour}
                    bottle={s.bottle}
                    state={s.bottle ? 'found' : labelsDone ? 'missing' : 'looking'}
                    chosen={assigning === s.id}
                    onClick={!tappable ? undefined : s.bottle ? () => showBottle(s.track) : labelsDone ? () => setAssigning(a => (a === s.id ? null : s.id)) : undefined}
                  />
                ))}
                {unsure.map(b => (
                  <KitSlot key={b.key} name="Not sure" bottle={b} state="unsure" onClick={tappable ? () => showBottle(idOf(b.shot.id, b.box), true) : undefined} />
                ))}
              </>
            : found.map(b => <FoundItem key={b.key} bottle={b} colour={b.component ? colourOf(b.component, components) : undefined} />)}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-3">
        {/* The video played (white), and how far SAM is through it (blue, ahead of the picture as it plays again); once
            the video is still, a handle to take it to any moment. */}
        <div
          role="slider"
          aria-label="Moment in the video"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(played * 100)}
          aria-disabled={!tappable}
          tabIndex={tappable ? 0 : -1}
          className={cn('relative flex h-8 grow touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white', tappable && 'cursor-pointer')}
          onPointerDown={e => {
            if (!tappable) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekBar(e);
          }}
          onPointerMove={e => {
            if (tappable && e.currentTarget.hasPointerCapture(e.pointerId)) seekBar(e);
          }}
          onKeyDown={e => {
            const step = e.key === 'ArrowRight' ? 0.02 : e.key === 'ArrowLeft' ? -0.02 : 0;
            if (!tappable || !step) return;
            e.preventDefault();
            scrub.current(Math.max(0, Math.min(1, played + step)));
          }}
        >
          <span aria-hidden="true" className="relative h-1 w-full overflow-hidden rounded-full bg-white/20">
            <span className="absolute inset-y-0 left-0 rounded-full bg-[#4f8df7] transition-[width] duration-200" style={{ width: `${samShare * 100}%` }} />
            <span className={cn('absolute inset-y-0 left-0 rounded-full bg-white', !tappable && 'transition-[width] duration-200')} style={{ width: `${played * 100}%` }} />
          </span>
          {tappable && (
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)] animate-in fade-in duration-300" style={{ left: `${played * 100}%` }} />
          )}
        </div>
        <button
          type="button"
          onClick={() => skip.current()}
          className="min-h-11 shrink-0 rounded-full bg-white/12 px-4 text-[15px] leading-5 font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {state === 'finishing' && background && waiting === 'labels' ? 'Open the protocol' : 'Skip'}
        </button>
      </div>
      {state === 'finishing' && (
        <ul aria-label="What Chapp is doing" aria-live="polite" className="m-0 flex list-none flex-col gap-1.5 p-0 px-1 animate-in fade-in duration-300">
          {frames.of > 0 &&
            (() => {
              const n = frames.of === 1 ? 'a frame' : `${frames.of} frames`;
              const read = frames.read >= frames.of || card !== null;
              return (
                <Doing done={read} by="Muse Spark">
                  {read ? `Looked at ${n} for which kit this is` : `Looking at ${n} for which kit this is${frames.of > 1 ? ` · ${frames.read} of ${frames.of}` : ''}`}
                </Doing>
              );
            })()}
          {kind === 'search' && (
            <Doing done={protocol !== null || contents !== null} by="Muse Spark">
              {protocol ? 'Read the kit’s manual'
              : contents === null ? 'Finding the kit’s manual'
              : contents.length ? `The manual lists ${contents.length} ${contents.length === 1 ? 'item' : 'items'} in the kit`
              : 'Looked for the kit’s manual'}
            </Doing>
          )}
          {waiting === 'sam' && <Doing by="SAM 3.1">Following the bottles through your video</Doing>}
          {work.lines.map((line, i) => (
            <Doing key={line} done={!work.busy || i < work.lines.length - 1} by={work.by[i]}>
              {line}
            </Doing>
          ))}
        </ul>
      )}
      {/* Which of the kit's bottles the one tapped is: the rest of the screen dimmed round it, what its label was read
          as first, those not found yet next, each in its colour; or none of this run's. */}
      {naming !== null && (
        <div className="absolute inset-0 z-10 animate-in fade-in duration-200" onClick={() => setNaming(null)}>
          {spot ?
            <svg aria-hidden="true" className="absolute inset-0 size-full" width={spot.W} height={spot.H}>
              <path d={`M0,0H${spot.W}V${spot.H}H0Z${hole}`} fill="rgba(0,0,0,0.6)" fillRule="evenodd" />
              {hole && <path d={hole} fill="none" stroke={named?.colour ?? '#fff'} strokeWidth={2.5} strokeLinejoin="round" />}
            </svg>
          : <div className="absolute inset-0 bg-black/60" />}
          <div
            role="dialog"
            aria-label="Which bottle is this?"
            className="absolute inset-x-0 bottom-0 rounded-t-[24px] bg-[#1b1b1d] px-5 pt-5 pb-[calc(20px+var(--screen-bottom))] animate-in slide-in-from-bottom duration-300"
            onClick={e => e.stopPropagation()}
          >
            <p className="m-0 text-[17px] leading-[22px] font-semibold">Which bottle is this?</p>
            {(first || thing?.text) && (
              <p className="m-0 mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] leading-[18px] font-medium text-white/70">
                <ModelTag dark>Muse Spark</ModelTag>
                {readAs ?
                  `read it as the ${nameOf(readAs)}`
                : thing?.match === 'mismatch' && (thing.candidates?.length ?? 0) > 1 ?
                  `isn’t sure: the ${thing.candidates!.map(nameOf).filter(Boolean).join(' or the ')}`
                : guess ?
                  `thinks it may be the ${nameOf(guess)}`
                : `read “${thing!.text}” on it`}
              </p>
            )}
            <div className="mt-3.5 flex flex-wrap gap-2">
              {choices.map(c => {
                const elsewhere = c.id !== first && Boolean(kitPicks[c.id]);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void nameBottle(naming, c.id)}
                    className={cn(
                      'flex min-h-9 items-center gap-1.5 rounded-[18px] px-4 text-[15px] leading-5 font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white',
                      c.id === first && 'ring-2 ring-white ring-offset-2 ring-offset-[#1b1b1d]',
                      elsewhere && 'opacity-60',
                    )}
                    style={{ background: colourOf(c.id, components) }}
                  >
                    {(c.id === first || elsewhere) && <Tick />}
                    {c.name}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => void nameBottle(naming, null)}
                className="min-h-9 rounded-[18px] bg-white/12 px-4 text-[15px] leading-5 font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Not for this run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A tick, in the colour of what it is on. */
function Tick() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="m5 12 5 5L19 7" />
    </svg>
  );
}

/**
 * A bottle's picture: a square around its box on the frame it was found on (the frame drawn as a background, sized and
 * placed so the square fills the tile), the rest of the square dimmed outside its outline, so the tile is that bottle,
 * not its neighbours; ringed in its colour, and ticked once named.
 */
function BottleTile({ shot, box, outline, ring, tick }: { shot: Shot; box: Box; outline?: string; ring?: string; tick?: string }) {
  const W = shot.width, H = shot.height;
  const side = Math.min(Math.max(box.width * W, box.height * H) * 1.2, W, H);
  const fx = Math.min(Math.max((box.x + box.width / 2) * W - side / 2, 0), W - side) / W;
  const fy = Math.min(Math.max((box.y + box.height / 2) * H - side / 2, 0), H - side) / H;
  const fw = side / W, fh = side / H;
  const picture: CSSProperties = {
    backgroundImage: `url(${shot.src})`,
    backgroundSize: `${100 / fw}% ${100 / fh}%`,
    backgroundPosition: `${fw < 1 ? (fx / (1 - fw)) * 100 : 0}% ${fh < 1 ? (fy / (1 - fh)) * 100 : 0}%`,
    boxShadow: `0 0 0 2px ${ring ?? 'rgba(255,255,255,0.85)'}`,
  };
  const TILE = 56;
  const edge = outline ? pathIn(outline, W, H, fx, fy, TILE / side) : null;
  return (
    <span aria-hidden="true" className="relative block size-14 shrink-0 rounded-[12px] bg-[#1b1b1d] bg-no-repeat" style={picture}>
      {edge && (
        <span className="absolute inset-0 overflow-hidden rounded-[12px]">
          <svg className="size-full" viewBox={`0 0 ${TILE} ${TILE}`}>
            <path d={`M0,0H${TILE}V${TILE}H0Z${edge}`} fill="rgba(0,0,0,0.55)" fillRule="evenodd" />
            <path d={edge} fill="none" stroke={ring ?? 'rgba(255,255,255,0.9)'} strokeWidth={1.5} strokeLinejoin="round" />
          </svg>
        </span>
      )}
      {tick && (
        <span
          className="chapp-anim absolute -right-1.5 -bottom-1.5 flex size-[18px] items-center justify-center rounded-full text-white shadow-[0_0_0_2px_#000]"
          style={{ background: tick, animation: 'chapp-pop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2) both' }}
        >
          <Tick />
        </span>
      )}
    </span>
  );
}

/** A bottle in the strip of those found, before the kit's bottles are known: its picture, and its name once read. */
function FoundItem({ bottle: { shot, box, outline, name, unsure }, colour }: { bottle: FoundBottle; colour?: string }) {
  const pop: CSSProperties = { animation: 'chapp-pop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2) both' };
  return (
    <li className="flex w-[66px] shrink-0 flex-col items-center gap-1.5">
      <BottleTile shot={shot} box={box} outline={outline} ring={undefined} tick={name ? (colour ?? '#1f6feb') : undefined} />
      {name ? (
        <span key={name} className="chapp-anim max-w-full truncate text-[11px] leading-[14px] font-semibold text-white" style={pop}>
          {name}
        </span>
      ) : unsure ? (
        <span className="text-[11px] leading-[14px] font-medium text-white/70">Not sure</span>
      ) : (
        <Shimmer dark className="mt-0.5 h-2.5 w-11 rounded-full" />
      )}
    </li>
  );
}

/**
 * One of the kit's bottles in the list under the video: the bottle the video showed of it (lit along its outline, in
 * its colour; a tap shows it on the video), a tile shimmering while the labels are read, or one not seen (a tap, then a
 * tap on the video, says which it is). Or a bottle Chapp is not sure of (a tap shows it and asks).
 */
function KitSlot({ name, colour, bottle, state, chosen = false, onClick }: {
  name: string;
  colour?: string;
  bottle?: { shot: Shot; box: Box; outline?: string };
  state: 'found' | 'looking' | 'missing' | 'unsure';
  chosen?: boolean;
  onClick?: () => void;
}) {
  const label = state === 'found' ? `${name}: show it on the video` : state === 'missing' ? `${name}: not seen. Tap, then tap it on the video` : state === 'unsure' ? 'A bottle Chapp is not sure of: name it' : `${name}: being looked for`;
  return (
    <li className="w-[66px] shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-pressed={state === 'missing' ? chosen : undefined}
        disabled={!onClick}
        onClick={onClick}
        className="flex w-full flex-col items-center gap-1.5 rounded-[14px] p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-default"
      >
        {bottle ?
          <BottleTile shot={bottle.shot} box={bottle.box} outline={bottle.outline} ring={colour} tick={state === 'found' ? colour : undefined} />
        : state === 'looking' ?
          <span aria-hidden="true" className="relative block size-14 overflow-hidden rounded-[12px] bg-white/6 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]">
            <Shimmer dark className="absolute inset-0" />
          </span>
        : <span
            aria-hidden="true"
            className={cn('flex size-14 items-center justify-center rounded-[12px] border-2 border-dashed text-center text-[10px] leading-3 font-semibold', chosen ? 'animate-pulse text-white' : 'text-white/60')}
            style={{ borderColor: chosen ? colour : 'rgba(255,255,255,0.3)', background: chosen ? `${colour}33` : undefined }}
          >
            Not seen
          </span>
        }
        <span className={cn('line-clamp-2 max-w-full text-center text-[11px] leading-[14px] font-semibold', state === 'found' ? 'text-white' : 'text-white/60')}>{name}</span>
      </button>
    </li>
  );
}

/** One thing Chapp is doing with the video: a spinner while it is under way, a tick once done, and which model does it. */
function Doing({ done, by, children }: { done?: boolean; by?: string; children: ReactNode }) {
  return (
    <li className={cn('grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2 text-[13px] leading-[18px] font-medium transition-colors duration-300', done ? 'text-white/60' : 'text-white')}>
      {done ? (
        <span className="mt-px flex size-4 items-center justify-center rounded-full bg-white/85 text-ink">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12 5 5L19 7" />
          </svg>
        </span>
      ) : (
        <span aria-label="Under way" className="chapp-anim mt-px size-4 animate-spin rounded-full border-2 border-white/25 border-t-white" />
      )}
      <span>{children}</span>
      {by ? <ModelTag dark>{by}</ModelTag> : <span />}
    </li>
  );
}

/**
 * /watch: a video chosen with Home's Upload (in the address's state). A new round of the kit's photos; Chapp says which
 * kit it is, and when the video ends the protocol opens at its glance (or the search for its manual), the bottles found
 * and read behind it. A video whose kit Chapp cannot tell goes back Home with that said, never to another kit.
 */
export function WatchScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const [video] = useState(() => (location.state as { video?: File } | null)?.video ?? null);
  useEffect(() => {
    if (video) useKit.getState().clear();
    // Opened by its address, or after a reload: there is no video to play.
    else navigate('/', { replace: true });
  }, [video, navigate]);
  if (!video) return null;
  const end = (told: KitTold) => {
    if (told !== 'none') return navigate('/protocol', { replace: true });
    toast('I couldn’t tell which kit is in your video. Say its name, or show me its box.');
    navigate('/', { replace: true });
  };
  return <Watch video={video} identify background onEnd={end} />;
}
