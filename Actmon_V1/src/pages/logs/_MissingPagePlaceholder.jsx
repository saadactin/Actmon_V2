import React from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * RECOVERY SCAFFOLDING — not a real feature page.
 *
 * LogsHub, LogsCategoryPage, AllTelemetryPage and AdminUserLogsPage are routed
 * from src/main.jsx but were never committed to any branch: Actmon_V1/.gitignore
 * carried a bare "logs" rule (Vite template default) that silently ignored
 * src/pages/logs/. Because vite.config.js disables the HMR error overlay, the
 * unresolved imports broke the whole module graph and the app rendered blank
 * with no visible error.
 *
 * The ignore rule is now scoped to /logs, so dropping the real implementations
 * into this folder will track them properly. Replace these placeholders then.
 */
export const MissingPagePlaceholder = ({ title, route }) => (
  <div className="p-6">
    <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40">
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <div>
        <h2 className="font-semibold text-amber-900 dark:text-amber-200">
          {title} — implementation not in this repo
        </h2>
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
          This route ({route}) is wired up in <code>src/main.jsx</code>, but its component was
          never committed — a bare <code>logs</code> rule in <code>Actmon_V1/.gitignore</code> kept
          <code> src/pages/logs/ </code> out of the repository. That rule is now scoped to
          <code> /logs</code>, so restoring the real file here will version it correctly.
        </p>
      </div>
    </div>
  </div>
);

export default MissingPagePlaceholder;
