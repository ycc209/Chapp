import type { ReactNode } from 'react';
import type { Source } from '../../../shared/ai.ts';
import { cn } from '../../lib/cn.ts';

/** Links from model text and citations remain ordinary web links, never executable URLs. */
export function webLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function inline(text: string): ReactNode[] {
  const tokens = /\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index > at) nodes.push(text.slice(at, match.index));
    const href = match[2] && webLink(match[2]);
    nodes.push(match[1]
      ? href ? <a key={match.index} href={href} target="_blank" rel="noreferrer" className="underline decoration-blue/40 underline-offset-2">{match[1]}</a> : match[1]
      : match[3] ? <strong key={match.index} className="font-bold">{match[3]}</strong>
      : <code key={match.index} className="rounded bg-sunken px-1 text-[0.9em]">{match[4]}</code>);
    at = match.index + match[0].length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

/** Readable prose and simple Markdown, rendered as React text (no HTML from the model). */
export function ReplyText({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={i} className="m-0 overflow-x-auto rounded-xl bg-sunken p-3 text-[0.85em]"><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { blocks.push(<p key={i} className="m-0 font-bold">{inline(heading[1]!)}</p>); i++; continue; }
    const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (item) {
      const ordered = /^\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const next = (ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/).exec(lines[i]!);
        if (!next) break;
        items.push(<li key={i}>{inline(next[1]!)}</li>); i++;
      }
      blocks.push(ordered ? <ol key={`list-${i}`} className="m-0 list-decimal space-y-1 pl-5">{items}</ol> : <ul key={`list-${i}`} className="m-0 list-disc space-y-1 pl-5">{items}</ul>);
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```)/.test(lines[i]!)) paragraph.push(lines[i++]!);
    blocks.push(<p key={i} className="m-0 whitespace-pre-wrap">{inline(paragraph.join('\n'))}</p>);
  }
  return <div className={cn('flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]', className)}>{blocks}</div>;
}

export function ReplySources({ sources = [], className }: { sources?: readonly Source[]; className?: string }) {
  const seen = new Set<string>();
  const links = sources.filter(s => {
    const key = `${s.url}#${s.page ?? ''}`;
    if (!webLink(s.url) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (!links.length) return null;
  return <ul aria-label="Sources" className={cn('m-0 mt-3 flex list-none flex-col gap-1.5 p-0 text-[13px] leading-[18px] font-medium text-text', className)}>
    {links.map(s => <li key={`${s.url}#${s.page ?? ''}`}><a href={webLink(s.page ? `${s.url.split('#')[0]}#page=${s.page}` : s.url)!} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 [overflow-wrap:anywhere]">{s.title || new URL(s.url).hostname}{s.page ? ` · p. ${s.page}` : ''}</a></li>)}
  </ul>;
}
