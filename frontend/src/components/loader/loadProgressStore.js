/**
 * The one place a loading percentage may come from.
 *
 * A progress bar is a claim about work: "this much of what you are waiting for
 * is done". The easy implementations make that claim up — a timer that creeps
 * toward 90%, a number that jumps to 72 because 72 looked convincing in a
 * mockup. Both are confident and wrong, and when the work actually fails the
 * bar keeps climbing.
 *
 * So progress here is only ever a ratio of REGISTERED WORK. A caller declares
 * the tasks it is about to perform, with a weight for each, then reports each
 * one done or failed. Until something is registered there is no denominator
 * and no percentage — the store says so, and the bar runs indeterminate rather
 * than inventing a figure.
 *
 * Three rules this file exists to enforce:
 *   1. No percentage without registered work.
 *   2. The value can never exceed 100.
 *   3. 100 is reached only when every registered task has actually finished.
 */
import { create } from 'zustand';

export const TASK = {
  pending: 'pending',
  active: 'active',
  done: 'done',
  failed: 'failed',
};

const EMPTY = { tasks: {}, order: [], startedAt: null, cancelled: false };

export const useLoadProgress = create((set, get) => ({
  ...EMPTY,

  /**
   * Declare the work for one loading operation. Called once, up front: a
   * denominator that grows as you go makes the bar walk backwards, which reads
   * as a bug even when the underlying work is fine.
   *
   * `tasks` is [{ id, label, weight?, panel? }]. `panel` names which monitoring
   * panel this task drives, so a panel is only ever shown for work that is
   * genuinely happening.
   */
  begin(tasks) {
    const list = Array.isArray(tasks) ? tasks.filter((t) => t && t.id) : [];
    set({
      tasks: Object.fromEntries(list.map((t) => [t.id, {
        id: t.id,
        label: t.label || t.id,
        weight: Number(t.weight) > 0 ? Number(t.weight) : 1,
        panel: t.panel || null,
        // Carried through, not dropped: the panel on screen and the platform
        // it stands on are both positioned from `slot`, and `kind` picks the
        // icon and the 3D emblem. Losing them here left the loader with a
        // working percentage and no panels at all.
        slot: t.slot || null,
        kind: t.kind || null,
        status: TASK.pending,
        error: null,
      }])),
      order: list.map((t) => t.id),
      startedAt: Date.now(),
      cancelled: false,
    });
  },

  /** Mark a task as in flight. Purely for the panel's own label — a task that
   *  is running is not partially complete, and contributes nothing yet. */
  start(id) {
    const t = get().tasks[id];
    if (!t || t.status === TASK.done) return;
    set((s) => ({ tasks: { ...s.tasks, [id]: { ...t, status: TASK.active } } }));
  },

  complete(id) {
    const t = get().tasks[id];
    if (!t) return;
    set((s) => ({ tasks: { ...s.tasks, [id]: { ...t, status: TASK.done, error: null } } }));
  },

  fail(id, error) {
    const t = get().tasks[id];
    if (!t) return;
    set((s) => ({
      tasks: { ...s.tasks, [id]: { ...t, status: TASK.failed, error: String(error?.message || error || 'failed') } },
    }));
  },

  /** The caller went away — stop claiming anything is in progress. */
  cancel() { set({ ...EMPTY, cancelled: true }); },

  /** Operation over; the store holds nothing until the next `begin`. */
  reset() { set({ ...EMPTY }); },
}));

/* ── derived readings ───────────────────────────────────────────────────
   Pure functions over a snapshot, so they can be tested without React and
   so every consumer reads the same number. */

/**
 * The progress of a snapshot.
 *
 * `determinate` is false when nothing is registered: there is no denominator,
 * so there is no honest percentage and the caller must show an indeterminate
 * bar instead of a number.
 *
 * A failed task counts as settled — the operation is over for it, and leaving
 * it out would park the bar below 100 forever while the error is already on
 * screen.
 *
 * `operationFailed` is ANY failure, not all of them. These sequences are
 * blocking: if one required step failed, the thing you were waiting for did
 * not happen, whatever the other steps managed. Reporting that as "1 of 2
 * done, 100%" leaves a full bar over a session that was never established —
 * the stuck-at-a-number case, with extra confidence.
 */
export function readProgress(snapshot) {
  const tasks = Object.values(snapshot?.tasks || {});
  if (!tasks.length) {
    return {
      determinate: false, percent: null, done: 0, total: 0,
      failed: [], active: [], finished: false,
      operationFailed: false, failedAll: false,
    };
  }

  const total = tasks.reduce((sum, t) => sum + t.weight, 0);
  const settled = tasks.filter((t) => t.status === TASK.done || t.status === TASK.failed);
  const doneWeight = settled.reduce((sum, t) => sum + t.weight, 0);
  const failed = tasks.filter((t) => t.status === TASK.failed);

  // Clamped as a belt-and-braces measure: a caller that registers a task twice
  // should produce a wrong label, never a 140% bar.
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((doneWeight / total) * 100))) : null;

  return {
    determinate: true,
    percent,
    done: settled.length,
    total: tasks.length,
    failed,
    active: tasks.filter((t) => t.status === TASK.active),
    finished: settled.length === tasks.length,
    operationFailed: failed.length > 0,
    failedAll: failed.length === tasks.length,
  };
}

/** The line under the bar: what is happening right now, in the caller's own
 *  words. Falls back to the next pending task so the line is never empty
 *  between one task finishing and the next starting. */
export function currentLabel(snapshot, fallback) {
  const order = snapshot?.order || [];
  const tasks = snapshot?.tasks || {};
  const active = order.map((id) => tasks[id]).find((t) => t?.status === TASK.active);
  if (active) return active.label;
  const next = order.map((id) => tasks[id]).find((t) => t?.status === TASK.pending);
  if (next) return next.label;
  return fallback || null;
}

/**
 * Run a promise as a registered task: started when it begins, completed or
 * failed by its own outcome. Nothing here can mark work done that did not
 * finish, which is the whole point.
 */
export async function trackTask(id, promise) {
  const store = useLoadProgress.getState();
  store.start(id);
  try {
    const value = await promise;
    useLoadProgress.getState().complete(id);
    return value;
  } catch (err) {
    useLoadProgress.getState().fail(id, err);
    throw err;
  }
}
