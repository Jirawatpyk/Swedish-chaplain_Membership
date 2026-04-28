/**
 * useMinDelay — returns true only when BOTH `ready === true` AND `ms` has
 * elapsed since the hook first mounted.
 *
 * Usage context: gate rendering of a real component behind a minimum
 * skeleton-display duration so that fast networks don't produce a
 * "flash of skeleton". Spec: specs/009-online-payment/ux-phase3-contract.md
 * § 2.2 rule 3 ("Minimum display duration: 300 ms from Sheet open, even
 * if `ready` fires sooner").
 *
 * Guard: if `ms <= 0`, returns `ready` directly without setting a timer.
 */
import * as React from 'react';

export function useMinDelay(ms: number, ready: boolean): boolean {
  const [elapsed, setElapsed] = React.useState<boolean>(ms <= 0);

  React.useEffect(() => {
    if (ms <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      setElapsed(true);
    }, ms);
    return () => clearTimeout(timer);
  }, [ms]);

  if (ms <= 0) {
    return ready;
  }
  return elapsed && ready;
}
