/**
 * ORACLE WAIT EVENTS — what a wait actually means, and what to do about it.
 *
 * A wait event name is only useful to someone who already knows Oracle. This is
 * the knowledge that turns "log file sync, 4.2s" into a decision, and it lives
 * here rather than inside one panel so the Live Queries table, the dashboard's
 * wait chart and the report all explain an event the same way.
 *
 * Matched most-specific-first: `enq: TX` is a row lock, while plain `enq:` covers
 * the rest of the enqueue family.
 */

/**
 * `test` is matched against the event name, or against the wait CLASS where the
 * event name alone doesn't say enough (an idle session has no event).
 */
const WAIT_KB = [
  {
    id: 'db-file-sequential-read',
    test: /db file sequential read/i,
    label: 'Single-block read',
    why: 'One block at a time from disk — typically an index lookup, or a read of undo. '
      + 'The blocks it needs are not in the buffer cache.',
    action: 'Check the index is selective enough to be worth using, and whether the '
      + 'buffer cache is large enough to hold the working set.',
    tone: 'warning',
  },
  {
    id: 'db-file-scattered-read',
    test: /db file scattered read/i,
    label: 'Multi-block read (full scan)',
    why: 'A full table or index scan is running. Oracle reads many blocks at once, '
      + 'which is efficient per block but means it is reading the whole object.',
    action: 'If the query should be selective, it is missing a usable index. If the scan '
      + 'is intended, consider partitioning so it reads less.',
    tone: 'warning',
  },
  {
    id: 'log-file-sync',
    test: /log file sync/i,
    label: 'Commit waiting on redo',
    why: 'The session has committed and is waiting for the log writer to flush redo to '
      + 'disk. Usually caused by committing very often, or by slow redo storage.',
    action: 'Batch work into fewer commits, and check redo log write latency — redo '
      + 'belongs on the fastest storage available.',
    tone: 'warning',
  },
  {
    id: 'log-file-parallel-write',
    test: /log file parallel write/i,
    label: 'Redo write to disk',
    why: 'The log writer itself is waiting on the storage holding the redo logs.',
    action: 'This is a storage latency problem, not a SQL problem. Move redo to faster '
      + 'disk, or separate it from datafile I/O.',
    tone: 'warning',
  },
  {
    id: 'enq-tx-row-lock',
    test: /enq: tx\s*-\s*row lock|enq: tx/i,
    label: 'Row lock — blocked by another session',
    why: 'Another session has uncommitted changes to a row this one needs. It will wait '
      + 'until that session commits or rolls back.',
    action: 'Find the blocking session and deal with that transaction — this session '
      + 'cannot proceed on its own. Long-open transactions are the usual cause.',
    tone: 'danger',
  },
  {
    id: 'enq-tm',
    test: /enq: tm/i,
    label: 'Table lock',
    why: 'A DDL or an unindexed foreign key is holding a table-level lock.',
    action: 'Index the foreign key columns — an unindexed FK makes Oracle lock the whole '
      + 'child table on a parent delete.',
    tone: 'danger',
  },
  {
    id: 'enq-other',
    test: /^enq:/i,
    label: 'Enqueue (lock) wait',
    why: 'Waiting for a lock other than a row or table lock — a sequence, a space '
      + 'allocation, or an internal resource.',
    action: 'The lock type in the event name identifies which resource; check v$lock for '
      + 'who holds it.',
    tone: 'danger',
  },
  {
    id: 'buffer-busy',
    test: /buffer busy waits/i,
    label: 'Hot block contention',
    why: 'Several sessions want the same block at the same time. Common on a small, '
      + 'heavily-updated table or a sequence-driven index leaf.',
    action: 'Spread the access: increase the number of freelists, use ASSM, or hash-'
      + 'partition the hot object.',
    tone: 'danger',
  },
  {
    id: 'latch',
    test: /latch/i,
    label: 'Latch contention',
    why: 'Contention on an in-memory structure. Usually means very high concurrency on '
      + 'one shared thing — often the shared pool, from SQL that is not using bind variables.',
    action: 'Check for literal SQL that should be using bind variables; that is the most '
      + 'common cause of library-cache latch contention.',
    tone: 'danger',
  },
  {
    id: 'sqlnet',
    test: /sql\*net/i,
    label: 'Network round-trip',
    why: 'Waiting on the client. The database has done its work and is sending rows, or '
      + 'waiting for the next request.',
    action: 'Usually an application problem, not a database one: fetch in larger batches, '
      + 'and avoid row-by-row processing across the network.',
    tone: 'info',
  },
  {
    id: 'read-by-other-session',
    test: /read by other session/i,
    label: 'Waiting on another session’s read',
    why: 'Another session is already reading the block this one wants from disk.',
    action: 'A symptom of the same I/O pressure as the read events — the fix is the same.',
    tone: 'warning',
  },
  {
    id: 'free-buffer-waits',
    test: /free buffer waits/i,
    label: 'Buffer cache full',
    why: 'No clean buffer is available: the cache is too small for the workload, or the '
      + 'database writer cannot keep up.',
    action: 'Increase the buffer cache, or reduce the write rate. Check DBWR write times.',
    tone: 'danger',
  },
  {
    id: 'cpu',
    test: /^cpu$|on cpu/i,
    classTest: /^cpu$/i,
    label: 'On CPU',
    why: 'Not waiting at all — the session is actively using CPU. Parsing, sorting, or '
      + 'processing rows.',
    action: 'If this dominates, look for work being done that need not be: full scans, '
      + 'cartesian joins, sorts that could use an index.',
    tone: 'success',
  },
  {
    id: 'concurrency',
    classTest: /concurrency/i,
    label: 'Concurrency wait',
    why: 'Waiting for a shared internal resource other sessions also want.',
    action: 'Reduce the contention rather than tuning the individual statement — spread '
      + 'the work across more blocks or more objects.',
    tone: 'danger',
  },
  {
    id: 'user-io',
    classTest: /user i\/o/i,
    label: 'User I/O',
    why: 'Waiting for the storage to return blocks the session asked for.',
    action: 'Either it is reading more than it needs (a SQL problem) or the storage is '
      + 'slow (an infrastructure problem). The read events above distinguish them.',
    tone: 'warning',
  },
  {
    id: 'idle',
    classTest: /idle/i,
    label: 'Idle',
    why: 'The session is connected but doing nothing. Idle waits are not a problem and '
      + 'are normally excluded from wait analysis.',
    action: 'Nothing to do. A large number of idle sessions may point at a connection '
      + 'pool that is bigger than it needs to be.',
    tone: 'neutral',
  },
];

const UNKNOWN = {
  id: 'unknown',
  label: 'Unclassified wait',
  why: null,
  action: 'Look the event up in v$event_name and Oracle’s wait-event reference — it is '
    + 'not one of the common ones.',
  tone: 'neutral',
};

/**
 * Explain one wait. Returns `{ id, label, why, action, tone }`; `why` is null for
 * an event this does not recognise, so a caller can tell "explained" from "named".
 */
export function explainWait(event, waitClass) {
  const ev = String(event || '').trim();
  const wc = String(waitClass || '').trim();

  if (ev) {
    const byEvent = WAIT_KB.find((k) => k.test?.test(ev));
    if (byEvent) return byEvent;
  }
  if (wc) {
    const byClass = WAIT_KB.find((k) => k.classTest?.test(wc));
    if (byClass) return byClass;
  }
  return { ...UNKNOWN, why: ev ? `Waiting on ${ev}.` : null };
}

/** Whether a wait is one of the idle ones that should be excluded from analysis. */
export const isIdleWait = (event, waitClass) =>
  /idle/i.test(String(waitClass || '')) || !String(event || '').trim();

/**
 * Wait class → a tone for a badge. Classes, not events: the class is what Oracle
 * itself groups by, so a chart legend built on classes stays stable.
 */
export const WAIT_CLASS_TONES = {
  'User I/O': 'warning',
  'System I/O': 'warning',
  Concurrency: 'danger',
  Application: 'danger',
  Configuration: 'warning',
  Commit: 'warning',
  Network: 'info',
  Cluster: 'info',
  Administrative: 'neutral',
  Scheduler: 'neutral',
  Other: 'neutral',
  Idle: 'neutral',
  CPU: 'success',
};
