/**
 * DEV-ONLY AUTH BYPASS — off unless explicitly switched on.
 *
 * Set VITE_DISABLE_AUTH=true in frontend/.env.local (gitignored via the ".env.*"
 * rule) to render the app shell without a session, skipping the login page and
 * the mandatory OTP step. Added so the dashboards can be inspected without a
 * working SMTP config, which the OTP flow depends on.
 *
 * Because this reads an import.meta.env flag, a build without the variable set
 * evaluates to false and the guard behaves exactly as before.
 *
 * TO REVERT: delete frontend/.env.local, or set the flag to false.
 *
 * SCOPE: this bypasses the CLIENT-side route guard only. It does not mint a JWT,
 * so requests to the :8000 backend still go out unauthenticated and will 401 —
 * pages render but their data is empty. The :8001 cloud service requires no auth,
 * which is why the cloud pages still show real data.
 */
export const AUTH_DISABLED = import.meta.env.VITE_DISABLE_AUTH === 'true';
