import axios from 'axios';
import { APP } from '@/config/app.config';
import { useAuthStore } from '@/store/authStore';

/**
 * Single axios instance for the whole app.
 *
 * Base URL is `/api/v1` in dev (Vite proxies it to the FastAPI backend on :8000)
 * and can be pointed elsewhere with VITE_API_BASE for a hosted build.
 */
const client = axios.create({
  baseURL: APP.apiBase,
  headers: { 'Content-Type': 'application/json' },
  timeout: APP.requestTimeout,
});

export const TOKEN_KEY = 'actmon_token';

client.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Requests where a 401 is an EXPECTED outcome (wrong password, wrong OTP) — a
// rejected login attempt is not "your session died", and must not redirect the
// login page to itself mid-attempt.
const AUTH_FLOW_PATHS = ['/auth/login', '/auth/verify-otp', '/auth/resend-otp'];

// FastAPI's `detail` is a plain string for a raised HTTPException, but for a
// 422 request-validation failure it's an ARRAY of {loc, msg, type} objects —
// passing that straight into `new Error(...)` stringifies each object to the
// literal text "[object Object]" (JS's default Object.toString()), which is
// exactly what every page rendering a validation error was silently showing.
// This renders the actual field + message instead.
function detailToMessage(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === 'string') return d;
        const field = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== 'body').join('.') : null;
        return field ? `${field}: ${d?.msg || 'invalid'}` : d?.msg || JSON.stringify(d);
      })
      .join('; ');
  }
  if (detail && typeof detail === 'object') return detail.msg || JSON.stringify(detail);
  return null;
}

client.interceptors.response.use(
  (res) => res,
  (error) => {
    // Normalise every failure into an Error with a message worth showing a user,
    // and keep the status on it so callers can special-case 401/403.
    if (error.response) {
      const { status, data } = error.response;

      // A 401 OUTSIDE the auth flow means the token on hand is no longer valid —
      // expired, revoked, or the server restarted and forgot it. Every page that
      // calls the API used to handle this itself (or, mostly, didn't): the token
      // stayed in localStorage and the page just showed its own "not signed in"
      // banner, so the user could sit on a dead session until they thought to
      // refresh. This is the one place that sees EVERY request, so it is the one
      // place that can guarantee the bounce back to /login actually happens.
      const url = error.config?.url || '';
      const isAuthFlow = AUTH_FLOW_PATHS.some((p) => url.includes(p));
      const onLoginPage = typeof window !== 'undefined'
        && window.location.pathname === APP.loginRoute;
      if (status === 401 && !isAuthFlow && !onLoginPage) {
        useAuthStore.getState().clearToken();
        // A hard navigation, not react-router's navigate() — this interceptor
        // runs outside any component, with no access to that hook. Same
        // `?expired=true` convention the token-expiry timer already uses, so
        // Login shows the same "Session expired" notice regardless of which of
        // the two paths caught it.
        window.location.href = `${APP.loginRoute}?expired=true`;
      }

      const err = new Error(detailToMessage(data?.detail) || data?.message || `Request failed (${status})`);
      err.status = status;
      return Promise.reject(err);
    }
    if (error.code === 'ECONNABORTED') {
      return Promise.reject(new Error('The server took too long to respond.'));
    }
    const err = new Error('Cannot reach the server.');
    err.offline = true;
    return Promise.reject(err);
  },
);

/**
 * The message to show for a failed request.
 *
 * The interceptor above has already pulled FastAPI's `detail` onto `error.message`,
 * so `err.response.data.detail` — what the pages ported from the old module all
 * reach for — is always undefined here, and every one of them was quietly falling
 * through to its own generic string. This is the one place that knows the shape.
 */
export function errorText(error, fallback = 'The request failed.') {
  return error?.message || detailToMessage(error?.response?.data?.detail) || fallback;
}

/**
 * Coerce the many shapes the backend returns into an array.
 * Endpoints variously answer with a bare list, `{data: []}`, `{agents: []}`, etc.
 */
export function ensureArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'items', 'results', 'agents', 'servers', 'accounts', 'alerts', 'notifications']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

export default client;
