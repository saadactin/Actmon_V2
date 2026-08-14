import { useEffect, useMemo, useState } from 'react';
import {
  FileSpreadsheet, FileText, ChevronDown, Loader2, CalendarRange, AlertTriangle, Link2, Unlink,
} from 'lucide-react';
import { useCostReport } from '../hooks/useCost';
import { downloadCsv } from '../utils/csvExport';
import { downloadCostReportPdf } from '../utils/costPdfExport';
import CloudFilterBar from './CloudFilterBar';
import Table, { EmptyState } from '@/components/ui/Table';
import Pagination from '@/components/ui/Pagination';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { InlineLoading } from '@/components/ui/Loading';

const DAY_PRESETS = [30, 90, 180, 365];
const PAGE_SIZE = 50;
const CURRENCY_SYMBOLS = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };

function symbolFor(code) {
  return code ? (CURRENCY_SYMBOLS[code] ?? `${code} `) : '';
}

const inputClass = 'rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent';

export const CostReportPanel = ({ accountId, open: openProp, onOpenChange }) => {
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const setOpen = (next) => {
    setOpenSelf(next);
    onOpenChange?.(next);
  };
  const [days, setDays] = useState(30);
  // Resource detail is the more useful default — it names each billed resource
  // and shows what it is attached to. "By service & day" is the timeline view.
  const [groupBy, setGroupBy] = useState('resource');
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('All');
  const [accountFilter, setAccountFilter] = useState('All');
  const [serviceFilter, setServiceFilter] = useState('All');
  const [regionFilter, setRegionFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [attachFilter, setAttachFilter] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minCost, setMinCost] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(null);
  const [exportNote, setExportNote] = useState(null);

  const { data, isLoading, isFetching, isError } = useCostReport(accountId, days, open, groupBy);
  const rows = data?.rows || [];
  const byResource = groupBy === 'resource';

  // AWS has no per-resource billing (Cost Explorer only exposes it via a separate
  // opt-in API with 14-day retention), so resource mode comes back empty there.
  // Rather than greet the user with a blank panel, fall back to the view that
  // does work — once, and only when we truly got zero rows.
  const [autoFellBack, setAutoFellBack] = useState(false);
  useEffect(() => {
    if (!open || isLoading || !data) return;
    if (byResource && rows.length === 0 && !autoFellBack) {
      setAutoFellBack(true);
      setGroupBy('service');
    }
  }, [open, isLoading, data, byResource, rows.length, autoFellBack]);

  const uniqSorted = (key, source) => Array.from(new Set(source.map((r) => r[key]).filter(Boolean))).sort();

  const providers = useMemo(() => uniqSorted('provider', rows), [rows]);
  const rowsInProvider = useMemo(
    () => (providerFilter === 'All' ? rows : rows.filter((r) => r.provider === providerFilter)),
    [rows, providerFilter],
  );
  const accountsInReport = useMemo(() => uniqSorted('account_name', rowsInProvider), [rowsInProvider]);
  const services = useMemo(() => uniqSorted('service', rows), [rows]);
  const regions = useMemo(() => uniqSorted('region', rows), [rows]);
  const resourceTypes = useMemo(() => uniqSorted('resource_type', rows), [rows]);
  // Only worth offering a provider/account picker when more than one is present —
  // scoped to a single account these were dead controls taking up a row.
  const showProviderFilter = providers.length > 1;
  const showAccountFilter = accountsInReport.length > 1;

  const filtered = useMemo(() => {
    const minC = minCost !== '' ? parseFloat(minCost) : null;
    const maxC = maxCost !== '' ? parseFloat(maxCost) : null;
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (providerFilter !== 'All' && r.provider !== providerFilter) return false;
      if (accountFilter !== 'All' && r.account_name !== accountFilter) return false;
      if (serviceFilter !== 'All' && r.service !== serviceFilter) return false;
      if (regionFilter !== 'All' && r.region !== regionFilter) return false;
      if (typeFilter !== 'All' && r.resource_type !== typeFilter) return false;
      if (attachFilter !== 'All' && (r.attachment_status || 'NA') !== attachFilter) return false;
      // Date bounds only apply to the day-by-day shape; resource rows are totals.
      if (!byResource && dateFrom && r.date < dateFrom) return false;
      if (!byResource && dateTo && r.date > dateTo) return false;
      if (minC != null && !Number.isNaN(minC) && (r.cost ?? 0) < minC) return false;
      if (maxC != null && !Number.isNaN(maxC) && (r.cost ?? 0) > maxC) return false;
      if (s) {
        const hay = [
          r.service, r.account_name, r.region, r.provider,
          r.resource_name, r.resource_type, r.attached_to_name, r.provider_resource_id,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [rows, providerFilter, accountFilter, serviceFilter, regionFilter, typeFilter,
    attachFilter, dateFrom, dateTo, minCost, maxCost, search, byResource]);

  const totalCost = useMemo(() => filtered.reduce((sum, r) => sum + (r.cost || 0), 0), [filtered]);
  const currency = data?.currency ?? null;
  const sym = symbolFor(currency);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const hasActiveFilters = !!(search || providerFilter !== 'All' || accountFilter !== 'All'
    || serviceFilter !== 'All' || regionFilter !== 'All' || typeFilter !== 'All'
    || attachFilter !== 'All' || dateFrom || dateTo || minCost || maxCost);

  const clearFilters = () => {
    setSearch(''); setProviderFilter('All'); setAccountFilter('All');
    setServiceFilter('All'); setRegionFilter('All'); setTypeFilter('All');
    setAttachFilter('All'); setDateFrom(''); setDateTo('');
    setMinCost(''); setMaxCost(''); setPage(1);
  };

  // Resource mode carries the detail worth exporting — name, type, size, what it
  // is attached to, and the raw provider ID for anything not in inventory.
  const exportColumns = byResource
    ? [
      { key: 'resource_name', label: 'Resource Name' },
      { key: 'resource_type', label: 'Resource Type' },
      { key: 'service', label: 'Billed Service' },
      { key: 'provider', label: 'Provider' },
      { key: 'account_name', label: 'Account' },
      { key: 'region', label: 'Region' },
      { key: 'status', label: 'Status' },
      { key: 'size_gb', label: 'Size (GB)' },
      { key: 'attachment_status', label: 'Attachment' },
      { key: 'attached_to_name', label: 'Attached To' },
      { key: 'attached_to_status', label: 'Attached To Status' },
      { key: 'cost', label: `Cost (${days}d)` },
      { key: 'currency', label: 'Currency' },
      { key: 'in_inventory', label: 'In Inventory' },
      { key: 'provider_resource_id', label: 'Provider Resource ID' },
    ]
    : [
      { key: 'date', label: 'Date' },
      { key: 'provider', label: 'Provider' },
      { key: 'account_name', label: 'Account' },
      { key: 'service', label: 'Service' },
      { key: 'region', label: 'Region' },
      { key: 'cost', label: 'Cost' },
      { key: 'currency', label: 'Currency' },
    ];

  const fileStem = `cost-report-${byResource ? 'by-resource' : 'by-service'}-${days}d-${new Date().toISOString().slice(0, 10)}`;

  const handleDownloadCsv = () => {
    downloadCsv(`${fileStem}.csv`, exportColumns, filtered);
  };

  const handleDownloadPdf = async () => {
    setExporting('pdf');
    setExportNote(null);
    try {
      const pdfColumns = byResource
        ? [
          { key: 'resource_name', label: 'Resource', width: 54 },
          { key: 'resource_type', label: 'Type', width: 38 },
          { key: 'service', label: 'Service', width: 40 },
          { key: 'region', label: 'Region', width: 32 },
          { key: 'size_gb', label: 'GB', width: 18, align: 'right' },
          { key: 'attached_to_name', label: 'Attached To', width: 48 },
          { key: 'cost', label: 'Cost', width: 27, align: 'right' },
        ]
        : [
          { key: 'date', label: 'Date', width: 24 },
          { key: 'provider', label: 'Provider', width: 22 },
          { key: 'account_name', label: 'Account', width: 55 },
          { key: 'service', label: 'Service', width: 65 },
          { key: 'region', label: 'Region', width: 40 },
          { key: 'cost', label: 'Cost', width: 30, align: 'right' },
          { key: 'currency', label: 'Currency', width: 20 },
        ];
      const { truncated, rowsWritten } = await downloadCostReportPdf(
        `${fileStem}.pdf`,
        byResource ? 'Cloud Cost Report — By Resource' : 'Cloud Cost Report — By Service & Day',
        `Last ${days} days · ${filtered.length} rows · Total ${sym}${totalCost.toFixed(2)}${currency ? '' : ' (currency: NA)'}`,
        pdfColumns,
        filtered.map((r) => ({
          ...r,
          cost: r.cost != null ? r.cost.toFixed(2) : '',
          resource_name: r.resource_name || (byResource ? '(not in inventory)' : ''),
        })),
      );
      setExportNote(truncated ? `PDF capped to ${rowsWritten.toLocaleString()} of ${filtered.length.toLocaleString()} rows — use CSV for the full dataset.` : null);
    } finally {
      setExporting(null);
    }
  };

  // Filter row — search + the category selects that are worth showing (some are
  // conditional: provider/account only appear when more than one is present,
  // resource type / attachment only apply to the "by resource" shape).
  const filterFields = [
    showProviderFilter && {
      key: 'provider',
      value: providerFilter,
      onChange: (v) => { setProviderFilter(v); setAccountFilter('All'); setPage(1); },
      options: [{ id: 'All', label: 'All Providers' }, ...providers.map((p) => ({ id: p, label: p }))],
    },
    showAccountFilter && {
      key: 'account',
      value: accountFilter,
      onChange: (v) => { setAccountFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Accounts' }, ...accountsInReport.map((a) => ({ id: a, label: a }))],
    },
    {
      key: 'service',
      value: serviceFilter,
      onChange: (v) => { setServiceFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Services' }, ...services.map((s) => ({ id: s, label: s }))],
    },
    byResource && resourceTypes.length > 0 && {
      key: 'type',
      value: typeFilter,
      onChange: (v) => { setTypeFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Resource Types' }, ...resourceTypes.map((t) => ({ id: t, label: t }))],
    },
    byResource && {
      key: 'attach',
      value: attachFilter,
      onChange: (v) => { setAttachFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'Any Attachment' }, { id: 'Attached', label: 'Attached' }, { id: 'Unattached', label: 'Unattached' }],
    },
    {
      key: 'region',
      value: regionFilter,
      onChange: (v) => { setRegionFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Regions' }, ...regions.map((r) => ({ id: r, label: r }))],
    },
  ].filter(Boolean);

  // Table columns/rows for the shared Table component
  const columns = byResource
    ? [
      { key: 'resource', label: 'Resource' },
      { key: 'type', label: 'Type' },
      { key: 'service', label: 'Service' },
      { key: 'region', label: 'Region' },
      { key: 'size', label: 'Size (GB)', align: 'right' },
      { key: 'attached', label: 'Attached To' },
      { key: 'cost', label: 'Cost', align: 'right' },
    ]
    : [
      { key: 'date', label: 'Date' },
      { key: 'provider', label: 'Provider' },
      { key: 'account', label: 'Account' },
      { key: 'service', label: 'Service' },
      { key: 'region', label: 'Region' },
      { key: 'cost', label: 'Cost', align: 'right' },
    ];

  const tableRows = byResource
    ? pageRows.map((r, i) => ({
      key: i,
      cells: {
        resource: (
          <div className="max-w-[260px]">
            {r.resource_name ? (
              <span className="font-semibold text-fg">{r.resource_name}</span>
            ) : (
              <span className="text-subtle italic" title={r.provider_resource_id}>not in inventory</span>
            )}
            {r.status && (
              <Badge tone={/stop|deallocat/i.test(r.status) ? 'danger' : 'neutral'} size="xs" className="ml-1.5 uppercase tracking-wide">
                {r.status}
              </Badge>
            )}
          </div>
        ),
        type: r.resource_type || '—',
        service: r.service || '—',
        region: r.region || '—',
        size: r.size_gb != null ? Number(r.size_gb).toLocaleString() : '—',
        attached: r.attached_to_name ? (
          <span className="inline-flex items-center gap-1.5 text-fg">
            <Link2 size={12} className="shrink-0 text-accent-text" />
            {r.attached_to_name}
            {r.attached_to_status && /stop|deallocat/i.test(r.attached_to_status) && (
              <Badge tone="danger" size="xs" className="uppercase tracking-wide">stopped</Badge>
            )}
          </span>
        ) : r.attachment_status === 'Unattached' ? (
          <span className="inline-flex items-center gap-1.5 text-warning">
            <Unlink size={12} className="shrink-0" /> Unattached
          </span>
        ) : (
          <span className="text-subtle">—</span>
        ),
        cost: <span className="font-semibold text-fg">{symbolFor(r.currency)}{(r.cost ?? 0).toFixed(2)}</span>,
      },
    }))
    : pageRows.map((r, i) => ({
      key: i,
      cells: {
        date: r.date,
        provider: <Badge tone="neutral">{r.provider}</Badge>,
        account: r.account_name,
        service: r.service,
        region: r.region || '—',
        cost: <span className="font-semibold text-fg">{symbolFor(r.currency)}{(r.cost ?? 0).toFixed(2)}</span>,
      },
    }));

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-sunken"
      >
        <span className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-wider text-fg">
          <CalendarRange size={16} className="text-accent-text" />
          Detailed Cost Report
          <span className="text-[11px] font-semibold normal-case tracking-normal text-subtle">
            (up to 365 days · per resource or per service · CSV / PDF)
          </span>
        </span>
        <ChevronDown size={16} className={`text-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-5">
          {/* Date range presets */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Range:</span>
            {DAY_PRESETS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? 'subtle' : 'secondary'}
                onClick={() => { setDays(d); setPage(1); }}
              >
                Last {d} days
              </Button>
            ))}
            {(isLoading || isFetching) && (
              <span className="flex items-center gap-1.5 text-xs text-subtle">
                <Loader2 size={12} className="animate-spin" /> Querying billing APIs…
              </span>
            )}
          </div>

          {/* Grouping — the whole shape of the report, so it sits beside the range */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted">Detail:</span>
            {[
              ['resource', 'By resource', 'Every billed resource with name, type, size and what it is attached to'],
              ['service', 'By service & day', 'Daily spend per service — the timeline view'],
            ].map(([mode, label, title]) => (
              <Button
                key={mode}
                title={title}
                size="sm"
                variant={groupBy === mode ? 'subtle' : 'secondary'}
                onClick={() => { setGroupBy(mode); setPage(1); }}
              >
                {label}
              </Button>
            ))}
            {byResource && (
              <span className="text-[11px] text-muted">
                totals per resource over the window (not per-day)
              </span>
            )}
            {autoFellBack && !byResource && (
              <span className="rounded-control border border-warning/30 bg-warning-soft px-2 py-1 text-[11px] text-warning-fg">
                This provider has no per-resource billing data — switched to service &amp; day.
              </span>
            )}
          </div>

          {isError ? (
            <div className="flex items-center gap-2 py-4 text-sm text-danger">
              <AlertTriangle size={16} /> Failed to load the cost report.
            </div>
          ) : isLoading || !data ? (
            /* Must come before the content branch: `data` is undefined until the
               first response lands, and the summary/table below read from it.
               isLoading is false on a refetch that still has data, so switching
               range or grouping keeps the old rows visible instead of flashing. */
            <InlineLoading label={`Querying billing APIs for the last ${days} days…`} className="py-14" />
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">
              {byResource ? (
                <>
                  No per-resource billing data for this range. AWS is expected here — Cost Explorer only
                  exposes resource-level cost through a separate opt-in API with 14-day retention.
                  Switch to <strong>By service &amp; day</strong> for a breakdown that works on every provider.
                </>
              ) : (
                <>
                  No billing rows returned for this range — either the account has no spend, or the
                  provider&rsquo;s billing API isn&rsquo;t reachable for it. See the account&rsquo;s cost
                  summary above for details.
                </>
              )}
            </div>
          ) : (
            <>
              {/* Filters */}
              <CloudFilterBar
                search={search}
                onSearchChange={(v) => { setSearch(v); setPage(1); }}
                searchPlaceholder={byResource ? 'Search resource, type, attached-to…' : 'Search service, account, region…'}
                filters={filterFields}
              />
              <div className="flex flex-wrap items-center gap-2">
                {/* Date bounds are meaningless on per-resource totals */}
                {!byResource && (
                  <>
                    <input type="date" className={inputClass} value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
                    <span className="text-xs text-subtle">to</span>
                    <input type="date" className={inputClass} value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="To date" />
                  </>
                )}
                <input type="number" placeholder="Min cost" className={`${inputClass} w-24`} value={minCost} onChange={(e) => { setMinCost(e.target.value); setPage(1); }} />
                <input type="number" placeholder="Max cost" className={`${inputClass} w-24`} value={maxCost} onChange={(e) => { setMaxCost(e.target.value); setPage(1); }} />
                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </div>

              {/* Summary + export */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-sunken px-4 py-2.5">
                <span className="text-xs text-muted">
                  <strong className="text-fg">{filtered.length.toLocaleString()}</strong> rows ·
                  Total <strong className="text-fg">{sym}{totalCost.toFixed(2)}</strong>
                  {!currency && <span className="text-subtle"> (currency: NA)</span>}
                  {byResource && (data?.unmatched_resources ?? 0) > 0 && (
                    <span
                      className="text-subtle"
                      title="Billed resource IDs with no match in discovered inventory — usually types discovery doesn't scan (boot volumes, VNICs, DB systems) or resources deleted mid-window."
                    >
                      {' '}· {(data?.unmatched_resources ?? 0).toLocaleString()} not in inventory
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={filtered.length === 0} onClick={handleDownloadCsv}>
                    <FileSpreadsheet size={13} /> Download CSV
                  </Button>
                  <Button variant="secondary" size="sm" disabled={filtered.length === 0 || exporting !== null} onClick={handleDownloadPdf}>
                    {exporting === 'pdf' ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Download PDF
                  </Button>
                </div>
              </div>

              {exportNote && (
                <div className="rounded-control border border-warning/30 bg-warning-soft px-3 py-2 text-[11px] text-warning-fg">
                  {exportNote}
                </div>
              )}

              {/* Table */}
              <div className="card overflow-hidden">
                <Table
                  columns={columns}
                  rows={tableRows}
                  empty={<EmptyState icon="search" title="No rows match these filters" />}
                />
                <Pagination
                  page={clampedPage}
                  pageCount={totalPages}
                  total={filtered.length}
                  onPage={setPage}
                  unit="rows"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
