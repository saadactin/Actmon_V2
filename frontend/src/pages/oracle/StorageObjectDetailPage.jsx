import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Textarea from '@/components/ui/Textarea';
import { PageLoading } from '@/components/ui/Loading';
import Stepper from '@/components/ui/Stepper';
import Toasts, { useToasts } from '@/components/ui/Toast';
import Meter from '@/components/charts/Meter';
import { fmtBytes, fmtNumber } from '@/config/dbCatalog';
import { STATUS_TONES, EXECUTABLE_ACTIONS, ACTION_LABELS, JOB_STATUS_TONES, fmtIST } from './storageHealthConstants';

/**
 * Real page (not a modal) for one storage object — a tablespace, datafile,
 * segment, index or partition — opened by clicking a row on Storage Health.
 * Same navigation shape as the Slow Query detail page: the row's data
 * travels via router state, and a hard refresh with nothing to show falls
 * back to "go back and pick one" rather than pretending to recover it.
 *
 * Finding / Explanation / Related Maintenance are the only things shown by
 * default — everything else (real blocks, the DBA_TABLES dictionary, live
 * system load, the impact estimate, Ask ActMon AI) is a click-to-open
 * accordion so the page starts short and only grows when asked.
 */

const TITLES = { datafile: 'Datafile', tablespace: 'Tablespace', segment: 'Segment', index: 'Index', partition: 'Partition' };
const ICONS = { datafile: 'desktop', tablespace: 'database', segment: 'table', index: 'layers', partition: 'layers' };
const BLOCK_DETAIL_TYPES = new Set(['datafile', 'tablespace', 'segment']);
const ACTIVE_JOB_STATUSES = new Set(['pending_approval', 'approved', 'running']);

function paramsFor(target) {
  const { object_type, file_id, file_name, tablespace_name, owner, segment_name } = target;
  const p = { object_type };
  if (object_type === 'datafile') {
    if (file_id) p.file_id = file_id;
    else p.file_name = file_name;
  } else if (object_type === 'tablespace') {
    p.tablespace_name = tablespace_name;
  } else if (object_type === 'segment') {
    p.owner = owner;
    p.segment_name = segment_name;
  }
  return p;
}

function titleCase(snake) {
  return snake.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Every finding's evidence string is "key=value, key=value, ..." — turn it
 * into readable chips instead of one dense sentence of raw text. */
function parseEvidence(str) {
  if (!str) return [];
  return str.split(/,\s+/).map((part) => {
    const m = part.trim().match(/^([a-zA-Z0-9_ ]+)=(.+?)\.?$/);
    if (m) return { label: titleCase(m[1].trim().replace(/ /g, '_')), value: m[2].trim() };
    return { label: null, value: part.trim() };
  }).filter((p) => p.value);
}

function objectNameFor(target, data) {
  if (target.finding) return target.finding.object_name;
  if (target.object_type === 'tablespace') return target.tablespace_name || data?.tablespace_name;
  if (target.object_type === 'datafile') return target.file_name || data?.file_name;
  if (target.object_type === 'segment') return `${target.owner || data?.owner}.${target.segment_name || data?.segment_name}`;
  return target.label;
}

function plainEnglishSummary(target, data) {
  if (target.object_type === 'segment' && data) {
    const usedMb = data.num_rows != null && data.avg_row_len != null ? (data.num_rows * data.avg_row_len) / 1024 / 1024 : null;
    const sizeMb = data.size_mb ?? 0;
    const emptyPct = usedMb != null && sizeMb > 0 ? Math.max(0, Math.round((1 - usedMb / sizeMb) * 100)) : null;
    if (emptyPct != null) {
      return `This table takes up ${fmtBytes(data.size_bytes ?? sizeMb * 1024 * 1024)} on disk, but based on its ${fmtNumber(data.num_rows)} rows, only about ${100 - emptyPct}% of that is real data. Roughly ${emptyPct}% is empty space left behind by deleted rows that Oracle hasn't given back to the tablespace yet.`;
    }
    return `This table takes up ${fmtBytes(data.size_bytes ?? sizeMb * 1024 * 1024)} on disk across ${fmtNumber(data.blocks)} storage blocks.`;
  }
  if ((target.object_type === 'datafile' || target.object_type === 'tablespace') && data?.blocks && typeof data.blocks === 'object') {
    const b = data.blocks;
    const noun = target.object_type === 'tablespace' ? 'tablespace' : 'datafile';
    return `This ${noun} is ${fmtBytes(data.size_bytes)} in total. About ${b.used_pct}% of it (${fmtBytes(data.used_bytes)}) actually holds data, and the remaining ${(100 - b.used_pct).toFixed(1)}% (${fmtBytes(data.free_bytes)}) is free space still reserved for this ${noun} but not yet used.`;
  }
  if (target.object_type === 'index' && target.raw) {
    const r = target.raw;
    return `This is a ${r.index_type || 'B-tree'} index on ${r.table_name}, currently ${r.status === 'VALID' ? 'valid and usable' : `in ${r.status} status, which usually means it needs a rebuild`}. It uses ${fmtNumber(r.leaf_blocks)} leaf blocks to store ${r.num_rows != null ? `${fmtNumber(r.num_rows)} index entries` : 'its entries'}.`;
  }
  if (target.object_type === 'partition' && target.raw) {
    const r = target.raw;
    return `This is one partition of ${r.owner}.${r.table_name}, holding ${r.num_rows != null ? `${fmtNumber(r.num_rows)} rows` : 'an unknown number of rows'} and taking up ${r.size_mb != null ? `${fmtNumber(r.size_mb)} MB` : 'an unmeasured amount of space'}.`;
  }
  return null;
}

/** Rough, clearly-labelled impact estimate — never a fabricated precise
 * number. The volume is real (from the object's own measured size); the
 * duration is a stated assumption range, not a measurement. */
function impactEstimate(target, data) {
  const f = target.finding;
  if (!f || !EXECUTABLE_ACTIONS.has(f.recommended_action)) return null;

  let volumeBytes = null;
  if (target.object_type === 'segment' && data) {
    volumeBytes = (data.size_bytes ?? (data.size_mb || 0) * 1024 * 1024);
  } else if (target.object_type === 'index' && target.raw?.leaf_blocks) {
    volumeBytes = target.raw.leaf_blocks * 8192;
  }
  if (!volumeBytes) return null;

  const volumeMb = volumeBytes / 1024 / 1024;
  const lowSec = volumeMb / 80;   // optimistic: 80 MB/s
  const highSec = volumeMb / 15;  // conservative: 15 MB/s
  const fmtDur = (s) => (s < 60 ? `${Math.max(1, Math.round(s))}s` : `${Math.round(s / 60)}m`);

  return {
    volumeText: fmtBytes(volumeBytes),
    durationText: `${fmtDur(lowSec)}–${fmtDur(highSec)}`,
  };
}

export default function StorageObjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { state } = useLocation();
  const { toasts, push, dismiss } = useToasts();
  const target = state?.target;
  const backTo = `/oracle-dashboard/${id}/storage-health`;

  const [open, setOpen] = useState({});
  const toggle = (key) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  const [precise, setPrecise] = useState(null);
  const [dictStep, setDictStep] = useState(1);
  const [aiThread, setAiThread] = useState([]);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const wantsBlockDetail = !!target && BLOCK_DETAIL_TYPES.has(target.object_type);

  // Fetched eagerly (not gated behind the accordion) — the Explanation and
  // Estimated Impact sections need it even before "Real Space & Blocks" is
  // opened. Only its detailed display is click-to-reveal.
  const blockQ = useQuery({
    queryKey: ['oracleStorageBlockDetail', id, target?.object_type, target?.file_id, target?.file_name, target?.tablespace_name, target?.owner, target?.segment_name],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-storage-block-detail`, { params: paramsFor(target) }).then((r) => r.data),
    enabled: wantsBlockDetail,
    retry: false,
  });

  // Genuinely lazy — nothing fetches until the user opens that accordion.
  const loadQ = useQuery({
    queryKey: ['oracleDashboardLoad', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-dashboard`).then((r) => r.data),
    enabled: !!target && !!open.load,
    retry: false,
    refetchInterval: 30000,
  });

  const jobsQ = useQuery({
    queryKey: ['oracleMaintenanceJobs', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-storage-maintenance/jobs`).then((r) => r.data),
    enabled: !!target,
    retry: false,
    refetchInterval: 20000,
  });

  const wantsTableDict = !!target && target.object_type === 'segment' && !!target.owner && !!target.segment_name && !!open.dict;
  const tableDictQ = useQuery({
    queryKey: ['oracleTableDictionary', id, target?.owner, target?.segment_name],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-table-dictionary`, { params: { owner: target.owner, table_name: target.segment_name } }).then((r) => r.data),
    enabled: wantsTableDict,
    retry: false,
  });

  const requestMut = useMutation({
    mutationFn: ({ object_type, object_name }) => client
      .post(`/connections/oracle/${id}/oracle-storage-maintenance/request`, { object_type, object_name })
      .then((r) => r.data),
    onSuccess: () => {
      push('Maintenance requested — pending approval.', 'success');
      qc.invalidateQueries({ queryKey: ['oracleMaintenanceJobs', id] });
      qc.invalidateQueries({ queryKey: ['oracleStorageFindings', id] });
    },
    onError: (e) => push(errorText(e), 'error'),
  });

  const preciseMut = useMutation({
    mutationFn: ({ owner, segment_name, segment_type }) => client
      .get(`/connections/oracle/${id}/oracle-storage-precise-check`, { params: { owner, segment_name, segment_type } })
      .then((r) => r.data),
  });

  const runPreciseCheck = () => {
    if (!target) return;
    const owner = target.owner ?? data?.owner;
    const segment_name = target.segment_name ?? data?.segment_name;
    preciseMut.mutate(
      { owner, segment_name, segment_type: 'TABLE' },
      {
        onSuccess: (d) => setPrecise({ ok: true, data: d }),
        onError: (e) => setPrecise({ ok: false, message: errorText(e) }),
      },
    );
  };

  if (!target) {
    return (
      <>
        <PageHeader title="Storage Object" icon="database" backTo={backTo} />
        <Notice tone="info" title="No object selected.">
          This page shows detail for one object handed to it from Storage Health — open it by clicking a row there.
        </Notice>
        <Button variant="primary" iconRight="chevron-right" onClick={() => navigate(backTo)}>Open Storage Health</Button>
      </>
    );
  }

  const data = blockQ.data?.status === 'success' ? blockQ.data : null;
  const f = target.finding;
  const jobs = jobsQ.data?.jobs || [];
  const objectName = objectNameFor(target, data);
  const relatedJobs = jobs.filter((j) => j.object_type === target.object_type && j.object_name === objectName)
    .sort((a, b) => new Date(b.requested_at || 0) - new Date(a.requested_at || 0));
  const activeJob = relatedJobs.find((j) => ACTIVE_JOB_STATUSES.has(j.status));

  const executable = f && EXECUTABLE_ACTIONS.has(f.recommended_action);
  const summary = plainEnglishSummary(target, data);
  const impact = impactEstimate(target, data);
  const hs = loadQ.data?.health_summary || {};
  const evidenceChips = parseEvidence(f?.evidence);

  const blocksIsBreakdown = data?.blocks && typeof data.blocks === 'object';

  const askAi = async (question) => {
    setAiLoading(true);
    try {
      const facts = {};
      if (data?.size_bytes != null) facts.size = fmtBytes(data.size_bytes);
      if (data?.block_size) facts.block_size = fmtBytes(data.block_size);
      if (blocksIsBreakdown) {
        facts.total_blocks = data.blocks.total; facts.used_blocks = data.blocks.used;
        facts.free_blocks = data.blocks.free; facts.used_pct = `${data.blocks.used_pct}%`;
      }
      if (target.object_type === 'segment' && data) {
        facts.rows = data.num_rows; facts.avg_row_len_bytes = data.avg_row_len;
        facts.last_analyzed = data.last_analyzed; facts.row_movement = data.row_movement;
      }
      if (target.raw) Object.assign(facts, target.raw);
      if (precise?.ok) facts.precise_reclaimable_mb = precise.data.reclaimable_mb;
      if (impact) { facts.estimated_io_volume = impact.volumeText; facts.estimated_duration = impact.durationText; }
      facts.current_db_cpu_pct = hs.db_cpu_pct; facts.current_host_cpu_pct = hs.host_cpu_pct;
      facts.current_active_sessions = hs.active_sessions;
      if (relatedJobs[0]) { facts.last_maintenance_status = relatedJobs[0].status; facts.last_maintenance_reclaimed_mb = relatedJobs[0].reclaimed_mb; }

      const res = await client.post(`/connections/oracle/${id}/oracle-storage-ai-explain`, {
        object_type: target.object_type,
        object_label: target.label || objectName,
        problem: f?.problem,
        evidence: f?.evidence,
        expected_benefit: f?.expected_benefit,
        risk: f?.risk,
        facts,
        question: question || null,
        history: aiThread,
      }).then((r) => r.data);

      if (res.status === 'success') {
        setAiThread((prev) => [...prev, { question: question || null, answer: res.answer }]);
        setAiQuestion('');
      } else {
        push(res.error || 'ActMon AI could not answer that.', 'error');
      }
    } catch (e) {
      push(errorText(e), 'error');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <>
      <PageHeader
        title={target.label || objectName}
        description={TITLES[target.object_type]}
        icon={ICONS[target.object_type] || 'database'}
        backTo={backTo}
        actions={executable && (
          activeJob ? (
            <Badge tone={JOB_STATUS_TONES[activeJob.status] || 'neutral'} size="sm">
              {activeJob.status === 'pending_approval' ? 'Pending approval' : activeJob.status === 'approved' ? 'Approved — not started' : 'Running'}
            </Badge>
          ) : (
            <Button variant="primary" loading={requestMut.isPending} onClick={() => requestMut.mutate({ object_type: f.object_type, object_name: f.object_name })}>
              Request Maintenance — {ACTION_LABELS[f.recommended_action] || f.recommended_action}
            </Button>
          )
        )}
      />
      <Toasts toasts={toasts} onDismiss={dismiss} />

      <div className="space-y-gutter">
        {f && (
          <Section icon="alert" title="Finding" subtitle="What the deterministic checks detected">
            <div className="space-y-4 rounded-card border border-border bg-sunken p-5">
              <div className="flex items-center gap-2.5">
                <Badge tone={STATUS_TONES[f.status] || 'neutral'} size="sm">{f.status}</Badge>
                <span className="text-[16px] font-bold text-fg">{f.problem}</span>
              </div>

              <div>
                <p className="mb-2 text-[12px] font-bold tracking-wide text-subtle uppercase">Evidence</p>
                <div className="flex flex-wrap gap-2">
                  {evidenceChips.map((c, i) => (
                    <span key={i} className="rounded-control border border-border bg-surface px-3 py-1.5 text-[13px]">
                      {c.label ? <><span className="text-muted">{c.label}: </span><span className="font-bold text-fg">{c.value}</span></> : <span className="font-semibold text-fg">{c.value}</span>}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid gap-gutter-sm sm:grid-cols-2">
                <div className="rounded-card bg-success-soft p-3.5">
                  <p className="mb-1 text-[12px] font-bold tracking-wide text-success-fg uppercase">Expected Benefit</p>
                  <p className="text-[13px] font-medium text-success-fg">{f.expected_benefit || '—'}</p>
                </div>
                <div className="rounded-card bg-warning-soft p-3.5">
                  <p className="mb-1 text-[12px] font-bold tracking-wide text-warning-fg uppercase">Risk</p>
                  <p className="text-[13px] font-medium text-warning-fg">{f.risk || '—'}</p>
                </div>
              </div>
            </div>
          </Section>
        )}

        {summary && (
          <Section icon="info" title="Explanation" subtitle="What this actually means, no jargon">
            <p className="rounded-card border border-border bg-surface p-4 text-[13px] leading-relaxed text-fg">{summary}</p>
          </Section>
        )}

        <Section icon="history" title="Related Maintenance" subtitle="Live status of every job ever requested for this object">
          {relatedJobs.length === 0 && <p className="text-[12px] text-muted">No maintenance has ever been requested for this object.</p>}
          {relatedJobs.length > 0 && (
            <div className="space-y-1.5">
              {relatedJobs.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => navigate(`/oracle-dashboard/${id}/storage-health/job`, { state: { job: j } })}
                  className="flex w-full items-center justify-between gap-2 rounded-control border border-border px-3 py-2 text-left hover:bg-sunken"
                >
                  <span className="flex items-center gap-2">
                    <Badge tone={JOB_STATUS_TONES[j.status] || 'neutral'} size="xs">{String(j.status).replace('_', ' ')}</Badge>
                    <span className="text-[12px] font-semibold text-fg">{ACTION_LABELS[j.recommended_action] || j.recommended_action}</span>
                  </span>
                  <span className="text-[11px] text-muted">
                    {j.status === 'succeeded' && j.reclaimed_mb != null ? `Reclaimed ${fmtNumber(j.reclaimed_mb)} MB · ` : ''}
                    {fmtIST(j.requested_at)}
                    <Icon name="chevron-right" size={12} className="ml-1 inline text-subtle" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>

        {wantsBlockDetail && blockQ.isLoading && <PageLoading title="Loading real block-level space…" />}
        {wantsBlockDetail && (blockQ.error || blockQ.data?.status === 'error') && (
          <Notice tone="danger" title="Could not load details.">{blockQ.data?.error || errorText(blockQ.error)}</Notice>
        )}

        {data && (
          <ToggleSection
            open={!!open.space} onToggle={() => toggle('space')}
            icon="database" title="Real Space & Blocks" subtitle="Measured directly from Oracle's data dictionary, not estimated"
          >
            {(data.errors || []).filter(Boolean).length > 0 && (
              <Notice tone="warning" title="Some checks could not run.">{data.errors.filter(Boolean).join(' · ')}</Notice>
            )}
            <div className="grid grid-cols-2 gap-gutter-sm sm:grid-cols-3">
              {data.size_bytes != null && <StatCell label="Size" value={fmtBytes(data.size_bytes)} accent />}
              {data.block_size ? <StatCell label="Block Size" value={fmtBytes(data.block_size)} /> : null}
              {data.status_ ? <StatCell label="Status" value={<Badge tone={data.status_ === 'AVAILABLE' ? 'success' : 'warning'} size="xs">{data.status_}</Badge>} /> : null}
            </div>

            {blocksIsBreakdown && (
              <div className="mt-3">
                <div className="grid grid-cols-3 gap-gutter-sm">
                  <StatCell label="Total Blocks" value={fmtNumber(data.blocks.total)} />
                  <StatCell label="Used (has data)" value={fmtNumber(data.blocks.used)} />
                  <StatCell label="Free (empty)" value={fmtNumber(data.blocks.free)} />
                </div>
                <div className="mt-2">
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-sunken">
                    <div
                      className={cn('h-full rounded-full', data.blocks.used_pct > 90 ? 'bg-danger-fg' : data.blocks.used_pct > 75 ? 'bg-warning-fg' : 'bg-accent')}
                      style={{ width: `${Math.min(data.blocks.used_pct, 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    {data.blocks.used_pct}% of blocks have data — {fmtBytes(data.used_bytes)} used, {fmtBytes(data.free_bytes)} free, {fmtBytes(data.block_size)} per block.
                  </p>
                </div>
              </div>
            )}

            {target.object_type === 'datafile' && (
              <div className="mt-3 grid gap-gutter-sm sm:grid-cols-2">
                <StatCell label="Tablespace" value={data.tablespace_name} />
                <StatCell label="Autoextend" value={data.autoextend === 'YES' ? 'On' : 'Off'} />
                {data.max_bytes ? <StatCell label="Max Size" value={fmtBytes(data.max_bytes)} /> : null}
                <StatCell label="File Path" value={<span className="break-all text-[11px] font-normal">{data.file_name}</span>} className="sm:col-span-2" />
              </div>
            )}

            {target.object_type === 'tablespace' && Array.isArray(data.datafiles) && (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-bold tracking-wide text-subtle uppercase">
                  Datafiles ({data.datafiles.length}) — click one for its own block detail
                </p>
                <div className="space-y-1">
                  {data.datafiles.map((d) => (
                    <button
                      key={d.file_id}
                      type="button"
                      onClick={() => navigate(`/oracle-dashboard/${id}/storage-health/object`, { state: { target: { object_type: 'datafile', file_id: d.file_id, label: d.file_name } } })}
                      className="flex w-full items-center justify-between gap-2 rounded-control border border-border px-2.5 py-1.5 text-left hover:bg-sunken"
                    >
                      <span className="truncate-safe font-mono text-[11px] text-fg">{d.file_name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone={d.status === 'AVAILABLE' ? 'success' : 'warning'} size="xs">{d.status}</Badge>
                        <span className="font-mono text-[11px] text-muted">{fmtBytes(d.size_bytes)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {target.object_type === 'segment' && (
              <div className="mt-3 space-y-3">
                <div className="grid gap-gutter-sm sm:grid-cols-3">
                  <StatCell label="Blocks" value={fmtNumber(data.blocks)} />
                  <StatCell label="Rows" value={data.num_rows != null ? fmtNumber(data.num_rows) : '—'} />
                  <StatCell label="Avg Row Len" value={data.avg_row_len != null ? `${fmtNumber(data.avg_row_len)} B` : '—'} />
                  <StatCell label="Tablespace" value={data.tablespace_name} />
                  <StatCell label="Row Movement" value={data.row_movement || '—'} />
                  <StatCell label="Last Analyzed" value={data.last_analyzed || '—'} />
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-bold tracking-wide text-subtle uppercase">Precise Block-Level Fullness</p>
                  {!precise && (
                    <Button size="sm" variant="secondary" loading={preciseMut.isPending} onClick={runPreciseCheck}>
                      Get precise space (DBMS_SPACE.SPACE_USAGE)
                    </Button>
                  )}
                  {precise?.ok === false && (
                    <p className="text-[12px] text-muted">Not available for this connection: {precise.message}</p>
                  )}
                  {precise?.ok === true && (
                    <div className="grid grid-cols-3 gap-gutter-sm sm:grid-cols-6">
                      <StatCell label="Unformatted" value={`${fmtNumber(precise.data.unformatted_mb)} MB`} />
                      <StatCell label="0–25% full" value={`${fmtNumber(precise.data.fs1_mb)} MB`} />
                      <StatCell label="25–50% full" value={`${fmtNumber(precise.data.fs2_mb)} MB`} />
                      <StatCell label="50–75% full" value={`${fmtNumber(precise.data.fs3_mb)} MB`} />
                      <StatCell label="75–100% full" value={`${fmtNumber(precise.data.fs4_mb)} MB`} />
                      <StatCell label="Fully used" value={`${fmtNumber(precise.data.full_mb)} MB`} />
                      <div className="col-span-3 sm:col-span-6">
                        <StatCell label="Measured reclaimable" value={`${fmtNumber(precise.data.reclaimable_mb)} MB (${precise.data.reclaimable_pct}%)`} accent />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </ToggleSection>
        )}

        {target.object_type === 'segment' && data && (
          <ToggleSection
            open={!!open.dict} onToggle={() => toggle('dict')}
            icon="list" title="Table Dictionary (DBA_TABLES)" subtitle="The real dictionary row Oracle keeps for this table — step through it instead of one long dump"
          >
            {tableDictQ.isLoading && <p className="text-[12px] text-muted">Loading…</p>}
            {(tableDictQ.error || tableDictQ.data?.status === 'error') && (
              <Notice tone="danger" title="Could not load DBA_TABLES.">{tableDictQ.data?.error || errorText(tableDictQ.error)}</Notice>
            )}
            {tableDictQ.data?.status === 'success' && (
              <>
                <Stepper
                  steps={tableDictQ.data.groups.map((g, i) => ({ n: i + 1, label: g.label }))}
                  step={dictStep}
                />
                <div className="grid gap-gutter-sm sm:grid-cols-3">
                  {Object.entries(tableDictQ.data.groups[dictStep - 1].fields).map(([k, v]) => (
                    <StatCell key={k} label={titleCase(k)} value={v ?? '—'} />
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <Button size="sm" variant="secondary" disabled={dictStep === 1} onClick={() => setDictStep((s) => s - 1)}>Back</Button>
                  <span className="text-[11px] text-subtle">Step {dictStep} of {tableDictQ.data.groups.length}</span>
                  <Button size="sm" variant="secondary" disabled={dictStep === tableDictQ.data.groups.length} onClick={() => setDictStep((s) => s + 1)}>Next</Button>
                </div>
              </>
            )}
          </ToggleSection>
        )}

        {target.object_type === 'index' && target.raw && (
          <Section icon="layers" title="Index Detail">
            <div className="grid gap-gutter-sm sm:grid-cols-3">
              <StatCell label="Table" value={`${target.raw.owner}.${target.raw.table_name}`} />
              <StatCell label="Type" value={`${target.raw.index_type}${target.raw.uniqueness === 'UNIQUE' ? ' · unique' : ''}`} />
              <StatCell label="Status" value={<Badge tone={target.raw.status === 'VALID' ? 'success' : 'warning'} size="xs">{target.raw.status}</Badge>} />
              <StatCell label="Leaf Blocks" value={fmtNumber(target.raw.leaf_blocks)} />
              {target.raw.num_rows != null && <StatCell label="Rows" value={fmtNumber(target.raw.num_rows)} />}
            </div>
          </Section>
        )}

        {target.object_type === 'partition' && target.raw && (
          <Section icon="layers" title="Partition Detail">
            <div className="grid gap-gutter-sm sm:grid-cols-3">
              <StatCell label="Table" value={`${target.raw.owner}.${target.raw.table_name}`} />
              {target.raw.size_mb != null && <StatCell label="Size" value={`${fmtNumber(target.raw.size_mb)} MB`} />}
              {target.raw.num_rows != null && <StatCell label="Rows" value={fmtNumber(target.raw.num_rows)} />}
              {target.raw.last_analyzed && <StatCell label="Last Analyzed" value={target.raw.last_analyzed} />}
              {target.raw.high_value && <StatCell label="High Value" value={<span className="break-all text-[11px] font-normal">{target.raw.high_value}</span>} className="sm:col-span-3" />}
            </div>
          </Section>
        )}

        <ToggleSection
          open={!!open.load} onToggle={() => toggle('load')}
          icon="cpu" title="Current System Load" subtitle="Live, instance-wide — same snapshot as the main Oracle dashboard"
        >
          {loadQ.isLoading ? (
            <p className="text-[12px] text-muted">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-gutter sm:grid-cols-4">
                <Meter label="Host CPU" value={hs.host_cpu_pct} icon="cpu" />
                <Meter label="DB CPU" value={hs.db_cpu_pct} icon="database" />
                <Meter label="SGA Used" value={hs.sga_used_pct} icon="layers" />
                <Meter label="Session Load" value={hs.session_pct} icon="users" hint={hs.active_sessions != null ? `${fmtNumber(hs.active_sessions)} active` : undefined} />
              </div>
              <p className="mt-3 text-center text-[12px] text-muted">
                {(hs.db_cpu_pct > 70 || hs.host_cpu_pct > 80)
                  ? `Load looks high right now (DB CPU ${hs.db_cpu_pct}%). If this action isn't urgent, consider running it during a quieter period.`
                  : `Load looks normal right now (DB CPU ${hs.db_cpu_pct ?? '—'}%). This looks like a reasonable time to run maintenance.`}
              </p>
            </>
          )}
        </ToggleSection>

        {impact && (
          <ToggleSection
            open={!!open.impact} onToggle={() => toggle('impact')}
            icon="clock" title="Estimated Impact" subtitle="A rough estimate, not a measurement — actual time depends on your storage speed and current load"
          >
            <div className="grid grid-cols-1 gap-gutter-sm text-center sm:grid-cols-3">
              <StatCell label="Data to Read/Rewrite" value={impact.volumeText} centered accent />
              <StatCell label="Rough Duration" value={impact.durationText} centered accent />
              <StatCell label="Assumption Used" value="15–80 MB/s throughput" centered />
            </div>
          </ToggleSection>
        )}

        <ToggleSection
          open={!!open.ai} onToggle={() => toggle('ai')}
          icon="sparkles" title="Ask ActMon AI" subtitle="Grounded only in the real facts on this page — never guesses a number"
        >
          <div className="space-y-3">
            {aiThread.length === 0 && (
              <Button variant="secondary" loading={aiLoading} onClick={() => askAi(null)}>Explain Plan</Button>
            )}
            {aiThread.map((t, i) => (
              <div key={i} className="space-y-1">
                {t.question && <p className="text-[12px] font-semibold text-fg">You asked: {t.question}</p>}
                <p className="rounded-card border border-border bg-surface p-3 text-[13px] leading-relaxed text-fg">{t.answer}</p>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <Textarea
                rows={2}
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                placeholder='Ask a question about this object — e.g. "why is this critical" or "is it safe to shrink now"'
                wrapperClassName="flex-1"
              />
              <Button variant="primary" loading={aiLoading} disabled={!aiQuestion.trim()} onClick={() => askAi(aiQuestion.trim())}>
                Ask
              </Button>
            </div>
          </div>
        </ToggleSection>
      </div>
    </>
  );
}

function Section({ icon, title, subtitle, children }) {
  return (
    <section className="card p-card">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
          <Icon name={icon} />
        </span>
        <div className="min-w-0">
          <h2 className="truncate-safe text-[14px] font-bold text-fg">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Same shell as Section, but the header itself is the button — click to
 * reveal the body, click again to collapse. Nothing inside fetches or
 * renders until it's been opened at least once (queries gate on `open`). */
function ToggleSection({ open, onToggle, icon, title, subtitle, children }) {
  return (
    <section className="card overflow-hidden p-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 p-card text-left hover:bg-sunken"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
          <Icon name={icon} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate-safe text-[14px] font-bold text-fg">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted">{subtitle}</p>}
        </div>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} className="shrink-0 text-subtle" />
      </button>
      {open && <div className="border-t border-border p-card">{children}</div>}
    </section>
  );
}

function StatCell({ label, value, accent, centered, className }) {
  return (
    <div className={cn('rounded-card border border-border bg-surface px-2.5 py-2', centered && 'text-center', className)}>
      <p className="truncate text-[9px] font-bold tracking-wide text-subtle uppercase">{label}</p>
      <p className={cn('mt-0.5 text-[13px] font-bold', accent ? 'text-accent-text' : 'text-fg')}>{value}</p>
    </div>
  );
}
