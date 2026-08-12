import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Badge from '@/components/ui/Badge';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import { listNotificationHistory } from '@/api/notifications';
import { organizationsApi } from '@/api/admin';
import { CHANNEL_DEFS, CHANNEL_ORDER } from '@/config/notificationChannels';
import { fullTime, responseTime } from '@/lib/format';

const STATUS_TONE = { sent: 'success', pending: 'warning', failed: 'danger' };
const SEVERITY_TONE = { Critical: 'danger', critical: 'danger', Warning: 'warning', warning: 'warning', Information: 'info', information: 'info' };

/**
 * Delivery history — every notification the queue dispatcher has attempted,
 * append-only (notification_history table). Columns and filters match the
 * spec exactly: this is the audit trail for "did the alert actually go out."
 */
export default function NotificationHistoryPage() {
  const [search, setSearch] = useState('');
  const [channelType, setChannelType] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [status, setStatus] = useState('all');
  const [orgId, setOrgId] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState({ key: 'sent_at', dir: 'desc' });

  const { data: orgs = [] } = useQuery({ queryKey: ['organizations'], queryFn: () => organizationsApi.list() });
  const orgName = (id) => orgs.find((o) => String(o.org_id) === String(id))?.org_name || `Org ${id}`;

  const filters = useMemo(() => ({
    org_id: orgId === 'all' ? undefined : Number(orgId),
    channel_type: channelType === 'all' ? undefined : channelType,
    severity: severity === 'all' ? undefined : severity,
    status: status === 'all' ? undefined : status,
    search: search.trim() || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  }), [orgId, channelType, severity, status, search, dateFrom, dateTo]);

  const { data: history = [], isFetching, refetch } = useQuery({
    queryKey: ['notification-history', filters],
    queryFn: () => listNotificationHistory(filters),
  });

  const hasFilters = search || channelType !== 'all' || severity !== 'all' || status !== 'all' || orgId !== 'all' || dateFrom || dateTo;
  const clearFilters = () => {
    setSearch(''); setChannelType('all'); setSeverity('all'); setStatus('all'); setOrgId('all'); setDateFrom(''); setDateTo('');
  };

  const columns = [
    { key: 'sent_at', label: 'Date & Time', sortable: true, width: 150 },
    { key: 'alert_name', label: 'Alert Name', sortable: true },
    { key: 'org', label: 'Organization', sortable: true },
    { key: 'server_name', label: 'Server' },
    { key: 'database_name', label: 'Database' },
    { key: 'severity', label: 'Severity', width: 100 },
    { key: 'channel_type', label: 'Channel', width: 110 },
    { key: 'recipient', label: 'Recipient' },
    { key: 'status', label: 'Status', width: 90 },
    { key: 'response_code', label: 'Resp. Code', align: 'right', width: 90 },
    { key: 'response_time_ms', label: 'Resp. Time', align: 'right', width: 100 },
    { key: 'retry_count', label: 'Retries', align: 'right', width: 80 },
    { key: 'error_message', label: 'Error' },
  ];

  const rows = history.map((h) => ({
    key: String(h.id),
    sort: {
      sent_at: h.sent_at ? new Date(h.sent_at).getTime() : 0,
      alert_name: h.alert_name || '',
      org: orgName(h.org_id),
    },
    cells: {
      sent_at: <span className="text-[12px] text-muted whitespace-nowrap">{h.sent_at ? fullTime(h.sent_at) : '—'}</span>,
      alert_name: <span className="font-semibold text-fg">{h.alert_name || '—'}</span>,
      org: <span className="text-muted">{orgName(h.org_id)}</span>,
      server_name: h.server_name || <span className="text-subtle">—</span>,
      database_name: h.database_name || <span className="text-subtle">—</span>,
      severity: <Badge tone={SEVERITY_TONE[h.severity] || 'neutral'} size="xs">{h.severity || '—'}</Badge>,
      channel_type: (
        <span className="flex items-center gap-1.5">
          <Icon name={CHANNEL_DEFS[h.channel_type]?.icon || 'send'} size={13} className="text-subtle" />
          {CHANNEL_DEFS[h.channel_type]?.label || h.channel_type}
        </span>
      ),
      recipient: <span className="truncate-safe block max-w-48 text-muted">{h.recipient || '—'}</span>,
      status: <Badge tone={STATUS_TONE[h.status] || 'neutral'} size="xs">{h.status}</Badge>,
      response_code: h.response_code ?? <span className="text-subtle">—</span>,
      response_time_ms: h.response_time_ms != null ? responseTime(h.response_time_ms) : <span className="text-subtle">—</span>,
      retry_count: h.retry_count ?? 0,
      error_message: h.error_message
        ? <span className="truncate-safe block max-w-64 text-danger-fg" title={h.error_message}>{h.error_message}</span>
        : <span className="text-subtle">—</span>,
    },
  }));

  const sorted = sortRows(rows, sort);

  return (
    <div className="space-y-gutter">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          placeholder="Search alert, server, database, recipient…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-64 sm:flex-1"
        />
        <Select
          width="auto"
          value={channelType}
          onChange={setChannelType}
          options={[{ id: 'all', label: 'All channels' }, ...CHANNEL_ORDER.map((c) => ({ id: c, label: CHANNEL_DEFS[c].label }))]}
        />
        <Select
          width="auto"
          value={severity}
          onChange={setSeverity}
          options={[
            { id: 'all', label: 'All severities' },
            { id: 'Critical', label: 'Critical' },
            { id: 'Warning', label: 'Warning' },
            { id: 'Information', label: 'Information' },
          ]}
        />
        <Select
          width="auto"
          value={status}
          onChange={setStatus}
          options={[
            { id: 'all', label: 'All statuses' },
            { id: 'sent', label: 'Sent' },
            { id: 'pending', label: 'Pending' },
            { id: 'failed', label: 'Failed' },
          ]}
        />
        <Select
          width="auto"
          value={orgId}
          onChange={setOrgId}
          options={[{ id: 'all', label: 'All organizations' }, ...orgs.map((o) => ({ id: String(o.org_id), label: o.org_name }))]}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          loading={isFetching}
          onClick={() => refetch()}
        >
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-subtle">Date range</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
        />
        <span className="text-[11px] text-subtle">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>
        )}
        <span className="ml-auto shrink-0 text-[12px] whitespace-nowrap text-subtle">{history.length} deliveries</span>
      </div>

      <section className="card overflow-hidden">
        <Table
          columns={columns}
          rows={sorted}
          sort={sort}
          onSort={(key) => setSort((s) => nextSort(s, key))}
          loading={isFetching}
          empty={
            hasFilters ? (
              <EmptyState
                icon="filter"
                title="No deliveries match these filters"
                body="Try widening the search or clearing a filter."
                action={<Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                icon="mail"
                title="No notifications sent yet"
                body="Deliveries appear here the moment an alert rule fires into an enabled channel."
              />
            )
          }
        />
      </section>
    </div>
  );
}
