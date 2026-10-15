import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { Field, Section, Segmented } from '@/components/ui/Field';

const RISK_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'NONE', 'UNKNOWN'];

/**
 * Scope step: current/selected resources (only offered when the caller
 * arrived with a hand-picked set — e.g. from the Resources table's "Build
 * Report…" action), a filtered subset of the account, or the whole account.
 *
 * Filters mirror the same fields the Resources table filters on
 * (region/type/risk/free text) — a filter that works there works here
 * unchanged, because both ends send the same shape to the same backend
 * query.
 */
export default function ReportScopeSelector({ scope, onChange, preSelectedIds = [] }) {
  const hasPreSelection = preSelectedIds.length > 0;

  const modeOptions = [
    ...(hasPreSelection ? [{ id: 'resources', label: `Selected resources (${preSelectedIds.length})` }] : []),
    { id: 'filtered', label: 'Filtered subset' },
    { id: 'account', label: 'Whole account' },
  ];

  const setFilter = (key, value) => onChange({
    ...scope,
    filters: { ...scope.filters, [key]: value || undefined },
  });

  const toggleRisk = (level) => {
    const current = scope.filters.risk || [];
    const next = current.includes(level) ? current.filter((r) => r !== level) : [...current, level];
    setFilter('risk', next.length ? next : undefined);
  };

  return (
    <div className="space-y-5">
      <Section title="Scope">
        <Segmented
          options={modeOptions}
          value={scope.mode}
          onChange={(mode) => onChange({ ...scope, mode })}
        />
        {scope.mode === 'resources' && !hasPreSelection && (
          <Notice tone="warning" className="mt-3">
            No resources were selected. Go back to the Resources table, select rows, and
            reopen the report builder, or pick a filtered/whole-account scope instead.
          </Notice>
        )}
      </Section>

      {scope.mode === 'filtered' && (
        <Section title="Filters">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Search" hint="Name, provider ID, IP, type, region, tag value">
              <Input
                value={scope.filters.q || ''}
                onChange={(e) => setFilter('q', e.target.value)}
                placeholder="e.g. prod-db"
              />
            </Field>
            <Field label="Region" hint="Comma-separated, e.g. ap-south-1, us-east-1">
              <Input
                value={(scope.filters.region || []).join(', ')}
                onChange={(e) => setFilter('region', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
            <Field label="Resource type" hint="Comma-separated, e.g. EC2Instance, S3Bucket">
              <Input
                value={(scope.filters.type || []).join(', ')}
                onChange={(e) => setFilter('type', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
            <Field label="Environment" hint="Comma-separated, e.g. Production, Staging">
              <Input
                value={(scope.filters.environment || []).join(', ')}
                onChange={(e) => setFilter('environment', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
          </div>
          <Field label="Security risk" className="mt-3">
            <div className="flex flex-wrap gap-1.5">
              {RISK_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => toggleRisk(level)}
                  className="cursor-pointer"
                >
                  <Badge tone={(scope.filters.risk || []).includes(level) ? 'accent' : 'outline'}>
                    {level}
                  </Badge>
                </button>
              ))}
            </div>
          </Field>
        </Section>
      )}

      {scope.mode === 'account' && (
        <Notice tone="info">
          Every resource in this account is in scope. Large accounts are capped at
          1,000 resources per report — narrow the scope with a filter if that cap is hit.
        </Notice>
      )}
    </div>
  );
}
