/**
 * Unit tests for useIdleWarningSuppression — paired with
 * src/hooks/use-idle-warning-suppression.ts per Constitution Principle II.
 * Contract: specs/009-online-payment (G2 T080, FR-028c).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  useIdleWarningSuppression,
  PAUSE_IDLE_TIMER_EVENT,
  RESUME_IDLE_TIMER_EVENT,
  PAY_SHEET_HARD_CAP_MS,
} from '@/hooks/use-idle-warning-suppression';

interface DispatchSpyLike {
  mock: { calls: Array<[Event, ...unknown[]]> };
  mockRestore: () => void;
}

function countDispatchedOfType(spy: DispatchSpyLike, type: string): number {
  return spy.mock.calls.filter((call) => {
    const ev = call[0];
    return ev instanceof Event && ev.type === type;
  }).length;
}

describe('useIdleWarningSuppression', () => {
  let dispatchSpy: DispatchSpyLike;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatchSpy = vi.spyOn(
      window,
      'dispatchEvent',
    ) as unknown as DispatchSpyLike;
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('mount with isActive=false does NOT fire any suppression events', () => {
    renderHook(() => useIdleWarningSuppression(false));
    expect(countDispatchedOfType(dispatchSpy, PAUSE_IDLE_TIMER_EVENT)).toBe(0);
    expect(countDispatchedOfType(dispatchSpy, RESUME_IDLE_TIMER_EVENT)).toBe(0);
  });

  it('flipping to isActive=true dispatches pauseIdleTimer exactly once', () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useIdleWarningSuppression(active),
      { initialProps: { active: false } },
    );
    expect(countDispatchedOfType(dispatchSpy, PAUSE_IDLE_TIMER_EVENT)).toBe(0);

    rerender({ active: true });
    expect(countDispatchedOfType(dispatchSpy, PAUSE_IDLE_TIMER_EVENT)).toBe(1);
  });

  it('flipping isActive=true → false dispatches resumeIdleTimer exactly once', () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useIdleWarningSuppression(active),
      { initialProps: { active: true } },
    );
    // Initial mount already fired pause. Flip off.
    rerender({ active: false });
    expect(countDispatchedOfType(dispatchSpy, RESUME_IDLE_TIMER_EVENT)).toBe(1);
  });

  it('unmount while active fires resumeIdleTimer on cleanup', () => {
    const { unmount } = renderHook(() => useIdleWarningSuppression(true));
    expect(countDispatchedOfType(dispatchSpy, PAUSE_IDLE_TIMER_EVENT)).toBe(1);
    unmount();
    expect(countDispatchedOfType(dispatchSpy, RESUME_IDLE_TIMER_EVENT)).toBe(1);
  });

  it('advancing 30 min while active flips timeoutExceeded to true', () => {
    const { result } = renderHook(() => useIdleWarningSuppression(true));
    expect(result.current.timeoutExceeded).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PAY_SHEET_HARD_CAP_MS);
    });
    expect(result.current.timeoutExceeded).toBe(true);
  });

  it('reset() re-arms the 30-min hard cap', () => {
    const { result } = renderHook(() => useIdleWarningSuppression(true));
    act(() => {
      vi.advanceTimersByTime(PAY_SHEET_HARD_CAP_MS);
    });
    expect(result.current.timeoutExceeded).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.timeoutExceeded).toBe(false);

    // Advance 29 min — should still be false.
    act(() => {
      vi.advanceTimersByTime(PAY_SHEET_HARD_CAP_MS - 60_000);
    });
    expect(result.current.timeoutExceeded).toBe(false);

    // One more minute → over the cap again.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.timeoutExceeded).toBe(true);
  });

  it('isActive=false does not start the hard-cap timer', () => {
    const { result } = renderHook(() => useIdleWarningSuppression(false));
    act(() => {
      vi.advanceTimersByTime(PAY_SHEET_HARD_CAP_MS * 2);
    });
    expect(result.current.timeoutExceeded).toBe(false);
  });
});
