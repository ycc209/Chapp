import { describe, expect, it, vi } from 'vitest';
import { createScientificResearch, reviewScientificAnswer } from '../server/ai/science.ts';
import { EvidenceRegistry } from '../server/ai/evidence.ts';
import type { ReadDocument } from '../server/ai/sourceReader.ts';
import { UpstreamError } from '../server/ai/provider.ts';

type Json = Record<string, any>;
const message = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const answer = (body: unknown) => ({ id: 'review-final', status: 'completed', output: [message(JSON.stringify(body))] });
const document = (url: string, text = `Original method ${new URL(url).pathname} describes the assay controls and their limitations.`): ReadDocument => ({ url, title: 'Original method', format: 'html', pages: [{ text }], fetchedAt: '2026-10-31T00:00:00Z' });
const search = (urls: string[], query = 'assay controls') => ({ type: 'web_search_call', action: { type: 'search', query }, results: urls.map(url => ({ url, title: 'Original method', snippet: 'Discovery snippet, not original document text.' })) });

describe('scientific source discovery and reading', () => {
  it('starts every candidate read at once and keeps the first three distinct documents to arrive; a slow page never holds the turn', async () => {
    const groups = [['https://example.org/a1', 'https://example.org/a2'], ['https://example.org/b1', 'https://example.org/b2'], ['https://example.org/c1', 'https://example.org/c2']];
    const respond = vi.fn(async (_body: Json) => ({ status: 'completed', output: [...groups.map((urls, i) => search(urls, `part ${i}`)), message('UNREAD MODEL ESSAY MUST NOT PASS THROUGH')] }));
    const gates = new Map<string, () => void>();
    const read = vi.fn(async (url: string) => {
      if (url.endsWith('a1')) throw new Error('Original page unavailable');
      // b1 and c1 are slow pages: they arrive only when the test lets them.
      if (url.endsWith('1')) await new Promise<void>(resolve => { gates.set(url, resolve); });
      return document(url);
    });
    const registry = new EvidenceRegistry();
    // Round-robin across the searches, all six under way at once.
    const evidence = await createScientificResearch(respond, read)('Check all three parts of this scientific question.', {}, 30_000, registry);
    expect(read.mock.calls.map(c => c[0])).toEqual([groups[0][0], groups[1][0], groups[2][0], groups[0][1], groups[1][1], groups[2][1]]);
    // a1 failed at once; a2, b2 and c2 arrived; b1 and c1 were still on their way and were let go.
    expect(registry.list().filter(s => s.status === 'read').map(s => s.url)).toEqual([groups[0][1], groups[1][1], groups[2][1]]);
    expect(registry.list().find(s => s.url === groups[0][0])?.status).toBe('searched');
    expect(registry.list().find(s => s.url === groups[1][0])?.status).toBe('searched');
    for (const release of gates.values()) release();
    expect(evidence.data).toMatchObject({ readFailures: [{ sourceId: 'S1', reason: 'Original page unavailable' }] });
    expect(JSON.stringify(evidence.data)).not.toContain('UNREAD MODEL ESSAY');
    expect((evidence.data as Json).report).toBeUndefined();
    expect((evidence.data as Json).excerpts).toHaveLength(3);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('returns an honest verification limitation when discovery finds no original source', async () => {
    const respond = vi.fn(async () => ({ status: 'completed', output: [message('This generated scientific assertion was not supported by discovery.')] }));
    const read = vi.fn(async (url: string) => document(url));
    const result = await createScientificResearch(respond, read)('Explain the evidence.', {}, 30_000, new EvidenceRegistry());
    expect(read).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ sources: [], excerpts: [], limitation: expect.stringContaining('No original document could be read') });
    expect(JSON.stringify(result.data)).not.toContain('generated scientific assertion');
  });

  it('does not count mirrored documents as independent reads and stops after six attempts', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://example.org/document-${i + 1}`);
    const respond = vi.fn(async () => ({ status: 'completed', output: [search(urls)] }));
    const read = vi.fn(async (url: string) => document(url, urls.indexOf(url) < 5 ? 'The same original text is mirrored on several pages.' : `Independent original method ${url.split('-').at(-1)}.`));
    const registry = new EvidenceRegistry();
    await createScientificResearch(respond, read)('Compare the evidence.', {}, 30_000, registry);
    expect(read.mock.calls.map(c => c[0])).toEqual(urls.slice(0, 6));
    expect(registry.list().find(s => s.url === urls[6])?.status).toBe('searched');
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('keeps failed documents as searched, without upgrading snippets into evidence', async () => {
    const respond = vi.fn(async () => ({ status: 'completed', output: [search(['https://example.org/blocked'])] }));
    const read = vi.fn(async () => { throw new Error('HTTP 403'); });
    const registry = new EvidenceRegistry();
    const result = await createScientificResearch(respond, read)('Explain the evidence.', {}, 30_000, registry);
    expect(result.data).toMatchObject({ sources: [{ status: 'searched' }], excerpts: [], readFailures: [{ reason: 'HTTP 403' }], limitation: expect.any(String) });
  });

  it('rejects an incomplete discovery response before attempting document reads', async () => {
    const respond = vi.fn(async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [search(['https://example.org/partial'])] }));
    const read = vi.fn(async (url: string) => document(url));
    await expect(createScientificResearch(respond, read)('Question', {}, 30_000, new EvidenceRegistry())).rejects.toThrow(UpstreamError);
    expect(read).not.toHaveBeenCalled();
  });
});

const exact = 'Dye-based assays report double-stranded DNA fluorescence.';
function ready() {
  const registry = new EvidenceRegistry();
  const source = registry.register([[{ url: 'https://example.org/original-method?version=2', title: 'Original method' }]])[0]!;
  const read = registry.attach(source.id, { ...document(source.url, exact + ' Interpretation requires appropriate assay controls.'), format: 'pdf', pages: [{ page: 3, text: exact + ' Interpretation requires appropriate assay controls.' }] });
  return { registry, ref: read.excerpts[0]!.id, url: source.url };
}

describe('paragraph-level scientific evidence review', () => {
  it('preserves supported paragraphs and labels inference while rejecting bad IDs, fabricated quotations and duplicate paragraph IDs', async () => {
    const { registry, ref, url } = ready();
    const respond = vi.fn(async () => answer({ paragraphs: [
      { id: 'good', text: exact, kind: 'supported' },
      { id: 'bad-id', text: 'This paragraph uses an invented source.', kind: 'supported' },
      { id: 'bad-quote', text: 'This paragraph invents an exact quotation.', kind: 'supported' },
      { id: 'infer', text: '這項訊號仍需要結合控制組判讀。', kind: 'inference' },
      { id: 'good', text: 'Duplicate paragraph must not survive.', kind: 'context' },
    ], citations: [
      { paragraphId: 'good', ref, quote: exact },
      { paragraphId: 'bad-id', ref: 'S999:P3:1', quote: exact },
      { paragraphId: 'bad-quote', ref, quote: 'Every late signal proves contamination.' },
      { paragraphId: 'infer', ref, quote: 'Interpretation requires appropriate assay controls.' },
    ] }));
    const result = await reviewScientificAnswer(respond, { question: '晚期訊號代表什麼？', draft: 'Draft awaiting review.', registry, live: {}, milliseconds: 30_000 });
    expect(result.rejectedParagraphs).toBe(3);
    expect(result.say).toContain(exact);
    expect(result.say).toContain('推論：');
    expect(result.say).not.toContain('invented source');
    expect(result.say).not.toContain('invents an exact quotation');
    expect(result.say).not.toContain('Duplicate paragraph');
    expect(result.sources).toEqual([expect.objectContaining({ url, page: 3, quote: 'Interpretation requires appropriate assay controls.' })]);
    expect(result.say.match(/\[S1 · p\. 3\]/g)).toHaveLength(2);
  });

  it('does not accept scientific paragraphs without a checked quote or expose reviewer-written URLs', async () => {
    const { registry, ref } = ready();
    const respond = vi.fn(async () => answer({ paragraphs: [
      { id: 'unsupported', text: 'An unsupported scientific conclusion.', kind: 'supported' },
      { id: 'unchecked-inference', text: 'An unsupported inference.', kind: 'inference' },
      { id: 'good', text: `${exact} [Injected link](https://invented.example/fake) [[S999]]`, kind: 'supported' },
    ], citations: [{ paragraphId: 'good', ref, quote: exact }] }));
    const result = await reviewScientificAnswer(respond, { question: 'Explain the finding.', draft: '', registry, live: {}, milliseconds: 30_000 });
    expect(result.rejectedParagraphs).toBe(2);
    expect(result.say).not.toContain('unsupported scientific');
    expect(result.say).not.toContain('unsupported inference');
    expect(result.say).not.toContain('https://invented.example');
    expect(result.say).not.toContain('S999');
    expect(result.say).toContain(exact);
  });

  it('explains the verification gap when the reviewer provides no supported answer', async () => {
    const result = await reviewScientificAnswer(async () => answer({ paragraphs: [], citations: [] }), { question: 'What can be concluded?', draft: '', registry: new EvidenceRegistry(), live: {}, milliseconds: 30_000 });
    expect(result.say).toContain('does not yet support a verified answer');
    expect(result.sources).toEqual([]);
  });

  it.each([
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message('partial')] },
    { status: 'failed', error: { message: 'Review failed' }, output: [] },
    { status: 'completed', output: [] },
  ])('rejects incomplete, failed or absent reviewer responses', async response => {
    await expect(reviewScientificAnswer(async () => response, { question: 'Question', draft: 'Draft', registry: new EvidenceRegistry(), live: {}, milliseconds: 30_000 })).rejects.toThrow();
  });
});
