/**
 * Unit tests for `setMemberHalt` use case (T029, F7 Batch C).
 *
 * Q14 clear-halt action. Tests cover authz across the FULL admissible
 * set (018: admin + super_admin + system, with marketing narrowed out and
 * manager + member denied), member_not_found, success, repo errors.
 *
 * The set is not 'admin role only' any more, and never really was: the F7
 * bridge used to hardcode `{actorRole:'admin'}` for every caller, so the
 * check admitted everyone — including the Resend webhook. Callers now pass
 * their real actor, which is what makes these cases meaningful.
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
  // 017 actor-role truth sweep — the admissible set, pinned EXACTLY. These
  // four arms did not exist as tests before: the bridge's hardcoded 'admin'
  // meant only that one value was ever observed in production.
  it.each(['admin', 'super_admin', 'system'] as const)(
    'admits %s (the set the broadcasts.clear_halt gate + the webhook produce)',
    async (actorRole) => {
      const memberRepo = {
        updateBroadcastsHaltedInTx: vi.fn(async () => ok(1)),
      } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

      const result = await setMemberHalt(
        { tenant, memberRepo },
        memberId,
        false,
        { actorRole },
      );

      expect(result.ok, `${actorRole} must be admitted`).toBe(true);
      expect(memberRepo.updateBroadcastsHaltedInTx).toHaveBeenCalledOnce();
    },
  );

  it.each(['manager', 'marketing', 'member'] as const)(
    'denies %s and never touches the repo',
    async (actorRole) => {
      const memberRepo = {
        updateBroadcastsHaltedInTx: vi.fn(),
      } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];

      const result = await setMemberHalt(
        { tenant, memberRepo },
        memberId,
        false,
        { actorRole },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('member_halt.unauthorised');
      expect(memberRepo.updateBroadcastsHaltedInTx).not.toHaveBeenCalled();
    },
  );

  /**
   * LOCKSTEP (017 security review #2). The admissible set is written by hand
   * in the use case; the route gate is `broadcasts.clear_halt` (018 split it
   * out of `broadcasts.write` to narrow marketing out). If a future bundle
   * edit grants that key to a role the use case does not admit — or revokes it
   * from one it does — the two drift apart silently, and the route's
   * fallback-to-'admin' ternary would then stamp a role the actor never held
   * WHILE letting them through. Derive one side from the other so that edit
   * fails here instead.
   */
  it('the human half of the admissible set === the holders of broadcasts.clear_halt', async () => {
    const { ROLES } = await import('@/modules/auth/domain/role');
    const { hasPermission } = await import(
      '@/modules/auth/domain/permissions/evaluator'
    );
    const gateHolders = ROLES.filter((r) => hasPermission(r, 'broadcasts.clear_halt'));

    const admitted: string[] = [];
    for (const role of ROLES) {
      const memberRepo = {
        updateBroadcastsHaltedInTx: vi.fn(async () => ok(1)),
      } as unknown as Parameters<typeof setMemberHalt>[0]['memberRepo'];
      const r = await setMemberHalt({ tenant, memberRepo }, memberId, false, {
        actorRole: role,
      });
      if (r.ok) admitted.push(role);
    }

    expect([...admitted].sort()).toEqual([...gateHolders].sort());
  });

});
