import { categoryTone, formatPct, statusMeta } from '../../utils/resourceModel';
import { BarRow, Panel, PanelEmpty, ViewLink } from './OverviewPrimitives';

/**
 * What exists, where it is, and what state it is in.
 *
 * All three panels read the facet counts the resource query layer already
 * computed in the database for this account. Nothing here counts resources —
 * that is what made the old Overview download the whole estate, and it is also
 * how a dashboard ends up disagreeing with the page it links to.
 *
 * Horizontal bars rather than pies: the questions here are "how much of the
 * estate" and "which is biggest", and a bar answers both at a glance at any
 * count, where a nine-slice donut answers neither.
 */

export function ResourceLandscape({
  facets, total, isLoading, error, onOpenType, onOpenCategory, region,
}) {
  const categories = facets?.categories || [];
  const types = facets?.types || [];

  return (
    <Panel
      title="Resource Landscape"
      icon="boxes"
      // States its own scope. A panel narrowed to one region sitting beside an
      // account-wide cost figure, with nothing saying so, invites a comparison
      // that is simply wrong.
      subtitle={total
        ? `${total.toLocaleString()} resources${region ? ` in ${region}` : ' in this account'}`
        : undefined}
      action={<ViewLink onClick={() => onOpenCategory(null)}>Resources</ViewLink>}
      loading={isLoading}
      error={error}
      empty={!isLoading && !error && categories.length === 0}
      emptyMessage="No resources have been discovered for this account."
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-micro font-bold uppercase tracking-wider text-subtle">
            By category
          </p>
          <div className="space-y-0.5">
            {categories.slice(0, 7).map((facet) => (
              <BarRow
                key={facet.value}
                label={facet.label}
                value={facet.count}
                total={total}
                tone={categoryTone(facet.value)}
                onClick={() => onOpenCategory(facet.value)}
                title={`${facet.label}: ${facet.count} resources (${formatPct(total ? (facet.count / total) * 100 : null)} of inventory)`}
              />
            ))}
          </div>
        </div>

        {types.length > 0 && (
          <div>
            <p className="mb-1.5 text-micro font-bold uppercase tracking-wider text-subtle">
              Top resource types
            </p>
            <div className="space-y-0.5">
              {types.slice(0, 6).map((facet) => (
                <BarRow
                  key={facet.value}
                  label={facet.label}
                  value={facet.count}
                  total={total}
                  tone="accent"
                  onClick={() => onOpenType(facet.value)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function RegionDistribution({
  facets, total, isLoading, error, onOpenRegion,
}) {
  const regions = facets?.regions || [];
  return (
    <Panel
      title="Regional Distribution"
      icon="globe"
      subtitle={regions.length ? `${regions.length} region${regions.length === 1 ? '' : 's'}` : undefined}
      loading={isLoading}
      error={error}
      empty={!isLoading && !error && regions.length === 0}
      emptyMessage="No region was reported for any resource in this account."
    >
      <div className="space-y-0.5">
        {regions.slice(0, 8).map((facet) => (
          <BarRow
            key={facet.value}
            label={facet.label}
            value={facet.count}
            total={total}
            tone="info"
            onClick={() => onOpenRegion(facet.value)}
            title={`${facet.label}: ${facet.count} resources (${formatPct(total ? (facet.count / total) * 100 : null)})`}
          />
        ))}
      </div>
      {regions.length > 0 && total > 0 && (
        <p className="mt-2 border-t border-border pt-2 text-meta text-muted">
          {`${regions[0].label} holds ${formatPct((regions[0].count / total) * 100)} of this account's inventory.`}
        </p>
      )}
    </Panel>
  );
}

export function StatusDistribution({
  facets, summary, total, isLoading, error, onOpenStatus, region,
}) {
  const statuses = facets?.statuses || [];
  const unknown = summary?.status_unknown_count ?? 0;
  const reported = Math.max(0, (total || 0) - unknown);
  const coverage = total ? (reported / total) * 100 : null;

  return (
    <Panel
      title="Resource State"
      icon="activity"
      subtitle={`Normalized across providers${region ? ` · ${region}` : ''}; the provider's own word is kept on each resource`}
      loading={isLoading}
      error={error}
      empty={!isLoading && !error && statuses.length === 0}
      emptyMessage="No resource state information is available."
    >
      <div className="space-y-0.5">
        {statuses.map((facet) => {
          const meta = statusMeta(facet.value);
          return (
            <BarRow
              key={facet.value}
              label={meta.label}
              value={facet.count}
              total={total}
              tone={meta.tone === 'neutral' ? 'neutral' : meta.tone}
              onClick={() => onOpenStatus(facet.value)}
              title={
                facet.value === 'UNKNOWN'
                  ? 'The provider reported no lifecycle state for these resources. They are not assumed healthy.'
                  : `${meta.label}: ${facet.count}`
              }
            />
          );
        })}
      </div>

      {/* Without this line, resources whose state nobody reported simply
          vanish from the reader's mental total. */}
      {total > 0 && (
        <div className="mt-3 border-t border-border pt-2 text-meta text-muted">
          <span className="font-semibold text-fg">{`${reported.toLocaleString()} / ${total.toLocaleString()}`}</span>
          {` resources have a provider-reported state (${formatPct(coverage)}).`}
          {unknown > 0 && ' The rest are shown as “Not reported”, which is not the same as healthy.'}
        </div>
      )}
    </Panel>
  );
}
