import { useLocation, useNavigate } from 'react-router';
import { AmountCard, amountText, VialRack } from '../../components/lab/index.ts';
import { useProtocol } from '../../state/protocol.ts';
import { useRun } from '../../state/run.ts';
import { formatConcentration, shortName, splitName } from '../protocol/content.ts';
import { CloseIcon } from './icons.tsx';
import { planFor } from './plan.ts';

/**
 * Standards-2: the rack for this run and what goes into it, the stock and the diluent with the user's photos of the
 * bottles once the kit has been photographed. Opened from the amounts under Plan's rack.
 */
export function StandardsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const protocolId = useRun(s => s.protocolId) ?? 'pierce-bca';
  const procedure = useRun(s => s.procedure);
  const samples = useRun(s => s.samples);
  const replicates = useRun(s => s.replicates);
  const standardReplicates = useRun(s => s.standardReplicates);
  const standards = useRun(s => s.standards);
  const photos = useRun(s => s.photos);
  const { protocol, error } = useProtocol(protocolId);
  const v = protocol ? planFor(protocol, procedure, { samples, replicates, standardReplicates, standards }) : null;
  const ready = standards === 'ready';

  // Back where it was opened from; opened by address, to the plan.
  const close = () => (location.key !== 'default' ? navigate(-1) : navigate('/plan'));

  const stock = v?.stockPart;
  const diluent = v?.diluentPart;

  return (
    <div className="relative flex h-full flex-col gap-[18px] overflow-y-auto bg-bg px-5 pt-[calc(56px+var(--screen-top))] pb-[var(--screen-bottom)] [scrollbar-width:none]">
      <div className="flex shrink-0 flex-col gap-1 px-1">
        <p className="m-0 text-[13px] leading-[18px] font-medium text-text">{protocol && v ? `${shortName(protocol)} · ${v.procedure.name}` : ' '}</p>
        <h1 className="m-0 text-[30px] leading-9 font-bold tracking-[-0.02em] text-ink">Standards</h1>
      </div>
      {error && (
        <p role="alert" className="m-0 px-1 text-[17px] leading-6 font-medium text-ink">
          {error}
        </p>
      )}
      {v && <VialRack unit={v.series.unit} vials={v.series.vials} ready={ready ? { need: v.series.need } : undefined} className="shrink-0" />}
      {v && !ready && (
        <section aria-label="What goes into the vials" className="flex shrink-0 flex-col gap-2.5">
          {stock && (
            <AmountCard
              name={splitName(stock.name).name}
              detail={['Stock', stock.concentration && formatConcentration(stock.concentration)].filter(Boolean).join(' · ')}
              amount={amountText(v.series.stock)}
              photo={photos[stock.id]}
              matched={Boolean(photos[stock.id])}
            />
          )}
          {diluent && (
            <AmountCard
              name={splitName(diluent.name).name}
              detail={v.diluentNote || 'Diluent'}
              amount={amountText(v.series.diluent)}
              photo={photos[diluent.id]}
              matched={Boolean(photos[diluent.id])}
            />
          )}
        </section>
      )}
      {v && ready && <p className="m-0 px-1 text-[15px] leading-[22px] text-text">Already made: the run skips making them.</p>}
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="absolute top-[calc(56px+var(--screen-top))] right-5 flex size-11 items-center justify-center rounded-full text-ink outline-none focus-visible:ring-2 focus-visible:ring-blue"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
