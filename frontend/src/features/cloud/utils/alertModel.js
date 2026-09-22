/**
 * The Alerts tab's vocabulary — severity, evaluation state, lifecycle state,
 * notification state, categories and durations.
 *
 * Separate from `components/alerts/AlertPrimitives.jsx` for the same reason
 * `resourceModel.js` is separate from the resource components: this is the part
 * that decides what a value MEANS, and it should be testable without a DOM.
 * The .jsx file renders these; it does not define them.
 *
 * The rule that runs through everything here: an absent value is NA, never 0,
 * and an unreadable one is never painted as healthy.
 */

export const SEVERITY_META = {
  CRITICAL: { tone: 'danger', label: 'Critical', icon: 'alert' },
  HIGH: { tone: 'danger', label: 'High', icon: 'alert' },
  MEDIUM: { tone: 'warning', label: 'Medium', icon: 'alert' },
  LOW: { tone: 'info', label: 'Low', icon: 'info' },
  INFO: { tone: 'neutral', label: 'Info', icon: 'info' },
};

export const severityMeta = (s) => SEVERITY_META[(s || '').toUpperCase()]
  || { tone: 'neutral', label: s || 'Not set', icon: 'info' };

/**
 * The six evaluation states, and what each one MEANS — not just how it looks.
 *
 * The three inconclusive ones are deliberately neither green nor red. "I could
 * not check" is its own answer, and rendering it as either healthy or firing is
 * the specific failure this whole feature exists to avoid.
 */
export const RESULT_META = {
  TRIGGERED: {
    tone: 'danger', label: 'Condition met', icon: 'alert',
    help: 'The condition was true at the last evaluation.',
  },
  NOT_TRIGGERED: {
    tone: 'success', label: 'Condition not met', icon: 'check',
    help: 'The data was read and the condition was false.',
  },
  RESOLVED: {
    tone: 'success', label: 'Resolved', icon: 'check',
    help: 'The condition stopped being true and the alert was closed.',
  },
  UNKNOWN: {
    tone: 'warning', label: 'Could not evaluate', icon: 'help',
    help: 'The data source could not be read. This is NOT the same as the '
      + 'condition being false — no alert was opened, and no open alert was '
      + 'resolved.',
  },
  ERROR: {
    tone: 'danger', label: 'Evaluation error', icon: 'alert',
    help: 'The evaluation itself failed. No alert was opened or resolved.',
  },
  UNSUPPORTED: {
    tone: 'neutral', label: 'Not supported', icon: 'ban',
    help: 'This condition cannot be evaluated for this account.',
  },
};

export const resultMeta = (state) => RESULT_META[state] || {
  tone: 'neutral', label: 'Never evaluated', icon: 'clock',
  help: 'This rule has not run yet. It will be evaluated on the next pass.',
};

export const STATE_META = {
  OPEN: { tone: 'danger', label: 'Open' },
  ACKNOWLEDGED: { tone: 'warning', label: 'Acknowledged' },
  RESOLVED: { tone: 'success', label: 'Resolved' },
};

export const CATEGORY_META = {
  security: { label: 'Security', icon: 'shield' },
  cost: { label: 'Cost', icon: 'report' },
  resource: { label: 'Resources', icon: 'server' },
  drift: { label: 'Config Drift', icon: 'branch' },
  event: { label: 'Events', icon: 'logs' },
  discovery: { label: 'Discovery', icon: 'refresh' },
  platform: { label: 'Platform Health', icon: 'activity' },
};

export const categoryMeta = (c) => CATEGORY_META[c]
  || { label: c || 'Other', icon: 'bell' };

/**
 * Notification status is about the EMAIL, never about the alert.
 *
 * None of these keys may reuse an alert lifecycle word. A reader who sees
 * "Resolved" in the Notification column will take it to mean the email
 * succeeded, and an alert can be correctly OPEN while its email failed to leave
 * the building.
 */
export const NOTIFICATION_META = {
  QUEUED: {
    tone: 'info', label: 'Queued',
    help: 'Handed to the delivery queue. Not yet confirmed sent.',
  },
  SKIPPED_COOLDOWN: {
    tone: 'neutral', label: 'Suppressed',
    help: 'Within the rule’s cooldown — the alert is still open.',
  },
  // Distinct from the cooldown on purpose. A cooldown is the rule working as
  // configured; a silence is a person deciding to stop the mail, and an
  // operator wondering why they heard nothing needs to tell those apart.
  SILENCED: {
    tone: 'warning', label: 'Silenced',
    help: 'This rule is silenced, so no email was sent. The alert itself was '
      + 'still recorded and is still open.',
  },
  NO_RECIPIENT: {
    tone: 'warning', label: 'No recipient',
    help: 'The alert was recorded but nobody is configured to receive it.',
  },
  NOT_CONFIGURED: {
    tone: 'warning', label: 'Email not configured',
    help: 'No SMTP server is set up, so nothing could be queued.',
  },
  CHANNEL_DISABLED: {
    tone: 'warning', label: 'Channel off',
    help: 'Email delivery is switched off, so nothing was queued.',
  },
  FAILED_TO_QUEUE: {
    tone: 'danger', label: 'Queue failed',
    help: 'The notification queue could not be written.',
  },
  // Written by the Security Center's own notify path, which predates the alert
  // engine and still raises alerts directly from findings. 293 alerts on the
  // live estate carry this value, so leaving it to the fallback would render
  // nearly every historical row as a bare lowercase string.
  no_channel: {
    tone: 'warning', label: 'No channel',
    help: 'No delivery channel was enabled for this alert’s severity when '
      + 'it fired, so nothing was queued.',
  },
};

export const notificationMeta = (status) => {
  if (!status) return { tone: 'neutral', label: 'Not attempted', help: undefined };
  if (NOTIFICATION_META[status]) return NOTIFICATION_META[status];
  // The Security Center writes "queued:3" — the count of channels it handed
  // the alert to. Still queued, not sent, so it gets the queued treatment and
  // the same caveat.
  if (String(status).startsWith('queued:')) {
    const n = String(status).split(':')[1];
    return {
      tone: 'info',
      label: n && n !== '1' ? `Queued (${n})` : 'Queued',
      help: 'Handed to the delivery queue. Not yet confirmed sent.',
    };
  }
  return { tone: 'neutral', label: status, help: undefined };
};

/**
 * Seconds → "5 minutes" / "1 hour" / the caller's word for off.
 *
 * `null` and `undefined` are NA, never 0 — an interval that was never set is
 * unknown, not instant, and a rule list showing "0 seconds" for an unconfigured
 * cooldown would be actively wrong.
 */
export function humanDuration(seconds, { zero = 'Off' } = {}) {
  if (seconds === null || seconds === undefined) return 'NA';
  const n = Number(seconds);
  if (!Number.isFinite(n)) return 'NA';
  if (n === 0) return zero;
  if (n < 60) return `${n} second${n === 1 ? '' : 's'}`;
  if (n < 3600) {
    const m = Math.round(n / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (n < 86400) {
    const h = Math.round(n / 3600);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(n / 86400);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * The history filter's state selector.
 *
 * `''` is the default feed — what still needs attention. `ALL` is genuinely
 * everything. The two are distinct on purpose: a default that quietly included
 * resolved alerts would make a handled estate look like a burning one.
 */
export const statesFor = (value) => {
  if (value === 'ALL') return ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
  if (!value) return ['OPEN', 'ACKNOWLEDGED'];
  return [value];
};
