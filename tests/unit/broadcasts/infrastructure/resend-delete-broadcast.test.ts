/**
 * `deleteBroadcast` — the port method three dispatch arms said did not exist.
 *
 * Each of them had minted a Resend broadcast, failed to persist its id, and
 * wrote "we leak the resource we just minted, because the gateway has no
 * `deleteBroadcast`" — at critical, every 5 minutes, for as long as the fault
 * lasted. The DELETE endpoint was already in use on this branch: the `'draft'`
 * status measurement was taken by creating a broadcast and deleting it against
 * the live account. So the gap was on our side of the port.
 *
 * Same harness as `deleteAudience`'s cases in `resend-remove-contact.test.ts`,
 * because the contract is the same one: 404 / 410 (already gone) RESOLVE — a
 * reclaim of a resource that is already absent has met its goal, and a throw
 * there would make the best-effort wrapper at the call site log a leak that
 * did not happen — and a 5xx throws retryable after the backoff budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const removeBroadcastMock = vi.fn();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => ({
    broadcasts: { remove: removeBroadcastMock },
  }),
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

const BROADCAST_ID = 'bc_11111111-2222-4333-8444-555555555555';

describe('resendBroadcastsGateway.deleteBroadcast', () => {
  beforeEach(() => {
    removeBroadcastMock.mockReset();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on success, and it is `broadcasts.remove` with the id — not some other verb', async () => {
    removeBroadcastMock.mockResolvedValue({
      data: { object: 'broadcast', id: BROADCAST_ID, deleted: true },
      error: null,
    });

    await expect(resendBroadcastsGateway.deleteBroadcast(BROADCAST_ID)).resolves.toBeUndefined();
    expect(removeBroadcastMock).toHaveBeenCalledWith(BROADCAST_ID);
  });

  it('404 → resolves (already gone is the goal, not a failure)', async () => {
    removeBroadcastMock.mockResolvedValue({
      data: null,
      error: { statusCode: 404, name: 'not_found', message: 'Broadcast not found' },
    });

    await expect(resendBroadcastsGateway.deleteBroadcast(BROADCAST_ID)).resolves.toBeUndefined();
  });

  it('410 → resolves, same reason', async () => {
    removeBroadcastMock.mockResolvedValue({
      data: null,
      error: { statusCode: 410, name: 'gone', message: 'Broadcast gone' },
    });

    await expect(resendBroadcastsGateway.deleteBroadcast(BROADCAST_ID)).resolves.toBeUndefined();
  });

  /**
   * Positive control. Without a failing case the three above would also be
   * satisfied by a `deleteBroadcast` that swallowed every response — which is
   * exactly the shape that would let a call site log "reclaimed" for a resource
   * still sitting in the dashboard.
   */
  it('5xx → throws retryable after the backoff budget, so the call site logs the leak it actually has', async () => {
    // withRetry sleeps 1+2+4+8+16 s of real setTimeout between attempts.
    vi.useFakeTimers();
    removeBroadcastMock.mockResolvedValue({
      data: null,
      error: { statusCode: 503, name: 'internal_server_error', message: 'down' },
    });
    const p = resendBroadcastsGateway.deleteBroadcast(BROADCAST_ID);
    const assertion = expect(p).rejects.toMatchObject({ name: 'GatewayThrowable', kind: 'retryable' });
    await vi.runAllTimersAsync();
    await assertion;
  });
});
