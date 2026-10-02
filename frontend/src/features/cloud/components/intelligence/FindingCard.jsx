import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { relativeTime } from '../../utils/resourceModel';
import { severityAccent, severityTone } from '../../utils/securityModel';
import {
  PROVIDER_LABEL, SIGNAL_META, categoryMeta, confidenceMeta, lastCheckText, savingsView,
  statusMeta,
} from '../../utils/intelligenceModel';

/**
 * One finding, as a row an engineer can triage from without opening it:
 * what, on which resource, the evidence that proves it, what to do, and what
 * it is worth — or why that is not known.
 */
export default function FindingCard({ finding: f, onOpen }) {
  const cat = categoryMeta(f.category);
  const status = statusMeta(f.status_group);
  const sav = savingsView(f.savings);
  const conf = confidenceMeta(f.confidence);
  const check = f.status_group === 'OPEN' || f.status_group === 'ACKNOWLEDGED'
    ? lastCheckText(f.last_check) : null;
  const res = f.resource || {};
  const highlights = f.highlights || [];

  return (
    <li className={cn(
      'rounded-card border border-border border-l-4 bg-surface transition-colors hover:border-strong',
      severityAccent(f.severity),
      f.status_group === 'SUPPRESSED' && 'opacity-70',
    )}
    >
      <div className="flex flex-col gap-3 p-3.5 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
            <Badge tone="outline">
              <Icon name={cat.icon} size={11} />
              {cat.label}
            </Badge>
            {f.signal && SIGNAL_META[f.signal] && (
              <Badge tone={SIGNAL_META[f.signal].tone} size="xs">{SIGNAL_META[f.signal].label}</Badge>
            )}
            <Badge tone={status.tone} size="xs">{f.status_label || status.label}</Badge>
            {f.source === 'security' && (
              <Badge tone="neutral" size="xs" title="From the Security Center's engine">Security Center</Badge>
            )}
          </div>

          <button type="button" onClick={onOpen} className="mt-1.5 block text-left">
            <span className="text-[14px] font-semibold text-fg hover:underline">{f.title}</span>
          </button>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Icon name="box" size={12} />
              <span className="font-medium text-fg">{res.name || 'Account-wide'}</span>
            </span>
            {res.type && <span>{res.type}</span>}
            <span>{PROVIDER_LABEL[f.provider] || f.provider}</span>
            {res.region && <span>{res.region}</span>}
            <span title={f.first_detected_at ? new Date(f.first_detected_at).toLocaleString() : undefined}>
              Detected {relativeTime(f.first_detected_at) || '—'}
            </span>
          </div>

          {highlights.length > 0 ? (
            <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
              {highlights.map((h) => (
                <div key={h.label} className="min-w-0">
                  <dt className="truncate-safe text-[10px] font-semibold uppercase tracking-wider text-subtle">
                    {h.label}
                  </dt>
                  <dd className={cn('truncate-safe text-[12.5px] tabular-nums',
                    h.display === 'N/A' ? 'text-muted' : 'text-fg')}
                    title={h.detail || undefined}
                  >
                    {h.display}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-muted">{f.description}</p>
          )}

          {f.recommendation && (
            <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg">
              <Icon name="sparkles" size={13} className="mt-0.5 shrink-0 text-accent-text" />
              <span className="line-clamp-2">{f.recommendation}</span>
            </p>
          )}
          {check && <p className="mt-1.5 text-[11px] italic text-subtle">{check}</p>}
        </div>

        <div className="flex shrink-0 flex-row items-end justify-between gap-3 lg:w-48 lg:flex-col lg:items-end">
          <div className="text-right">
            <div className={cn('text-[16px] font-bold tabular-nums', sav.priced ? 'text-fg' : 'text-muted')}>
              {sav.text}
            </div>
            <div className="text-[10.5px] text-subtle" title={sav.reason || undefined}>
              {sav.priced ? `saving · ${sav.sub}` : 'saving not quantified'}
            </div>
            <div className="mt-1 text-[10.5px] text-muted">
              Confidence <span className="font-semibold text-fg">{conf.label}</span>
            </div>
          </div>
          <Button size="sm" iconRight="chevron-right" onClick={onOpen}>
            {f.source === 'security' ? 'View details' : 'View analysis'}
          </Button>
        </div>
      </div>
    </li>
  );
}
