/**
 * Copy-to-clipboard with a working fallback for plain-HTTP origins.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost)
 * — it is simply undefined on a plain-HTTP origin, which is exactly how this
 * app is served in a LAN deployment (see components/ui/CopyButton.jsx, which
 * this extracts the same logic from). Without a fallback, `navigator
 * .clipboard?.writeText(...)` silently does nothing — no error, no copy —
 * which is worse than the deprecated execCommand('copy') this falls back to.
 *
 * Returns true/false instead of throwing, so callers can flash a
 * success/failure state without their own try/catch.
 */
export async function copyText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
