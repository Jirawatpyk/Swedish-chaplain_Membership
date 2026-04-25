/**
 * Simplify S3 — shared countdown-with-interrupt hook.
 *
 * Both `<ConfirmationPanel>` (5s auto-close) and `<HardCapPrompt>`
 * (60s cancel countdown) implement the identical pattern:
 *
 *   1. setInterval ticks `remaining` down once per second
 *   2. an `interruptedRef` lets a user action freeze the timer mid-flight
 *   3. a SEPARATE effect dispatches `onExpire()` when `remaining === 0`
 *      — keeps the dispatch outside the setState-updater render-phase
 *      so React doesn't surface "Cannot update a component while
 *      rendering a different component"
 *
 * Returns `{ remaining, interrupt }`:
 *   - `remaining` — current seconds left (1-shot decremented per tick)
 *   - `interrupt` — call to pause the timer; idempotent
 */
import { useEffect, useRef, useState } from 'react';

export function useCountdownAutoDismiss(
  initialSeconds: number,
  onExpire: () => void,
): { readonly remaining: number; readonly interrupt: () => void } {
  const [remaining, setRemaining] = useState<number>(initialSeconds);
  const interruptedRef = useRef<boolean>(false);

  // Ticker: decrement once per second; clears interval on interrupt
  // OR when remaining hits 0.
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (interruptedRef.current) {
          clearInterval(timer);
          return prev;
        }
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Dispatch onExpire once when countdown hits zero. Separate effect =
  // runs after commit, safely outside any render pass.
  useEffect(() => {
    if (remaining !== 0) return;
    if (interruptedRef.current) return;
    onExpire();
  }, [remaining, onExpire]);

  return {
    remaining,
    interrupt: () => {
      interruptedRef.current = true;
    },
  };
}
