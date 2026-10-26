/**
 * The ten stages of the loading scene, and the small state machine that moves
 * between them.
 *
 * A stage is a COMPOSITION — where the camera is, which parts of the world are
 * lit — not a claim that some piece of backend work happened. The work a page
 * is waiting on is one request; nothing here pretends it is ten. So:
 *
 *   - a page only visits the stages that depict what it actually queries
 *     (an Oracle page never tours cloud or agents);
 *   - the tour only moves forward while the real request is still pending and
 *     once the scene is actually on screen, and it parks on stage 9 for as long
 *     as the request keeps running — it never reaches "done" on its own;
 *   - stage 10, the reveal, is entered ONLY when the caller reports success;
 *   - a failure freezes the tour where it is (the page's own error UI takes
 *     over), and a fast request simply skips whatever stages it did not need.
 *
 * Pure functions, so the rules can be tested without a browser.
 */

export const STAGE = {
  init: 1, connect: 2, infra: 3, rac: 4, telemetry: 5,
  cloud: 6, agents: 7, processing: 8, prepare: 9, reveal: 10,
};

/** What each stage is a picture of. `caption` describes the visualisation —
 *  it is never phrased as a completed step. */
export const STAGE_INFO = {
  1: { caption: 'ACTMON monitoring core' },
  2: { caption: 'Database connectivity' },
  3: { caption: 'Infrastructure' },
  4: { caption: 'Oracle RAC instances' },
  5: { caption: 'Database telemetry' },
  6: { caption: 'Cloud services' },
  7: { caption: 'Monitoring agents' },
  8: { caption: 'Metrics processing' },
  9: { caption: 'Preparing the dashboard' },
  10: { caption: '' },
};

/** Minimum time on a stage before the tour may move on, so each composition
 *  is seen settle rather than flashing past. Not a delay on the data: the
 *  reveal (10) is entered the moment the request succeeds, from any stage. */
export const DWELL_MS = 2600;

/** The stages each loading context visits, in order. Always 1 first and 9
 *  last; 10 is reached only through `done`. */
export const SEQUENCES = {
  oracleRac: [1, 2, 4, 5, 8, 9],
  databases: [1, 2, 5, 8, 9],
  infrastructure: [1, 3, 8, 9],
  cloud: [1, 6, 8, 9],
  agents: [1, 7, 8, 9],
  security: [1, 2, 8, 9],
  boot: [1, 2, 8, 9],
  route: [1, 2, 8, 9],
};

export function sequenceFor(variant) {
  return SEQUENCES[variant] || SEQUENCES.route;
}

export function initialState() {
  return { idx: 0, enteredAt: null, frozen: false };
}

/**
 * Next state of the tour.
 *
 * @param seq    the context's stage list
 * @param state  { idx, enteredAt, frozen }
 * @param ev     { now, sceneReady, done, failed, reducedMotion }
 */
export function step(seq, state, ev) {
  const last = seq.length - 1;
  if (state.frozen) return state;
  if (ev.failed) return { ...state, frozen: true };
  if (ev.done) return state.idx === -1 ? state : { idx: -1, enteredAt: ev.now, frozen: false };
  // Reduced motion: no tour — one still composition of the whole context.
  if (ev.reducedMotion) return state.idx === last ? state : { idx: last, enteredAt: ev.now, frozen: false };
  if (!ev.sceneReady) return state;
  if (state.enteredAt === null) return { ...state, enteredAt: ev.now };
  if (state.idx < last && ev.now - state.enteredAt >= DWELL_MS) {
    return { idx: state.idx + 1, enteredAt: ev.now, frozen: false };
  }
  return state;
}

/** The stage number a state shows. idx -1 is the reveal. */
export function stageOf(seq, state) {
  return state.idx === -1 ? STAGE.reveal : seq[Math.max(0, Math.min(seq.length - 1, state.idx))];
}

/** RAC node state from GV$INSTANCE, as the scene colours it. Anything not
 *  reported is 'unknown' — never assumed healthy. */
export function nodeState(n) {
  if (!n) return 'unknown';
  if (n.error) return 'failed';
  const s = String(n.instance_status || n.status || '').toUpperCase();
  if (!s) return 'unknown';
  if (s === 'OPEN') return 'known';
  if (s === 'MOUNTED' || s === 'STARTED') return 'connecting';
  return 'failed';
}
