import { create } from 'zustand';

/**
 * Display timezone for the Logs module (Audit Logs / Login History / User
 * Sessions / Password History) — deliberately a short, fixed list rather than
 * the full IANA catalog, per the actual ask. One representative zone per
 * country named; USA uses Eastern (the common business-hours default) since
 * a single country-wide zone doesn't otherwise exist.
 */
export const LOG_TIMEZONES = [
  { id: 'Asia/Kolkata', label: 'India (IST)' },
  { id: 'America/New_York', label: 'USA (Eastern)' },
  { id: 'Europe/Berlin', label: 'Germany (CET)' },
  { id: 'Europe/London', label: 'UK (GMT)' },
  { id: 'Asia/Dubai', label: 'UAE (GST)' },
];

const STORAGE_KEY = 'actmon_logs_tz';
const DEFAULT_TZ = LOG_TIMEZONES[0].id;

const readInitial = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return LOG_TIMEZONES.some((t) => t.id === saved) ? saved : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
};

export const useLogsTimezoneStore = create((set) => ({
  tz: readInitial(),
  setTz: (tz) => {
    try { localStorage.setItem(STORAGE_KEY, tz); } catch { /* private-browsing etc. */ }
    set({ tz });
  },
}));
