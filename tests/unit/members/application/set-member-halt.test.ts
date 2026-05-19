/**
 * Unit tests for `setMemberHalt` use case (T029, F7 Batch C).
 *
 * Q14 admin clear-halt action — admin role only. Tests cover authz
 * (admin/manager/member), member_not_found, success, repo errors.
 *
 * **Audit emission is NOT tested here** — F3 use-case mutates the flag
 * column ONLY (per plan.md § Complexity Tracking deviation row); F7's
 * caller emits `broadcast_member_dispatch_resumed` via F7's own
 * audit-port + adapter (Phase 3+ T060 bridge adapter).
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
import { setMemberHalt } from '@/modules/members/application/use-cases/set-member-halt';
import { asMemberId } from '@/modules/members';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');

describe('setMemberHalt', () => {
  it('rejects manager role with member_halt.unauthorised', async () => {
    const memberRepo = {
      updateBroadcastsHaltedInTx: vi.fn(),
    } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

    const result = await setMemberHalt(
      { tenant, memberRepo },
      memberId,
      false,
      { actorRole: 'manager' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('member_halt.unauthorised');
    }
    expect(memberRepo.updateBroadcastsHaltedInTx).not.toHaveBeenCalled();
  });

  it('rejects member role with member_halt.unauthorised', async () => {
    const memberRepo = {
      updateBroadcastsHaltedInTx: vi.fn(),
    } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

    const result = await setMemberHalt(
      { tenant, memberRepo },
      memberId,
      false,
      { actorRole: 'member' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('member_halt.unauthorised');
    }
  });

  it('admin role: success path with affected=1', async () => {
    const memberRepo = {
      updateBroadcastsHaltedInTx: vi.fn().mockResolvedValue(ok({ affected: 1 })),
    } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

    const result = await setMemberHalt(
      { tenant, memberRepo },
      memberId,
      false,
      { actorRole: 'admin' },
    );

    expect(result.ok).toBe(true);
    expect(memberRepo.updateBroadcastsHaltedInTx).toHaveBeenCalledWith(
      {},
      memberId,
      false,
    );
  });

  it('admin role + affected=0 returns member_not_found', async () => {
    const memberRepo = {
      updateBroadcastsHaltedInTx: vi.fn().mockResolvedValue(ok({ affected: 0 })),
    } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

    const result = await setMemberHalt(
      { tenant, memberRepo },
      memberId,
      false,
      { actorRole: 'admin' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('member_halt.member_not_found');
    }
  });

  it('admin role + repo error propagates', async () => {
    const memberRepo = {
      updateBroadcastsHaltedInTx: vi
        .fn()
        .mockResolvedValue(err({ code: 'repo.unexpected', cause: 'boom' })),
    } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

    const result = await setMemberHalt(
      { tenant, memberRepo },
      memberId,
      true,
      { actorRole: 'admin' },
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
      updateBroadcastsHaltedInTx: vi.fn(),
    } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

    const result = await setMemberHalt(
      { tenant, memberRepo },
      memberId,
      false,
      { actorRole: 'admin' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
