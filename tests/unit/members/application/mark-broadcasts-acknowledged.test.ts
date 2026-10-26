/**
 * Unit tests for `markBroadcastsAcknowledged` use case (T029, F7 Batch C).
 *
 * Q15 GDPR Art. 7 banner CTA. Sets `members.broadcasts_acknowledged_at`.
 * Tests cover member_not_found, success-first-ack (`previouslyNull=true`),
 * success-already-acked (`previouslyNull=false`), repo errors.
 *
 * **Audit emission is NOT tested here** — F3 use-case mutates the column
 * ONLY (per plan.md § Complexity Tracking deviation row); F7's caller
 * emits `member_acknowledged_broadcasts_terms` audit via F7's own
 * audit-port on the `previouslyNull=true` branch.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix "No 'db' export defined on
  // mock" collection error from F3 infra adapter import chain.
  db: {},
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({}),
  ),
}));

import { asTenantContext } from '@/modules/tenants';
import { markBroadcastsAcknowledged } from '@/modules/members/application/use-cases/mark-broadcasts-acknowledged';
import { asMemberId } from '@/modules/members';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('22222222-2222-4222-8222-222222222222');
const now = new Date('2026-04-30T12:00:00Z');
const clock = { now: () => now };

describe('markBroadcastsAcknowledged', () => {
  it('first acknowledgement: returns previouslyNull=true with timestamp', async () => {
    const memberRepo = {
      updateBroadcastsAcknowledgedAtInTx: vi
        .fn()
        .mockResolvedValue(ok({ affected: 1, previouslyNull: true })),
    } as unknown as Parameters<typeof markBroadcastsAcknowledged>[0]['memberRepo'];

    const result = await markBroadcastsAcknowledged(
      { tenant, memberRepo, clock },
      memberId,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.previouslyNull).toBe(true);
      expect(result.value.acknowledgedAt).toEqual(now);
    }
    expect(memberRepo.updateBroadcastsAcknowledgedAtInTx).toHaveBeenCalledWith(
      {},
      memberId,
      now,
    );
  });

  it('idempotent re-ack: returns previouslyNull=false (caller skips audit emit)', async () => {
    const memberRepo = {
      updateBroadcastsAcknowledgedAtInTx: vi
        .fn()
        .mockResolvedValue(ok({ affected: 1, previouslyNull: false })),
    } as unknown as Parameters<typeof markBroadcastsAcknowledged>[0]['memberRepo'];

    const result = await markBroadcastsAcknowledged(
      { tenant, memberRepo, clock },
      memberId,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.previouslyNull).toBe(false);
  });

  it('member_not_found when affected=0', async () => {
    const memberRepo = {
      updateBroadcastsAcknowledgedAtInTx: vi
        .fn()
        .mockResolvedValue(ok({ affected: 0, previouslyNull: true })),
    } as unknown as Parameters<typeof markBroadcastsAcknowledged>[0]['memberRepo'];

    const result = await markBroadcastsAcknowledged(
      { tenant, memberRepo, clock },
      memberId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark_ack.member_not_found');
    }
  });

  it('propagates repo error', async () => {
    const memberRepo = {
      updateBroadcastsAcknowledgedAtInTx: vi
        .fn()
        .mockResolvedValue(err({ code: 'repo.unexpected', cause: 'boom' })),
    } as unknown as Parameters<typeof markBroadcastsAcknowledged>[0]['memberRepo'];

    const result = await markBroadcastsAcknowledged(
      { tenant, memberRepo, clock },
      memberId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });

  it('catches thrown exception from runInTenant', async () => {
    const { runInTenant } = (await import('@/lib/db')) as unknown as {
      runInTenant: ReturnType<typeof vi.fn>;
    };
    runInTenant.mockRejectedValueOnce(new Error('boom'));

    const memberRepo = {
      updateBroadcastsAcknowledgedAtInTx: vi.fn(),
    } as unknown as Parameters<typeof markBroadcastsAcknowledged>[0]['memberRepo'];

    const result = await markBroadcastsAcknowledged(
      { tenant, memberRepo, clock },
      memberId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
