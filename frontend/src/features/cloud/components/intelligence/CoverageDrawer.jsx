import Badge from '@/components/ui/Badge';
import Drawer from '@/components/ui/Drawer';
import { PageLoading } from '@/components/ui/Loading';
import { useIntelligenceCoverage } from '../../hooks/useIntelligence';
import { relativeTime } from '../../utils/resourceModel';
import { categoryMeta } from '../../utils/intelligenceModel';
import { DrawerSection } from './IntelligencePrimitives';

/**
 * What the latest analysis could and could not decide, rule by rule, and what
 * no provider API publishes at all. "No findings" is only meaningful beside
 * this: a rule that could not decide for 40 resources has not cleared them.
 */
export default function CoverageDrawer({ accountId, open, onClose }) {
  const { data, isLoading } = useIntelligenceCoverage(accountId, open);
  const rules = (data?.rules || []).filter((r) => r.evaluated > 0);
  const idle = (data?.rules || []).filter((r) => !r.evaluated);
  const metrics = Object.entries(data?.telemetry?.metrics || {});

  return (
    <Drawer open={open} onClose={onClose} title="What was analyzed" icon="gauge" width={720}
      subtitle={data?.run ? `Latest analysis ${relativeTime(data.run.at)} · ${data.run.outcome}` : 'No analysis yet'}>
      {isLoading && <PageLoading title="Loading coverage…" minHeight={200} />}
      {data && (
        <div className="space-y-5 text-sm">
          <DrawerSection title="Rules that ran" icon="list">
            <div className="overflow-hidden rounded-control border border-border">
              <table className="w-full text-meta">
                <thead className="bg-sunken text-left text-micro uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-2.5 py-1.5">Check</th>
                    <th className="px-2 py-1.5 text-right">Checked</th>
                    <th className="px-2 py-1.5 text-right">Findings</th>
                    <th className="px-2 py-1.5 text-right">Clear</th>
                    <th className="px-2 py-1.5 text-right">Not enough data</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.rule_id} className="border-t border-border align-top">
                      <td className="px-2.5 py-1.5">
                        <div className="font-medium text-fg">{r.title}</div>
                        <div className="text-meta text-subtle">{categoryMeta(r.category).label}</div>
                        {r.reasons?.length > 0 && (r.insufficient > 0 || r.errors > 0) && (
                          <ul className="mt-1 space-y-0.5 text-meta text-muted">
                            {r.reasons.slice(0, 3).map((x) => (
                              <li key={x.reason}>{x.count}× {x.reason}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.evaluated}</td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{r.findings}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.clear}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.insufficient > 0 ? <Badge tone="warning" size="xs">{r.insufficient}</Badge> : 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {idle.length > 0 && (
              <p className="mt-2 text-meta text-subtle">
                {idle.length} other check{idle.length === 1 ? '' : 's'} had nothing to evaluate in this
                inventory ({idle.map((r) => r.title).slice(0, 6).join(', ')}{idle.length > 6 ? '…' : ''}).
              </p>
            )}
          </DrawerSection>

          <DrawerSection title="Telemetry collected" icon="activity">
            {metrics.length === 0 ? (
              <p className="text-[12px] text-muted">No telemetry was collected in the latest analysis.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {metrics.map(([metric, counts]) => (
                  <li key={metric} className="rounded-control border border-border px-2.5 py-1.5 text-meta">
                    <div className="font-semibold text-fg">{metric.replace(/_/g, ' ')}</div>
                    <div className="text-muted">
                      {counts.OK || 0} collected · {counts.NO_DATA || 0} no datapoints
                      {counts.DENIED ? ` · ${counts.DENIED} not permitted` : ''}
                      {counts.ERROR ? ` · ${counts.ERROR} provider errors` : ''}
                      {counts.NOT_COLLECTED ? ` · ${counts.NOT_COLLECTED} not published` : ''}
                      {counts.SKIPPED ? ` · ${counts.SKIPPED} not queried (stopped)` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>

          <DrawerSection title="What cannot be measured here" icon="help">
            <ul className="space-y-1.5">
              {(data.not_measurable || []).map((n) => (
                <li key={n.what} className="text-meta">
                  <span className="font-semibold text-fg">{n.what}.</span>{' '}
                  <span className="text-muted">{n.why}</span>
                </li>
              ))}
            </ul>
          </DrawerSection>
        </div>
      )}
    </Drawer>
  );
}
