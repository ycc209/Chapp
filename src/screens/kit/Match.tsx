import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Box } from '../../../shared/ai.ts';
import type { Protocol } from '../../../shared/protocol.ts';
import { useCutouts } from '../../components/bench/cutout.ts';
import { BottomBar } from '../../components/voice/BottomBar.tsx';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { useRun } from '../../state/run.ts';
import { TypingBar } from '../home/TypingBar.tsx';
import { useConverse } from '../home/useConverse.ts';
import { SampleBadge } from '../protocol/Body.tsx';
import { AskBadge, CheckBadge, ForwardIcon } from '../protocol/icons.tsx';
import { analyzing, readFound } from './analysis.ts';
import {
  amounts,
  cantLook,
  gotIt,
  heardAnswer,
  looking,
  reading,
  needsOf,
  noPhoto,
  offered,
  open,
  opening,
  rowDetail,
  slotsOf,
  subjectOf,
  thingTitle,
  type Need,
  type Pick,
  type Thing,
} from './matching.ts';
import { boxOnCover, cropAt, type Shot } from './photo.ts';
import { Picker } from './Picker.tsx';
import { outlineAt, useKit } from './store.ts';

const CHIP = 'flex min-h-11 items-center rounded-[22px] text-[15px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-blue';
const WHITE_CHIP = `${CHIP} bg-white px-4 font-semibold text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]`;
const DARK_CHIP = `${CHIP} bg-ink px-[18px] font-[650] text-white`;
const CARD_SHADOW = '0 1px 2px rgba(17, 17, 19, 0.03), 0 4px 14px rgba(17, 17, 19, 0.05)';
const THUMB = { width: 54, height: 72 };

const YES = 'Yes';
const NOT_THIS_RUN = 'Not for this run';
const SOMETHING_ELSE = 'Something else';
const SHOW_ME = 'Show me';
const NOT_IN_PHOTOS = 'Not in my photos';
const TAKE_PHOTO = 'Take a photo';
const KEEP_IT = 'Keep it';

type MatchProps = { protocol: Protocol; onCamera: () => void };

/**
 * Your kit (Recognized, Kit, Kit-Filled): the photos, every bottle the run needs, and Chapp's one question at a
 * time. SAM 3.1 has been finding the bottles since each photo was taken (analysis.ts); here Muse Spark reads their
 * labels. A label read is a match ("Kit · photo 1"); a guess is confirmed ("Is the small vial the Albumin Standard?");
 * a bottle nobody could tell is named ("What's the tall bottle?"). Whatever is still open, or everything when the
 * models are away, the user shows by hand: "Where's the Diluent?", a tap on a photo, "Is this the Diluent?". Once all
 * are in, it shows what this run takes of each.
 */
export function Match({ protocol, onCamera }: MatchProps) {
  const navigate = useNavigate();
  const kit = useKit();
  const { samples, replicates, standardReplicates, standards, procedure } = useRun();
  const needs = useMemo(() => needsOf(protocol), [protocol]);
  const amount = useMemo(
    () => amounts(protocol, procedure, samples, replicates, standardReplicates, standards),
    [protocol, procedure, samples, replicates, standardReplicates, standards],
  );
  const [picker, setPicker] = useState<{ shot: number; need: Need } | null>(null);
  const [typing, setTyping] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const { turn, send } = useConverse('kit');
  // Chapp's answer to something said that was not one of the answers on screen, until the next answer is picked.
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => {
    if (turn?.phase === 'reply') setReply(turn.say);
  }, [turn]);

  // Muse Spark reads the labels once SAM is done with every photo (sample photos are drawn already matched).
  useEffect(() => {
    if (!kit.sample) void readFound(protocol);
  }, [kit.seen, kit.sample, protocol]);

  const busy = analyzing(kit.seen);
  // SAM is still finding bottles on some photo; else, while busy, Muse Spark is reading the labels of what it found.
  const finding = Object.values(kit.seen).some(l => l.state === 'finding');
  const found = Object.values(kit.seen).reduce((n, l) => n + l.boxes.length, 0);
  // SAM could not look at any photo (offline, say): over to the user's taps.
  const unseen = !kit.sample && kit.shots.length > 0 && kit.shots.every(s => kit.seen[s.id]?.state === 'failed');
  const left = open(needs, kit);
  const subject = subjectOf(needs, kit, busy);
  const slots = slotsOf(needs, kit);
  const complete = !busy && !kit.pending && kit.things.length === 0 && left.length === 0;
  const shotNumber = (id: string) => kit.shots.findIndex(s => s.id === id) + 1;
  const picked = needs.filter(n => kit.picks[n.id]).length;
  // Each matched bottle's cut-out, made as it was matched (store.ts). One that did not come out whole gets a question
  // once everything else is in: a photo of just that bottle, or keep it.
  const cuts = useCutouts(useMemo(() => Object.fromEntries(needs.flatMap(n => (kit.picks[n.id] ? [[n.id, kit.picks[n.id]!.crop]] : []))), [needs, kit.picks]));
  const [kept, setKept] = useState<Record<string, true>>({});
  const retake = complete && !kit.sample ? (needs.find(n => kit.picks[n.id] && cuts[n.id] && !cuts[n.id]!.ok && !kept[n.id]) ?? null) : null;
  // The bottle a tap on a photo is for: the one asked about, else the first still open.
  const target = subject && subject.kind !== 'unknown' ? subject.need : (left[0] ?? null);
  /** Left to check once `need` is matched: "Diluent, got it. 1 more to check." */
  const leftAfter = (need: Need) => left.length - (left.includes(need) ? 1 : 0);

  const show = (need: Need, shot = 0) => {
    setReply(null);
    setPicker({ shot, need });
  };

  const answers: string[] = retake
    ? [TAKE_PHOTO, KEEP_IT]
    : !subject
      ? []
    : subject.kind === 'where'
      ? [SHOW_ME, NOT_IN_PHOTOS]
      : kit.reassign
        ? // Any other bottle, matched ones too: the crop may be the right picture of a bottle matched by mistake.
          [...needs.filter(n => subject.kind === 'unknown' || n.id !== subject.need.id).map(n => n.name), NOT_THIS_RUN]
        : subject.kind === 'unknown'
          ? [...offered(needs, kit).map(n => n.name), NOT_THIS_RUN, SOMETHING_ELSE]
          : [YES, NOT_THIS_RUN, SOMETHING_ELSE];

  const choose = (choice: string) => {
    setReply(null);
    if (retake) {
      if (choice === TAKE_PHOTO) {
        kit.retake(retake.id, `Take a photo of just the ${retake.name}.`);
        onCamera();
      } else if (choice === KEEP_IT) setKept(k => ({ ...k, [retake.id]: true }));
      return;
    }
    if (!subject) return;
    if (subject.kind === 'where') {
      if (choice === SHOW_ME) return show(subject.need);
      if (choice === NOT_IN_PHOTOS) return kit.skip(subject.need.id, noPhoto(subject.need.name, left.length - 1));
      return;
    }
    if (choice === SOMETHING_ELSE) return kit.setReassign(true);
    const named = choice === YES && subject.kind !== 'unknown' ? subject.need : needs.find(n => n.name === choice);
    if (subject.kind === 'pending') {
      if (choice === NOT_THIS_RUN) return kit.reject(`Okay, not that one.`);
      if (named) return kit.accept(named.id, gotIt(named.name, leftAfter(named)));
      return;
    }
    if (choice === NOT_THIS_RUN) return kit.answer(subject.thing.id, null, 'picked', `Okay, not that one.`);
    if (named) kit.answer(subject.thing.id, named.id, choice === YES ? 'confirmed' : 'picked', gotIt(named.name, leftAfter(named)));
  };

  // A spoken or typed answer that is one of the answers on screen is that answer; anything else goes to Chapp.
  const utter = (text: string) => {
    const answer = heardAnswer(text, answers);
    if (answer) choose(answer);
    else void send(text);
  };

  const pick = async (shot: number, at: { x: number; y: number }, need: Need, bottle: Box | null) => {
    setPicker(null);
    try {
      const { crop, box } = await cropAt(kit.shots[shot], at, bottle);
      useKit.getState().propose(need.id, { shot: kit.shots[shot].id, box, crop });
    } catch {
      toast('That photo could not be opened. Try another one?');
    }
  };

  /**
   * The marks on a photo of the strip: SAM's outline of each bottle (its box when there is none), blue once matched,
   * yellow while Chapp asks, dashed while nobody can tell.
   */
  const marksOn = (shot: string): Mark[] => {
    const look = kit.seen[shot];
    const mark = (box: Box, tone: Mark['tone']): Mark => ({ box, tone, outline: outlineAt(look, box) });
    // Bottles SAM found whose labels are not read yet light up dashed, as each photo comes back.
    if (look && (look.state === 'found' || look.state === 'reading')) return look.boxes.map(box => mark(box, 'dashed'));
    const all = (p: Pick) => p.boxes ?? [p.box];
    return [
      ...Object.values(kit.picks).filter(p => p.shot === shot).flatMap(p => all(p).map(box => mark(box, 'blue'))),
      ...kit.things.filter(t => t.shot === shot).flatMap(t => all(t).map(box => mark(box, t.match === 'guess' ? 'yellow' : 'dashed'))),
      ...(kit.pending?.shot === shot ? [mark(kit.pending.box, 'yellow')] : []),
    ];
  };

  const finish = () => {
    if (kit.sample) return navigate('/protocol?state=kit');
    navigate('/protocol', { state: { from: 'kit' } });
    // This round is over (the crops are in the run): the next visit starts with the camera.
    window.setTimeout(() => useKit.getState().clear(), 0);
  };

  const photoOf = (id: string) => (shotNumber(id) > 0 ? `photo ${shotNumber(id)}` : 'the photo');
  const line: ReactNode = reply ?? (retake ? (
    <>
      I couldn’t cut the <b className="font-bold">{retake.name}</b> out of {photoOf(kit.picks[retake.id]!.shot)} cleanly: {cuts[retake.id]!.why}.
    </>
  ) : complete ? (
    <>
      {picked === needs.length ? `All ${needs.length} are in.` : `${picked} of ${needs.length} have a photo.`} Amounts are for{' '}
      <b className="font-bold whitespace-nowrap">
        {samples} samples × {replicates}
      </b>
      .
    </>
  ) : busy ? (
    finding ? looking(kit.shots.length) : reading(found)
  ) : (
    kit.said ?? (unseen ? cantLook(needs.length) : opening(kit.shots.length, needs.length))
  ));

  return (
    <div className="relative flex h-full flex-col gap-4 px-5 pt-[calc(56px+var(--screen-top))] pb-[var(--screen-bottom)]">
      <div className="flex justify-end">
        <Link
          to="/protocol"
          state={complete && !kit.sample ? { from: 'kit' } : undefined}
          aria-label="Back to the protocol"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
        >
          <ForwardIcon />
        </Link>
      </div>

      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto [scrollbar-width:none]">
        <p aria-live="polite" aria-label="Chapp's answer" className="px-1 text-[17px] leading-6 font-medium text-ink">
          {line}
        </p>
        {kit.sample && <SampleBadge className="ml-1">Sample photos, drawn for review</SampleBadge>}
        <ul aria-label={`Your ${kit.shots.length} photo${kit.shots.length === 1 ? '' : 's'}`} className="flex shrink-0 gap-2 overflow-x-auto px-1 [scrollbar-width:none]">
          {kit.shots.map((shot, i) => (
            <li key={shot.id} className="shrink-0">
              <ShotThumb shot={shot} number={i + 1} marks={marksOn(shot.id)} onClick={target ? () => show(target, i) : undefined} />
            </li>
          ))}
          <li className="shrink-0">
            <button
              type="button"
              aria-label="Add another photo"
              onClick={onCamera}
              className="flex h-[72px] w-[54px] items-center justify-center rounded-[12px] border-[1.5px] border-dashed border-[#c9c9c4] text-text outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </li>
        </ul>
        <ul aria-label={complete ? 'Your kit' : 'What I found'} className="flex shrink-0 flex-col gap-2">
          {needs.map((need, i) => {
            const pick = kit.picks[need.id];
            const pending = kit.pending?.component === need.id ? kit.pending : undefined;
            // Until it is matched, a row shows what the models found for it: a guess, or a bottle nobody could tell.
            const thing = pick || pending ? undefined : (kit.things.find(t => t.match === 'guess' && t.component === need.id) ?? slots.get(need.id));
            const asked = subject && (subject.kind === 'unknown' ? thing === subject.thing : subject.need.id === need.id);
            return (
              <Row
                key={need.id}
                need={need}
                shape={shapeOf(needs, i)}
                pick={pick}
                pending={pending}
                thing={thing}
                skipped={kit.skipped[need.id]}
                asked={!complete && Boolean(asked)}
                detail={rowDetail(need, { pick, pending, thing, skipped: kit.skipped[need.id] }, shotNumber) + (pick && !pending && cuts[need.id] && !cuts[need.id]!.ok ? ' · hard to cut out' : '')}
                amount={complete ? amount[need.id] : undefined}
                onClick={() => (thing ? kit.ask(thing.id) : show(need, Math.max(0, shotNumber(pick?.shot ?? '') - 1)))}
              />
            );
          })}
        </ul>
      </div>

      {retake ? (
        <div className="flex shrink-0 flex-col gap-2.5">
          <div className="flex items-center gap-3 px-1">
            <span className="flex size-[72px] shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(180deg,#f7f9fc_0%,#e4e9f0_100%)]">
              <img src={cuts[retake.id]!.src} alt="" draggable={false} className="max-h-16 max-w-16 object-contain" />
            </span>
            <p className="text-[17px] leading-6 font-medium text-ink">Take a photo of just that bottle?</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {answers.map(a => (
              <button key={a} type="button" onClick={() => choose(a)} className={a === TAKE_PHOTO ? DARK_CHIP : WHITE_CHIP}>
                {a}
              </button>
            ))}
          </div>
        </div>
      ) : complete ? (
        <button
          type="button"
          onClick={finish}
          className="flex min-h-[52px] shrink-0 items-center justify-center rounded-full bg-ink text-[17px] leading-[22px] font-[650] text-white outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2"
        >
          Done
        </button>
      ) : (
        subject && (
          <div className="flex shrink-0 flex-col gap-2.5">
            <p className="px-1 text-[17px] leading-6 font-medium text-ink">
              {subject.kind === 'where' ? (
                <>
                  Where’s the <b className="font-bold">{subject.need.name}</b>?
                </>
              ) : kit.reassign ? (
                'Which bottle is this?'
              ) : subject.kind === 'pending' ? (
                <>
                  Is this the <b className="font-bold">{subject.need.name}</b>?
                </>
              ) : subject.kind === 'guess' ? (
                <>
                  Is the {subject.thing.looks} the <b className="font-bold">{subject.need.name}</b>?
                </>
              ) : (
                <>
                  What’s the <b className="font-bold">{subject.thing.looks}</b>?
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {answers.map(a => (
                <button key={a} type="button" onClick={() => choose(a)} className={a === YES || a === SHOW_ME ? DARK_CHIP : WHITE_CHIP}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        )
      )}

      {typing ? (
        <TypingBar plusOpen={false} plusRef={plusRef} onPlus={onCamera} onSend={utter} onClose={() => setTyping(false)} />
      ) : (
        <BottomBar onPlus={onCamera} onKeyboard={() => setTyping(true)} onUtterance={utter} />
      )}

      {picker && (
        <Picker
          shots={kit.shots}
          start={picker.shot}
          name={picker.need.name}
          bottles={id => kit.seen[id]?.boxes ?? []}
          outlineOf={(id, box) => outlineAt(kit.seen[id], box)}
          onPick={(shot, at, bottle) => void pick(shot, at, picker.need, bottle)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

type Shape = 'wide' | 'medium' | 'vial' | 'tall';

/** Which drawing stands in for a bottle with no photo yet: the design's four (Recognized.dc.html). */
function shapeOf(needs: Need[], i: number): Shape {
  const need = needs[i];
  if (need.role === 'standard') return 'vial';
  if (need.role === 'diluent') return 'tall';
  return needs.slice(0, i).some(n => n.role === 'reagent') ? 'medium' : 'wide';
}

const SILHOUETTES: Record<Shape, ReactNode> = {
  wide: (
    <>
      <rect x="22" y="13" width="12" height="5" rx="1.5" />
      <rect x="24" y="18" width="8" height="3" />
      <rect x="14" y="21" width="28" height="27" rx="5" />
    </>
  ),
  medium: (
    <>
      <rect x="23.5" y="19" width="9" height="5" rx="1.5" />
      <rect x="19" y="24" width="18" height="23" rx="4" />
    </>
  ),
  vial: (
    <>
      <rect x="24.5" y="16" width="7" height="5" rx="1.5" />
      <rect x="24" y="21" width="8" height="26" rx="3" />
    </>
  ),
  tall: (
    <>
      <rect x="23" y="5" width="10" height="5" rx="1.5" />
      <rect x="24.5" y="10" width="7" height="5" />
      <rect x="19" y="15" width="18" height="36" rx="4" />
    </>
  ),
};

type RowProps = {
  need: Need;
  shape: Shape;
  pick?: Pick;
  pending?: Pick;
  thing?: Thing;
  skipped?: boolean;
  asked: boolean;
  detail: string;
  amount?: string;
  onClick: () => void;
};

/**
 * One bottle: its crop (or the drawing), a tick or a ?, its name and where its picture came from. Until it is
 * matched, what the models found for it stands in: "Small vial · Photo 2 · maybe the Albumin Standard".
 */
function Row({ need, shape, pick, pending, thing, skipped, asked, detail, amount, onClick }: RowProps) {
  const crop = pending?.crop ?? pick?.crop ?? thing?.crop;
  const title = thing ? thingTitle(thing) : need.name;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${title}, ${detail}${amount ? `, ${amount}` : ''}. ${thing ? 'Answer about it' : 'Show it on a photo'}`}
        className={cn(
          'grid w-full items-center gap-3.5 rounded-[18px] bg-white py-2.5 pr-4 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue',
          amount ? 'grid-cols-[56px_minmax(0,1fr)_auto]' : 'grid-cols-[56px_minmax(0,1fr)]',
        )}
        style={{ boxShadow: asked ? `inset 0 0 0 2px #e5c100, ${CARD_SHADOW}` : CARD_SHADOW }}
      >
        <span className="relative size-14 rounded-[12px] bg-[#1b1b1d]">
          {crop ? (
            <img src={crop} alt="" draggable={false} className="block size-14 rounded-[12px] object-cover" />
          ) : (
            <svg width="56" height="56" viewBox="0 0 56 56" fill="#4a4a50" aria-hidden="true" className="block">
              {SILHOUETTES[shape]}
            </svg>
          )}
          {pick && !pending ? <CheckBadge /> : !skipped && <AskBadge />}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[17px] leading-[22px] font-[650] text-ink">{title}</span>
          <span className="text-[13px] leading-[18px] text-text">{detail}</span>
        </span>
        {amount && <span className="text-[20px] leading-6 font-[750] text-ink tabular-nums">{amount}</span>}
      </button>
    </li>
  );
}

type Mark = { box: Box; tone: 'blue' | 'yellow' | 'dashed'; outline?: string };
type ShotThumbProps = { shot: Shot; number: number; marks: Mark[]; onClick?: () => void };

/** A photo in the strip, with SAM's outline (or a box) where each bottle on it is (Recognized.dc.html). */
function ShotThumb({ shot, number, marks, onClick }: ShotThumbProps) {
  // Where the whole photo lands on the thumbnail (object-fit: cover): outlines in fractions scale onto it.
  const on = boxOnCover({ x: 0, y: 0, width: 1, height: 1 }, shot, THUMB);
  return (
    <button
      type="button"
      aria-label={`Photo ${number}`}
      onClick={onClick}
      disabled={!onClick}
      className="relative block h-[72px] w-[54px] overflow-hidden rounded-[12px] bg-[#1b1b1d] outline-none focus-visible:ring-2 focus-visible:ring-blue"
    >
      <img src={shot.src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      {marks.map((m, i) => !m.outline && <Square key={i} box={boxOnCover(m.box, shot, THUMB)} tone={m.tone} />)}
      {marks.some(m => m.outline) && (
        <svg aria-hidden="true" className="absolute inset-0 size-full" viewBox={`0 0 ${THUMB.width} ${THUMB.height}`}>
          <g transform={`translate(${on.left} ${on.top}) scale(${on.width} ${on.height})`}>
            {marks.map((m, i) => m.outline && <Outline key={i} d={m.outline} tone={m.tone} />)}
          </g>
        </svg>
      )}
      <span className="absolute top-[5px] left-[7px] text-[11px] leading-[14px] font-bold text-white [text-shadow:0_0_3px_rgba(0,0,0,0.9),0_1px_2px_rgba(0,0,0,0.6)]">
        {number}
      </span>
    </button>
  );
}

/** SAM's outline of a bottle, in a photo's fractions (the enclosing group scales it onto the picture). */
export function Outline({ d, tone }: { d: string; tone: Mark['tone'] }) {
  const stroke = tone === 'blue' ? '#568dfa' : tone === 'yellow' ? '#ffe863' : '#ffffff';
  const fill = tone === 'blue' ? 'rgba(86,141,250,0.22)' : tone === 'yellow' ? 'rgba(255,232,99,0.22)' : 'rgba(255,255,255,0.12)';
  return <path d={d} fill={fill} stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeDasharray={tone === 'dashed' ? '3 2' : undefined} vectorEffect="non-scaling-stroke" className="transition-colors duration-300" />;
}

function Square({ box, tone }: { box: { left: number; top: number; width: number; height: number }; tone: Mark['tone'] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute box-border rounded-[5px] border-[1.5px] transition-colors duration-300',
        tone === 'blue'
          ? 'border-[#568dfa] bg-[rgba(86,141,250,0.16)]'
          : tone === 'yellow'
            ? 'border-mark bg-[rgba(255,232,99,0.18)]'
            : 'border-dashed border-white bg-[rgba(255,255,255,0.08)]',
      )}
      style={box}
    />
  );
}
