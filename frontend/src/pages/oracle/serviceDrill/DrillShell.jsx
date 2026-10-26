/**
 * The frame every drill-down level shares: breadcrumbs, Back, the page
 * heading, "read at" + Refresh, and the loading / error / not-found states.
 *
 * Breadcrumbs here are explicit and always shown: the app-wide trail is
 * derived from route segments and switchable, and a drill-down whose levels
 * are ids (INST_ID 1, SID 1345) needs the names the pages have read.
 */
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { cn } from '@/lib/cn';

import { drillCrumbs, parentPath } from './drillPaths';
import './drillLoader.css';

/**
 * Navigation inside the drill-down. Every step records the page it came from,
 * so Back can tell whether the previous history entry IS the parent level.
 */
export function useDrillNav() {
  const navigate = useNavigate();
  const location = useLocation();
  return (to) => navigate(to, { state: { drillFrom: location.pathname } });
}

/**
 * Back: one step of browser history when the previous entry is the parent
 * (keeps its scroll and filters), otherwise straight to the parent route —
 * a page opened from a link, a refresh or a breadcrumb jump still goes up
 * exactly one level, never out of the app.
 */
export function useDrillBack(ctx) {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const parent = parentPath(id, ctx);
  return () => {
    if (location.state?.drillFrom === parent && window.history.length > 1) navigate(-1);
    else navigate(parent);
  };
}

/**
 * The drill-down's loader: an animated database with orbiting nodes and an
 * indeterminate bar, sized to sit in the content area (no tall blank band).
 * It shows only while the page's request is pending; nothing in it claims a
 * step has finished.
 */
export function DrillLoader({ label = 'Reading from Oracle…', detail }) {
  return (
    <div className="drill-loader card" role="status" aria-live="polite">
      <div className="drill-loader__art" aria-hidden="true">
        <span className="drill-loader__halo" />
        <span className="drill-loader__orbit"><i /><i /><i /></span>
        <span className="drill-loader__db"><b /><b /><b /></span>
        <span className="drill-loader__node drill-loader__node--l"><Icon name="server" size={14} /></span>
        <span className="drill-loader__node drill-loader__node--r"><Icon name="activity" size={14} /></span>
      </div>
      <p className="mt-5 text-[18px] font-bold text-fg">{label}</p>
      {detail && <p className="mt-1 text-[13px] text-muted">{detail}</p>}
      <div className="drill-loader__bar"><span /></div>
    </div>
  );
}

/** Route params, decoded, as the drill helpers expect them. */
export function useDrillParams() {
  const p = useParams();
  const dec = (v) => (v == null ? undefined : decodeURIComponent(v));
  return {
    id: p.id,
    service: dec(p.service),
    inst: p.inst != null ? Number(p.inst) : undefined,
    sid: p.sid != null ? Number(p.sid) : undefined,
    serial: p.serial != null ? Number(p.serial) : undefined,
    sqlId: dec(p.sqlId),
  };
}

export function Crumbs({ items }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[12px] text-muted">
      {items.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <Icon name="chevron-right" size={12} className="text-subtle" />}
          {c.to
            ? <Link to={c.to} className="hover:text-accent-text hover:underline">{c.label}</Link>
            : <span className="font-semibold text-fg" aria-current="page">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

const STATUS_TONES = {
  online: 'success', active: 'success', open: 'success', killed: 'danger',
  partial: 'warning', mounted: 'warning', inactive: 'neutral', sniped: 'warning',
  offline: 'danger', not_active: 'danger', failed: 'danger', unknown: 'neutral',
};
const STATUS_LABEL = { not_active: 'Not active', unknown: 'Unknown' };

/** A status badge. Anything missing is "Unknown", never a guessed state. */
export function StatusBadge({ value, size = 'xs' }) {
  const v = value == null || value === '' ? 'unknown' : String(value).toLowerCase();
  const label = STATUS_LABEL[v] || (v.charAt(0).toUpperCase() + v.slice(1));
  return <Badge tone={STATUS_TONES[v] || 'neutral'} size={size}>{label}</Badge>;
}

/** A value or an explicit "N/A". Zero is a value; null is not. */
export const na = (v, fmt = (x) => x) => (v == null || v === '' || Number.isNaN(v) ? 'N/A' : fmt(v));

export function fmtTime(v) {
  if (!v) return 'N/A';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

export function fmtNum(v, digits = 0) {
  if (v == null || Number.isNaN(Number(v))) return 'N/A';
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtSecs(s) {
  if (s == null) return 'N/A';
  const n = Number(s);
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
  if (n < 86400) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`;
}

/** Key/value list for overview sections. */
export function Facts({ rows }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,40%)_1fr] gap-x-4 gap-y-2 text-[13px]">
      {rows.filter(Boolean).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words font-medium text-fg">{v ?? 'N/A'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A clickable section card leading to the next level. */
export function DrillCard({ icon, title, value, body, to, tone = 'accent' }) {
  const navigate = useDrillNav();
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="card group flex w-full items-start gap-3 p-card text-left transition-colors hover:border-strong hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-control',
        tone === 'accent' ? 'bg-accent-soft text-accent-text' : 'bg-sunken text-muted')}>
        <Icon name={icon} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[14px] font-bold text-fg">
          {title}
          <Icon name="chevron-right" size={14} className="ml-auto text-subtle group-hover:text-accent-text" />
        </span>
        {value != null && <span className="mt-0.5 block text-[13px] font-semibold text-accent-text">{value}</span>}
        {body && <span className="mt-0.5 block text-[12px] text-muted">{body}</span>}
      </span>
    </button>
  );
}

/**
 * @param ctx      { service, inst, sid, serial, sqlId, level } — for crumbs and Back
 * @param names    display names read so far ({ instance })
 * @param query    the react-query result for this level
 */
export default function DrillShell({ ctx, names, query, title, subtitle, icon, badge, loadingLabel, loadingDetail, children }) {
  const { id } = useDrillParams();
  const back = useDrillBack(ctx);
  const crumbs = drillCrumbs(id, ctx, names);
  const data = query?.data;
  const status = data?.status;

  let body = children;
  if (query?.isLoading) body = <DrillLoader label={loadingLabel} detail={loadingDetail} />;
  else if (query?.error) {
    body = (
      <Notice tone="danger" title="This level could not be read.">
        <p className="text-[12px]">{query.error?.response?.data?.detail
          ? JSON.stringify(query.error.response.data.detail) : String(query.error.message || query.error)}</p>
        <Button className="mt-2" size="sm" icon="refresh" onClick={() => query.refetch()}>Retry</Button>
      </Notice>
    );
  } else if (status === 'not_found' || status === 'ended' || status === 'error') {
    body = (
      <Notice tone={status === 'error' ? 'danger' : 'warning'}
        title={status === 'ended' ? 'Session ended.' : status === 'not_found' ? 'Not found.' : 'Read failed.'}>
        <p className="text-[12px]">{data.error}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" icon="arrow-left" onClick={back}>Back</Button>
          {status === 'error' && <Button size="sm" icon="refresh" onClick={() => query.refetch()}>Retry</Button>}
        </div>
      </Notice>
    );
  }

  return (
    <div className="space-y-gutter">
      <Crumbs items={crumbs} />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" icon="arrow-left" onClick={back}>
          Back
        </Button>
        <span className="grid h-10 w-10 place-items-center rounded-control bg-accent-soft text-accent-text">
          <Icon name={icon} size={20} />
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-[22px] font-bold text-fg break-all">
            {title}
            {badge}
          </h1>
          {subtitle && <p className="text-[12px] text-muted">{subtitle}</p>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data?.read_at && (
            <span className="text-[11px] text-subtle" title="When these values were read from Oracle (live, not cached history)">
              Live · read {new Date(data.read_at).toLocaleTimeString()}
            </span>
          )}
          {query && (
            <Button size="sm" variant="primary" icon="refresh" loading={query.isFetching} onClick={() => query.refetch()}>
              Refresh
            </Button>
          )}
        </div>
      </div>
      {body}
      {status === 'success' && (data.errors || []).length > 0 && (
        <Notice tone="warning" title="Some sections could not be read and are shown as N/A.">
          <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
            {data.errors.map((e, i) => <li key={i} className="font-mono break-all">{e}</li>)}
          </ul>
          <p className="mt-1 text-[11px]">Usually a missing SELECT grant for the monitoring user on the named view.</p>
        </Notice>
      )}
    </div>
  );
}
