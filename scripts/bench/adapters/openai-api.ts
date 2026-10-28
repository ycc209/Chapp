import { writeFileSync } from 'node:fs';
import OpenAI from 'openai';
import { manualTextBlock, type Adapter, type CallOutcome, type CallRequest, type Manual } from '../core.ts';
import { openaiFormat } from '../schema.ts';

type Json = Record<string, any>;

/**
 * OpenAI through the Responses API (openai SDK), for when OPENAI_API_KEY is set: the same request Meta gets (input_file
 * PDF, strict text.format json_schema, reasoning.effort).
 */
export function openaiApiAdapter(apiKey: string | undefined): Adapter {
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
    text: { format: openaiFormat(req.schemaName, req.schema) },
  });

  return {
    provider: 'openai-api',
    vendor: 'OpenAI',
    build: (req, manual) => body(req, manual, true),
    async send(req, manual, { timeoutMs, rawPath }): Promise<CallOutcome> {
      if (!apiKey) return { status: 'error', seconds: 0, apiSeconds: 0, usage: null, error: 'OPENAI_API_KEY is not set' };
      const client = new OpenAI({ apiKey, maxRetries: 0, timeout: timeoutMs });
      const from = performance.now();
      const seconds = () => Math.round(performance.now() - from) / 1000;
      let reply: Json;
      try {
        reply = (await client.responses.create(body(req, manual, false) as never)) as unknown as Json;
      } catch (error) {
        const s = seconds();
        const timedOut = error instanceof OpenAI.APIConnectionTimeoutError;
        return { status: timedOut ? 'timeout' : 'error', seconds: s, apiSeconds: s, usage: null, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
      }
      const s = seconds();
      writeFileSync(rawPath, JSON.stringify({ seconds: s, reply }, null, 2));
      const u = reply.usage ?? {};
      const usage = {
        input: u.input_tokens ?? 0,
        cachedInput: u.input_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
        output: u.output_tokens ?? 0,
        reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
      };
      const info = { status: reply.status, model: reply.model, incomplete: reply.incomplete_details ?? undefined };
      const refusal = (reply.output ?? []).flatMap((o: Json) => o.content ?? []).find((c: Json) => c.type === 'refusal');
      if (refusal) return { status: 'refusal', seconds: s, apiSeconds: s, usage, error: String(refusal.refusal).slice(0, 300), info };
      if (reply.status === 'incomplete') return { status: 'incomplete', seconds: s, apiSeconds: s, usage, error: JSON.stringify(reply.incomplete_details ?? {}), info };
      try {
        return { status: 'ok', seconds: s, apiSeconds: s, usage, json: JSON.parse(reply.output_text), info };
      } catch {
        return { status: 'bad-json', seconds: s, apiSeconds: s, usage, error: 'the reply is not the JSON asked for', info };
      }
    },
  };
}
