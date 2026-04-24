/**
 * Unit tests for the 3DS polling hook — G4 gap closeout.
 *
 * We test `useThreeDSecurePoll` directly (the polling loop extracted
 * out of <PaySheetInternal> for testability — the parent component
 * still owns the `payState` state machine; this hook owns the
 * `stripe.retrievePaymentIntent` interval).
 *
 * Covered scenarios (per three-d-secure-panel.tsx polling contract):
 *   - `processing → processing → succeeded` over three intervals
 *     advances to `onSucceeded`.
 *   - 5-minute timeout (150 iterations of `processing`) fires
 *     `onFailed('3ds_timeout')`.
 *   - Cleanup: `clearInterval` fires when `enabled` flips to false
 *     (observable through no further `retrievePaymentIntent` calls
 *     after `rerender`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

import {
  useThreeDSecurePoll,
  THREE_DS_POLL_INTERVAL_MS,
  THREE_DS_POLL_MAX_ITERATIONS,
} from '@/hooks/use-three-d-secure-poll';

const retrievePaymentIntent = vi.fn();
const stripeLike = {
  retrievePaymentIntent,
  // rest of Stripe surface unused in this hook
} as unknown as Parameters<
  typeof useThreeDSecurePoll
>[0]['getStripe'] extends () => Promise<infer R>
  ? R
  : never;

describe('useThreeDSecurePoll', () => {
  beforeEach(() => {
    retrievePaymentIntent.mockReset();
    // `vi.useFakeTimers` is applied globally by tests/setup.ts with
    // `shouldAdvanceTime: false`. We keep that behaviour.
  });
  afterEach(() => {
    cleanup();
  });

  it('polls every 2 s and invokes onSucceeded when status transitions to "succeeded"', async () => {
    retrievePaymentIntent
      .mockResolvedValueOnce({
        paymentIntent: { id: 'pi_1', status: 'processing' },
      })
      .mockResolvedValueOnce({
        paymentIntent: { id: 'pi_1', status: 'processing' },
      })
      .mockResolvedValueOnce({
        paymentIntent: { id: 'pi_1', status: 'succeeded' },
      });

    const onSucceeded = vi.fn();
    const onFailed = vi.fn();

    renderHook(() =>
      useThreeDSecurePoll({
        enabled: true,
        clientSecret: 'cs_test',
        getStripe: () => Promise.resolve(stripeLike as unknown as Awaited<ReturnType<() => Promise<typeof stripeLike>>>),
        onSucceeded,
        onFailed,
      }),
    );

    // Advance 3 intervals → 3 poll invocations → 3rd resolves to
    // `succeeded` → onSucceeded fires.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(THREE_DS_POLL_INTERVAL_MS);
      });
    }

    expect(retrievePaymentIntent).toHaveBeenCalledTimes(3);
    expect(onSucceeded).toHaveBeenCalledWith('pi_1');
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('fires onFailed("3ds_timeout") after 150 iterations of "processing"', async () => {
    retrievePaymentIntent.mockResolvedValue({
      paymentIntent: { id: 'pi_1', status: 'processing' },
    });

    const onSucceeded = vi.fn();
    const onFailed = vi.fn();

    renderHook(() =>
      useThreeDSecurePoll({
        enabled: true,
        clientSecret: 'cs_test',
        getStripe: () => Promise.resolve(stripeLike as never),
        onSucceeded,
        onFailed,
      }),
    );

    // Advance past the cap: 151 iterations × 2 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        (THREE_DS_POLL_MAX_ITERATIONS + 1) * THREE_DS_POLL_INTERVAL_MS,
      );
    });

    expect(onFailed).toHaveBeenCalledWith('3ds_timeout');
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it('maps canceled → onFailed("canceled")', async () => {
    retrievePaymentIntent.mockResolvedValue({
      paymentIntent: { id: 'pi_1', status: 'canceled' },
    });

    const onFailed = vi.fn();
    renderHook(() =>
      useThreeDSecurePoll({
        enabled: true,
        clientSecret: 'cs_test',
        getStripe: () => Promise.resolve(stripeLike as never),
        onSucceeded: vi.fn(),
        onFailed,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREE_DS_POLL_INTERVAL_MS);
    });
    expect(onFailed).toHaveBeenCalledWith('canceled');
  });

  it('maps requires_payment_method → onFailed("card_declined")', async () => {
    retrievePaymentIntent.mockResolvedValue({
      paymentIntent: { id: 'pi_1', status: 'requires_payment_method' },
    });

    const onFailed = vi.fn();
    renderHook(() =>
      useThreeDSecurePoll({
        enabled: true,
        clientSecret: 'cs_test',
        getStripe: () => Promise.resolve(stripeLike as never),
        onSucceeded: vi.fn(),
        onFailed,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREE_DS_POLL_INTERVAL_MS);
    });
    expect(onFailed).toHaveBeenCalledWith('card_declined');
  });

  it('is inert when enabled=false (no retrieve calls)', async () => {
    const onSucceeded = vi.fn();
    const onFailed = vi.fn();

    renderHook(() =>
      useThreeDSecurePoll({
        enabled: false,
        clientSecret: 'cs_test',
        getStripe: () => Promise.resolve(stripeLike as never),
        onSucceeded,
        onFailed,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('clears the interval when enabled flips to false (cleanup)', async () => {
    retrievePaymentIntent.mockResolvedValue({
      paymentIntent: { id: 'pi_1', status: 'processing' },
    });

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useThreeDSecurePoll({
          enabled,
          clientSecret: 'cs_test',
          getStripe: () => Promise.resolve(stripeLike as never),
          onSucceeded: vi.fn(),
          onFailed: vi.fn(),
        }),
      { initialProps: { enabled: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREE_DS_POLL_INTERVAL_MS);
    });
    const callsAfterFirstTick = retrievePaymentIntent.mock.calls.length;
    expect(callsAfterFirstTick).toBeGreaterThan(0);

    rerender({ enabled: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREE_DS_POLL_INTERVAL_MS * 5);
    });

    // No additional calls after cleanup.
    expect(retrievePaymentIntent.mock.calls.length).toBe(callsAfterFirstTick);
  });
});
