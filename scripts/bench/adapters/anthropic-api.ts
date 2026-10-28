import { writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { manualTextBlock, type Adapter, type CallOutcome, type CallRequest, type Manual } from '../core.ts';
import { claudeFormat } from '../schema.ts';

type Json = Record<string, any>;
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Claude through the Messages API (@anthropic-ai/sdk), for when ANTHROPIC_API_KEY is set: the PDF as a base64
 * document block before the task, structured output through output_config.format, effort through output_config.effort,
 * thinking left to its adaptive default. The effort "low-nothink" sends thinking { type: "between_tools" } at low
 * (Claude Sonnet 5.5's way to turn thinking off). No server-side fallbacks: another model answering would spoil the
 * timing, so a refusal is recorded as one.
 */
export function anthropicApiAdapter(apiKey: string | undefined): Adapter {
  const body = (req: CallRequest, manual: Manual, elide: boolean) => {
    const nothink = req.effort.endsWith('-nothink');
    const effort = req.effort.replace(/-nothink$/, '') as Effort;
    return {
      model: req.model,
      max_tokens: 64000,
      system: req.system,
      messages: [
        {
          role: 'user' as const,
          content: [
            req.input === 'text'
              ? { type: 'text' as const, text: elide ? `<manual text, ${manual.text.length} chars>` : manualTextBlock(manual) }
              : { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: elide ? `<${manual.base64.length} chars>` : manual.base64 } },
            { type: 'text' as const, text: req.task },
          ],
        },
      ],
      output_config: { effort, format: claudeFormat(req.schema) },
      ...(nothink ? { thinking: { type: 'between_tools' as const } } : {}),
    };
  };

  return {
    provider: 'anthropic-api',
    vendor: 'Anthropic',
    build: (req, manual) => body(req, manual, true),
    async send(req, manual, { timeoutMs, rawPath }): Promise<CallOutcome> {
      if (!apiKey) return { status: 'error', seconds: 0, apiSeconds: 0, usage: null, error: 'ANTHROPIC_API_KEY is not set' };
      const client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
      const from = performance.now();
      const seconds = () => Math.round(performance.now() - from) / 1000;
      let message: Anthropic.Message;
      try {
        message = await client.messages.stream(body(req, manual, false) as Anthropic.MessageStreamParams, { signal: AbortSignal.timeout(timeoutMs) }).finalMessage();
      } catch (error) {
        const s = seconds();
        const timedOut = error instanceof Anthropic.APIConnectionTimeoutError || (error instanceof Error && /abort|timeout/i.test(error.name + error.message));
        return { status: timedOut ? 'timeout' : 'error', seconds: s, apiSeconds: s, usage: null, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
      }
      const s = seconds();
      writeFileSync(rawPath, JSON.stringify({ seconds: s, reply: message }, null, 2));
      const u = message.usage as Anthropic.Usage;
      const usage = {
        input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cachedInput: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens,
        reasoning: u.output_tokens_details?.thinking_tokens ?? null,
      };
      const info: Json = { stop_reason: message.stop_reason, model: message.model, stop_details: (message as Json).stop_details ?? undefined };
      if (message.stop_reason === 'refusal') return { status: 'refusal', seconds: s, apiSeconds: s, usage, error: JSON.stringify(info.stop_details ?? {}), info };
      if (message.stop_reason === 'max_tokens') return { status: 'incomplete', seconds: s, apiSeconds: s, usage, error: 'max_tokens', info };
      const text = message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
      try {
        return { status: 'ok', seconds: s, apiSeconds: s, usage, json: JSON.parse(text), info };
      } catch {
        return { status: 'bad-json', seconds: s, apiSeconds: s, usage, error: 'the reply is not the JSON asked for', info };
      }
    },
  };
}
