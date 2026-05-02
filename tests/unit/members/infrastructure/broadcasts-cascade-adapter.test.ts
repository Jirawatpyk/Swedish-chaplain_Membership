/**
 * Round 1 review (G4) — `f7BroadcastsCascadeAdapter` outcome translation.
 *
 * The adapter is the F3↔F7 boundary. The Round 1 review found a
 * signal-loss bug where adapter failure returned the same shape as the
 * no-in-flight case (`{cancelledCount: 0}`), making it impossible for
 * the F3 caller to emit a stop-the-line metric. The fix added the
 * `outcome: 'ok' | 'cascade_failed'` discriminator. These tests pin
 * that contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { cancelInFlightBroadcastsForMember, makeCancelInFlightBroadcastsForMemberDeps } =
  vi.hoisted(() => ({
    cancelInFlightBroadcastsForMember: vi.fn(),
    makeCancelInFlightBroadcastsForMemberDeps: vi.fn(() => ({})),
  }));
vi.mock('@/modules/broadcasts', () => ({
  cancelInFlightBroadcastsForMember,
  makeCancelInFlightBroadcastsForMemberDeps,
}));

import {
  f7BroadcastsCascadeAdapter,
  noopBroadcastsCascadeAdapter,
} from '@/modules/members/infrastructure/adapters/broadcasts-cascade-adapter';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');

describe('f7BroadcastsCascadeAdapter (G4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates use-case ok → outcome="ok" with counts forwarded', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 3, skippedConcurrentCount: 1 }),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(
      tenant,
      memberId,
      {
        cancellationReason: 'originator_member_deleted',
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
      },
    );
    expect(result.outcome).toBe('ok');
    expect(result.cancelledCount).toBe(3);
    expect(result.skippedConcurrentCount).toBe(1);
  });

  it('translates use-case ok with zero in-flight → outcome="ok" + zeros', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 0, skippedConcurrentCount: 0 }),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(
      tenant,
      memberId,
      {
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
      },
    );
    expect(result.outcome).toBe('ok');
    expect(result.cancelledCount).toBe(0);
    expect(result.skippedConcurrentCount).toBe(0);
  });

  it('translates use-case err → outcome="cascade_failed" + zeros (signal-loss closed)', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      err({ kind: 'cascade.server_error', message: 'neon down' }),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(
      tenant,
      memberId,
      {
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
      },
    );
    expect(result.outcome).toBe('cascade_failed');
    expect(result.cancelledCount).toBe(0);
    expect(result.skippedConcurrentCount).toBe(0);
  });

  it('omits cancellationReason when caller passes undefined (exactOptionalPropertyTypes)', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 0, skippedConcurrentCount: 0 }),
    );
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      initiatedByUserId: null,
      requestId: 'req-7',
    });
    const passedInput = cancelInFlightBroadcastsForMember.mock.calls[0]![1];
    expect(Object.prototype.hasOwnProperty.call(passedInput, 'cancellationReason')).toBe(false);
  });
});

describe('noopBroadcastsCascadeAdapter', () => {
  it('returns outcome="ok" + zeros without invoking F7', async () => {
    const result = await noopBroadcastsCascadeAdapter.cancelInFlightForMember(
      tenant,
      memberId,
      { initiatedByUserId: null, requestId: null },
    );
    expect(result.outcome).toBe('ok');
    expect(result.cancelledCount).toBe(0);
    expect(result.skippedConcurrentCount).toBe(0);
  });
});
