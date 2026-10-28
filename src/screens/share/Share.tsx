import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { shareLink, type SharedSetup, type ShareScope } from '../../../shared/share.ts';
import { ChappHeader } from '../../components/chapp/ChappHeader.tsx';
import { SampleDataTag } from '../../components/lab/index.ts';
import { toast } from '../../components/ui/Toaster.tsx';
import { cn } from '../../lib/cn.ts';
import { useProtocol } from '../../state/protocol.ts';
import { userName } from '../../state/profile.ts';
import { useRun } from '../../state/run.ts';
import { speak } from '../../voice/speak.ts';
import { ERROR_LINE } from '../home/HomeCenter.tsx';
import { useConverse } from '../home/useConverse.ts';
import { useSharedLibrary } from '../library/store.ts';
import { postShare } from './api.ts';
import { Answer, PAGE, PILL_DARK, PILL_LIGHT, SAMPLE_TAG, SAY, ScreenBar, TravelList, useFace } from './parts.tsx';
import { QrCode, qrPng } from './Qr.tsx';
import { buildShare, catalog, hasResults, parsePhotos, parseTrim, shortName, standardR2, travels } from './setup.ts';

const SCOPES: ShareScope[] = ['all', 'noresults', 'protocol'];

/**
 * What Chapp says about each trim (Share-QR's three answers, and the softer two when there are no results yet), then
 * where the kit photos go: with the code (the default), or kept on this phone. Nothing about photos when there are none.
 */
function answerFor(scope: ShareScope, withResults: boolean, photos: 'sent' | 'kept' | 'none') {
  const kit = photos === 'sent' ? ' Your kit photos go with it.' : photos === 'kept' ? ' Your kit photos stay on this phone.' : '';
  if (scope === 'noresults') return `Protocol and plan only. The results stay here.${kit}`;
  if (scope === 'protocol') return `${withResults ? 'Just the protocol. Your plan and results stay here.' : 'Just the protocol. Your plan stays here.'}${kit}`;
  return withResults
    ? `A labmate scans this to get the same setup: the protocol, your plan and these results.${kit}`
    : `A labmate scans this to get the same setup: the protocol and your plan.${kit}`;
}

/**
 * Share-QR: the run as a code a labmate scans with the iPhone camera (it opens /import?s=<id>). What travels is
 * listed under it, and replying trims it: tap "Without the results" or "Just the protocol", or say it. Each trim is
 * its own share on the server, so what was left out never leaves this phone. The kit photos go along unless "Without
 * the photos" is on (10/28: sent by default). Save image keeps the code as a PNG; Add to library marks the protocol for
 * the shared library (Soon).
 *
 * For design review a trim opens from the address: ?scope=noresults|protocol.
 */
export function ShareScreen() {
  useFace('wink');
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<ShareScope>(() => {
    const asked = params.get('scope') as ShareScope | null;
    return asked && SCOPES.includes(asked) ? asked : 'all';
  });
  useEffect(() => {
    if (params.has('scope')) setParams({}, { replace: true });
  }, []);

  const protocolId = useRun(s => s.protocolId);
  const procedure = useRun(s => s.procedure);
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const standardReplicates = useRun(s => s.standardReplicates);
  const standards = useRun(s => s.standards);
  const readings = useRun(s => s.readings);
  const readingsFrom = useRun(s => s.readingsFrom);
  const photos = useRun(s => s.photos);
  const { protocol, error } = useProtocol(protocolId);
  const withResults = hasResults({ readings });
  const shown: ShareScope = scope === 'noresults' && !withResults ? 'all' : scope;
  const [sendPhotos, setSendPhotos] = useState(true);
  const hasPhotos = protocol ? protocol.components.some(c => photos[c.id]) : false;
  const photoState = !hasPhotos ? 'none' : sendPhotos ? 'sent' : 'kept';

  const setup = useMemo(
    () => {
      if (!protocol) return null;
      const run = { protocolId, procedure, samples, replicates, standardReplicates, standards, readings, photos };
      // Chapp's example readings travel marked as such, so the labmate's phone labels them "Sample data" too.
      return buildShare(
        shown,
        run,
        protocol,
        { r2: standardR2(protocol, run), sampleData: readingsFrom === 'sample' },
        { photos: sendPhotos, from: userName },
      );
    },
    [protocol, shown, protocolId, procedure, samples, replicates, standardReplicates, standards, readings, readingsFrom, photos, sendPhotos],
  );
  const { link, previous, failed, retry } = useShareLink(setup);

  // What was said on this screen and went to Chapp (not a trim): its answer shows until the next trim.
  const { turn, send } = useConverse('share');
  const [talked, setTalked] = useState(false);
  const reply = talked && turn ? (turn.phase === 'reply' ? turn.say : turn.phase === 'error' ? ERROR_LINE : null) : null;

  const trim = (next: ShareScope, aloud = false) => {
    setTalked(false);
    setScope(next);
    if (aloud) void speak(answerFor(next, withResults, photoState)).catch(() => {});
  };
  const togglePhotos = (send: boolean, aloud = false) => {
    setTalked(false);
    setSendPhotos(send);
    if (aloud) void speak(answerFor(shown, withResults, send ? 'sent' : 'kept')).catch(() => {});
  };
  const heard = (text: string) => {
    const photosSaid = hasPhotos ? parsePhotos(text) : null;
    if (photosSaid !== null) return togglePhotos(photosSaid, true);
    const next = parseTrim(text);
    if (next) return trim(next === 'noresults' && !withResults ? 'all' : next, true);
    setTalked(true);
    void send(text);
  };

  const inLibrary = useSharedLibrary(s => (protocolId ? s.ids.includes(protocolId) : false));
  const addToLibrary = useSharedLibrary(s => s.add);
  const name = protocol ? shortName(protocol) : '';
  const image = useCodeImage(link?.url ?? null, name);
  const lines = setup && protocol ? travels(setup, protocol) : null;

  const replies = [
    ...(withResults ? [{ id: 'noresults' as const, t: 'Without the results' }] : []),
    { id: 'protocol' as const, t: 'Just the protocol' },
  ];

  return (
    <div className="relative h-full overflow-hidden bg-bg">
      <div className={PAGE}>
        <Answer>
          {!protocolId
            ? 'There is nothing to share yet. Find a protocol first.'
            : error
              ? error
              : (reply ?? answerFor(shown, withResults, photoState))}
        </Answer>

        {link ? (
          <Link
            to={`/import?s=${link.id}`}
            aria-label="The code; open what a labmate sees after scanning"
            className="mb-7 flex shrink-0 flex-col items-center gap-3 self-center no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-4"
          >
            <QrCode text={link.url} />
            <span className="text-[13px] leading-[18px] font-semibold text-text">Scan with Chapp</span>
          </Link>
        ) : previous && !failed ? (
          // The next trim's code is on its way: the last one stays in place, faded, so nothing jumps and it is not
          // mistaken for the new one.
          <div aria-label="Making the code" className="mb-7 flex shrink-0 flex-col items-center gap-3 self-center opacity-15">
            <QrCode text={previous.url} />
            <span className="text-[13px] leading-[18px] font-semibold text-text">Scan with Chapp</span>
          </div>
        ) : (
          <div className="mb-7 flex shrink-0 flex-col items-center gap-3 self-center">
            <button
              type="button"
              disabled={!failed}
              onClick={retry}
              aria-label={failed ? 'Make the code again' : 'Making the code'}
              className="flex size-[210px] items-center justify-center rounded-inner bg-sunken text-[15px] leading-5 font-semibold text-text outline-none focus-visible:ring-2 focus-visible:ring-blue"
            >
              {failed ? 'Try again' : ''}
            </button>
            <span className="text-[13px] leading-[18px] font-semibold text-text">{failed ? "I couldn't make the code" : 'Scan with Chapp'}</span>
          </div>
        )}

        {lines && (
          <section aria-label="What travels" className="mb-7 flex shrink-0 flex-col gap-2.5 px-1">
            <TravelList travels={lines} />
          </section>
        )}

        <div className="mt-auto flex shrink-0 flex-col gap-5">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 pl-1">
              {inLibrary ? (
                <p className={SAY}>
                  It is in the shared library; search <b className="font-bold">{name}</b>
                  {protocol && catalog(protocol) && (
                    <>
                      {' '}
                      or <b className="font-bold">{catalog(protocol)}</b>
                    </>
                  )}
                  .
                </p>
              ) : (
                <p className={SAY}>Send less?</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2 px-1">
              <div role="radiogroup" aria-label="What to send" className="flex flex-wrap gap-2">
                {replies.map(o => {
                  const on = shown === o.id;
                  return (
                    <button key={o.id} type="button" role="radio" aria-checked={on} onClick={() => trim(on ? 'all' : o.id)} className={chip(on)}>
                      {o.t}
                    </button>
                  );
                })}
              </div>
              {/* The photos are their own choice, with any trim: on by default, this keeps them here. */}
              {hasPhotos && (
                <button type="button" aria-pressed={!sendPhotos} onClick={() => togglePhotos(!sendPhotos)} className={chip(!sendPhotos)}>
                  Without the photos
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <button type="button" disabled={!image} onClick={() => image && saveImage(image)} className={PILL_LIGHT}>
              Save image
            </button>
            {inLibrary ? (
              <Link to="/library?view=shared" className={PILL_DARK}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                In the library
              </Link>
            ) : (
              <button type="button" disabled={!protocolId} onClick={() => protocolId && addToLibrary(protocolId)} className={PILL_DARK}>
                Add to library
              </button>
            )}
          </div>
        </div>
      </div>
      <ScreenBar onUtterance={heard} />
      {setup?.results?.sampleData && <SampleDataTag className={SAMPLE_TAG} />}
      <ChappHeader subtitle={name ? `${name} · Share` : 'Share'} back={{ to: '/results', label: 'Back to the results' }} />
    </div>
  );
}

const chip = (on: boolean) =>
  cn(
    'min-h-11 rounded-[22px] px-4 text-[15px] leading-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-2',
    on ? 'bg-ink text-white' : 'bg-white text-ink shadow-[0_1px_2px_rgba(17,17,19,0.06),0_2px_8px_rgba(17,17,19,0.04)]',
  );

/**
 * The link for this setup: posted once per distinct setup (each trim, each change to the plan) and remembered, so
 * flipping back to a trim shows the code it had.
 */
function useShareLink(setup: SharedSetup | null) {
  const key = setup ? JSON.stringify(setup) : '';
  const [ids, setIds] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const id = ids[key];
  const [previous, setPrevious] = useState<string | null>(null);
  useEffect(() => {
    if (id) setPrevious(id);
  }, [id]);

  useEffect(() => {
    if (!setup || id) return;
    const abort = new AbortController();
    setFailed(null);
    postShare(setup, abort.signal).then(
      got => setIds(all => ({ ...all, [key]: got })),
      () => !abort.signal.aborted && setFailed(key),
    );
    return () => abort.abort();
  }, [key, id, attempt]);

  return {
    link: id ? { id, url: shareLink(window.location.origin, id) } : null,
    previous: previous ? { id: previous, url: shareLink(window.location.origin, previous) } : null,
    failed: failed === key,
    retry: () => setAttempt(a => a + 1),
  };
}

/**
 * The code as a PNG file, made as soon as the code is: Safari only opens the share sheet straight from the tap, with no
 * waiting in between.
 */
function useCodeImage(url: string | null, name: string) {
  const [image, setImage] = useState<{ url: string; file: File } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    qrPng(url).then(png => live && setImage({ url, file: new File([png], `Chapp ${name || 'setup'} code.png`, { type: 'image/png' }) }));
    return () => {
      live = false;
    };
  }, [url, name]);
  return image && image.url === url ? image.file : null;
}

/** Save image: the share sheet where the phone has one for files (iPhone: Save Image), otherwise a download. */
async function saveImage(file: File) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch {
      // Closing the share sheet is not an error.
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast('Saved the code');
}
