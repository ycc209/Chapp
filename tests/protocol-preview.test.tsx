import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolIntro, ProtocolPreview } from '../shared/ai.ts';
import { ProgressiveOverview } from '../src/screens/protocol/Body.tsx';
import { executeAssistantAction, resetAssistantActions } from '../src/state/assistantActions.ts';
import { useRun } from '../src/state/run.ts';

const intro: ProtocolIntro = {
  title: 'Example enzyme kit', summary: 'An enzyme converts the substrate to a coloured product.',
  kit: { name: 'Example enzyme kit', vendor: 'Example', catalogs: ['E100'] },
  source: { title: 'Example manual', publisher: 'Example', docId: 'E100', revision: '1', url: 'https://example.org/manual.pdf' },
  overview: { steps: ['Add substrate.', 'Measure the colour.'], cite: { page: 2 } },
  procedure: { name: 'Assay', steps: [], others: [] },
  contents: [{ name: 'Substrate', amount: '2 mL' }],
};

let store: typeof import('../src/state/protocolPreview.ts').useProtocolPreviews;
beforeAll(async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  store = (await import('../src/state/protocolPreview.ts')).useProtocolPreviews;
});
beforeEach(() => { store.setState({ previews: {} }); resetAssistantActions(); });

describe('isolated manual preview events', () => {
  it('keeps an early intro and source when the full read fails, and persists the usable partial', () => {
    store.getState().receive({ id: 'one', state: 'reading', title: intro.title, source: { url: intro.source.url }, intro, progress: ['Found the manual'] });
    store.getState().receive({ id: 'one', state: 'error', error: 'The detailed read failed.', progress: ['Reading the steps'] });
    expect(store.getState().previews.one).toMatchObject({ state: 'error', intro, source: { url: intro.source.url }, progress: ['Found the manual', 'Reading the steps'] });
    expect(JSON.parse(sessionStorage.getItem('chapp.protocol.previews')!).state.previews.one.intro).toEqual(intro);
  });

  it('merges sparse ready events and ignores late progress state regressions', () => {
    store.getState().receive({ id: 'one', state: 'reading', intro, progress: ['Reading'] });
    store.getState().receive({ id: 'one', state: 'ready', protocolId: 'example-enzyme', title: 'Final title' });
    store.getState().receive({ id: 'one', state: 'reading', progress: ['Old progress'], title: 'Old title', intro: { ...intro, summary: 'An earlier incomplete summary.' } });
    expect(store.getState().previews.one).toMatchObject({ state: 'ready', title: 'Final title', protocolId: 'example-enzyme', intro, progress: ['Reading'] });
  });

  it('bounds the cache without dropping the preview most recently updated', () => {
    for (let n = 0; n < 12; n++) store.getState().receive({ id: `p${n}`, state: 'reading' });
    store.getState().receive({ id: 'p0', state: 'ready', protocolId: 'example-enzyme' });
    store.getState().receive({ id: 'p12', state: 'reading' });
    expect(Object.keys(store.getState().previews)).toHaveLength(12);
    expect(store.getState().previews.p0?.state).toBe('ready');
    expect(store.getState().previews.p1).toBeUndefined();
  });

  it('keeps partial content after reload without claiming the disconnected read is still running', async () => {
    store.getState().receive({ id: 'one', state: 'reading', intro });
    await store.persist.rehydrate();
    expect(store.getState().previews.one).toMatchObject({ state: 'error', intro });
    expect(store.getState().previews.one?.error).toContain('reloaded');
  });

  it('does not mutate the current experiment when events arrive or a preview action targets its layout', async () => {
    const before = useRun.getState().samples;
    store.getState().receive({ id: 'one', state: 'ready', protocolId: 'example-enzyme' });
    const receipt = await executeAssistantAction({ type: 'setSamples', samples: before + 1 }, {
      callId: 'preview-layout', context: { screen: 'protocol-preview', previewProtocolId: 'example-enzyme' }, protocol: null, navigate: vi.fn(),
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.message).toContain('preview');
    expect(useRun.getState().samples).toBe(before);
  });
});

describe('progressive overview sections', () => {
  const render = (preview: ProtocolPreview, open: 'kit' | 'principle' | '' = '') => renderToStaticMarkup(<ProgressiveOverview preview={preview} open={open} onOpen={() => {}} />);

  it('shows all four section headings before the introduction arrives', () => {
    const html = render({ id: 'one', state: 'reading', title: 'Selected manual' });
    for (const heading of ['At a glance', 'In the kit', 'Steps', 'Principle']) expect(html).toContain(heading);
    expect(html).toContain('Reading the overview');
    expect(html).not.toContain('Pierce');
  });

  it('shows kit contents with no early steps and keeps them visible after a read error', () => {
    const html = render({ id: 'one', state: 'error', intro, error: 'Unavailable' }, 'kit');
    expect(html).toContain('Substrate');
    expect(html).toContain('2 mL');
    expect(html).toContain('Add substrate.');
    expect(html).not.toContain('Reading the overview');
    expect(html).not.toContain('Photograph your kit');
  });

  it('uses the available introductory explanation in Principle while the full read continues', () => {
    expect(render({ id: 'one', state: 'reading', intro }, 'principle')).toContain(intro.summary);
  });
});
