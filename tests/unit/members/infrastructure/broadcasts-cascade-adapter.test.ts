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
      ok({ cancelledCount: 3, skippedConcurrentCount: 1, unexpectedErrorCount: 0 }),
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
    if (result.outcome !== 'ok') return;
    expect(result.cancelledCount).toBe(3);
    expect(result.skippedConcurrentCount).toBe(1);
  });

  it('translates use-case ok with zero in-flight → outcome="ok" + zeros', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0 }),
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
    if (result.outcome !== 'ok') return;
    expect(result.cancelledCount).toBe(0);
    expect(result.skippedConcurrentCount).toBe(0);
  });

  it('translates use-case ok with unexpectedErrorCount > 0 → outcome="cascade_partial_failure" (Round 5 signal-loss closed)', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 2, skippedConcurrentCount: 1, unexpectedErrorCount: 3 }),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(
      tenant,
      memberId,
      {
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
      },
    );
    expect(result.outcome).toBe('cascade_partial_failure');
    if (result.outcome !== 'cascade_partial_failure') return;
    expect(result.cancelledCount).toBe(2);
    expect(result.skippedConcurrentCount).toBe(1);
    expect(result.unexpectedErrorCount).toBe(3);
  });

  it('translates use-case err → outcome="cascade_failed" (no counts in DU branch — signal-loss closed)', async () => {
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
    // DU shape: cascade_failed branch has no counts (TS-enforced).
    expect((result as { cancelledCount?: number }).cancelledCount).toBeUndefined();
  });

  it('propagates use-case throws (does NOT swallow into outcome="cascade_failed")', async () => {
    cancelInFlightBroadcastsForMember.mockRejectedValueOnce(
      new Error('neon connection refused'),
    );
    await expect(
      f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
      }),
    ).rejects.toThrow('neon connection refused');
  });

  it('omits cancellationReason when caller passes undefined (exactOptionalPropertyTypes)', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0 }),
    );
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      initiatedByUserId: null,
      requestId: 'req-7',
    });
    const passedInput = cancelInFlightBroadcastsForMember.mock.calls[0]![1];
    expect(Object.prototype.hasOwnProperty.call(passedInput, 'cancellationReason')).toBe(false);
  });
});

/**
 * Spec 139 DE2 wiring / P7 — the erasure caller selects the cascade's
 * `delete_then_cancel` mode through this port, and the count of E-Blasts
 * Resend had already accepted travels back to `member_erased`. Archive passes
 * no mode, so the F7 default (`skip`) applies (DE4).
 */
describe('f7BroadcastsCascadeAdapter — spec 139 erasure mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards onDispatchBegun to the F7 use case when the caller sets it', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0 }),
    );
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      cancellationReason: 'gdpr_erasure_request',
      initiatedByUserId: 'admin-7',
      requestId: 'req-7',
      onDispatchBegun: 'delete_then_cancel',
    } as never);
    expect(cancelInFlightBroadcastsForMember.mock.calls[0]![1]).toMatchObject({ onDispatchBegun: 'delete_then_cancel' });
  });

  it('omits onDispatchBegun when the caller does not set it (archive keeps the F7 default)', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0 }),
    );
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, { initiatedByUserId: null, requestId: 'req-7' });
    const passed = cancelInFlightBroadcastsForMember.mock.calls[0]![1];
    expect(Object.prototype.hasOwnProperty.call(passed, 'onDispatchBegun')).toBe(false);
    // Spec 140 s1 review round 1 — nor a deadline: archive is unchanged.
    expect(Object.prototype.hasOwnProperty.call(passed, 'deadlineAt')).toBe(false);
  });

  it('forwards deadlineAt to the F7 use case when the caller sets it (spec 140 s1 review round 1)', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0 }),
    );
    const deadlineAt = new Date('2026-10-31T00:04:30Z');
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      initiatedByUserId: null,
      requestId: 'req-7',
      onDispatchBegun: 'delete_then_cancel',
      deadlineAt,
    });
    expect(cancelInFlightBroadcastsForMember.mock.calls[0]![1]).toMatchObject({ deadlineAt });
  });

  it.each([
    { unexpectedErrorCount: 0, outcome: 'ok' },
    { unexpectedErrorCount: 2, outcome: 'cascade_partial_failure' },
  ])('carries alreadySentCount on the $outcome arm', async ({ unexpectedErrorCount, outcome }) => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({ cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount, alreadySentCount: 3, resendDraftsCleared: 0, resendCopiesRetained: 0 }),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      initiatedByUserId: 'admin-7',
      requestId: 'req-7',
    });
    expect(result).toMatchObject({ outcome, alreadySentCount: 3 });
  });

  // Spec 140 s1 — the terminal-draft pass's two counts travel back to
  // `member_erased` on both arms, exactly as `alreadySentCount` does.
  it.each([
    { unexpectedErrorCount: 0, outcome: 'ok' },
    { unexpectedErrorCount: 1, outcome: 'cascade_partial_failure' },
  ])('carries resendDraftsCleared and resendCopiesRetained on the $outcome arm', async ({ unexpectedErrorCount, outcome }) => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok({
        cancelledCount: 0,
        skippedConcurrentCount: 0,
        unexpectedErrorCount,
        alreadySentCount: 0,
        resendDraftsCleared: 2,
        resendCopiesRetained: 1,
      }),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      initiatedByUserId: 'admin-7',
      requestId: 'req-7',
      onDispatchBegun: 'delete_then_cancel',
    });
    expect(result).toMatchObject({ outcome, resendDraftsCleared: 2, resendCopiesRetained: 1 });
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
    if (result.outcome !== 'ok') return;
    expect(result.cancelledCount).toBe(0);
    expect(result.skippedConcurrentCount).toBe(0);
  });
});
