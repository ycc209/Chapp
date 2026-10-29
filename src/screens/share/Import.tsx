import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { SharedPlan, StoredShare } from '../../../shared/share.ts';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { SampleDataTag } from '../../components/lab/index.ts';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { kitPhotos } from '../../state/library.ts';
import { useRun } from '../../state/run.ts';
import { matchCommand } from '../../voice/commands.ts';
import { speak } from '../../voice/speak.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { acknowledge, useConverse } from '../home/useConverse.ts';
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
  const [said, setSaid] = useState<string | null>(null);
  const { turn, send } = useConverse('import');
  const [talked, setTalked] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ phase: 'loading' });
    getShare(id, abort.signal).then(
      share => {
        setPlan(share.plan);
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
    if (!pending) return;
    useRun.setState(importPatch(pending, useRun.getState(), kitPhotos(pending.protocolId)));
    navigate('/protocol');
  };

  const heard = (text: string) => {
    const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (pending && /^(?:ok |okay |yes )?(?:use (?:it|this|this setup|the setup)(?: as is)?|import(?: it)?|yes|sounds good|looks good)(?: please)?$/.test(words)) return use();
    if (/^(?:not now|later|no thanks|cancel)$/.test(words)) return navigate('/');
    const command = plan && matchCommand(text);
    if (plan && command && command.every(a => a.type === 'setSamples' || a.type === 'setReplicates')) {
      let next = plan;
      // "In triplicate" sets the standards' replicates too, as on Plan (state/actions.ts).
      for (const a of command) next = a.type === 'setSamples' ? { ...next, samples: a.samples } : a.type === 'setReplicates' ? { ...next, replicates: a.replicates, standardReplicates: a.replicates } : next;
      setPlan(next);
      setTalked(false);
      const changed = share?.plan && share.results && !samePlan(next, share.plan);
      const ack = changed
        ? `${acknowledge(command)} The results were for ${share.plan!.samples} samples ${replicatesWords(share.plan!.replicates)}, so they stay out.`
        : acknowledge(command);
      setSaid(ack);
      void speak(ack).catch(() => {});
      return;
    }
    setSaid(null);
    setTalked(true);
    void send(text);
  };

  const reply = talked && turn ? (turn.phase === 'reply' ? turn.say : turn.phase === 'error' ? ERROR_LINE : null) : null;
  const name = protocol ? shortName(protocol) : '';

  let answer: ReactNode;
  if (load.phase === 'loading') answer = 'Opening what was shared…';
  else if (load.phase === 'missing') answer = "I can't find this setup on this computer. Ask your labmate for a fresh code.";
  else if (load.phase === 'failed') answer = load.message;
  else if (protocolError) answer = protocolError;
  else if (!protocol || !pending) answer = 'Opening what was shared…';
  else answer = reply ?? <Shared share={share!} name={name} />;

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
                {said ? `${said} ` : ''}
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
  const photos = share.kit.some(c => c.photo);
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
