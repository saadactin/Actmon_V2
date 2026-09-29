import { useMemo, useState } from 'react';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/Table';
import { InlineLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { BucketStrip, CertificateTable, SourcesTable } from '../certificates/CertificatePrimitives';
import { useAccountCertificates } from '../../hooks/useCertificates';
import { bucketMeta, KIND_ORDER, kindMeta } from '../../utils/clientModel';
import { formatDateTime } from '../../utils/securityModel';

/**
 * One account's certificates, secrets and keys — the Security Center tab.
 *
 * Expired certificates are findings (and compliance failures); expiring ones
 * are operational warnings. Both come from the inventory shown here, so the
 * tab and the findings list cannot disagree about what exists.
 */
export default function SecurityCertificates({ accountId, onOpenFinding }) {
  const { data, isLoading, isError, error } = useAccountCertificates(accountId);
  const [bucket, setBucket] = useState(null);
  const [kind, setKind] = useState('');

  const objects = useMemo(() => (data?.objects || []).filter((o) => (
    (!bucket || o.bucket === bucket) && (!kind || o.kind === kind)
  )), [data, bucket, kind]);

  if (isLoading) return <InlineLoading label="Loading certificates and secrets…" />;
  if (isError) {
    return (
      <CloudSection>
        <EmptyState
          icon="alert"
          title="Certificates unavailable"
          body={error?.response?.data?.detail || error?.message
            || 'The request failed. This is a load error, not an empty inventory.'}
        />
      </CloudSection>
    );
  }

  const summary = data?.summary || {};

  return (
    <div className="space-y-5">
      {/* No "Collect now": every refresh reads every store, then re-assesses,
          so the header's Refresh all is the one way to re-read them. */}
      <p className="max-w-3xl text-[12px] leading-relaxed text-muted">{data?.note}</p>

      {data?.never_collected ? (
        <CloudSection>
          <EmptyState
            icon="lock"
            title="Not collected yet"
            body="No certificate, secret or key store has been read for this account. Every refresh reads them — use Refresh all at the top of the page. Until then this is unknown — not empty."
          />
        </CloudSection>
      ) : (
        <>
          {summary.sources_failing > 0 && (
            <Notice tone="warning" title={`${summary.sources_failing} of ${summary.sources_total} store scope(s) could not be read.`}>
              Their last known objects are kept and shown below, so the list may be out of date
              for those stores — it is never reported as empty. The Stores table says why each
              failed{summary.sources_actionable ? ' and what permission would fix it' : ''}.
            </Notice>
          )}

          {summary.certificates_unreadable > 0 && (
            <Notice tone="warning" title={`${summary.certificates_unreadable} certificate(s) could not be parsed.`}>
              Their stores listed them, but their expiry could not be read, so they are not in
              the inventory below. The Stores table names each one.
            </Notice>
          )}

          <BucketStrip byBucket={summary.by_bucket} onSelect={setBucket} active={bucket} />

          <CloudSection
            title="Inventory"
            description={bucket
              ? `Showing ${bucketMeta(bucket).label.toLowerCase()} only — click the tile again to clear.`
              : 'Soonest expiry first. Thresholds: expiring within '
                + `${data?.thresholds?.expiring_days ?? 30} days, urgent within ${data?.thresholds?.urgent_days ?? 7}.`}
            action={(
              <Select
                width="auto"
                size="sm"
                value={kind}
                onChange={setKind}
                options={[{ id: '', label: 'All kinds' },
                  ...KIND_ORDER.map((k) => ({ id: k, label: kindMeta(k).label }))]}
              />
            )}
            bodyClassName="p-0"
          >
            <CertificateTable objects={objects} onOpenFinding={onOpenFinding} />
          </CloudSection>

          <CloudSection
            title="Stores"
            description={`Each store this account's credentials were asked to list. Last collection ${
              formatDateTime((data?.sources || []).reduce((latest, s) => (
                s.last_attempt_at && (!latest || s.last_attempt_at > latest) ? s.last_attempt_at : latest
              ), null))}.`}
            bodyClassName="p-0"
          >
            <SourcesTable sources={data?.sources} />
          </CloudSection>
        </>
      )}
    </div>
  );
}
