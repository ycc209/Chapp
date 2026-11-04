import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StandardsTable } from '../src/components/lab/StandardsTable.tsx';
import { halvingSeries } from '../src/components/lab/model.ts';

// The dilution table, the Standards step's in both layouts: gloves on it is only read; with the buttons (Run-Standards)
// a tap on a row ticks that vial, and the run page's own taps (right side Next, left Back) leave the row alone.

// Five standards: 2,000 halved to 250 and the blank, for duplicates of 25 µL.
const { vials } = halvingSeries(2000, 4, 2, 25);
const rows = (markup: string) => markup.match(/<div role="row"[^>]*>/g)!.slice(1);

describe('the standards table', () => {
  it('gloves on: rows that only read, the vial now in yellow', () => {
    const markup = renderToStaticMarkup(<StandardsTable vials={vials} done={{ A: true }} />);
    expect(rows(markup)).toHaveLength(5);
    expect(markup).not.toContain('data-own-tap');
    expect(markup).not.toContain('tabindex');
    expect(markup).toMatch(/aria-label="Vial B, [^"]*, now"/);
  });

  it('with the buttons: every row taps (and takes Enter), kept from the page’s Next and Back taps', () => {
    const markup = renderToStaticMarkup(<StandardsTable vials={vials} done={{}} onVial={() => {}} />);
    for (const row of rows(markup)) {
      expect(row).toContain('data-own-tap=""');
      expect(row).toContain('tabindex="0"');
      expect(row).toContain('cursor-pointer');
    }
  });
});
