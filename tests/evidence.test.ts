import { describe, expect, it } from 'vitest';
import { EvidenceRegistry, candidatesFromResponse, type ReadDocument } from '../server/ai/evidence.ts';

const url = (n: number) => `https://example.org/source-${n}`;
const candidate = (n: number) => ({ url: url(n), title: `Source ${n}`, snippet: `Search summary ${n}` });
const document = (sourceUrl = url(1), pages = [{ page: 1, text: 'The original source describes DNA purification.' }]): ReadDocument => ({
  url: sourceUrl, title: 'Original document', format: 'pdf', fetchedAt: '2026-10-31T00:00:00.000Z', pages,
});
const read = (registry: EvidenceRegistry, n = 1, text = 'The original source describes DNA purification.') => {
  const source = registry.register([[candidate(n)]])[0]!;
  return registry.attach(source.id, document(url(n), [{ page: 1, text }]));
};

describe('program-owned source registry', () => {
  it('takes turns across searches instead of filling the candidate budget from the first search', () => {
    const registry = new EvidenceRegistry();
    const sources = registry.register([
      { title: 'First query', candidates: [candidate(1), candidate(2), candidate(3), candidate(4)] },
      { title: 'Second query', candidates: [candidate(5), candidate(6)] },
      { title: 'Third query', candidates: [candidate(7), candidate(8)] },
    ], 5);
    expect(sources.map(s => s.url)).toEqual([url(1), url(5), url(7), url(2), url(6)]);
    expect(sources[1]!.groups).toEqual([{ index: 1, title: 'Second query' }]);
  });

  it('deduplicates across groups without consuming their quota and keeps IDs across calls', () => {
    const registry = new EvidenceRegistry();
    const sources = registry.register([[candidate(1), candidate(2)], [candidate(1), candidate(3)]], 2);
    expect(sources.map(s => s.url)).toEqual([url(1), url(3)]);
    expect(registry.get('S1')!.groups.map(g => g.index)).toEqual([0, 1]);
    const again = registry.register([[{ ...candidate(1), url: `${url(1)}#section`, groupIndex: 4, groupTitle: 'Follow-up' }]])[0]!;
    expect(again).toMatchObject({ id: 'S1', url: url(1), status: 'searched' });
    expect(again.groups).toContainEqual({ index: 4, title: 'Follow-up' });
    again.url = 'https://changed.example.org';
    expect(registry.get('S1')!.url).toBe(url(1));
  });

  it('registers tool result groups and citation metadata, never generated prose links', () => {
    const body = { output: [
      { type: 'web_search_call', action: { query: 'DNA' }, results: [candidate(1), { url: 'javascript:alert(1)' }] },
      { type: 'web_search_call', action: { queries: ['PCR inhibitors'] }, results: [candidate(2)] },
      { type: 'web_search_call', status: 'failed', action: { type: 'open_page', url: url(99) } },
      { type: 'message', content: [{ type: 'output_text', text: `[Invented](${url(100)})`, annotations: [{ type: 'url_citation', url: url(3), title: 'API citation' }] }] },
    ] };
    const registry = new EvidenceRegistry();
    expect(candidatesFromResponse(body).map(g => g.title)).toEqual(['DNA', 'PCR inhibitors', 'API citation metadata']);
    expect(registry.registerResponse(body).map(s => s.url)).toEqual([url(1), url(2), url(3)]);
    expect(registry.list().every(s => s.status === 'searched')).toBe(true);
  });

  it('rejects unsafe/invalid candidate URLs and handles empty budgets', () => {
    const registry = new EvidenceRegistry();
    expect(registry.register([[{ url: 'javascript:alert(1)' }, { url: 'https://name:secret@example.org' }, { url: 'https://example.org\nforged' }]])).toEqual([]);
    expect(registry.register([[candidate(1)]], 0)).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('preserves the original URL through redirects and assigns stable page/excerpt IDs', () => {
    const registry = new EvidenceRegistry();
    registry.register([[candidate(1)]]);
    const attached = registry.attach('S1', document('https://cdn.example.org/redirected.pdf', [
      { page: 3, text: 'First paragraph.\n\nSecond paragraph.' }, { page: 5, text: 'Another page.' },
    ]));
    expect(attached).toMatchObject({ id: 'S1', url: url(1), status: 'read', document: { url: 'https://cdn.example.org/redirected.pdf' } });
    expect(attached.excerpts.map(e => e.id)).toEqual(['S1:P3:1', 'S1:P3:2', 'S1:P5:1']);
    expect(registry.renderCitations('Evidence [[S1:P3:2]].')).toMatchObject({ text: `Evidence [S1 · p. 3](${url(1)}#page=3).`, sources: [{ url: url(1), page: 3 }] });
  });

  it('does not invent page numbers for HTML and rejects empty reads', () => {
    const registry = new EvidenceRegistry();
    registry.register([[candidate(1), candidate(2)]]);
    const attached = registry.attach('S1', { ...document(), format: 'html', pages: [{ text: 'An HTML paragraph.' }] });
    expect(attached.excerpts[0]).toEqual({ id: 'S1:P1:1', sourceId: 'S1', text: 'An HTML paragraph.' });
    expect(registry.renderCitations('[[S1:P1:1]]').text).toBe(`[S1](${url(1)})`);
    expect(() => registry.attach('S2', document(url(2), [{ page: 1, text: '  ' }]))).toThrow('no readable text');
    expect(registry.get('S2')!.status).toBe('searched');
  });

  it('bounds sources without reusing expired IDs and bounds read documents separately', () => {
    const registry = new EvidenceRegistry({ maxSources: 2, maxDocuments: 1 });
    read(registry, 1); read(registry, 2);
    expect(registry.get('S1')).toMatchObject({ status: 'searched', excerpts: [] });
    expect(registry.get('S1')!.document).toBeUndefined();
    expect(registry.get('S2')!.status).toBe('read');
    const third = registry.register([[candidate(3)]])[0]!;
    expect(third.id).toBe('S3');
    expect(registry.get('S1')).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
    expect(registry.renderCitations('[[S1]]').issues[0]!.code).toBe('unknown_reference');
  });

  it('bounds total read text and discloses document truncation', () => {
    const registry = new EvidenceRegistry({ maxReadChars: 20 });
    read(registry, 1, 'a'.repeat(12)); read(registry, 2, 'b'.repeat(12));
    expect(registry.get('S1')!.status).toBe('searched');
    const source = read(registry, 3, 'c'.repeat(50));
    expect(source.document).toMatchObject({ truncated: true, pages: [{ text: 'c'.repeat(20) }] });
    expect(registry.list().filter(s => s.status === 'read')).toHaveLength(1);
  });
});

describe('read evidence selection and exact quotations', () => {
  it('ranks Chinese/English text and takes turns across sources and pages', () => {
    const registry = new EvidenceRegistry();
    registry.register([[candidate(1), candidate(2)]]);
    registry.attach('S1', document(url(1), [
      { page: 1, text: 'Administrative contacts.' },
      { page: 3, text: 'DNA PCR 樣本的基質抑制。\n\nMore PCR 樣本的基質抑制。' },
      { page: 4, text: 'PCR 樣本的基質抑制。' },
    ]));
    registry.attach('S2', document(url(2), [{ page: 8, text: 'DNA PCR 另一些基質抑制的證據。' }]));
    const selected = registry.selectExcerpts('DNA PCR 樣本 基質抑制', { limit: 3 });
    expect(selected.map(e => e.id)).toEqual(['S1:P3:1', 'S2:P8:1', 'S1:P4:1']);
    expect(registry.selectExcerpts('DNA', { maxChars: 24 }).reduce((sum, e) => sum + e.text.length, 0)).toBeLessThanOrEqual(24);
  });

  it('uses actual English search queries to retrieve late-page evidence for a Chinese question', () => {
    const registry = new EvidenceRegistry();
    registry.register([{ title: 'SYBR Green qPCR NTC primer-dimer melt curve analysis manufacturer manual', candidates: [candidate(1)] }]);
    registry.attach('S1', document(url(1), [
      { page: 1, text: 'SYBR Green qPCR\nNTC primer-dimer melt curve analysis\nManufacturer manual\n2026' },
      { page: 2, text: 'Contents\nSYBR Green qPCR NTC ........ 10\nPrimer-dimer melt curve analysis ........ 35' },
      ...Array.from({ length: 6 }, (_, i) => ({ page: i + 3, text: 'SYBR Green qPCR manufacturer manual. Storage and ordering information.' })),
      { page: 35, text: 'A signal in the NTC may result from primer-dimer formation. Compare the melt curve with the sample to distinguish these products.' },
    ]));
    const prompt = registry.promptEvidence('我的 qPCR 陰性對照在很晚才出現訊號，應該如何排查？', { limit: 3 });
    expect(prompt.excerpts[0]!.id).toBe('S1:P35:1');
    expect(prompt.sources[0]).toMatchObject({ host: 'example.org' });
    expect(JSON.stringify(prompt.sources)).not.toContain('https://');
  });

  it('gives identical mirror documents one selection turn while retaining both citation IDs', () => {
    const registry = new EvidenceRegistry();
    registry.register([[candidate(1), candidate(2), candidate(3)]]);
    const pages = [{ page: 1, text: 'DNA purification uses controls.' }, { page: 2, text: 'DNA purification also requires clean equipment.' }];
    registry.attach('S1', document(url(1), pages));
    registry.attach('S2', document(url(2), pages.map(page => ({ ...page, text: page.text.replaceAll(' ', '\n') }))));
    registry.attach('S3', document(url(3), [{ page: 7, text: 'DNA measurements need an independent reference.' }]));
    expect(registry.selectExcerpts('DNA purification', { limit: 3 }).map(e => e.id)).toEqual(['S1:P1:1', 'S3:P7:1', 'S1:P2:1']);
    expect(registry.get('S2')!.status).toBe('read');
    expect(registry.renderCitations('[[S2:P1:1]]').sources).toEqual([{ url: url(2), title: 'Original document', page: 1 }]);
  });

  it('shows read/search status and selected text without giving the model citation URLs', () => {
    const registry = new EvidenceRegistry();
    read(registry); registry.register([[candidate(2)]]);
    const prompt = registry.promptEvidence('DNA');
    expect(prompt.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'S1', status: 'read' }), expect.objectContaining({ id: 'S2', status: 'searched', searchSummary: 'Search summary 2' })]));
    expect(JSON.stringify(prompt)).not.toContain('https://');
    expect(prompt.note).toContain('does not establish');
  });

  it('checks quotes only against the referenced read text, with whitespace normalization', () => {
    const registry = new EvidenceRegistry();
    registry.register([[candidate(1), candidate(2)]]);
    registry.attach('S1', document(url(1), [{ page: 1, text: 'DNA\n  purification uses\tcontrols.' }, { page: 2, text: 'A separate paragraph.' }]));
    expect(registry.checkQuote('S1:P1:1', 'DNA purification uses controls.')).toEqual({ ok: true });
    expect(registry.checkQuote('S1', 'DNA purification uses controls.')).toEqual({ ok: true });
    for (const quote of ['dna purification uses controls.', 'DNA … controls.', 'DNA purification proves reliability.']) {
      expect(registry.checkQuote('S1:P1:1', quote).issue?.code).toBe('quote_not_found');
    }
    expect(registry.checkQuote('S1:P2:1', 'DNA purification').ok).toBe(false);
    expect(registry.checkQuote('S2', 'Search summary 2').issue?.code).toBe('unread_source');
    expect(registry.checkQuote('S1:P99:1', 'DNA').issue?.code).toBe('unknown_reference');
    expect(registry.checkQuote('S1', ' ').issue?.code).toBe('empty_quote');
  });
});

describe('source ID rendering without all-or-nothing rejection', () => {
  it('keeps valid citations and prose while reporting every unknown reference/link', () => {
    const registry = new EvidenceRegistry(); read(registry);
    const result = registry.renderCitations(`A supported passage [[S1:P1:1]]. An ordinary explanation. Unknown [[S99]]. [Unregistered paper](https://invented.invalid/paper).`);
    expect(result.text).toContain(`[S1 · p. 1](${url(1)}#page=1)`);
    expect(result.text).toContain('An ordinary explanation.');
    expect(result.text).toContain('Unregistered paper.');
    expect(result.text).not.toContain('invented.invalid');
    expect(result.sources).toHaveLength(1);
    expect(result.issues.map(i => i.code)).toEqual(['unknown_reference', 'unregistered_url']);
  });

  it('does not convert search-only sources to read evidence, but permits clearly marked document links', () => {
    const registry = new EvidenceRegistry(); registry.register([[candidate(1)]]);
    const blocked = registry.renderCitations('[[S1]]');
    expect(blocked.text).not.toContain('https://');
    expect(blocked.sources).toEqual([]);
    expect(blocked.issues[0]!.code).toBe('unread_source');
    const linked = registry.renderCitations('[[S1]]', { allowUnreadLinks: true });
    expect(linked.text).toBe(`[S1 · search result](${url(1)})`);
    expect(linked.sources[0]!.title).toContain('not read');
    expect(registry.get('S1')!.status).toBe('searched');
  });

  it('neutralizes unregistered bare/autolinks and uses registry metadata for known URLs', () => {
    const registry = new EvidenceRegistry(); read(registry);
    const result = registry.renderCitations(`Unknown https://invented.invalid/paper. <https://other.invalid>. [Invented title](${url(1)}).`);
    expect(result.text).toContain('`https://invented.invalid/paper`.');
    expect(result.text).toContain('`https://other.invalid`');
    expect(result.text).toContain(`[S1](${url(1)})`);
    expect(result.text).not.toContain('Invented title');
    expect(result.issues.filter(i => i.code === 'unregistered_url')).toHaveLength(2);
    const nested = registry.renderCitations('[see [another](https://nested.invalid)](https://outer.invalid)');
    expect(nested.text).toBe('`see [another](https://nested.invalid)`');
    expect(nested.sources).toEqual([]);
  });

  it('preserves fenced/inline code and explicitly identified user quotation examples', () => {
    const registry = new EvidenceRegistry(); read(registry);
    const quoted = '> You wrote [an example](https://user.example.invalid), not a reference.';
    const codeBlock = '```js\nconst sample = "[[S99]] https://example.invalid/code";\n```';
    const text = `${codeBlock}\nUse \`[[S99]]\` or \`https://example.invalid\` in your test.\n${quoted}\nActual citation [[S1]].`;
    const result = registry.renderCitations(text, { quotedUserText: [quoted] });
    expect(result.text).toContain(codeBlock);
    expect(result.text).toContain('`[[S99]]` or `https://example.invalid`');
    expect(result.text).toContain(quoted);
    expect(result.text).toContain(`[S1](${url(1)})`);
    expect(result.issues).toEqual([]);
  });

  it('can reject model-written URLs even when registered, keeping only explicitly checked ID citations', () => {
    const registry = new EvidenceRegistry(); read(registry, 1); read(registry, 2);
    const result = registry.renderCitations(`Checked [[S1]]. [An extra source](${url(2)}). Bare ${url(2)}. Unregistered [another](https://invented.invalid).`, { allowRawLinks: false });
    expect(result.text).toContain(`[S1](${url(1)})`);
    expect(result.text).toContain('An extra source.');
    expect(result.text).toContain(`Bare \`${url(2)}\`.`);
    expect(result.text).not.toContain(`](${url(2)})`);
    expect(result.sources.map(s => s.url)).toEqual([url(1)]);
    expect(result.issues.map(i => i.code)).toEqual(['raw_url', 'raw_url']);
    expect(registry.renderCitations(`Example \`${url(2)}\`.`, { allowRawLinks: false }).issues).toEqual([]);
  });

  it('escapes parentheses in rendered URLs without rewriting the stored destination', () => {
    const registry = new EvidenceRegistry(), original = 'https://example.org/paper(2022).pdf';
    registry.register([[{ url: original }]]); registry.attach('S1', document(original));
    const rendered = registry.renderCitations('[[S1]]');
    expect(rendered.text).toBe('[S1](https://example.org/paper%282022%29.pdf)');
    expect(rendered.sources[0]!.url).toBe(original);
    expect(registry.renderCitations(rendered.text)).toEqual(rendered);
  });
});
