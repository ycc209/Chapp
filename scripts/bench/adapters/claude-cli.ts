import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualTextBlock, type Adapter, type CallOutcome, type CallRequest, type Manual } from '../core.ts';
import { claudeSchema } from '../schema.ts';
import { cleanEnv, parseLine, runCli } from './cli.ts';

type Json = Record<string, any>;

/** The Claude Code CLI: CLAUDE_BIN, else where its installer puts it. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(homedir(), '.local/bin/claude');

/** Whether Claude Code can log in from here (its keychain login, or CLAUDE_CODE_OAUTH_TOKEN from .env). */
export function claudeLoggedIn(bin = CLAUDE_BIN): boolean {
  try {
    const out = execFileSync(bin, ['auth', 'status'], { env: cleanEnv({ CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }), timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out).loggedIn === true;
  } catch {
    return false;
  }
}

/** How the PDF reaches Claude Code: a base64 document block (stream-json input), the Read tool on a copy, or pdftotext. */
export type PdfMode = 'document' | 'read' | 'text';

/**
 * Claude through Claude Code in print mode on the user's subscription (`claude -p`), one call per run.
 *
 * The rules replace Claude Code's own system prompt (--system-prompt); --safe-mode leaves out CLAUDE.md, hooks,
 * plugins and MCP servers; no tools (or only Read, in "read" mode); the schema goes in --json-schema, which Claude Code
 * answers through its StructuredOutput tool. The run gets a clean environment (none of this session's variables), with
 * CLAUDE_CODE_OAUTH_TOKEN passed on when .env has one. Claude Code reports duration_ms (wall), duration_api_ms (the
 * model's time) and total_cost_usd; the effort "low-nothink" asks for low with thinking off (MAX_THINKING_TOKENS=0).
 */
export function claudeCliAdapter(bin = CLAUDE_BIN, pdfMode: PdfMode = 'document'): Adapter {
  const content = (req: CallRequest, manual: Manual, elide: boolean): Json[] => {
    const task = { type: 'text', text: req.task };
    if (req.input === 'text' || pdfMode === 'text') return [{ type: 'text', text: elide ? `<manual text, ${manual.text.length} chars>` : manualTextBlock(manual) }, task];
    if (pdfMode === 'read') return [{ type: 'text', text: 'The manual is the file manual.pdf in the working directory: read it with the Read tool.' }, task];
    return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: elide ? `<${manual.base64.length} chars>` : manual.base64 } }, task];
  };
  const effortOf = (req: CallRequest) => req.effort.replace(/-nothink$/, '');
  const reads = (req: CallRequest) => pdfMode === 'read' && req.input === 'pdf';
  const args = (req: CallRequest) => [
    '-p', '--model', req.model, '--effort', effortOf(req),
    '--safe-mode', '--strict-mcp-config', '--no-session-persistence',
    '--tools', reads(req) ? 'Read' : '', ...(reads(req) ? ['--allowedTools', 'Read'] : []),
    '--system-prompt', req.system,
    '--json-schema', JSON.stringify(claudeSchema(req.schema)),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ];
  const stdin = (req: CallRequest, manual: Manual, elide: boolean) => JSON.stringify({ type: 'user', message: { role: 'user', content: content(req, manual, elide) } }) + '\n';

  return {
    provider: 'claude-cli',
    vendor: 'Anthropic',
    build: (req, manual) => ({ bin, args: args(req).map(a => (a === req.system ? '<RULES>' : a)), stdin: JSON.parse(stdin(req, manual, true)), pdfMode }),
    async send(req, manual, { timeoutMs, rawPath }): Promise<CallOutcome> {
      const dir = mkdtempSync(join(tmpdir(), 'chapp-bench-claude-'));
      try {
        if (reads(req)) copyFileSync(manual.path, join(dir, 'manual.pdf'));
        const env = cleanEnv({
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          ...(req.effort.endsWith('-nothink') ? { MAX_THINKING_TOKENS: '0' } : {}),
        });
        const run = await runCli(bin, args(req), stdin(req, manual, false), { cwd: dir, env, timeoutMs });
        const events = run.lines.map(l => ({ at: l.at, event: parseLine(l.line) ?? { raw: l.line.slice(0, 500) } }));
        // The init event lists every tool, skill and command: keep its gist, not the whole list.
        const kept = events.map(e => (e.event.type === 'system' && e.event.subtype === 'init' ? { at: e.at, event: { type: 'system', subtype: 'init', model: e.event.model, tools: e.event.tools } } : e));
        writeFileSync(rawPath, JSON.stringify({ seconds: run.seconds, code: run.code, stderr: run.stderr.slice(-4000), events: kept }, null, 2));
        const result = [...events].reverse().find(e => e.event.type === 'result')?.event as Json | undefined;
        const assistants = events.filter(e => e.event.type === 'assistant').map(e => e.event.message as Json);
        const u: Json = result?.usage ?? {};
        const usage = result
          ? {
              input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              cachedInput: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              reasoning: u.output_tokens_details?.thinking_tokens ?? null,
            }
          : null;
        const apiSeconds = typeof result?.duration_api_ms === 'number' ? result.duration_api_ms / 1000 : run.seconds;
        const info: Json = {
          exit: run.code,
          durationMs: result?.duration_ms,
          durationApiMs: result?.duration_api_ms,
          turns: result?.num_turns,
          stopReasons: assistants.map(m => m?.stop_reason),
          models: [...new Set(assistants.map(m => m?.model))],
          modelUsage: result?.modelUsage ? Object.keys(result.modelUsage) : undefined,
          input: req.input === 'text' || pdfMode === 'text' ? 'text' : pdfMode === 'read' ? 'Read tool' : 'document block',
        };
        const reportedCostUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
        if (run.timedOut) return { status: 'timeout', seconds: run.seconds, apiSeconds, usage, reportedCostUsd, error: `timed out after ${timeoutMs / 1000} s`, info };
        if (assistants.some(m => m?.stop_reason === 'refusal') || result?.stop_reason === 'refusal') {
          return { status: 'refusal', seconds: run.seconds, apiSeconds, usage, reportedCostUsd, error: JSON.stringify(assistants.find(m => m?.stop_details)?.stop_details ?? {}).slice(0, 300), info };
        }
        if (!result || result.is_error) {
          const message = result?.result ?? (result?.errors ? JSON.stringify(result.errors) : run.stderr.trim().split('\n').slice(-3).join(' '));
          return { status: 'error', seconds: run.seconds, apiSeconds, usage, reportedCostUsd, error: String(message).slice(0, 300), info };
        }
        let json = result.structured_output;
        if (json === undefined) {
          try {
            json = JSON.parse(result.result);
          } catch {
            return { status: 'bad-json', seconds: run.seconds, apiSeconds, usage, reportedCostUsd, error: 'no structured output', info };
          }
        }
        return { status: 'ok', seconds: run.seconds, apiSeconds, usage, reportedCostUsd, json, info };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
