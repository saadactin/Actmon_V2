import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';

/*
 * Diagnosis Kit — small, token-only building blocks shared across the
 * Diagnosis page's tabs (Overview / Terminal / Errors & Logs / Timeline /
 * Root Cause & AI / Recommended Actions / History). No hard-coded colour
 * anywhere — every tone routes through the maps below, matching the app's
 * one design rule (see frontend/README.md).
 */

export const SEV_TONE = { Critical: 'danger', High: 'danger', Medium: 'warning', Low: 'success' };
export const STAT_TEXT_TONE = { danger: 'text-danger', success: 'text-success-fg', warning: 'text-warning-fg', accent: 'text-accent-text' };
export const SECTION_ICON_TONE = {
  accent: 'bg-accent-soft text-accent-text',
  danger: 'bg-danger-soft text-danger-fg',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  info: 'bg-info-soft text-info-fg',
  neutral: 'bg-neutral-soft text-muted',
};
export const CHECK_STATUS_TONE = {
  passed: 'success', warning: 'warning', failed: 'danger', running: 'accent', skipped: 'neutral', info: 'info',
};
export const CHECK_ICON = { running: 'spinner', passed: 'check', warning: 'alert', failed: 'close', skipped: 'clock', info: 'info' };
export const CHECK_TEXT_TONE = { passed: 'text-success-fg', warning: 'text-warning-fg', failed: 'text-danger', running: 'text-accent-text', info: 'text-subtle', skipped: 'text-subtle' };

export const OK_WORDS = ['running', 'active', 'ok', 'healthy', 'true', 'online', 'primary', 'open'];
export const BAD_WORDS = ['stopped', 'failed', 'down', 'false', 'offline', 'error'];

export function SeverityBadge({ severity }) {
  return <Badge tone={SEV_TONE[severity] || 'neutral'} size="sm">{severity || 'Unknown'}</Badge>;
}

export function StatusBadge({ status }) {
  return <Badge tone={CHECK_STATUS_TONE[status] || 'neutral'} size="sm">{status || 'pending'}</Badge>;
}

export function TriBadge({ value }) {
  const v = String(value ?? '').toLowerCase();
  const tone = OK_WORDS.includes(v) ? 'success' : BAD_WORDS.includes(v) ? 'danger' : 'neutral';
  return <Badge tone={tone} size="sm">{value ?? '—'}</Badge>;
}

export function Section({ title, icon, tone = 'accent', children, className, actions }) {
  return (
    <div className={cn('card mb-gutter overflow-hidden', className)}>
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md', SECTION_ICON_TONE[tone] || SECTION_ICON_TONE.accent)}>
          <Icon name={icon} size={14} />
        </span>
        <h3 className="flex-1 text-[11px] font-black uppercase tracking-wide text-fg">{title}</h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export function Stat({ label, value, tone }) {
  return (
    <div className="rounded-control border border-border bg-sunken p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">{label}</p>
      <p className={cn('mt-0.5 text-[15px] font-black', tone ? (STAT_TEXT_TONE[tone] || 'text-fg') : 'text-fg')}>{value ?? '—'}</p>
    </div>
  );
}

export function StatGrid({ children }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>;
}

export function MiniTable({ headers, rows, emptyMsg = 'No data' }) {
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-border bg-sunken">
            {headers.map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-left text-[10px] font-bold uppercase text-subtle">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {(!rows || rows.length === 0) ? (
            <tr><td colSpan={headers.length} className="py-6 text-center text-subtle">{emptyMsg}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {row.map((cell, j) => <td key={j} className="px-3 py-2 align-top text-fg">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Unavailable({ reason }) {
  return (
    <div className="flex items-start gap-2.5 rounded-control border border-border bg-sunken p-3 text-[13px] text-muted">
      <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-subtle" />
      <span>{reason || 'Not available for this environment yet.'}</span>
    </div>
  );
}

/** A permission-shaped failure gets its own honest callout instead of a bare
    failed badge — see diagnose_engine.py's _permission_issue(). */
export function PermissionRequired({ issue }) {
  if (!issue) return null;
  return (
    <div className="mt-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-[12.5px]">
      <p className="mb-1.5 flex items-center gap-1.5 font-black uppercase tracking-wide text-warning-fg">
        <Icon name="shield-check" size={13} /> Permission Required
      </p>
      <dl className="space-y-1 text-fg">
        <div><dt className="inline font-bold">Required: </dt><dd className="inline">{issue.required}</dd></div>
        <div><dt className="inline font-bold">Why: </dt><dd className="inline">{issue.why}</dd></div>
        <div><dt className="inline font-bold">Enables: </dt><dd className="inline">{issue.enables}</dd></div>
        <div><dt className="inline font-bold">Current status: </dt><dd className="inline">{issue.status}</dd></div>
        <div><dt className="inline font-bold">How obtained: </dt><dd className="inline">{issue.how_obtained}</dd></div>
      </dl>
    </div>
  );
}

/** One command+output terminal block — the shared visual for a single
    executed check, used in both the Checks sidebar's inline result and the
    Terminal tab's transcript. */
export function TerminalEntry({ entry, onCopyCommand, onRunAgain, className }) {
  return (
    <div className={cn('card overflow-hidden', className)}>
      <div className="flex items-center gap-2 border-b border-border bg-sunken px-3 py-2">
        <StatusBadge status={entry.status} />
        <span className="flex-1 truncate-safe text-[12.5px] font-bold text-fg">{entry.title}</span>
        {entry.durationMs != null && <span className="text-[11px] text-subtle">{entry.durationMs}ms</span>}
        {entry.exitCode != null && <span className="text-[11px] text-subtle">exit {entry.exitCode}</span>}
      </div>
      <div className="p-3">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-subtle">Command</p>
        <div className="mb-2 flex items-start gap-2">
          <pre className="max-h-24 flex-1 overflow-y-auto whitespace-pre-wrap break-all rounded-control bg-inverse p-2 font-mono text-[11px] text-on-inverse">{entry.command || '—'}</pre>
        </div>
        <div className="mb-2 flex flex-wrap gap-2">
          {onCopyCommand && (
            <button type="button" onClick={() => onCopyCommand(entry.command)} className="flex items-center gap-1 text-[11.5px] font-semibold text-accent-text hover:underline">
              <Icon name="copy" size={11} /> Copy Command
            </button>
          )}
          {onRunAgain && (
            <button type="button" onClick={() => onRunAgain(entry)} className="flex items-center gap-1 text-[11.5px] font-semibold text-accent-text hover:underline">
              <Icon name="refresh" size={11} /> Run Again
            </button>
          )}
        </div>
        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-subtle">Output</p>
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-control bg-inverse p-2 font-mono text-[11px] text-on-inverse">{entry.output || entry.detail || '(no output)'}</pre>
        {entry.detail && entry.output && entry.detail !== entry.output && (
          <p className="mt-1.5 text-[12px] text-muted">{entry.detail}</p>
        )}
        <PermissionRequired issue={entry.permissionIssue} />
      </div>
    </div>
  );
}
