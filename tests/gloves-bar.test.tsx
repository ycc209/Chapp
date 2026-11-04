import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GlovesBar, HeardWords, heardTail } from '../src/screens/run/Gloves.tsx';

// Gloves on, what Chapp hears shows just above the Listening waveform: settled words in ink, the rest in grey. (The bar
// reads them from the session store, which a server render always sees empty: the words are checked on HeardWords.)

const words = (heard: string, interim: string, dark = false) => renderToStaticMarkup(<HeardWords heard={heard} interim={interim} dark={dark} />);

describe('the words heard, over the gloves bar', () => {
  it('shows what is heard, the words still being recognized in grey', () => {
    expect(words('vial C', 'is OK')).toBe(
      '<span data-heard="" class="m-0 max-w-[340px] text-center text-[20px] leading-[26px] font-semibold text-ink">vial C<span class="text-faint"> is OK</span></span>',
    );
    expect(words('vial C', 'is OK', true)).toContain('text-white">vial C<span class="text-white/60"> is OK</span>');
    expect(words('next', '')).toContain('>next</span>');
  });

  it('shows nothing when nothing is heard yet; the bar still says Listening or Tap to listen', () => {
    expect(words('', '')).toBe('');
    expect(renderToStaticMarkup(<GlovesBar listening onTap={() => {}} />)).toContain('>Listening</span>');
    expect(renderToStaticMarkup(<GlovesBar listening={false} onTap={() => {}} />)).toContain('>Tap to listen</span>');
  });

  it('keeps the latest words of a long sentence, cut at a word', () => {
    expect(heardTail('', '')).toBeNull();
    expect(heardTail('', 'next')).toEqual({ settled: '', interim: 'next' });
    expect(heardTail('next', '')).toEqual({ settled: 'next', interim: '' });
    const heard = 'I put twenty five microliters of standard A into A1 and A2 and then standard B into B1 and B2';
    const tail = heardTail(heard, 'and now C');
    expect(tail!.settled.startsWith('…')).toBe(true);
    expect(tail!.settled.length + tail!.interim.length).toBeLessThanOrEqual(91);
    expect(tail!.settled).toMatch(/^…\S/);
    expect(tail!.settled.endsWith('into B1 and B2')).toBe(true);
    expect(tail!.interim).toBe(' and now C');
  });
});
