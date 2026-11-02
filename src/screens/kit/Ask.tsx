import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { Protocol } from '../../../shared/protocol.ts';
import { cn } from '../../lib/cn.ts';
import { analyzing } from './analysis.ts';
import { gotIt, needsOf, noPhoto, offered, open, subjectOf } from './matching.ts';
import { useKit } from './store.ts';

const PILL = 'flex min-h-9 cursor-pointer items-center rounded-[18px] border-0 px-4 font-[inherit] text-[15px] leading-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue';
const DARK = 'bg-ink text-white';
const WHITE = 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]';

const YES = 'Yes';
const NOT_THIS_RUN = 'Not for this run';
const SOMETHING_ELSE = 'Something else';
const SHOW_ME = 'Show me';
const NOT_IN_PHOTOS = 'Not in my photos';

/**
 * What the kit screen would ask about the round's photos, asked on the protocol instead, so the user need not open the
 * kit screen after a video: a guess to confirm ("Is the small vial the Albumin Standard?"), a bottle nobody could
 * tell, or one of the kit's own still to show by hand ("Where's the Insulin?"), one at a time as the kit screen asks
 * them (matching.ts subjectOf), with the same answers. Show me opens the kit screen on that bottle's picker. Nothing while the models
 * are still at the photos, or once every bottle is matched or skipped.
 */
export function KitAsk({ protocol }: { protocol: Protocol }) {
  const navigate = useNavigate();
  const kit = useKit();
  const needs = useMemo(() => needsOf(protocol), [protocol]);
  if (kit.sample || !kit.shots.length) return null;
  const busy = analyzing(kit.seen) || kit.following !== null;
  const first = subjectOf(needs, kit, busy);
  // Where a bottle is, asked only of the kit's own: the user's are theirs to show or not (Not in the kit).
  const subject = first?.kind === 'where' && !first.need.kit ? subjectOf(needs.filter(n => n.kit), kit, busy) : first;
  if (!subject) return null;
  const left = open(needs, kit);
  const leftAfter = (id: string) => left.length - (left.some(n => n.id === id) ? 1 : 0);

  const answers: string[] =
    subject.kind === 'where' ? [SHOW_ME, NOT_IN_PHOTOS]
    : kit.reassign ? [...needs.filter(n => subject.kind === 'unknown' || n.id !== subject.need.id).map(n => n.name), NOT_THIS_RUN]
    : subject.kind === 'unknown' ? [...offered(needs, kit).map(n => n.name), NOT_THIS_RUN, SOMETHING_ELSE]
    : [YES, NOT_THIS_RUN, SOMETHING_ELSE];

  const choose = (choice: string) => {
    if (subject.kind === 'where') {
      if (choice === SHOW_ME) return navigate('/kit', { state: { show: subject.need.id } });
      if (choice === NOT_IN_PHOTOS) return kit.skip(subject.need.id, noPhoto(subject.need.name, left.length - 1));
      return;
    }
    if (choice === SOMETHING_ELSE) return kit.setReassign(true);
    const named = choice === YES && subject.kind !== 'unknown' ? subject.need : needs.find(n => n.name === choice);
    if (subject.kind === 'pending') {
      if (choice === NOT_THIS_RUN) return kit.reject('Okay, not that one.');
      if (named) return kit.accept(named.id, gotIt(named.name, leftAfter(named.id)));
      return;
    }
    if (choice === NOT_THIS_RUN) return kit.answer(subject.thing.id, null, 'picked', 'Okay, not that one.');
    if (named) kit.answer(subject.thing.id, named.id, choice === YES ? 'confirmed' : 'picked', gotIt(named.name, leftAfter(named.id)));
  };

  const crop = subject.kind === 'pending' ? kit.pending?.crop : subject.kind === 'where' ? undefined : subject.thing.crop;
  return (
    <div className="mt-[22px] flex shrink-0 flex-col gap-3">
      <div className="flex items-center gap-3 px-1">
        {crop && <img src={crop} alt="" draggable={false} className="size-[72px] shrink-0 rounded-[14px] object-cover" />}
        <p aria-label="Chapp's answer" className="m-0 text-[17px] leading-6 font-medium text-ink">
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
      </div>
      <div className="flex flex-wrap gap-2 px-1">
        {answers.map(a => (
          <button key={a} type="button" onClick={() => choose(a)} className={cn(PILL, a === YES || a === SHOW_ME ? DARK : WHITE)}>
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}
