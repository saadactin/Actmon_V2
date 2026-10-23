import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import CloudSection from '../CloudSection';
import { downloadComplianceExport } from '../../api/securityCenter.api';

// What each format is FOR, not just what it is — an auditor asking for "the
// report" usually wants the PDF to sign and the workbook to sample from.
const FORMATS = [
  { id: 'pdf', label: 'PDF report', hint: 'The document to read and sign off.' },
  { id: 'xlsx', label: 'Excel workbook', hint: 'Working papers: every control, check and evidence row.' },
  { id: 'zip', label: 'Audit pack (ZIP)', hint: 'PDF + Excel + JSON, with SHA256SUMS and a README.' },
  { id: 'json', label: 'JSON', hint: 'The same pack, machine-readable, for an evidence archive.' },
];

/**
 * The Compliance tab's "Export for audit" panel.
 *
 * Scope follows the framework tile the user has selected, because the usual
 * request is one framework for one client ("ISO 27001 for KOEL"); every
 * applicable framework is one option away. The pack ID the server returns is
 * shown after a download so the user can quote which pack they sent — the
 * same ID is printed on every page of the PDF.
 */
export default function ComplianceExportPanel({ accountId, frameworks = [], selected }) {
  const [scope, setScope] = useState(selected || '');
  const [format, setFormat] = useState('pdf');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState(null);

  // Clicking a framework tile retargets the export; clearing the tile filter
  // leaves the last explicit choice alone.
  useEffect(() => {
    if (selected) setScope(selected);
  }, [selected]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setIssued(await downloadComplianceExport(accountId, {
        framework: scope || undefined, format,
      }));
    } catch (err) {
      setIssued(null);
      setError(err?.message || 'The export failed.');
    } finally {
      setBusy(false);
    }
  };

  const fmt = FORMATS.find((f) => f.id === format) || FORMATS[0];
  return (
    <CloudSection
      title="Export for audit"
      description="Control results with the evidence behind each one, every suppressed or accepted exception, the gaps that need manual evidence, and the method — sealed with a SHA-256 so the copy an auditor holds can be verified."
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0">
          <div className="mb-1 text-micro font-bold uppercase tracking-wider text-muted">Scope</div>
          <Select
            width="auto"
            size="sm"
            value={scope}
            onChange={setScope}
            aria-label="Frameworks to export"
            options={[
              { id: '', label: `All applicable frameworks (${frameworks.length})` },
              ...frameworks.map((f) => ({ id: f.framework, label: f.label })),
            ]}
          />
        </label>
        <label className="min-w-0">
          <div className="mb-1 text-micro font-bold uppercase tracking-wider text-muted">Format</div>
          <Select
            width="auto"
            size="sm"
            value={format}
            onChange={setFormat}
            aria-label="Export format"
            options={FORMATS.map(({ id, label }) => ({ id, label }))}
          />
        </label>
        <Button variant="primary" size="sm" icon="download" loading={busy} onClick={run}>
          {busy ? 'Building pack…' : 'Download'}
        </Button>
        <p className="min-w-0 pb-1.5 text-meta text-subtle">{fmt.hint}</p>
      </div>

      {issued && (
        <p className="mt-3 text-meta text-muted">
          Issued pack <span className="font-mono font-semibold text-fg">{issued.packId || '—'}</span>
          {' · '}
          <span className="break-all">{issued.filename}</span>
          {issued.sha256 && (
            <span className="block break-all font-mono text-subtle">SHA-256 {issued.sha256}</span>
          )}
        </p>
      )}
      {error && (
        <Notice tone="danger" title="Export failed." className="mt-3 mb-0">{error}</Notice>
      )}
    </CloudSection>
  );
}
