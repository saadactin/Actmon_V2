/**
 * The one place the application blocks the whole screen: resolving who you are
 * before the shell renders.
 *
 * A token can outlive the `user` it was issued with, and the app then has to
 * ask the backend. Until that answers, every page inside the shell would
 * render for an identity nobody has established yet. That wait is real, it is
 * the only full-screen wait the app has, and it is what the loader covers.
 *
 * WHAT IS REGISTERED, AND WHY NOT MORE. Two tasks: the application starting,
 * and the identity call. There is no third — `getMenu()` exists in the API
 * layer but nothing calls it on boot (permissions are restored from local
 * storage), and adding a request purely so a third panel would have something
 * to show would be inventing work to decorate a loading screen. If boot grows
 * a real step later, it gets a task and a panel then.
 *
 * Ordinary page and panel refreshes deliberately do NOT come through here —
 * they keep their in-page loaders, because covering the whole screen for a
 * background refresh is worse than the wait.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import Actmon3DLoader from './Actmon3DLoader';
import { getVariant } from './loaderVariants';
import { readProgress, trackTask, useLoadProgress } from './loadProgressStore';

/**
 * @param active   true while the identity is genuinely unresolved
 * @param resolve  () => Promise — the real call; its outcome drives the bar
 * @param onResolved / onFailed  what the caller does with the result
 */
export default function BootGate({ active, resolve, onResolved, onFailed, children }) {
  const begin = useLoadProgress((s) => s.begin);
  const complete = useLoadProgress((s) => s.complete);
  const reset = useLoadProgress((s) => s.reset);
  const cancel = useLoadProgress((s) => s.cancel);
  const snapshot = useLoadProgress((s) => s);
  const [attempt, setAttempt] = useState(0);
  const runRef = useRef(null);

  useEffect(() => {
    if (!active) { reset(); return undefined; }

    let cancelled = false;
    const spec = getVariant('boot');
    begin(spec.tasks);

    // The application itself is up — this component is running, the stores
    // have rehydrated and the router has matched. That is a real step, and
    // it is finished.
    complete('boot:app');

    runRef.current = (async () => {
      try {
        const me = await trackTask('boot:auth', resolve());
        if (!cancelled) onResolved?.(me);
      } catch (err) {
        if (!cancelled) onFailed?.(err);
      }
    })();

    return () => { cancelled = true; };
    // `attempt` re-runs the sequence when the user presses Try again.
  }, [active, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  if (!active) return children;

  // Hold the loader until the work is genuinely finished, so the shell never
  // appears over a half-resolved session.
  const progress = readProgress(snapshot);
  if (progress.determinate && progress.finished && !progress.failed.length) return children;

  return (
    <Actmon3DLoader
      variant="boot"
      onRetry={retry}
      onCancel={cancel}
    />
  );
}
