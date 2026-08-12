import { useEffect, useMemo, useState } from 'react';
import {
  FileSpreadsheet, FileText, ChevronLeft, ChevronRight, ChevronDown,
  Loader2, CalendarRange, Search, X, AlertTriangle, Link2, Unlink,
} from 'lucide-react';
import { useCostReport } from '../hooks/useCost';
import { downloadCsv } from '../utils/csvExport';
import { downloadCostReportPdf } from '../utils/costPdfExport';

const DAY_PRESETS = [30, 90, 180, 365];
const PAGE_SIZE = 50;
const CURRENCY_SYMBOLS = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };

function symbolFor(code) {
  return code ? (CURRENCY_SYMBOLS[code] ?? `${code} `) : '';
}

const selectClass = 'text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500';
const inputClass = 'text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500';

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

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-2.5 text-sm font-bold text-gray-700 uppercase tracking-wider">
          <CalendarRange size={16} className="text-blue-600" />
          Detailed Cost Report
          <span className="text-[11px] font-semibold text-gray-400 normal-case tracking-normal">
            (up to 365 days · per resource or per service · CSV / PDF)
          </span>
        </span>
        <ChevronDown size={16} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-gray-100 p-5 space-y-4">
          {/* Date range presets */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Range:</span>
            {DAY_PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => { setDays(d); setPage(1); }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                  days === d ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Last {d} days
              </button>
            ))}
            {(isLoading || isFetching) && (
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <Loader2 size={12} className="animate-spin" /> Querying billing APIs…
              </span>
            )}
          </div>

          {/* Grouping — the whole shape of the report, so it sits beside the range */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Detail:</span>
            {[
              ['resource', 'By resource', 'Every billed resource with name, type, size and what it is attached to'],
              ['service', 'By service & day', 'Daily spend per service — the timeline view'],
            ].map(([mode, label, title]) => (
              <button
                key={mode}
                title={title}
                onClick={() => { setGroupBy(mode); setPage(1); }}
                className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                  groupBy === mode ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
            {byResource && (
              <span className="text-[11px] text-gray-500">
                totals per resource over the window (not per-day)
              </span>
            )}
            {autoFellBack && !byResource && (
              <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                This provider has no per-resource billing data — switched to service &amp; day.
              </span>
            )}
          </div>

          {isError ? (
            <div className="text-sm text-red-600 flex items-center gap-2 py-4">
              <AlertTriangle size={16} /> Failed to load the cost report.
            </div>
          ) : isLoading || !data ? (
            /* Must come before the content branch: `data` is undefined until the
               first response lands, and the summary/table below read from it.
               isLoading is false on a refetch that still has data, so switching
               range or grouping keeps the old rows visible instead of flashing. */
            <div className="flex flex-col items-center justify-center gap-3 py-14">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              <span className="text-xs text-gray-500">
                Querying billing APIs for the last {days} days…
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">
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
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                  <input
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    placeholder={byResource ? 'Search resource, type, attached-to…' : 'Search service, account, region…'}
                    className={`${inputClass} pl-8 w-60`}
                  />
                </div>
                {showProviderFilter && (
                  <select className={selectClass} value={providerFilter} onChange={(e) => { setProviderFilter(e.target.value); setAccountFilter('All'); setPage(1); }}>
                    <option value="All">All Providers</option>
                    {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
                {showAccountFilter && (
                  <select className={selectClass} value={accountFilter} onChange={(e) => { setAccountFilter(e.target.value); setPage(1); }}>
                    <option value="All">All Accounts</option>
                    {accountsInReport.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                )}
                <select className={selectClass} value={serviceFilter} onChange={(e) => { setServiceFilter(e.target.value); setPage(1); }}>
                  <option value="All">All Services</option>
                  {services.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {byResource && resourceTypes.length > 0 && (
                  <select className={selectClass} value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
                    <option value="All">All Resource Types</option>
                    {resourceTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                {byResource && (
                  <select className={selectClass} value={attachFilter} onChange={(e) => { setAttachFilter(e.target.value); setPage(1); }}>
                    <option value="All">Any Attachment</option>
                    <option value="Attached">Attached</option>
                    <option value="Unattached">Unattached</option>
                  </select>
                )}
                <select className={selectClass} value={regionFilter} onChange={(e) => { setRegionFilter(e.target.value); setPage(1); }}>
                  <option value="All">All Regions</option>
                  {regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {/* Date bounds are meaningless on per-resource totals */}
                {!byResource && (
                  <>
                    <input type="date" className={inputClass} value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
                    <span className="text-xs text-gray-400">to</span>
                    <input type="date" className={inputClass} value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="To date" />
                  </>
                )}
                <input type="number" placeholder="Min cost" className={`${inputClass} w-24`} value={minCost} onChange={(e) => { setMinCost(e.target.value); setPage(1); }} />
                <input type="number" placeholder="Max cost" className={`${inputClass} w-24`} value={maxCost} onChange={(e) => { setMaxCost(e.target.value); setPage(1); }} />
                {hasActiveFilters && (
                  <button onClick={clearFilters} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
                    <X size={12} /> Clear filters
                  </button>
                )}
              </div>

              {/* Summary + export */}
              <div className="flex items-center justify-between gap-3 flex-wrap bg-gray-50 border border-gray-200 rounded-lg px-4 py-2.5">
                <span className="text-xs text-gray-600">
                  <strong className="text-gray-900">{filtered.length.toLocaleString()}</strong> rows ·
                  Total <strong className="text-gray-900">{sym}{totalCost.toFixed(2)}</strong>
                  {!currency && <span className="text-gray-400"> (currency: NA)</span>}
                  {byResource && (data?.unmatched_resources ?? 0) > 0 && (
                    <span
                      className="text-gray-400"
                      title="Billed resource IDs with no match in discovered inventory — usually types discovery doesn't scan (boot volumes, VNICs, DB systems) or resources deleted mid-window."
                    >
                      {' '}· {(data?.unmatched_resources ?? 0).toLocaleString()} not in inventory
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownloadCsv}
                    disabled={filtered.length === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <FileSpreadsheet size={13} /> Download CSV
                  </button>
                  <button
                    onClick={handleDownloadPdf}
                    disabled={filtered.length === 0 || exporting !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {exporting === 'pdf' ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Download PDF
                  </button>
                </div>
              </div>

              {exportNote && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {exportNote}
                </div>
              )}

              {/* Table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead className="bg-gray-50">
                      <tr>
                        {(byResource
                          ? ['Resource', 'Type', 'Service', 'Region', 'Size (GB)', 'Attached To', 'Cost']
                          : ['Date', 'Provider', 'Account', 'Service', 'Region', 'Cost']
                        ).map((h, i, arr) => (
                          <th
                            key={h}
                            className={`px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap ${
                              i === arr.length - 1 || h === 'Size (GB)' ? 'text-right' : 'text-left'
                            }`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pageRows.length === 0 ? (
                        <tr>
                          <td colSpan={byResource ? 7 : 6} className="px-3 py-10 text-center text-sm text-gray-500">
                            No rows match these filters.
                          </td>
                        </tr>
                      ) : byResource ? (
                        pageRows.map((r, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-xs whitespace-nowrap max-w-[260px]">
                              {r.resource_name ? (
                                <span className="font-semibold text-gray-900">{r.resource_name}</span>
                              ) : (
                                <span
                                  className="text-gray-400 italic"
                                  title={r.provider_resource_id}
                                >
                                  not in inventory
                                </span>
                              )}
                              {r.status && (
                                <span className={`ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${
                                  /stop|deallocat/i.test(r.status)
                                    ? 'bg-red-50 text-red-600 border-red-200'
                                    : 'bg-gray-100 text-gray-500 border-gray-200'
                                }`}
                                >
                                  {r.status}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{r.resource_type || '—'}</td>
                            <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{r.service || '—'}</td>
                            <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{r.region || '—'}</td>
                            <td className="px-3 py-2 text-xs text-right text-gray-700 whitespace-nowrap tabular-nums">
                              {r.size_gb != null ? Number(r.size_gb).toLocaleString() : '—'}
                            </td>
                            <td className="px-3 py-2 text-xs whitespace-nowrap">
                              {r.attached_to_name ? (
                                <span className="inline-flex items-center gap-1.5 text-gray-700">
                                  <Link2 size={12} className="text-blue-500 shrink-0" />
                                  {r.attached_to_name}
                                  {r.attached_to_status && /stop|deallocat/i.test(r.attached_to_status) && (
                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 text-[9px] font-bold uppercase">
                                      stopped
                                    </span>
                                  )}
                                </span>
                              ) : r.attachment_status === 'Unattached' ? (
                                <span className="inline-flex items-center gap-1.5 text-amber-600">
                                  <Unlink size={12} className="shrink-0" /> Unattached
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-right font-semibold text-gray-900 whitespace-nowrap tabular-nums">
                              {symbolFor(r.currency)}{(r.cost ?? 0).toFixed(2)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        pageRows.map((r, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{r.date}</td>
                            <td className="px-3 py-2 text-xs whitespace-nowrap">
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-gray-100 text-gray-600 border-gray-200">
                                {r.provider}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{r.account_name}</td>
                            <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{r.service}</td>
                            <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{r.region || '—'}</td>
                            <td className="px-3 py-2 text-xs text-right font-semibold text-gray-900 whitespace-nowrap tabular-nums">
                              {symbolFor(r.currency)}{(r.cost ?? 0).toFixed(2)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50">
                  <span className="text-[11px] text-gray-500">
                    Page {clampedPage} of {totalPages}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={clampedPage <= 1}
                      className="p-1 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                    >
                      <ChevronLeft size={13} />
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={clampedPage >= totalPages}
                      className="p-1 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                    >
                      <ChevronRight size={13} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
