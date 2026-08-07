import React, { useMemo, useState } from 'react';
import {
  FileSpreadsheet, FileText, ChevronLeft, ChevronRight, ChevronDown,
  Loader2, CalendarRange, Search, X, AlertTriangle,
} from 'lucide-react';
import { useCostReport } from '../hooks/useCost';
import { downloadCsv } from '../utils/csvExport';
import { downloadCostReportPdf } from '../utils/costPdfExport';

interface Props {
  accountId: string | null;
  /** Controlled open state. Omit to let the panel manage its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const DAY_PRESETS = [30, 90, 180, 365];
const PAGE_SIZE = 50;
const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };

function symbolFor(code?: string | null): string {
  return code ? (CURRENCY_SYMBOLS[code] ?? `${code} `) : '';
}

const selectClass = 'text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500';
const inputClass = 'text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500';

export const CostReportPanel: React.FC<Props> = ({ accountId, open: openProp, onOpenChange }) => {
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const setOpen = (next: boolean) => {
    setOpenSelf(next);
    onOpenChange?.(next);
  };
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('All');
  const [accountFilter, setAccountFilter] = useState('All');
  const [serviceFilter, setServiceFilter] = useState('All');
  const [regionFilter, setRegionFilter] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minCost, setMinCost] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const { data, isLoading, isFetching, isError } = useCostReport(accountId, days, open);
  const rows: any[] = data?.rows || [];

  const uniqSorted = (key: string, source: any[]) =>
    Array.from(new Set(source.map(r => r[key]).filter(Boolean))).sort();

  const providers = useMemo(() => uniqSorted('provider', rows), [rows]);
  const rowsInProvider = useMemo(
    () => (providerFilter === 'All' ? rows : rows.filter(r => r.provider === providerFilter)),
    [rows, providerFilter],
  );
  const accountsInReport = useMemo(() => uniqSorted('account_name', rowsInProvider), [rowsInProvider]);
  const services = useMemo(() => uniqSorted('service', rows), [rows]);
  const regions = useMemo(() => uniqSorted('region', rows), [rows]);

  const filtered = useMemo(() => {
    const minC = minCost !== '' ? parseFloat(minCost) : null;
    const maxC = maxCost !== '' ? parseFloat(maxCost) : null;
    const s = search.trim().toLowerCase();
    return rows.filter(r => {
      if (providerFilter !== 'All' && r.provider !== providerFilter) return false;
      if (accountFilter !== 'All' && r.account_name !== accountFilter) return false;
      if (serviceFilter !== 'All' && r.service !== serviceFilter) return false;
      if (regionFilter !== 'All' && r.region !== regionFilter) return false;
      if (dateFrom && r.date < dateFrom) return false;
      if (dateTo && r.date > dateTo) return false;
      if (minC != null && !Number.isNaN(minC) && (r.cost ?? 0) < minC) return false;
      if (maxC != null && !Number.isNaN(maxC) && (r.cost ?? 0) > maxC) return false;
      if (s) {
        const hay = `${r.service || ''} ${r.account_name || ''} ${r.region || ''} ${r.provider || ''}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [rows, providerFilter, accountFilter, serviceFilter, regionFilter, dateFrom, dateTo, minCost, maxCost, search]);

  const totalCost = useMemo(() => filtered.reduce((sum, r) => sum + (r.cost || 0), 0), [filtered]);
  const currency: string | null = data?.currency ?? null;
  const sym = symbolFor(currency);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const hasActiveFilters = !!(search || providerFilter !== 'All' || accountFilter !== 'All' ||
    serviceFilter !== 'All' || regionFilter !== 'All' || dateFrom || dateTo || minCost || maxCost);

  const clearFilters = () => {
    setSearch(''); setProviderFilter('All'); setAccountFilter('All');
    setServiceFilter('All'); setRegionFilter('All'); setDateFrom(''); setDateTo('');
    setMinCost(''); setMaxCost(''); setPage(1);
  };

  const exportColumns = [
    { key: 'date', label: 'Date' },
    { key: 'provider', label: 'Provider' },
    { key: 'account_name', label: 'Account' },
    { key: 'service', label: 'Service' },
    { key: 'region', label: 'Region' },
    { key: 'cost', label: 'Cost' },
    { key: 'currency', label: 'Currency' },
  ];

  const handleDownloadCsv = () => {
    downloadCsv(`cost-report-${days}d-${new Date().toISOString().slice(0, 10)}.csv`, exportColumns, filtered);
  };

  const handleDownloadPdf = async () => {
    setExporting('pdf');
    setExportNote(null);
    try {
      const { truncated, rowsWritten } = await downloadCostReportPdf(
        `cost-report-${days}d-${new Date().toISOString().slice(0, 10)}.pdf`,
        'Cloud Cost Report',
        `Last ${days} days · ${filtered.length} rows · Total ${sym}${totalCost.toFixed(2)}${currency ? '' : ' (currency: NA)'}`,
        [
          { key: 'date', label: 'Date', width: 24 },
          { key: 'provider', label: 'Provider', width: 22 },
          { key: 'account_name', label: 'Account', width: 55 },
          { key: 'service', label: 'Service', width: 65 },
          { key: 'region', label: 'Region', width: 40 },
          { key: 'cost', label: 'Cost', width: 30, align: 'right' as const },
          { key: 'currency', label: 'Currency', width: 20 },
        ],
        filtered.map(r => ({ ...r, cost: r.cost != null ? r.cost.toFixed(2) : '' })),
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
          Detailed Cost Report — All Providers
          <span className="text-[11px] font-semibold text-gray-400 normal-case tracking-normal">
            (up to 365 days, per-service, all filters)
          </span>
        </span>
        <ChevronDown size={16} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-gray-100 p-5 space-y-4">
          {/* Date range presets */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Range:</span>
            {DAY_PRESETS.map(d => (
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

          {isError ? (
            <div className="text-sm text-red-600 flex items-center gap-2 py-4">
              <AlertTriangle size={16} /> Failed to load the cost report.
            </div>
          ) : !isLoading && rows.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">
              No billing rows returned for this range — either the account has no spend, or the provider's
              per-service billing API isn't reachable for it. See the account's cost summary above for details.
            </div>
          ) : (
            <>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                  <input
                    value={search}
                    onChange={e => { setSearch(e.target.value); setPage(1); }}
                    placeholder="Search service, account, region…"
                    className={`${inputClass} pl-8 w-56`}
                  />
                </div>
                <select className={selectClass} value={providerFilter} onChange={e => { setProviderFilter(e.target.value); setAccountFilter('All'); setPage(1); }}>
                  <option value="All">All Providers</option>
                  {providers.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <select className={selectClass} value={accountFilter} onChange={e => { setAccountFilter(e.target.value); setPage(1); }}>
                  <option value="All">All Accounts</option>
                  {accountsInReport.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <select className={selectClass} value={serviceFilter} onChange={e => { setServiceFilter(e.target.value); setPage(1); }}>
                  <option value="All">All Services</option>
                  {services.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className={selectClass} value={regionFilter} onChange={e => { setRegionFilter(e.target.value); setPage(1); }}>
                  <option value="All">All Regions</option>
                  {regions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input type="date" className={inputClass} value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
                <span className="text-xs text-gray-400">to</span>
                <input type="date" className={inputClass} value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} title="To date" />
                <input type="number" placeholder="Min cost" className={`${inputClass} w-24`} value={minCost} onChange={e => { setMinCost(e.target.value); setPage(1); }} />
                <input type="number" placeholder="Max cost" className={`${inputClass} w-24`} value={maxCost} onChange={e => { setMaxCost(e.target.value); setPage(1); }} />
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
                        <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Date</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Provider</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Account</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Service</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Region</th>
                        <th className="px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pageRows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-10 text-center text-sm text-gray-500">
                            No rows match these filters.
                          </td>
                        </tr>
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
                            <td className="px-3 py-2 text-xs text-right font-semibold text-gray-900 whitespace-nowrap">
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
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={clampedPage <= 1}
                      className="p-1 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                    >
                      <ChevronLeft size={13} />
                    </button>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
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
