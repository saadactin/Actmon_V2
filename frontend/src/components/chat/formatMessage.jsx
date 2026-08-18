import { useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';

/**
 * Markdown-lite for chat bubbles: escape everything first, then re-introduce
 * only the constructs the AI actually uses (headings, bold/italic/inline code,
 * bullet/numbered lists, fenced code, and pipe tables) plus a copy button on
 * code blocks — the same handful of things ChatGPT/Cursor render, kept
 * dependency-free since it's five regexes' worth of surface, not a markdown
 * engine's worth.
 *
 * Escaping BEFORE any substitution is what keeps this safe — a reply that
 * contained `<img onerror=...>` renders as literal text, never as markup.
 */
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(line) {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code class="rounded-xs bg-sunken px-1 py-0.5 font-mono text-[14px]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export default function FormatMessage({ text }) {
  if (!text) return null;

  // Fenced code blocks are pulled out first so nothing inside them is touched
  // by the inline rules above (a `**` in a SQL comment must stay literal).
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  const blocks = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    const lang = parts[i + 1];
    const code = parts[i + 2];
    if (prose) blocks.push({ type: 'prose', text: prose });
    if (code !== undefined) blocks.push({ type: 'code', lang, text: code });
  }

  return (
    <div className="space-y-2 text-[16px] leading-relaxed text-fg">
      {blocks.map((b, i) => (b.type === 'code'
        ? <CodeBlock key={i} lang={b.lang} code={b.text} />
        : <Prose key={i} text={b.text} />))}
    </div>
  );
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (line) => isTableRow(line) && /^[\s|:-]+$/.test(line);
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function Prose({ text }) {
  // Blank-line-separated blocks; inside each, a leading "### " becomes a small
  // heading, "- "/"* " a bullet, "1. " a numbered item, and a run of "|...|"
  // rows (with a "|---|" separator) a table — the block forms the system
  // prompt is told to use, plus tables for anything comparison/list-shaped.
  const lines = text.split('\n');
  const nodes = [];
  let list = null;
  let listOrdered = false;

  const flushList = () => {
    if (list) {
      const Tag = listOrdered ? 'ol' : 'ul';
      nodes.push(
        <Tag key={nodes.length} className={cn('ml-4 space-y-0.5', listOrdered ? 'list-decimal' : 'list-disc')}>
          {list}
        </Tag>,
      );
    }
    list = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (!line.trim()) { flushList(); i += 1; continue; }

    if (isTableRow(line) && isSeparatorRow(lines[i + 1] || '')) {
      flushList();
      const header = splitRow(line);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && isTableRow(lines[j])) { rows.push(splitRow(lines[j])); j += 1; }
      nodes.push(<MarkdownTable key={nodes.length} header={header} rows={rows} />);
      i = j;
      continue;
    }

    if (/^#{1,4}\s+/.test(line)) {
      flushList();
      const heading = line.replace(/^#{1,4}\s+/, '');
      nodes.push(
        <p key={nodes.length} className="mt-1 text-[11px] font-bold tracking-wide text-subtle uppercase"
          dangerouslySetInnerHTML={{ __html: inline(heading) }} />,
      );
      i += 1; continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      if (list && !listOrdered) flushList();
      listOrdered = true;
      list = list || [];
      list.push(<li key={nodes.length + list.length} dangerouslySetInnerHTML={{ __html: inline(line.replace(/^\d+\.\s+/, '')) }} />);
      i += 1; continue;
    }

    if (/^[-*]\s+/.test(line)) {
      if (list && listOrdered) flushList();
      listOrdered = false;
      list = list || [];
      list.push(<li key={nodes.length + list.length} dangerouslySetInnerHTML={{ __html: inline(line.replace(/^[-*]\s+/, '')) }} />);
      i += 1; continue;
    }

    flushList();
    nodes.push(<p key={nodes.length} dangerouslySetInnerHTML={{ __html: inline(line) }} />);
    i += 1;
  }
  flushList();

  return <>{nodes}</>;
}

/** Same visual language as the app's data tables (border/sunken header), scaled
 * down for an inline chat bubble rather than a full page — a chat reply's table
 * is read, not sorted/paginated, so the heavier Table component would be overkill. */
function MarkdownTable({ header, rows }) {
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="bg-sunken">
            {header.map((h, i) => (
              <th key={i} className="border-b border-border px-2.5 py-1.5 text-left font-bold text-muted"
                dangerouslySetInnerHTML={{ __html: inline(h) }} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className={ri % 2 ? 'bg-sunken/40' : undefined}>
              {r.map((c, ci) => (
                <td key={ci} className="border-b border-border px-2.5 py-1.5 text-fg last:border-b-0"
                  dangerouslySetInnerHTML={{ __html: inline(c) }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const body = code.replace(/\n$/, '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (permissions/non-secure context) — silently no-op */
    }
  };

  return (
    <div className="overflow-hidden rounded-control border border-border">
      <div className="flex items-center justify-between border-b border-border bg-sunken px-2.5 py-1">
        <span className="font-mono text-[10px] font-bold tracking-wide text-subtle uppercase">{lang || 'text'}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-subtle hover:bg-surface hover:text-fg"
        >
          <Icon name={copied ? 'check' : 'copy'} size={11} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-inverse px-3 py-2 text-[14px] leading-relaxed text-on-inverse">
        <code>{body}</code>
      </pre>
    </div>
  );
}
