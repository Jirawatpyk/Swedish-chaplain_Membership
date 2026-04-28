/**
 * useIdleWarningSuppression — pauses the F1 idle-watcher while a
 * long-running, user-attention-holding UI (such as the G2 PaySheet
 * drawer) is open, and resumes the normal 29-minute warning clock on
 * close/unmount.
 *
 * Why this exists
 * ---------------
 * The Stripe PaymentElement + 3DS challenge flow can legitimately
 * keep the PaySheet open for 5–10 minutes without any mouse/keyboard
 * activity on the page itself (the 3DS iframe owns focus). Under the
 * default F1 policy that would trigger the 29-minute "Are you still
 * here?" modal and involuntarily sign the user out mid-payment
 * (FR-028c).
 *
 * Contract (spec F5 / 009-online-payment / FR-028c)
 * -------------------------------------------------
 * - `isActive=true`  → dispatch `CustomEvent('swecham:pause-idle-timer')`
 *   once (on the transition false → true, or on mount if already true).
 * - `isActive=false` → dispatch `CustomEvent('swecham:resume-idle-timer')`
 *   once (on the transition true → false).
 * - On unmount while active → dispatch `resume` in the cleanup so a
 *   drawer that crashes or unmounts abruptly never leaves the idle
 *   watcher frozen.
 * - Hard cap: even with suppression active, a drawer open longer than
 *   30 minutes flips `timeoutExceeded=true` so the PaySheet body can
 *   render an in-drawer "Are you still here?" prompt rather than
 *   silently holding the session open forever.
 * - `reset()` — G3/G4 calls this when the user confirms the in-drawer
 *   prompt; it re-arms the 30-minute hard-cap timer.
 *
 * Why CustomEvent (not a shared React context / Zustand store)
 * ------------------------------------------------------------
 * The F1 <IdleWarningDialog> already uses `window.addEventListener`
 * for its test hook (`swecham:open-idle-warning`). Extending the same
 * `swecham:*` event namespace keeps the contract symmetric and avoids
 * a provider boundary that would have to wrap the entire authenticated
 * shell. Cross-tree wiring without prop drilling is exactly what
 * CustomEvent is for, and it's same-origin-safe because the listener
 * can only be attached from inside our own client bundle.
 *
 * PCI note
 * --------
 * This hook deliberately stores NOTHING — no client secret, no payment
 * state, no session token. It only flips a boolean and manages a
 * single timer. Zero persistence (localStorage/sessionStorage/cookies).
 */
import * as React from 'react';

/** Hard-cap: involuntarily resume idle-watcher after 30 min of drawer-open, FR-028c. */
export const PAY_SHEET_HARD_CAP_MS = 30 * 60 * 1000;

export const PAUSE_IDLE_TIMER_EVENT = 'swecham:pause-idle-timer' as const;
export const RESUME_IDLE_TIMER_EVENT = 'swecham:resume-idle-timer' as const;

export interface UseIdleWarningSuppressionResult {
  /** True once the 30-min hard-cap has elapsed while the drawer was open. */
  readonly timeoutExceeded: boolean;
  /** Re-arm the 30-min hard-cap timer (caller handles the prompt UI). */
  readonly reset: () => void;
}

export function useIdleWarningSuppression(
  isActive: boolean,
): UseIdleWarningSuppressionResult {
  const [timeoutExceeded, setTimeoutExceeded] = React.useState<boolean>(false);
  // `resetToken` bumps whenever the caller asks to re-arm the hard-cap.
  const [resetToken, setResetToken] = React.useState<number>(0);
  // Track whether we have an outstanding pause so the cleanup path knows
  // whether to emit a balancing resume. Using a ref avoids an extra render.
  const pausedRef = React.useRef<boolean>(false);

  // Pause / resume dispatch — one-shot on transition.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isActive) {
      window.dispatchEvent(new CustomEvent(PAUSE_IDLE_TIMER_EVENT));
      pausedRef.current = true;
      return () => {
        if (pausedRef.current) {
          window.dispatchEvent(new CustomEvent(RESUME_IDLE_TIMER_EVENT));
          pausedRef.current = false;
        }
      };
    }
    // isActive=false: if we had previously paused, emit resume once.
    if (pausedRef.current) {
      window.dispatchEvent(new CustomEvent(RESUME_IDLE_TIMER_EVENT));
      pausedRef.current = false;
    }
    return undefined;
  }, [isActive]);

  // Hard-cap timer — only runs while the drawer is active. Re-armed via
  // `resetToken`. Cleared automatically on deactivation/unmount.
  React.useEffect(() => {
    if (!isActive) {
      setTimeoutExceeded(false);
      return undefined;
    }
    if (typeof window === 'undefined') return undefined;
    const handle = window.setTimeout(() => {
      setTimeoutExceeded(true);
    }, PAY_SHEET_HARD_CAP_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [isActive, resetToken]);

  const reset = React.useCallback(() => {
    setTimeoutExceeded(false);
    setResetToken((n) => n + 1);
  }, []);

  return { timeoutExceeded, reset };
}
