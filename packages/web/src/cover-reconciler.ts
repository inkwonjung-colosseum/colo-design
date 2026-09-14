/**
 * D65 의 단언 고리 — the one z-order rule, made repairable.
 *
 * The native preview view draws above every renderer pixel, so the renderer
 * owns exactly one fact — "a layer is over the stage right now" — and the
 * main process obeys it. The fact is ASSERTED, never toggled, and this
 * reconciler is what makes an assertion survive a call that does not land:
 *
 *  - `applied` is what main CONFIRMED, not what we meant. A rejected call
 *    drops it back to unknown; it is never set to the opposite, because a
 *    call can reject after main already applied it and guessing would push
 *    the next assertion the wrong way.
 *  - a rejected assertion retries on a bounded backoff. The DOM cannot be
 *    trusted to ring again: the layer that exposed this bug is a settings
 *    modal sitting still, and a still modal produces no mutations at all.
 *  - one call is in flight at a time, and the state read AFTER it settles
 *    is the one that counts — a layer opened and closed inside a round trip
 *    still converges, and a streaming transcript does not emit an IPC call
 *    per mutation batch.
 */

/**
 * The layers that must cover the stage. Four class names by convention
 * (`.modal` z60 · `.palette` z70 · `.selector__backdrop` z40 · `.pip--large`)
 * plus an opt-in attribute, so a new layer can join without being renamed.
 * The reverse rule lives in styles.css's z-index note.
 */
export const COVER_LAYERS =
  ".modal, .palette, .selector__backdrop, .pip--large, [data-cover-stage]";

/** Waits between retries of a rejected assertion, in order. */
export const COVER_RETRY_MS = [250, 750, 2000];

/** A pending backoff, as the host's timer API named it. Opaque on purpose. */
export type CoverTimer = unknown;

export interface CoverReconcilerOptions {
  /** Reads the DOM: is a layer over the stage right now? */
  desired: () => boolean;
  /** The bridge call. Resolves once main has applied the assertion. */
  apply: (on: boolean) => Promise<unknown>;
  /** Backoff for rejected assertions; empty disables retrying. */
  retries?: number[];
  /** Injected in tests — the timer the backoff rides. */
  setTimer?: (run: () => void, ms: number) => CoverTimer;
  clearTimer?: (handle: CoverTimer) => void;
}

export interface CoverReconciler {
  /** Re-read the DOM and assert if main's confirmed state disagrees. */
  sync: () => void;
  /** Stop retrying — the watcher is going away. */
  stop: () => void;
  /** What main last confirmed; null while unknown. */
  applied: () => boolean | null;
}

export function createCoverReconciler(options: CoverReconcilerOptions): CoverReconciler {
  const retries = options.retries ?? COVER_RETRY_MS;
  // The browser's handle is a number; tests hand back whatever they like,
  // so the reconciler only ever stores it and gives it back.
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number): CoverTimer => window.setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: CoverTimer) => window.clearTimeout(handle as number));

  /** main's confirmed state — null means "unknown", which always re-asserts. */
  let confirmed: boolean | null = null;
  let inflight = false;
  let stopped = false;
  /** Rejections since the last confirmed assertion — indexes the backoff. */
  let failures = 0;
  let timer: unknown = null;

  const disarm = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const assert = (): void => {
    if (stopped || inflight) return;
    const want = options.desired();
    if (want === confirmed) return;
    inflight = true;
    disarm();
    let settled: Promise<boolean>;
    try {
      settled = Promise.resolve(options.apply(want)).then(
        () => true,
        () => false,
      );
    } catch {
      // A bridge that throws rather than rejects is the same event.
      settled = Promise.resolve(false);
    }
    void settled.then((ok) => {
      inflight = false;
      if (stopped) return;
      if (ok) {
        confirmed = want;
        failures = 0;
        // The DOM may have moved while the call was out.
        if (options.desired() !== confirmed) assert();
        return;
      }
      confirmed = null;
      const wait = retries[failures];
      if (wait === undefined) return; // budget spent; a DOM change revives it
      failures += 1;
      timer = setTimer(() => {
        timer = null;
        assert();
      }, wait);
    });
  };

  return {
    sync: () => {
      // A DOM change is fresh evidence: the backoff starts over, so a
      // planner who keeps working is never left behind a spent retry budget.
      failures = 0;
      disarm();
      assert();
    },
    stop: () => {
      stopped = true;
      disarm();
    },
    applied: () => confirmed,
  };
}
