import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import ProviderLogo from '../ProviderLogo';
import {
  accountRoute, certificateHealth, findingCounts, formatMoneyMap, moneyTitle, postureLabel,
} from '../../utils/clientModel';
import { formatCount, formatDateTime, providerLabel } from '../../utils/securityModel';

/**
 * Cells shared by the portfolio, a client's page and its account list, so a
 * number reads the same wherever it appears.
 */

/** Spend per currency — never one merged figure — with the exact amounts in
 *  the tooltip. NA (not 0) where no billing is stored. */
export function MoneyCell({ map, previous, previousLabel = 'last month' }) {
  return (
    <div className="min-w-0">
      <div className="truncate-safe text-[13px] font-semibold text-fg" title={moneyTitle(map)}>
        {formatMoneyMap(map)}
      </div>
      {previous !== undefined && (
        <div className="truncate-safe text-[11px] text-subtle" title={moneyTitle(previous)}>
          {previousLabel}: {formatMoneyMap(previous)}
        </div>
      )}
    </div>
  );
}

export function PostureBadge({ security, detail }) {
  const p = postureLabel(security);
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <Badge tone={p.tone}>{p.text}</Badge>
        {p.provisional && (
          <abbr title="Published on low data coverage — provisional." className="no-underline">
            <Icon name="info" size={12} className="text-subtle" />
          </abbr>
        )}
      </div>
      {detail && <div className="mt-0.5 truncate-safe text-[11px] text-subtle">{detail}</div>}
    </div>
  );
}

/** Confirmed findings only. */
export function FindingsCell({ findings, undetermined }) {
  const f = findingCounts(findings);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={f.critical ? 'danger' : 'neutral'} size="xs">{f.critical} critical</Badge>
        <Badge tone={f.high ? 'warning' : 'neutral'} size="xs">{f.high} high</Badge>
      </div>
      <div className="mt-0.5 text-[11px] text-subtle">
        {formatCount(f.total)} confirmed
        {undetermined ? ` · ${formatCount(undetermined)} undetermined` : ''}
      </div>
    </div>
  );
}

export function CertificateCell({ certs }) {
  const h = certificateHealth(certs);
  return (
    <div className="min-w-0">
      <Badge tone={h.tone}>{h.text}</Badge>
      {h.detail && <div className="mt-0.5 truncate-safe text-[11px] text-subtle">{h.detail}</div>}
    </div>
  );
}

export function ProviderCounts({ byProvider }) {
  const entries = Object.entries(byProvider || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <span className="text-[12px] text-subtle">No accounts</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {entries.map(([p, n]) => (
        <span key={p} className="inline-flex items-center gap-1 text-[12px] text-fg" title={providerLabel(p)}>
          <ProviderLogo provider={p} size={16} />
          {n}
        </span>
      ))}
    </div>
  );
}

export function StatCard({ label, value, sub, icon, tone = 'bg-accent-soft text-accent-text', title }) {
  return (
    <div className="card flex items-center gap-3.5 p-card" title={title}>
      {icon && (
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tone}`}>
          <Icon name={icon} size={18} />
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate-safe text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
        <div className="mt-0.5 truncate-safe text-xl font-bold text-fg">{value}</div>
        {sub && <div className="truncate-safe text-[11px] text-subtle">{sub}</div>}
      </div>
    </div>
  );
}

const DISCOVERY_TONE = { ok: 'success', scanning: 'info', failed: 'danger', never_scanned: 'neutral' };
const DISCOVERY_LABEL = { ok: 'Scanned', scanning: 'Scanning', failed: 'Last scan failed', never_scanned: 'Never scanned' };

/**
 * One row per account (estate_summary.account_summaries shape). Clicking a
 * row opens the account's own dashboard.
 */
export function AccountSummaryTable({
  accounts, onRemove, removingId, selectable = false, selectedKeys, onSelectionChange, empty,
}) {
  const navigate = useNavigate();
  const rows = (accounts || []).map((a) => {
    const route = accountRoute(a.provider, a.account_id);
    return {
      key: a.account_id,
      onClick: route ? () => navigate(route) : undefined,
      cells: {
        account: (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderLogo provider={a.provider} size={20} />
            <div className="min-w-0">
              <div className="truncate-safe text-[13px] font-medium text-fg">{a.account_name}</div>
              <div className="truncate-safe text-[11px] text-subtle">
                {[providerLabel(a.provider), a.environment, a.provider_account_id].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        ),
        scan: (
          <div className="min-w-0">
            <Badge tone={DISCOVERY_TONE[a.discovery_status] || 'neutral'} size="xs">
              {DISCOVERY_LABEL[a.discovery_status] || a.discovery_status}
            </Badge>
            <div className="mt-0.5 text-[11px] text-subtle">{formatCount(a.resources)} resources · {formatDateTime(a.last_discovery)}</div>
          </div>
        ),
        posture: <PostureBadge security={a.security} />,
        findings: <FindingsCell findings={a.findings} undetermined={a.findings_undetermined} />,
        certs: <CertificateCell certs={a.certificates} />,
        spend: <MoneyCell map={a.cost?.month_to_date} previous={a.cost?.previous_month} />,
        actions: onRemove ? (
          <Button
            size="sm"
            variant="danger-ghost"
            loading={removingId === a.account_id}
            onClick={(e) => { e.stopPropagation(); onRemove(a); }}
          >
            Remove
          </Button>
        ) : null,
      },
    };
  });
  const columns = [
    { key: 'account', label: 'Account' },
    { key: 'scan', label: 'Inventory', width: 200 },
    { key: 'posture', label: 'Posture', width: 120 },
    { key: 'findings', label: 'Findings', width: 170 },
    { key: 'certs', label: 'Certificates', width: 190 },
    { key: 'spend', label: 'Spend this month', width: 180, hint: 'Month to date, per currency. Last month beneath. NA where no billing is stored.' },
    ...(onRemove ? [{ key: 'actions', label: '', width: 90, align: 'right' }] : []),
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      selectable={selectable}
      selectedKeys={selectedKeys}
      onSelectionChange={onSelectionChange}
      empty={empty || <EmptyState icon="cloud" title="No accounts" />}
    />
  );
}
