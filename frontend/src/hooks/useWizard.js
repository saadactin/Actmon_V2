import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * WIZARD STATE — one definition, so every wizard behaves the same way.
 *
 * Three problems, three hooks:
 *
 *   useWizardStep    A step held in component state is lost on reload, dropping
 *                    the operator back at step 1. Holding it in the URL means a
 *                    refresh reloads the same step, and the step is linkable.
 *
 *   useWizardDraft   The step alone is not enough — an empty form on step 3 is
 *                    little better. Entries are mirrored to sessionStorage, minus
 *                    anything secret (see `omit`), and restored on reload.
 *
 *   useConfirmExit   Leaving mid-way discards the work, so Back asks first.
 */

/**
 * Current step, held in the query string.
 *
 * Steps `replace` rather than push. Pushing would fill the history stack with the
 * wizard's own steps, so Back would walk them one at a time — the operator wants
 * Back to mean "leave", which is what useConfirmExit then intercepts.
 */
export function useWizardStep({ param = 'step', initial = 0, min = 0, max }) {
  const [params, setParams] = useSearchParams();

  const raw = params.get(param);
  const parsed = raw === null ? NaN : Number(raw);
  const step = Number.isInteger(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : initial;

  const go = useCallback((next) => {
    const clamped = Math.min(max, Math.max(min, Number(next) || 0));
    const p = new URLSearchParams(window.location.search);
    p.set(param, String(clamped));
    setParams(p, { replace: true });
  }, [max, min, param, setParams]);

  return [step, go];
}

/**
 * Fields whose names mean "do not write this down".
 *
 * Matched on the LAST word of the key, not as a substring. A substring test looked
 * right and was badly wrong: /credential/ matched the `credentials` container and
 * discarded the whole object — username, host and port included — so the draft
 * persisted nothing at all. Word-wise also keeps `tokenName` (a label) while
 * dropping `agentToken`, and keeps `connection_name` and `monkey`.
 */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pass', 'secret', 'token', 'key', 'credential',
]);

const isSecretKey = (k) => SECRET_WORDS.has(
  String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_').pop(),
);

/**
 * Deep-copy `value`, dropping anything that looks like a secret.
 *
 * Exported because it is the part worth testing directly: a regression here would
 * quietly write a database password into session storage.
 */
export function redactDraft(value) {
  if (Array.isArray(value)) return value.map(redactDraft);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) continue;
      out[k] = redactDraft(v);
    }
    return out;
  }
  return value;
}

/**
 * Form state that survives a reload.
 *
 * Secrets are deliberately NOT persisted: a wizard that collects a database
 * password must not leave it in session storage for the rest of the browsing
 * session. After a reload the operator is on the same step with the same
 * non-secret entries and an empty password field, which is the correct trade.
 */
export function useWizardDraft(key, initial) {
  const storageKey = `actmon.wizard.${key}`;

  const [state, setState] = useState(() => {
    if (typeof sessionStorage === 'undefined') return initial;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      // Merge rather than replace: a draft written before a field existed must
      // not leave that field undefined.
      return saved ? deepMerge(initial, saved) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(redactDraft(state)));
    } catch {
      /* private mode / quota — the draft just won't survive a reload */
    }
  }, [storageKey, state]);

  const clear = useCallback(() => {
    try { sessionStorage.removeItem(storageKey); } catch { /* nothing to clean */ }
  }, [storageKey]);

  return [state, setState, clear];
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * Ask before the browser's Back button leaves the page.
 *
 * React Router's `useBlocker` needs a data router; this app mounts a plain
 * <BrowserRouter>, so the guard is done against history directly: a sentinel entry
 * is pushed on mount, so the first Back lands on it rather than leaving. The
 * handler then re-pushes the sentinel — so a second Back asks again — and raises
 * `pending` for the caller to show its confirmation.
 *
 * Confirming does NOT run history arithmetic. The caller navigates to its own exit
 * route, which is deterministic; walking the stack by a guessed offset is not.
 */
export function useConfirmExit(enabled = true) {
  /** null when nothing is being asked; otherwise { to } — `to` null means Back. */
  const [pending, setPending] = useState(null);
  const armed = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    window.history.pushState({ actmonWizardGuard: true }, '');
    armed.current = true;

    const onPop = () => {
      if (!armed.current) return;
      // The sentinel has just been consumed; put it back so the guard survives a
      // second Back, then ask.
      window.history.pushState({ actmonWizardGuard: true }, '');
      setPending({ to: null });
    };

    window.addEventListener('popstate', onPop);
    return () => {
      armed.current = false;
      window.removeEventListener('popstate', onPop);
    };
  }, [enabled]);

  /**
   * Ask before leaving for `to`. Returns true when the question was raised, so the
   * caller can navigate immediately on false:
   *
   *     const leave = (to) => { if (!exit.ask(to)) navigate(to); };
   *
   * Returns false once there is nothing left to lose (the guard disabled) — asking
   * after the work is committed is just an extra click. Cancel, the close button and
   * a Previous that would leave the wizard all go through this, so none of them can
   * discard a half-finished setup without asking.
   */
  const ask = useCallback((to = null) => {
    if (!enabled) return false;
    setPending({ to });
    return true;
  }, [enabled]);

  /** Call before navigating away without asking, so the guard doesn't fire. */
  const release = useCallback(() => { armed.current = false; }, []);

  return {
    pending: pending !== null,
    /** Where the operator was heading, or null when the browser's Back fired. */
    pendingTo: pending?.to ?? null,
    ask,
    /** The operator chose to leave — stop guarding and let the caller navigate. */
    confirm: useCallback(() => { armed.current = false; setPending(null); }, []),
    /** The operator chose to stay. */
    cancel: useCallback(() => setPending(null), []),
    release,
  };
}
