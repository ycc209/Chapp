import { writeFileSync } from 'node:fs';
import { replyText } from '../../../server/ai/import.ts';
import { manualTextBlock, type Adapter, type CallOutcome, type CallRequest, type Manual } from '../core.ts';
import { metaFormat } from '../schema.ts';

type Json = Record<string, any>;

/** Meta's /responses, exactly as server/ai/import.ts calls it (input_file PDF or the manual's text, strict text.format). */
export function metaAdapter(apiKey: string, baseUrl = 'https://api.meta.ai/v1'): Adapter {
  const body = (req: CallRequest, manual: Manual, elide: boolean) => ({
    model: req.model,
    reasoning: { effort: req.effort },
    input: [
      { role: 'system', content: req.system },
      {
        role: 'user',
        content: [
          req.input === 'text'
            ? { type: 'input_text', text: elide ? `<manual text, ${manual.text.length} chars>` : manualTextBlock(manual) }
            : { type: 'input_file', filename: manual.filename, file_data: elide ? `<data:application/pdf;base64, ${manual.base64.length} chars>` : `data:application/pdf;base64,${manual.base64}` },
          { type: 'input_text', text: req.task },
        ],
      },
    ],
    text: { format: metaFormat(req.schemaName, req.schema) },
  });
  const scrub = (text: string) => text.split(apiKey).join('***').replace(/\s+/g, ' ').trim().slice(0, 300);

  return {
    provider: 'meta',
    vendor: 'Meta',
    build: (req, manual) => body(req, manual, true),
    async send(req, manual, { timeoutMs, rawPath }): Promise<CallOutcome> {
      const from = performance.now();
      const seconds = () => Math.round(performance.now() - from) / 1000;
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body(req, manual, false)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        const s = seconds();
        return { status: timedOut ? 'timeout' : 'error', seconds: s, apiSeconds: s, usage: null, error: timedOut ? `timed out after ${timeoutMs / 1000} s` : scrub(String(error)) };
      }
      const s = seconds();
      if (!res.ok) return { status: 'error', seconds: s, apiSeconds: s, usage: null, error: `${res.status}: ${scrub(text)}` };
      let reply: Json;
      try {
        reply = JSON.parse(text);
      } catch {
        return { status: 'error', seconds: s, apiSeconds: s, usage: null, error: 'reply is not JSON' };
      }
      writeFileSync(rawPath, JSON.stringify({ seconds: s, reply }, null, 2));
      const u = reply.usage ?? {};
      const usage = {
        input: u.input_tokens ?? 0,
        cachedInput: u.input_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
        output: u.output_tokens ?? 0,
        reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
      };
      const info = { status: reply.status, effort: reply.reasoning?.effort, model: reply.model, incomplete: reply.incomplete_details ?? undefined };
      if (reply.status === 'failed' || reply.error) return { status: 'error', seconds: s, apiSeconds: s, usage, error: scrub(JSON.stringify(reply.error ?? {})), info };
      if (reply.status === 'incomplete') return { status: 'incomplete', seconds: s, apiSeconds: s, usage, error: JSON.stringify(reply.incomplete_details ?? {}), info };
      try {
        return { status: 'ok', seconds: s, apiSeconds: s, usage, json: JSON.parse(replyText(reply)), info };
      } catch {
        return { status: 'bad-json', seconds: s, apiSeconds: s, usage, error: 'the reply is not the JSON asked for', info };
      }
    },
  };
}
