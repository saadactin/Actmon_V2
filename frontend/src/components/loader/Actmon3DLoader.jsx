/**
 * The full-screen ACTMON loader.
 *
 * Three things it refuses to do, because each of them is a lie the easy
 * implementation tells:
 *
 *   It will not show a percentage it cannot justify. The number comes from
 *   `loadProgressStore`, which counts registered work. With nothing
 *   registered — a dynamic import, say, which reports no progress — the bar
 *   runs indeterminate and NO number is shown.
 *
 *   It will not show a monitoring panel for a subsystem that is not being
 *   queried. A variant declares the work it is actually doing, and only those
 *   panels, platforms and beams are drawn.
 *
 *   It will not report a subsystem healthy because its panel exists. Each
 *   panel's state is its task's real state: waiting, checking, done, or
 *   failed with the error.
 *
 * The composition is CSS and renders immediately. `three` is imported on
 * demand and layers the animated scene over it, so the engine is never in the
 * entry bundle and a machine without WebGL simply keeps the CSS version.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import Icon from '@/components/ui/Icon';
import { APP } from '@/config/app.config';
import { cn } from '@/lib/cn';

import { KINDS, getVariant } from './loaderVariants';
import { TASK, currentLabel, readProgress, useLoadProgress } from './loadProgressStore';
import './actmonLoader.css';

/** Draw the scene's projected node labels into `root`, reusing elements. */
function paintLabels(root, list) {
  if (!root) return;
  const seen = new Set();
  list.forEach((l) => {
    seen.add(l.key);
    let el = root.querySelector(`[data-key="${l.key}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'actmon-node-label';
      el.dataset.key = l.key;
      root.appendChild(el);
    }
    const text = `${l.label}${l.sub ? ` · ${l.sub}` : ''}`;
    if (el.textContent !== text) el.textContent = text;
    el.dataset.state = l.state;
    el.style.transform = `translate(-50%, -100%) translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`;
    el.style.opacity = String(Math.max(0, Math.min(1, l.alpha)));
  });
  [...root.children].forEach((el) => { if (!seen.has(el.dataset.key)) el.remove(); });
}

const STATUS_TEXT = {
  [TASK.pending]: 'Waiting…',
  [TASK.active]: null, // the task's own label is more specific
  [TASK.done]: 'Done',
  [TASK.failed]: 'Failed',
};

function Panel({ task }) {
  const kind = KINDS[task.kind] || KINDS.app;
  const status = task.status === TASK.failed
    ? (task.error || 'Failed')
    : task.status === TASK.active
      ? task.label
      : STATUS_TEXT[task.status];
  return (
    <div className="actmon-panel" data-state={task.status} title={status}>
      <span className="actmon-panel-icon"><Icon name={kind.icon} size={15} /></span>
      <span className="actmon-panel-text">
        <span className="actmon-panel-title">{task.panel}</span>
        <span className="actmon-panel-status">{status}</span>
      </span>
    </div>
  );
}

/**
 * @param variant   which operation this is — see loaderVariants.js
 * @param title     overrides the variant's headline
 * @param onRetry   shown when every registered task failed
 * @param onCancel  called on unmount so the operation does not keep claiming
 *                  to be in progress after its loader has gone
 */
export default function Actmon3DLoader({
  variant = 'route', title, onRetry, onCancel, fullscreen = true, minHeight,
  tracked = fullscreen, done = false, failed = false, nodes,
}) {
  const spec = getVariant(variant);
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [webgl, setWebgl] = useState(false);

  /* `tracked`: read the shared progress store. The boot sequence registers its
     steps there. A page's content loader does not — its wait is one query the
     page owns — so it must not show (or be stalled by) the boot's tasks. */
  const storeSnap = useLoadProgress((s) => s);
  const snapshot = tracked ? storeSnap : { order: [], tasks: {} };
  const progress = readProgress(snapshot);
  const tasks = (snapshot.order || []).map((id) => snapshot.tasks[id]).filter(Boolean);

  // Panels come from the registered tasks when there are any, so the screen
  // describes the work actually under way. With none registered the variant's
  // own declaration is used: in a page loader that work IS under way (the page
  // is mounted because its query is pending), so it shows as in progress;
  // otherwise waiting. Never completed — nothing here has confirmed that.
  const panelTasks = tasks.length
    ? tasks
    : spec.tasks.map((t) => ({ ...t, status: tracked ? TASK.pending : TASK.active, error: null }));

  const left = panelTasks.filter((t) => String(t.slot || '').match(/slot-[012]/));
  const right = panelTasks.filter((t) => String(t.slot || '').match(/slot-[345]/));

  /* ── the 3D world, loaded on demand ──
     Built ONCE per context. Stage changes only retarget it (see
     cinematicScene.js), so the canvas is never remounted between stages. */
  const labelsRef = useRef(null);

  /* Panel mode fills the content area from where it starts down to the
     bottom of the window, whatever sits above it (nav, page header, tabs,
     instance picker) — so there is no blank band under it on any page. */
  const rootRef = useRef(null);
  const [fitHeight, setFitHeight] = useState(null);
  useLayoutEffect(() => {
    if (fullscreen || minHeight) return undefined;
    const fit = () => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 0;
      setFitHeight(Math.max(420, Math.min(820, Math.round(window.innerHeight - top - 16))));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fullscreen, minHeight]);
  const [sceneReady, setSceneReady] = useState(false);
  const reducedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    reducedRef.current = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    (async () => {
      try {
        const mod = await import('./cinematicScene');
        if (cancelled || !canvasRef.current) return;
        if (!mod.webglAvailable()) return; // the CSS composition stands on its own
        sceneRef.current = mod.createCinematicScene(canvasRef.current, {
          reducedMotion: reducedRef.current,
          onLabels: (list) => paintLabels(labelsRef.current, list),
        });
        // Development only: lets the loader harness pause and seek the build.
        if (import.meta.env.DEV) window.__actmonScene = sceneRef.current;
        if (!cancelled) { setWebgl(true); setSceneReady(true); }
      } catch {
        // A failed chunk or a refused context is not an error worth showing
        // on a loading screen — the CSS composition is already on screen.
      }
    })();

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [variant]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Real RAC instances, when the page has them. Unknown until then. */
  const nodesKey = JSON.stringify((nodes || []).map((n) => [n.instance_name, n.host_name, n.instance_status, n.error]));
  useEffect(() => {
    if (sceneReady) sceneRef.current?.setNodes(nodes && nodes.length ? nodes : null);
  }, [sceneReady, nodesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The real request finished: the world fades out (the reveal). Until then
     the scene keeps building and then keeps moving — its timeline is
     animation, never a progress figure. */
  const stage = done ? 10 : 1;
  useEffect(() => { if (done && sceneReady) sceneRef.current?.setDone(); }, [done, sceneReady]);


  /* A hidden tab should not be rendering a loading animation. */
  useEffect(() => {
    const onVis = () => sceneRef.current?.setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  /* The operation owns the store; when its loader goes, so does its claim. */
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => () => { cancelRef.current?.(); }, []);

  const retry = useCallback(() => { onRetry?.(); }, [onRetry]);

  const headline = title || spec.title;
  const message = currentLabel(snapshot, headline);
  /* ANY failed step ends a blocking sequence: whatever else succeeded, the
     thing being waited for did not happen. Treating only an all-failed run as
     a failure left a full bar sitting over a session that was never
     established. */
  const failedAll = progress.determinate && progress.operationFailed;
  const firstError = progress.failed?.map((f) => `${f.panel || f.label} — ${f.error}`).join('; ');

  return (
    <div
      className={cn('actmon-loader', !fullscreen && 'actmon-loader--panel')}
      data-webgl={webgl}
      data-stage={stage}
      role="status"
      aria-live="polite"
      ref={rootRef}
      style={minHeight ? { height: minHeight } : fitHeight ? { height: fitHeight } : undefined}
    >
      <canvas ref={canvasRef} className="actmon-canvas" aria-hidden="true" />
      {/* Real node labels, positioned by the scene each frame (no re-render). */}
      <div ref={labelsRef} className="actmon-labels" aria-hidden="true" />

      {/* The supplied logo, whole. It already contains ACTMON and INTELLIGENT
          MONITORING, so the typed versions that used to sit under it are gone
          — they were a second wordmark over the first. */}
      <header className="actmon-brand">
        {APP.logoUrl
          ? <img src={APP.logoUrl} alt={APP.name || 'ACTMON'} className="brand-asset actmon-brand-logo" />
          : (
            <>
              <p className="actmon-brand-name">{APP.name || 'ACTMON'}</p>
              <p className="actmon-brand-sub">Intelligent Monitoring</p>
            </>
          )}
      </header>

      <div className="actmon-stage">
        <div className="actmon-col">
          {left.map((t) => <Panel key={t.id} task={t} />)}
        </div>

        {/* Visible until the canvas takes over, and the whole picture when it
            cannot — no WebGL, a blocked import, a lost context. */}
        <div className="actmon-core" aria-hidden="true">
          <span className="actmon-core-ring" />
          <span className="actmon-core-ring" />
          <span className="actmon-core-ring" />
          <span className="actmon-core-disc" />
        </div>

        <div className="actmon-col actmon-col--right">
          {right.map((t) => <Panel key={t.id} task={t} />)}
        </div>
      </div>

      <footer className="actmon-foot">
        {failedAll ? (
          <>
            <p className="actmon-error">
              {firstError ? `Loading failed: ${firstError}` : 'Loading failed.'}
            </p>
            {onRetry && <button type="button" className="actmon-retry" onClick={retry}>Try again</button>}
          </>
        ) : (
          <>
            <div
              className="actmon-bar"
              data-indeterminate={!progress.determinate}
              role="progressbar"
              aria-valuenow={progress.determinate ? progress.percent : undefined}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={headline}
            >
              <div
                className="actmon-bar-fill"
                style={progress.determinate ? { width: `${progress.percent}%` } : undefined}
              />
            </div>

            {/* No denominator, no number. An indeterminate wait gets a sweep
                and the message, which is all that is actually known. */}
            {progress.determinate && <span className="actmon-percent">{progress.percent}%</span>}

            <p className="actmon-message">{message}</p>

            {panelTasks.length > 0 && (
              <p className="actmon-categories">
                {panelTasks.map((t, i) => (
                  <span key={t.id} data-state={t.status}>
                    {i > 0 && <i>•&nbsp;</i>}
                    {t.panel}
                  </span>
                ))}
              </p>
            )}

          </>
        )}
      </footer>
    </div>
  );
}
