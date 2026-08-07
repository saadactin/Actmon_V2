/**
 * DEV-ONLY AUTH BYPASS — off unless explicitly switched on.
 *
 * Set VITE_DISABLE_AUTH=true (see Actmon_V1/.env.local, which is gitignored) to
 * skip the login page and render the app shell directly. Added to inspect the
 * cloud dashboards without completing the mandatory OTP flow, which needs a
 * working SMTP config in the smtp_configs table.
 *
 * Because this reads an import.meta.env flag, a production build without the
 * variable set compiles to `false` and the guard behaves exactly as before.
 *
 * TO REVERT: delete Actmon_V1/.env.local (or set the flag to false).
 *
 * NOTE: this only bypasses the CLIENT-side route guard. It does not mint a JWT,
 * so requests to the :8000 backend still go out unauthenticated and will 401 —
 * the response interceptor logs those and keeps the session, so pages render but
 * their data will be empty. The :8001 cloud service does not require auth, which
 * is why the cloud pages still show real data.
 */
export const AUTH_DISABLED = import.meta.env.VITE_DISABLE_AUTH === 'true';
