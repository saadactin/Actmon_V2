import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@/components/ui/Icon';
import { DB_TYPE_OPTIONS, ENVIRONMENTS, OS_TYPES, REGISTRATION } from '@/config/agents';

/**
 * Register Agent — a faithful copy of the existing module's dialog.
 *
 * Layout, proportions, wording and behaviour are the original: gradient header
 * with the title, subtitle and a translucent close button; a scrolling body
 * (max-h 70vh) with the same three two-column rows; the same info note; and a
 * tinted footer with Cancel plus a gradient primary button.
 *
 * The only change is that every colour, radius, font and size resolves through
 * design tokens instead of literals, so the dialog follows the theme, accent,
 * font, roundness and density settings. Set the accent to Indigo in Appearance to
 * reproduce the original palette exactly.
 *
 * FIELD / LABEL are kept as local constants, mirroring the original's
 * FIELD_CLS / LABEL_CLS, so the field rhythm is defined once and matches it
 * shape-for-shape (px-3 py-2, text-sm, sentence-case bold label).
 */
const FIELD = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg '
  + 'transition-colors placeholder:text-subtle hover:border-strong';
const LABEL = 'mb-1 block text-xs font-bold text-muted';

export default function RegisterAgentDialog({ open, onClose, onRegister, saving }) {
  const [form, setForm] = useState(REGISTRATION.defaults);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(REGISTRATION.defaults);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const set = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!form.agent_name.trim()) {
      setError('Agent name is required.');
      return;
    }
    setError(null);
    try {
      await onRegister(REGISTRATION.toPayload(form));
      onClose();
    } catch (err) {
      // The API client unwraps FastAPI's `detail`, so a 409 reads
      // "Agent 'x' is already registered." verbatim.
      setError(err?.message || 'Registration failed.');
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Register Agent"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm anim-fade-in" />

      <div
        className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl anim-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── header: gradient banner, white title + subtitle ── */}
        <div
          className="flex shrink-0 items-center justify-between px-6 py-5"
          style={{ background: 'var(--gradient-accent)' }}
        >
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold tracking-tight text-accent-fg">Register Agent</h2>
            <p className="mt-0.5 text-xs text-accent-fg/75">Add a new database agent to monitoring</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white/10 text-accent-fg transition-colors hover:bg-white/20"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* ── form body ── */}
        <form
          onSubmit={handleSubmit}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5"
        >
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2.5 text-xs text-danger-fg">
              <Icon name="shield" size={13} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-line">{error}</span>
            </div>
          )}

          <RegisterAgentFields form={form} set={set} />

          {/* lets Enter submit without showing a second button */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>

        {/* ── footer ── */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border bg-raised px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !form.agent_name.trim()}
            className="flex items-center gap-2 rounded-md px-5 py-2 text-sm font-bold text-accent-fg transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: 'var(--gradient-accent)' }}
          >
            <Icon name={saving ? 'spinner' : 'plus'} size={15} className={saving ? 'animate-spin' : undefined} />
            {saving ? 'Registering…' : 'Register Agent'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The field set, in the original order and layout.
 * Split out so it can be rendered — and asserted on — without a DOM, since React
 * cannot server-render the portal the dialog chrome uses.
 */
export function RegisterAgentFields({ form, set }) {
  return (
    <>
      {/* Agent name */}
      <div>
        <label className={LABEL} htmlFor="agent-name">
          Agent Name <span className="text-danger">*</span>
        </label>
        <input
          id="agent-name"
          type="text"
          required
          autoFocus
          value={form.agent_name}
          onChange={(e) => set('agent_name', e.target.value)}
          placeholder="e.g. prod-mysql-01"
          className={FIELD}
        />
        <p className="mt-1 text-[11px] text-subtle">Unique identifier for this agent</p>
      </div>

      {/* Engine + environment */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="agent-db-type">Database Engine</label>
          <select
            id="agent-db-type"
            value={form.db_type}
            onChange={(e) => set('db_type', e.target.value)}
            className={FIELD}
          >
            {DB_TYPE_OPTIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-env">Environment</label>
          <select
            id="agent-env"
            value={form.environment}
            onChange={(e) => set('environment', e.target.value)}
            className={FIELD}
          >
            {ENVIRONMENTS.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
      </div>

      {/* Hostname + IP */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="agent-hostname">Hostname</label>
          <input
            id="agent-hostname"
            type="text"
            value={form.hostname}
            onChange={(e) => set('hostname', e.target.value)}
            placeholder="db.example.com"
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-ip">IP Address</label>
          <input
            id="agent-ip"
            type="text"
            value={form.ip_address}
            onChange={(e) => set('ip_address', e.target.value)}
            placeholder="192.168.1.10"
            className={FIELD}
          />
        </div>
      </div>

      {/* OS + interval */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="agent-os">Operating System</label>
          <select
            id="agent-os"
            value={form.os_type}
            onChange={(e) => set('os_type', e.target.value)}
            className={FIELD}
          >
            {OS_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-interval">Collection Interval (sec)</label>
          <input
            id="agent-interval"
            type="number"
            min={REGISTRATION.interval.min}
            max={REGISTRATION.interval.max}
            value={form.collection_interval_sec}
            onChange={(e) => set('collection_interval_sec', e.target.value)}
            className={FIELD}
          />
        </div>
      </div>

      {/* Description */}
      <div>
        <label className={LABEL} htmlFor="agent-desc">Description</label>
        <input
          id="agent-desc"
          type="text"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="e.g. Primary MySQL replica cluster node"
          className={FIELD}
        />
      </div>

      {/* Info note — wording unchanged */}
      <div className="flex items-start gap-2 rounded-xl border border-accent-border bg-accent-softer px-3 py-2.5 text-[11px] text-accent-text">
        <Icon name="info" size={12} className="mt-0.5 shrink-0" />
        <span>
          The agent will be registered as <strong>offline</strong> until it starts sending
          heartbeats via the collector script.
        </span>
      </div>
    </>
  );
}
