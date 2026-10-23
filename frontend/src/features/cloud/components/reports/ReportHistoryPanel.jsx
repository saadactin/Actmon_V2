import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { Section } from '@/components/ui/Field';
import { downloadHistoryReport } from '../../api/reports.api';
import { useDeleteHistoryReport, useReportHistory } from '../../hooks/useReports';
import { deliveryMeta, formatBytes, reportStatusMeta } from '../../utils/clientModel';
import { errorMessage } from '../../utils/reportModel';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Every report generated for this account, newest first: the file (when it
 * was kept), what produced it, and — for a scheduled one — what happened to
 * its e-mail. "Queued" is the furthest this service can see; whether it was
 * sent is recorded by the dispatcher in notification history.
 */
export default function ReportHistoryPanel({ accountId }) {
  const history = useReportHistory(accountId);
  const remove = useDeleteHistoryReport(accountId);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const download = async (r) => {
    setError(null);
    setBusy(r.id);
    try {
      await downloadHistoryReport(accountId, r.id, r.filename || 'report');
    } catch (err) {
      setError(await errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (history.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
        <Icon name="spinner" size={16} className="animate-spin" />
        Loading report history...
      </div>
    );
  }
  if (history.isError) {
    return <Notice tone="danger" title="Could not load report history">{history.error?.message}</Notice>;
  }

  const reports = history.data?.reports || [];
  return (
    <Section title="Report History">
      <p className="text-meta text-subtle">
        The last {history.data?.keep ?? 30} reports for this account are kept, newest first. Each one is
        the baseline the next report compares against under "Since the last report".
      </p>
      {error && <Notice tone="danger" title="Download failed">{error}</Notice>}
      {reports.length === 0 ? (
        <Notice tone="info">No reports yet. Generate one from the Build tab, or set up a schedule.</Notice>
      ) : (
        <div className="overflow-x-auto rounded-control border border-border">
          <table className="w-full border-collapse text-left text-meta">
            <thead className="bg-sunken">
              <tr>
                {['Generated', 'Report', 'Period', 'Resources', 'File', 'E-mail', ''].map((h) => (
                  <th key={h} className="px-2.5 py-1.5 font-semibold text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const status = reportStatusMeta(r.status);
                const delivery = deliveryMeta(r.delivery_status);
                return (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-2.5 py-1.5 text-fg">
                      {when(r.generated_at)}
                      <span className="block text-subtle">{r.trigger === 'schedule' ? 'Scheduled' : `By ${r.requested_by || 'hand'}`}</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-fg">
                      {r.title || r.template_name || 'Resource assessment'}
                      {r.status !== 'GENERATED' && (
                        <span className="mt-0.5 block"><Badge tone={status.tone} size="xs">{status.label}</Badge></span>
                      )}
                      {r.error && <span className="block text-danger-fg">{r.error}</span>}
                    </td>
                    <td className="px-2.5 py-1.5 text-fg">{r.period_start ? `${r.period_start} to ${r.period_end}` : '—'}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-fg">{r.resources ?? '—'}</td>
                    <td className="px-2.5 py-1.5 text-fg">
                      {(r.format || '').toUpperCase()} · {formatBytes(r.size_bytes)}
                      {r.content_note && <span className="block text-subtle">{r.content_note}</span>}
                    </td>
                    <td className="px-2.5 py-1.5" title={r.delivery_message || delivery.hint}>
                      <Badge tone={delivery.tone} size="xs">{delivery.label}</Badge>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="download"
                          disabled={!r.downloadable}
                          loading={busy === r.id}
                          onClick={() => download(r)}
                        >
                          Download
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(r)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Delete this report?"
        message="The stored file and its summary are removed from history. The next report will compare against the one before it."
        confirmLabel="Delete"
        cancelLabel="Keep"
        tone="danger"
        loading={remove.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(confirm.id);
          } catch (err) {
            setError(await errorMessage(err));
          }
          setConfirm(null);
        }}
      />
    </Section>
  );
}
