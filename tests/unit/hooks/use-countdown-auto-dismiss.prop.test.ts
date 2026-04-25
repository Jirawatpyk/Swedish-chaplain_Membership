/**
 * R5 S010 — property test for `useCountdownAutoDismiss`.
 *
 * Invariant (timing-sensitive, hard to scenario-test exhaustively):
 *   forAll (initialSeconds ∈ [1, 60], interruptAtTick ∈ [0, initialSeconds-1]) →
 *     calling `interrupt()` at any tick BEFORE the countdown hits zero
 *     prevents `onExpire` from ever firing, no matter how far we
 *     advance the fake clock afterwards.
 *
 * Complements `confirmation-panel.test.tsx` + `hard-cap-prompt.test.tsx`
 * scenario tests by sweeping the entire (seconds × tick) interrupt-
 * timing matrix with shrinkage. Catches future regressions where
 * `clearInterval` is removed from `interrupt()` or the `interruptedRef`
 * guard is misplaced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import fc from 'fast-check';

import { useCountdownAutoDismiss } from '@/hooks/use-countdown-auto-dismiss';

describe('useCountdownAutoDismiss — property: interrupt() prevents onExpire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forAll seconds ∈ [1,60], tick ∈ [0,seconds-1] : interrupt() blocks onExpire', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        (initialSeconds, interruptAtTickRaw) => {
          const interruptAtTick = Math.min(interruptAtTickRaw, initialSeconds - 1);
          const onExpire = vi.fn<() => void>();

          const { result } = renderHook(() =>
            useCountdownAutoDismiss(initialSeconds, onExpire),
          );

          // Advance up to (but not past) the interrupt point.
          act(() => {
            vi.advanceTimersByTime(interruptAtTick * 1000);
          });

          // User-initiated pause.
          act(() => {
            result.current.interrupt();
          });

          // Push the clock well beyond the original expiry. If the
          // hook is correctly clearing the interval + honouring the
          // interruptedRef guard in BOTH effects, onExpire stays at 0.
          act(() => {
            vi.advanceTimersByTime((initialSeconds + 30) * 1000);
          });

          expect(onExpire).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('forAll seconds ∈ [1,10] : without interrupt, onExpire fires exactly once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (initialSeconds) => {
        const onExpire = vi.fn<() => void>();

        renderHook(() => useCountdownAutoDismiss(initialSeconds, onExpire));

        act(() => {
          vi.advanceTimersByTime((initialSeconds + 2) * 1000);
        });

        expect(onExpire).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 20 },
    );
  });
});
