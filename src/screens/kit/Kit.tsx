import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { Protocol } from '../../../shared/protocol.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { bottles } from '../protocol/content.ts';
import { findBottles, followBottles, whichKit } from './analysis.ts';
import { Camera } from './Camera.tsx';
import { gotIt, needsOf, recognized, type Pick, type Thing } from './matching.ts';
import { Match } from './Match.tsx';
import { Watch } from './Watch.tsx';
import type { Shot } from './photo.ts';
import { samplePhotos } from './sample.ts';
import { useKit } from './store.ts';

type Review = 'camera' | 'recognized' | 'kit' | 'filled';

// One empty list, so the store's selector returns the same value while a review's samples are hidden from the camera.
const NO_SHOTS: Shot[] = [];

/**
 * Your kit: photograph the bottles (Camera; each photo goes to SAM 3.1 as it is taken, a sweep or a video for SAM to
 * follow the bottles through), then match them to the protocol's bottles (Recognized → Kit → Kit-Filled: labels Muse
 * Spark read, guesses the user confirms, the rest shown by hand). The matched crops become the run's photos
 * (useRun().photos), shown on the protocol and at the bench.
 *
 * For design review a state opens from the address with drawn sample photos, never saved to the run, as the models
 * would leave them: ?state=recognized (reagents read, a guess and a bottle nobody could tell), kit (one more to check),
 * filled (all matched); ?state=camera is the camera.
 */
export function KitScreen() {
  const [params] = useSearchParams();
  const [review] = useState(() => params.get('state') as Review | null);
  const protocolId = useRun(s => s.protocolId) ?? 'pierce-bca';
  const { protocol, error } = useProtocol(protocolId);
  const shots = useKit(s => (s.sample ? NO_SHOTS : s.shots));
  // Opened from Home's +: the first photo may be the kit box, and Chapp says which kit it is. Opened to retake one
  // bottle (the protocol's "Take a photo"): the camera, whatever the round has.
  const location = useLocation();
  const opened = location.state as { from?: string; camera?: boolean } | null;
  const [view, setView] = useState<'camera' | 'match' | { watch: File; identify: boolean }>(() =>
    review === 'camera' || opened?.camera ? 'camera' : review || (!useKit.getState().sample && useKit.getState().shots.length) ? 'match' : 'camera',
  );
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  const identify = useRef(opened?.from === 'home' && !review);

  // A review fills the session with samples; a real visit drops a review's samples first.
  useEffect(() => {
    if (!protocol) return;
    const kit = useKit.getState();
    if (review && review !== 'camera') seedSample(protocol, review);
    else if (kit.sample) kit.clear();
    setReady(true);
  }, [protocol]);

  // Every photo goes to SAM as soon as it is taken (and again after a reload cut its first look short).
  useEffect(() => {
    if (!review) findBottles();
  }, [shots.length]);

  if (typeof view === 'object') {
    // A video from the library plays; opened from Home's +, its first frame says which kit it is.
    // Told which kit it is, the protocol opens with the bottles read behind it (as from Home); else the match screen.
    return (
      <Watch
        key={view.watch.name + view.watch.size}
        video={view.watch}
        identify={view.identify}
        background={view.identify}
        onEnd={told => (told === 'none' ? setView('match') : navigate('/protocol', { replace: true }))}
      />
    );
  }
  if (view === 'camera') {
    // Opened from Home's +, the first photo (or the first frame of a sweep or a video) says which kit it is.
    const identifyBy = (shot: Shot | undefined) => {
      if (!identify.current || !shot) return;
      identify.current = false;
      void whichKit(shot).then(to => to && navigate(to));
    };
    const fresh = () => {
      const kit = useKit.getState();
      if (kit.sample) kit.clear();
    };
    return (
      <Camera
        shots={shots}
        onShots={s => {
          fresh();
          useKit.getState().addShots(s);
          identifyBy(s[0]);
        }}
        onFootage={footage => {
          fresh();
          identifyBy(footage.frames[0]);
          void followBottles(footage);
        }}
        onVideo={video => {
          fresh();
          setView({ watch: video, identify: identify.current });
          identify.current = false;
        }}
        onDone={() => setView('match')}
      />
    );
  }
  if (!protocol || !ready) {
    return error ? <p className="px-6 pt-[calc(120px+var(--screen-top))] text-[17px] leading-6 font-medium text-ink">{error}</p> : null;
  }
  return <Match protocol={protocol} onCamera={() => setView('camera')} />;
}

/**
 * The storyboard's three photos as the models leave them. Recognized: the kit's reagents read, the standard a guess
 * ("small vial"), the user's own bottle not told ("tall bottle"). Kit: the tall bottle named the Diluent, "Is the small
 * vial the Albumin Standard?". Filled: that confirmed too.
 */
function seedSample(protocol: Protocol, review: Exclude<Review, 'camera'>) {
  const needs = needsOf(protocol);
  const { shots, picks } = samplePhotos(bottles(protocol));
  const read = needs.filter(n => n.kit && n.role !== 'standard');
  const standard = needs.find(n => n.role === 'standard');
  const own = needs.filter(n => !n.kit);
  const as = (id: string, how: Pick['how']): Pick => ({ ...picks[id], how });
  const thing = (id: string, looks: string, match: Thing['match']): Thing => ({ ...picks[id], id: `sample-${id}`, looks, text: '', component: match === 'guess' ? id : null, match });
  const matched = Object.fromEntries(read.map(n => [n.id, as(n.id, 'read')]));
  const guess = standard ? [thing(standard.id, 'small vial', 'guess')] : [];
  const kit = useKit.getState();
  if (review === 'recognized') {
    const things = [...guess, ...own.map(n => thing(n.id, 'tall bottle', 'none'))];
    return kit.seed({ shots, picks: matched, things, said: recognized(read.length + things.length, shots.length, read.length, things.length), sample: true });
  }
  const named = Object.fromEntries(own.map(n => [n.id, as(n.id, 'picked')]));
  if (review === 'filled') {
    return kit.seed({ shots, picks: { ...matched, ...named, ...(standard ? { [standard.id]: as(standard.id, 'confirmed') } : {}) }, sample: true });
  }
  // "Diluent, got it. 1 more to check.": the standard waits for "Is the small vial the Albumin Standard?".
  const last = own[own.length - 1] ?? read[read.length - 1];
  kit.seed({ shots, picks: { ...matched, ...named }, things: guess, said: gotIt(last.name, guess.length), sample: true });
}
