import { Link } from 'react-router';

/** A screen that is not built yet: its name and the design artboards it will follow. */
export function Placeholder({ title, boards }: { title: string; boards: string[] }) {
  return (
    <div className="flex h-full flex-col gap-4 px-7 pt-28 pb-10">
      <Link to="/" className="text-[15px] font-semibold text-blue">← Home</Link>
      <h1 className="text-[32px] leading-[38px] font-bold tracking-[-0.02em] text-ink">{title}</h1>
      <p className="text-muted">Coming in phase 1. Design artboards:</p>
      <ul className="flex flex-wrap gap-2">
        {boards.map(b => (
          <li key={b} className="rounded-chip bg-sunken px-2.5 py-1 text-[13px] font-medium text-text">{b}</li>
        ))}
      </ul>
    </div>
  );
}
