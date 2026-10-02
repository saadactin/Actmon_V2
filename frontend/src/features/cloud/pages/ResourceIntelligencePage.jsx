import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../components/CloudSection';
import CoverageDrawer from '../components/intelligence/CoverageDrawer';
import FindingCard from '../components/intelligence/FindingCard';
import FindingDetailDrawer from '../components/intelligence/FindingDetailDrawer';
import FindingFilters from '../components/intelligence/FindingFilters';
import IntelligenceSummary from '../components/intelligence/IntelligenceSummary';
import { useIntelligenceFindings, useIntelligenceSummary } from '../hooks/useIntelligence';
import {
  cardFilters, emptyFilters, filtersToParams, parseFilters, toApiFilters,
} from '../utils/intelligenceModel';

const PAGE = 25;

/**
 * Cloud Resource Intelligence — one workspace for what is wrong with an
 * account and what to do about it.
 *
 * Two engines feed it and stay distinct underneath: security findings are the
 * Security Center's own rows (shown, never re-evaluated), and cost,
 * rightsizing, performance, storage, network, database and reliability
 * findings come from the optimization engine, built on provider telemetry,
 * billing and configuration. The Security Center tab is unchanged and remains
 * the security workspace.
 *
 * Filters live in the URL so a shared link opens the same list; `?finding=
 * source:key` opens a finding's drawer.
 */
export default function ResourceIntelligencePage({ accountId, providerSlug }) {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const [search, setSearch] = useState(filters.search);
  const [offset, setOffset] = useState(0);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const openParam = params.get('finding') || '';
  const [openSource, openKey] = openParam.includes(':')
    ? [openParam.slice(0, openParam.indexOf(':')), openParam.slice(openParam.indexOf(':') + 1)]
    : [null, null];

  const summary = useIntelligenceSummary(accountId);
  const list = useIntelligenceFindings(accountId, toApiFilters(filters, { limit: PAGE, offset }));
  const accountRoute = providerSlug && accountId ? `/cloud/${providerSlug}-accounts/${accountId}` : null;

  const write = (nextFilters, finding = openParam) => {
    const p = filtersToParams(nextFilters);
    if (finding) p.finding = finding;
    setParams(p, { replace: true });
  };
  const setFilters = (next) => { setOffset(0); write(next); };

  // Debounced: a URL write per keystroke would refetch the list per keystroke.
  useEffect(() => { setSearch(filters.search); }, [filters.search]);
  useEffect(() => {
    if (search === filters.search) return undefined;
    const t = setTimeout(() => setFilters({ ...filters, search }), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeCard = useMemo(() => {
    const current = JSON.stringify(filtersToParams({ ...filters, search: '', sort: 'severity' }));
    const hit = (summary.data?.cards || []).find((c) => {
      const cf = cardFilters(c);
      return cf && JSON.stringify(filtersToParams(cf)) === current;
    });
    return hit?.id || null;
  }, [filters, summary.data]);

  if (!accountId) {
    return (
      <CloudSection>
        <EmptyState icon="cloud" title="Select a cloud account" body="Resource Intelligence analyses one account at a time." />
      </CloudSection>
    );
  }
  if (summary.isLoading) return <PageLoading title="Loading resource intelligence…" />;
  if (summary.isError) {
    return (
      <CloudSection>
        <EmptyState icon="alert" title="Resource Intelligence is unavailable"
          body={summary.error?.response?.data?.detail || summary.error?.message
            || 'The request failed. This is a load error, not a clean result.'} />
      </CloudSection>
    );
  }

  const data = list.data;
  const findings = data?.findings || [];
  const neverAnalyzed = !summary.data?.last_analysis;

  return (
    <div className="space-y-4">
      <IntelligenceSummary
        summary={summary.data}
        activeCard={activeCard}
        onCard={(card) => { const cf = cardFilters(card); if (cf) setFilters(cf); }}
        onCoverage={() => setCoverageOpen(true)}
      />

      {neverAnalyzed && (
        <div className="rounded-control border border-info-soft bg-info-soft px-3 py-2.5 text-[12px] leading-relaxed text-info-fg">
          <span className="font-semibold">This account has not been analyzed yet.</span> Security findings
          from the Security Center are listed below. Refresh intelligence — beside the tabs — reads 30 days
          of telemetry from the provider and analyses cost, utilization, storage, network and databases;
          Refresh all does the same as its last step.
        </div>
      )}

      <FindingFilters
        filters={{ ...filters, search }}
        facets={data?.facets}
        total={data?.total}
        onChange={(next) => {
          // Typing goes through the debounce; every other change applies now
          // (carrying whatever has been typed so far).
          if (next.search !== search) { setSearch(next.search); return; }
          setFilters({ ...next, search });
        }}
      />

      {list.isError && (
        <CloudSection>
          <EmptyState icon="alert" title="Findings could not be loaded"
            body={list.error?.response?.data?.detail || list.error?.message || 'The request failed.'} />
        </CloudSection>
      )}

      {!list.isError && list.isLoading && !data && <PageLoading title="Loading findings…" minHeight={200} />}

      {data && findings.length === 0 && (
        <CloudSection>
          <EmptyState
            icon="filter"
            title="No findings match these filters"
            body={neverAnalyzed
              ? 'No analysis has run yet, so only security findings can appear here.'
              : 'Widen the filters, or open "What was analyzed" — a check that could not decide has '
                + 'not cleared anything.'}
            action={(
              <Button size="sm" icon="filter" onClick={() => setFilters(emptyFilters())}>Clear filters</Button>
            )}
          />
        </CloudSection>
      )}

      {findings.length > 0 && (
        <ul className="space-y-2.5">
          {findings.map((f) => (
            <FindingCard
              key={`${f.source}:${f.key}`}
              finding={f}
              onOpen={() => write(filters, `${f.source}:${f.key}`)}
            />
          ))}
        </ul>
      )}

      {data && data.total > PAGE && (
        <div className="flex items-center justify-between">
          <Button size="sm" icon="chevron-left" disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </Button>
          <span className="text-xs text-muted">
            {offset + 1}–{offset + findings.length} of {data.total.toLocaleString()}
          </span>
          <Button size="sm" iconRight="chevron-right" disabled={!data.has_more}
            onClick={() => setOffset(offset + PAGE)}>
            Next
          </Button>
        </div>
      )}

      <FindingDetailDrawer
        accountId={accountId}
        accountRoute={accountRoute}
        source={openSource}
        findingKey={openKey}
        onClose={() => write(filters, '')}
      />
      <CoverageDrawer accountId={accountId} open={coverageOpen} onClose={() => setCoverageOpen(false)} />
    </div>
  );
}
