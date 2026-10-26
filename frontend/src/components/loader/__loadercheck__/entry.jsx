/* Mounts the real loader against the real stylesheet so its behaviour can be
   driven. The "work" below is controlled from the test, never by a timer —
   which is the property under test. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import Actmon3DLoader from '../Actmon3DLoader';
import BootGate from '../BootGate';
import { useLoadProgress } from '../loadProgressStore';
import { getVariant } from '../loaderVariants';
import { PageLoading, useLoaderReveal } from '@/components/ui/Loading';
import '@/styles/index.css';

/* The harness drives these from the test; nothing resolves on its own. */
let resolveBoot; let rejectBoot;
window.__boot = {
  succeed: (v) => resolveBoot?.(v),
  fail: (e) => rejectBoot?.(new Error(e || 'nope')),
};

/* The content-area loader as a page uses it: the request's state is driven
   from the test through window.__page, and the dashboard replaces the loader
   only through useLoaderReveal — exactly the Oracle dashboard's wiring. */
function PageHarness({ variant }) {
  const [state, setState] = useState({ loading: true, error: null, nodes: undefined });
  window.__page = {
    succeed: () => setState((s) => ({ ...s, loading: false })),
    fail: (e) => setState((s) => ({ ...s, loading: false, error: e || 'ORA-12541: TNS:no listener' })),
    nodes: (n) => setState((s) => ({ ...s, nodes: n })),
    restart: () => setState({ loading: true, error: null, nodes: undefined }),
  };
  const reveal = useLoaderReveal(state.loading, { ok: !state.error });
  return (
    <div style={{ padding: 24 }}>
      <div id="page-header" style={{ height: 120, fontSize: 28, fontWeight: 700 }}>Oracle Dashboard</div>
      <div id="content" style={{ width: '100%' }}>
        {reveal.show
          ? <PageLoading variant={variant} title="Connecting to Oracle…" done={reveal.done} nodes={state.nodes} />
          : state.error
            ? <div id="page-error">Connection failed: {state.error}</div>
            : <div id="page-dashboard" style={{ height: 400 }}>Dashboard content</div>}
      </div>
    </div>
  );
}

function Harness() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'boot';
  const [resolved, setResolved] = useState(false);
  const store = useLoadProgress();

  // Expose the store so the test can drive tasks directly for the
  // variant cases.
  window.__progress = store;
  window.__variant = getVariant;

  if (mode === 'page') return <PageHarness variant={params.get('variant') || 'oracleRac'} />;

  if (mode === 'variant') {
    const name = params.get('variant') || 'databases';
    return <Actmon3DLoader variant={name} />;
  }

  return (
    <BootGate
      active={!resolved}
      resolve={() => new Promise((res, rej) => { resolveBoot = res; rejectBoot = rej; })}
      onResolved={() => setResolved(true)}
      onFailed={() => { window.__bootFailed = true; }}
    >
      <div id="app-ready" style={{ padding: 40, fontSize: 24 }}>Application</div>
    </BootGate>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
