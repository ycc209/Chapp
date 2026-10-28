import { spawn } from 'node:child_process';

/** What a CLI run gave: its output lines with the second each arrived (from launch), its stderr, and how it ended. */
export type CliRun = { lines: { at: number; line: string }[]; stderr: string; code: number | null; seconds: number; timedOut: boolean };

/** Runs a CLI with `input` on stdin, timing each stdout line from launch; kills it at the timeout. */
export function runCli(bin: string, args: string[], input: string, o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CliRun> {
  return new Promise(resolve => {
    const from = performance.now();
    const at = () => Math.round(performance.now() - from) / 1000;
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: CliRun['lines'] = [];
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, o.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) lines.push({ at: at(), line });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
    });
    child.on('error', error => {
      stderr += `\n${error.message}`;
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) lines.push({ at: at(), line: buffer.trim() });
      resolve({ lines, stderr, code, seconds: at(), timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const parseLine = (line: string): Record<string, any> | null => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** A clean environment for a CLI: what it needs to find itself and its login, nothing from this session. */
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) if (v) env[k] = v;
  return env;
}
