/**
 * Markdown-lite for chat bubbles: escape everything first, then re-introduce
 * only the handful of constructs the AI actually uses (the backend's health-
 * report prompt asks for `###` headings, bullets and bold; code comes fenced).
 *
 * Escaping BEFORE any substitution is what keeps this safe — a reply that
 * contained `<img onerror=...>` renders as literal text, never as markup. No
 * dependency pulled in for what is, in practice, five regexes.
 */
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(line) {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code class="rounded-xs bg-sunken px-1 py-0.5 font-mono text-[11px]">$1</code>')
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
    <div className="space-y-2 text-[13px] leading-relaxed text-fg">
      {blocks.map((b, i) => (b.type === 'code'
        ? <CodeBlock key={i} lang={b.lang} code={b.text} />
        : <Prose key={i} text={b.text} />))}
    </div>
  );
}

function Prose({ text }) {
  // Blank-line-separated paragraphs; inside each, a leading "- " or "* " line
  // becomes a bullet and a leading "### " becomes a small heading — the only
  // two block-level forms the system prompt is told to use.
  const lines = text.split('\n');
  const nodes = [];
  let list = null;

  const flushList = () => {
    if (list) nodes.push(<ul key={nodes.length} className="ml-4 list-disc space-y-0.5">{list}</ul>);
    list = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) { flushList(); return; }

    if (/^#{1,4}\s+/.test(line)) {
      flushList();
      const heading = line.replace(/^#{1,4}\s+/, '');
      nodes.push(
        <p key={i} className="mt-1 text-[11px] font-bold tracking-wide text-subtle uppercase"
          dangerouslySetInnerHTML={{ __html: inline(heading) }} />,
      );
      return;
    }

    if (/^[-*]\s+/.test(line)) {
      list = list || [];
      list.push(
        <li key={i} dangerouslySetInnerHTML={{ __html: inline(line.replace(/^[-*]\s+/, '')) }} />,
      );
      return;
    }

    flushList();
    nodes.push(<p key={i} dangerouslySetInnerHTML={{ __html: inline(line) }} />);
  });
  flushList();

  return <>{nodes}</>;
}

function CodeBlock({ lang, code }) {
  return (
    <div className="overflow-hidden rounded-control border border-border">
      {lang && (
        <div className="border-b border-border bg-sunken px-2.5 py-1 font-mono text-[10px] font-bold tracking-wide text-subtle uppercase">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto bg-inverse px-3 py-2 text-[12px] leading-relaxed text-on-inverse">
        <code>{code.replace(/\n$/, '')}</code>
      </pre>
    </div>
  );
}
