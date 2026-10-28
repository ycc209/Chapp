import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualTextBlock, pageImages, type Adapter, type CallOutcome, type CallRequest, type Manual } from '../core.ts';
import { codexSchema } from '../schema.ts';
import { cleanEnv, parseLine, runCli } from './cli.ts';

type Json = Record<string, any>;

export const CODEX_BIN = '/Users/someone/.local/bin/codex';

/**
 * OpenAI's models through the Codex CLI on the user's ChatGPT subscription (`codex exec`), one call per run.
 *
 * Codex cannot take a PDF, so the manual goes in as pdftotext's text; a call that reads the PDF elsewhere also gets the
 * five pages as PNGs (-i), so figures such as the at-a-glance box are there. The rules, the manual and the task are one
 * prompt (Codex keeps its own instructions; it has no system-prompt flag), the schema goes in --output-schema, the
 * shell is turned off so the answer comes from the prompt alone, the user's config.toml is not loaded and nothing is
 * kept (--ephemeral). Wall time is launch to exit; the model's time is turn.started to turn.completed as the events
 * arrive. Codex adds its own instructions and tool list (about 14k input tokens on a one-line prompt).
 */
export function codexCliAdapter(bin = CODEX_BIN): Adapter {
  const prompt = (req: CallRequest, manual: Manual, elide: boolean) =>
    [
      req.system,
      elide ? `<manual text, ${manual.text.length} chars>` : manualTextBlock(manual),
      req.input === 'pdf' ? `The manual's pages are also attached as images, in order (page 1 first).` : '',
      req.task,
    ].filter(Boolean).join('\n\n');
  const args = (req: CallRequest, dir: string, images: string[]) => [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only',
    '--disable', 'shell_tool', '--disable', 'unified_exec',
    '-m', req.model, '-c', `model_reasoning_effort=${req.effort}`,
    '--output-schema', join(dir, 'schema.json'), '-o', join(dir, 'last.txt'), '--json', '-C', dir,
    ...images.flatMap(i => ['-i', i]),
    '-',
  ];

  return {
    provider: 'codex-cli',
    vendor: 'OpenAI',
    build(req, manual) {
      const images = req.input === 'pdf' ? pageImages(manual) : [];
      return { bin, args: args(req, '<tmp>', images), schema: codexSchema(req.schema), prompt: prompt(req, manual, true) };
    },
    async send(req, manual, { timeoutMs, rawPath }): Promise<CallOutcome> {
      const dir = mkdtempSync(join(tmpdir(), 'chapp-bench-codex-'));
      try {
        writeFileSync(join(dir, 'schema.json'), JSON.stringify(codexSchema(req.schema)));
        const images = req.input === 'pdf' ? pageImages(manual) : [];
        const run = await runCli(bin, args(req, dir, images), prompt(req, manual, false), { cwd: dir, env: cleanEnv(), timeoutMs });
        const events = run.lines.map(l => ({ at: l.at, event: parseLine(l.line) ?? { raw: l.line.slice(0, 500) } }));
        writeFileSync(rawPath, JSON.stringify({ seconds: run.seconds, code: run.code, stderr: run.stderr.slice(-4000), events }, null, 2));
        const find = (type: string) => events.find(e => e.event.type === type);
        const started = find('turn.started');
        const done = find('turn.completed');
        const failed = find('turn.failed') ?? find('error');
        const u: Json = done?.event.usage ?? {};
        const usage = done
          ? { input: u.input_tokens ?? 0, cachedInput: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? null }
          : null;
        const apiSeconds = started && done ? Math.round((done.at - started.at) * 1000) / 1000 : run.seconds;
        const tools = events.filter(e => e.event.type === 'item.completed' && e.event.item?.type && e.event.item.type !== 'agent_message' && e.event.item.type !== 'reasoning').map(e => e.event.item.type);
        const info: Json = { exit: run.code, startup: started?.at, tools, images: images.length, input: req.input === 'pdf' ? 'text+page images' : 'text' };
        if (run.timedOut) return { status: 'timeout', seconds: run.seconds, apiSeconds, usage, error: `timed out after ${timeoutMs / 1000} s`, info };
        if (!done) {
          const message = failed?.event.error?.message ?? failed?.event.message ?? run.stderr.trim().split('\n').slice(-3).join(' ');
          return { status: 'error', seconds: run.seconds, apiSeconds, usage, error: String(message).slice(0, 300), info };
        }
        const last = existsSync(join(dir, 'last.txt')) ? readFileSync(join(dir, 'last.txt'), 'utf8') : '';
        const text = last || ([...events].reverse().find(e => e.event.type === 'item.completed' && e.event.item?.type === 'agent_message')?.event.item.text ?? '');
        try {
          return { status: 'ok', seconds: run.seconds, apiSeconds, usage, json: JSON.parse(text), info };
        } catch {
          return { status: 'bad-json', seconds: run.seconds, apiSeconds, usage, error: 'the reply is not the JSON asked for', info };
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
