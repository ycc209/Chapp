import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { SharedPlan as SharedPlanSchema, type SharedPlan, type StoredShare } from '../../../shared/share.ts';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { ReplySources, ReplyText } from '../../components/chapp/ReplyText.tsx';
import { SampleDataTag } from '../../components/lab/index.ts';
import { runSetup } from '../../components/lab/model.ts';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { kitCover, kitPhotos, rememberCover } from '../../state/library.ts';
import { useRun } from '../../state/run.ts';
import { useSession } from '../../state/session.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { useConverse } from '../home/useConverse.ts';
import { coverFocus } from '../kit/cover.ts';
import { getShare, isMissing } from './api.ts';
import { Answer, PAGE, PILL_DARK, PILL_LIGHT, SAMPLE_TAG, SAY, ScreenBar, TravelList, useFace } from './parts.tsx';
import { Scanner } from './Scanner.tsx';
import { importPatch, replicatesWords, shortName, travels, whenSaid } from './setup.ts';

/**
 * /import: opened from a Chapp code (/import?s=<id>, the iPhone camera opens it directly) it shows what was shared;
 * opened from the + menu's "QR code" it is the scanner, which reads the code and comes back here with its id.
 */
export function ImportScreen() {
  const [params] = useSearchParams();
  const id = params.get('s');
  return id ? <Received key={id} id={id} /> : <Scanner />;
}

type Load = { phase: 'loading' } | { phase: 'ready'; share: StoredShare } | { phase: 'missing' } | { phase: 'failed'; message: string };

/**
 * Scan-Import ("Scanned on a labmate's phone"): who shared what, what you get, the kit's bottles, and Use this setup,
 * which writes it into this phone's run and opens the protocol. Before that the plan can be changed by saying it
 * ("8 samples", "in triplicate"), as Chapp asks.
 *
 * For design review the kit row opens from the address: &kit=open.
 */
function Received({ id }: { id: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  useFace(load.phase === 'missing' || load.phase === 'failed' ? 'sad' : 'surprised');
  const [attempt, setAttempt] = useState(0);
  const [kitOpen, setKitOpen] = useState(params.get('kit') === 'open');
  // The plan as it will be imported: the shared one, changed by what the user says here.
  const [plan, setPlan] = useState<StoredShare['plan']>(undefined);
  // A single model turn may edit several fields before React renders again.
  const planRef = useRef(plan);
  const changePlan = (next: StoredShare['plan']) => {
    planRef.current = next;
    setPlan(next);
  };
  const [talked, setTalked] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ phase: 'loading' });
    getShare(id, abort.signal).then(
      share => {
        changePlan(share.plan);
        setLoad({ phase: 'ready', share });
      },
      error => {
        if (abort.signal.aborted) return;
        setLoad(isMissing(error) ? { phase: 'missing' } : { phase: 'failed', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => abort.abort();
  }, [id, attempt]);

  const share = load.phase === 'ready' ? load.share : null;
  const { protocol, error: protocolError } = useProtocol(share?.protocolId ?? null);
  // The readings belong to the plate the sharer laid out: a different plan would put them in the wrong wells, so
  // changing the plan here leaves the results behind.
  const replanned = !!share?.plan && !!plan && !samePlan(plan, share.plan);
  const pending = useMemo(
    () => (share ? { ...share, plan, results: replanned ? undefined : share.results } : null),
    [share, plan, replanned],
  );
  const lines = pending && protocol ? travels(pending, protocol) : null;

  const use = () => {
    if (!share || !protocol) return false;
    const next = planRef.current;
    const changed = !!share.plan && !!next && !samePlan(next, share.plan);
    const adopted = { ...share, plan: next, results: changed ? undefined : share.results };
    useRun.setState(importPatch(adopted, useRun.getState(), kitPhotos(adopted.protocolId)));
    // Their photo of the kit's packaging becomes its cover here too, unless this phone has its own.
    const cover = adopted.cover;
    if (cover && !kitCover(adopted.protocolId)) rememberCover(adopted.protocolId, { src: cover.photo, round: adopted.id, ...(cover.box ? { box: cover.box } : {}) });
    useSession.getState().setExchange(null);
    navigate('/protocol');
    return true;
  };

  const { turn, send } = useConverse('share-import', {
    protocol: () => protocol,
    context: () => ({
      screen: 'share-import',
      protocolId: share?.protocolId ?? null,
      procedure: share?.procedure,
      ...(planRef.current ?? {}),
      pending: 'Shared setup preview, not the active run. Count changes edit this draft only. Pending question: Use this setup? Adopt only on explicit acceptance; discussion leaves the active run unchanged.',
    }),
    executePage: action => {
      if (action.type === 'navigate') return null;
      if (action.type === 'answer') {
        if (!action.yes) {
          navigate('/');
          return { ok: true, message: 'Closed the shared setup without importing it or changing the active run.' };
        }
        return use()
          ? { ok: true, message: 'Imported the shared setup with its previewed plan and opened the protocol.' }
          : { ok: false, message: 'The shared setup is still loading; nothing was imported.' };
      }
      if (action.type !== 'setSamples' && action.type !== 'setReplicates') {
        return { ok: false, message: 'This is a shared-run preview. It can change its sample count and replicates, or adopt the setup; it cannot change the active experiment.' };
      }
      const before = planRef.current;
      if (!before || !share || !protocol) return { ok: false, message: 'There is no shared plan available to edit. The active experiment was not changed.' };
      const next = action.type === 'setSamples'
        ? { ...before, samples: action.samples }
        : { ...before, replicates: action.replicates, standardReplicates: action.standardReplicates ?? before.standardReplicates ?? before.replicates };
      try {
        SharedPlanSchema.parse(next);
        runSetup(protocol, { procedure: share.procedure, ...next, standardReplicates: next.standardReplicates ?? next.replicates, standards: next.standards ?? 'kit' });
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'That preview plan does not fit this protocol.' };
      }
      changePlan(next);
      const changed = share.plan && share.results && !samePlan(next, share.plan);
      return {
        ok: true,
        message: `Shared preview now has ${next.samples} samples with ${next.replicates} replicates. The active run is unchanged.${changed ? ' The original results no longer match this plan and will not be imported.' : ''}`,
      };
    },
  });

  const heard = (text: string) => {
    setTalked(true);
    void send(text);
  };

  const name = protocol ? shortName(protocol) : '';

  let answer: ReactNode;
  if (load.phase === 'loading') answer = 'Opening what was shared…';
  else if (load.phase === 'missing') answer = "I can't find this setup on this computer. Ask your labmate for a fresh code.";
  else if (load.phase === 'failed') answer = load.message;
  else if (protocolError) answer = protocolError;
  else if (!protocol || !pending) answer = 'Opening what was shared…';
  else if (talked && turn) answer = <>
    <ReplyText text={turn.phase === 'error' ? turn.error || ERROR_LINE : turn.say || (turn.phase === 'thinking' ? turn.progress || '…' : '')} />
    {turn.phase === 'reply' && <ReplySources sources={turn.sources} />}
  </>;
  else answer = <Shared share={share!} name={name} />;

  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div className={PAGE}>
        <Answer>{answer}</Answer>

        {lines && pending && (
          <>
            <section aria-label="You get" className="mb-7 flex shrink-0 flex-col gap-2.5 px-1">
              <h2 className="m-0 text-[13px] leading-[18px] font-semibold text-text">You get</h2>
              <TravelList travels={lines} reagent appear />
            </section>

            <div className="share-appear flex shrink-0 flex-col border-b border-line" style={{ animationDelay: '560ms' }}>
              <button
                type="button"
                aria-expanded={kitOpen}
                onClick={() => setKitOpen(open => !open)}
                className="flex min-h-14 items-center gap-3 border-t border-line px-1 text-left text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-inset"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#55555c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
                  <path d="m3 8 9 5 9-5M12 13v8" />
                </svg>
                <span className="grow text-[17px] leading-[22px] font-semibold">Kit</span>
                <span className="text-[15px] leading-5 text-text">
                  {pending.kit.length} bottle{pending.kit.length === 1 ? '' : 's'}
                </span>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                  className="shrink-0 transition-transform duration-200"
                  style={{ transform: `rotate(${kitOpen ? 45 : 0}deg)` }}
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {kitOpen && (
                <div className="flex flex-col gap-3 pr-1 pb-[18px] pl-9">
                  {/* Their photo of the kit's box or bag, its cover, when it came along. */}
                  {pending.cover && (
                    <img
                      src={pending.cover.photo}
                      alt="Their photo of the kit"
                      draggable={false}
                      className="block aspect-[4/3] w-full rounded-[14px] bg-[#1b1b1d] object-cover"
                      style={{ objectPosition: coverFocus(pending.cover.box) }}
                    />
                  )}
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 text-base leading-[22px] font-semibold text-ink">
                    {pending.kit.map(c => (
                      <li key={c.id} className={cn('flex items-center gap-3', c.detail && 'justify-between')}>
                        <span className="flex min-w-0 items-center gap-2.5">
                          {/* Their photo of the bottle, when it came along (Protocol's In the kit thumbnails); rows without
                              one keep the names in line. */}
                          {c.photo ? (
                            <img src={c.photo} alt="" draggable={false} className="block size-8 shrink-0 rounded-[9px] bg-[#1b1b1d] object-cover" />
                          ) : (
                            pending.kit.some(k => k.photo) && <span aria-hidden="true" className="size-8 shrink-0" />
                          )}
                          {c.label}
                        </span>
                        {c.detail && <span className="text-right font-medium text-text">{c.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}

        <div className="mt-8 flex shrink-0 flex-col gap-5">
          <div className="flex flex-col gap-2 pl-1">
            {load.phase === 'ready' && protocol && (
              <p className={SAY}>
                {plan ? 'Use it as is, or tell me what is different. How many samples do you have?' : 'Use it as is, or tell me how many samples you have.'}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Link to="/" className={PILL_LIGHT}>
              Not now
            </Link>
            {load.phase === 'missing' ? (
              <Link to="/import" className={PILL_DARK}>
                Scan again
              </Link>
            ) : load.phase === 'failed' ? (
              <button type="button" onClick={() => setAttempt(a => a + 1)} className={PILL_DARK}>
                Try again
              </button>
            ) : (
              <button type="button" disabled={!pending || !protocol} onClick={use} className={PILL_DARK}>
                Use this setup
              </button>
            )}
          </div>
        </div>
      </div>
      <ScreenBar onUtterance={heard} />
      {pending?.results?.sampleData && <SampleDataTag className={SAMPLE_TAG} />}
      <ChappHeader subtitle={share?.from ? `Shared by ${share.from}` : 'Shared with you'} back={{ to: '/', label: 'Back home' }} />
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The same plate: the readings only fit the plan they were read with (a share without standards ran them like the samples). */
const samePlan = (a: SharedPlan, b: SharedPlan) =>
  a.samples === b.samples &&
  a.replicates === b.replicates &&
  (a.standardReplicates ?? a.replicates) === (b.standardReplicates ?? b.replicates) &&
  (a.standards ?? 'kit') === (b.standards ?? 'kit');

/**
 * "CJ Yu shared a Pierce BCA run: the protocol, a plan for 12 samples in duplicate, and the results from today. The kit
 * photos are not included; photograph your own and I will name the bottles." Shorter when the share was trimmed.
 */
function Shared({ share, name }: { share: StoredShare; name: string }) {
  const who = share.from ? <b className="font-bold">{share.from}</b> : 'A labmate';
  const photos = share.kit.some(c => c.photo) || Boolean(share.cover);
  const plan = share.plan && (
    <>
      a plan for <b className="font-bold">{plural(share.plan.samples, 'sample')}</b> {replicatesWords(share.plan.replicates)}
    </>
  );
  return (
    <>
      {who}{' '}
      {plan ? (
        <>
          shared a {name} run: the protocol{share.results ? ', ' : ' and '}
          {plan}
          {share.results && <>, and the results from {whenSaid(share.sharedAt)}</>}.
        </>
      ) : (
        <>shared the {name} protocol.</>
      )}{' '}
      {photos ? 'Their kit photos came along; check them against your own bottles.' : 'The kit photos are not included; photograph your own and I will name the bottles.'}
    </>
  );
}
