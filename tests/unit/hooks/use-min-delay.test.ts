/**
 * Unit tests for useMinDelay — paired with src/hooks/use-min-delay.ts
 * per Constitution Principle II (TDD-first). Contract:
 *   specs/009-online-payment/ux-phase3-contract.md § 2.2 rule 3.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useMinDelay } from '@/hooks/use-min-delay';

describe('useMinDelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when ready=false at mount (timer not elapsed either)', () => {
    const { result } = renderHook(() => useMinDelay(300, false));
    expect(result.current).toBe(false);
  });

  it('returns false when ready=true immediately but timer has not elapsed yet', () => {
    const { result } = renderHook(() => useMinDelay(300, true));
    expect(result.current).toBe(false);
  });

  it('returns true once BOTH ready=true AND timer has elapsed', () => {
    const { result } = renderHook(() => useMinDelay(300, true));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(true);
  });

  it('remains false if timer elapses but ready is still false', () => {
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useMinDelay(300, ready),
      { initialProps: { ready: false } },
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(false);
    // Flipping ready=true AFTER the timer has elapsed flips the return on the
    // very next render — no additional wait required.
    rerender({ ready: true });
    expect(result.current).toBe(true);
  });

  it('when ms=0 returns the ready value directly without a timer', () => {
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useMinDelay(0, ready),
      { initialProps: { ready: false } },
    );
    expect(result.current).toBe(false);
    rerender({ ready: true });
    expect(result.current).toBe(true);
  });

  it('when ms<0 (defensive) returns the ready value directly without a timer', () => {
    const { result } = renderHook(() => useMinDelay(-10, true));
    expect(result.current).toBe(true);
  });
});
