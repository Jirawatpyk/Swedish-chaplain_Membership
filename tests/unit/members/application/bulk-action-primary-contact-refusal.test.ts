/**
 * 108 T041 review round 1 (reliability M2) — bulk `unarchive` bypasses the
 * single-member designate flow on purpose (it is the Undo of a bulk archive),
 * so migration 0293's deferred trigger is what refuses a member that would
 * come back with no live primary. That raise reached the bulk catch as a bare
 * DB error and collapsed the whole all-or-nothing batch into
 * `server_error "bulk operation failed"` — with no member id, so the admin
 * could not tell which member to fix.
 *
 * The trigger's message names the member; map it to the typed `state_error`
 * the route already renders per member.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

import { logger } from '@/lib/logger';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const runInTenantMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: (...a: unknown[]) => runInTenantMock(...a),
}));

import { bulkAction } from '@/modules/members/application/use-cases/bulk-action';
import type { BulkActionDeps } from '@/modules/members/application/use-cases/bulk-action';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');

function triggerRaise(memberId: string): Error {
  // Drizzle 0.45 shape: wrapper message + the PostgresError on `.cause`.
  return Object.assign(new Error('Failed query: commit'), {
    cause: Object.assign(
      new Error(
        `primary-contact-invariant: member ${memberId} in tenant test-tenant has 0 live primary contact(s)`,
      ),
      { code: '23514' },
    ),
  });
}

function makeDeps(): BulkActionDeps {
  return {
    tenant,
    memberRepo: {} as never,
    audit: { record: vi.fn(), recordInTx: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    clock: { now: () => new Date('2026-09-05T00:00:00Z') },
    plans: {} as never,
  };
}

describe('bulkAction — deferred primary-contact refusal is a typed, per-member error', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the 0293 raise at COMMIT to state_error{no_primary_contact} naming the member', async () => {
    runInTenantMock.mockRejectedValueOnce(triggerRaise(MEMBER));

    const result = await bulkAction(
      { action: 'unarchive', member_ids: [MEMBER] },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: 'state_error',
      memberId: MEMBER,
      code: 'no_primary_contact',
    });
  });

  it('a trigger raise whose message names no member falls back to the sanitized server_error (never a blank memberId)', async () => {
    runInTenantMock.mockRejectedValueOnce(
      Object.assign(new Error('Failed query: commit'), {
        cause: Object.assign(new Error('primary-contact-invariant: has 0 live primary contact(s)'), {
          code: '23514',
        }),
      }),
    );

    const result = await bulkAction(
      { action: 'unarchive', member_ids: [MEMBER] },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: 'server_error', message: 'bulk operation failed' });
  });

  it('bulk unarchive refuses an ERASED member with undelete_erased before any write (reliability round 2, N2)', async () => {
    // The single undelete has an erased gate; the bulk Undo-of-archive arm
    // had none, and 0293 exempts erased members — so an erased+archived id in
    // a bulk unarchive would come back `active`.
    const archived = {
      tenantId: 'test-tenant',
      memberId: MEMBER,
      status: 'archived',
      archivedAt: new Date(Date.now() - 86_400_000),
    };
    const memberRepo = {
      findManyByIdsInTx: vi.fn().mockResolvedValue(ok(new Map([[MEMBER, archived]]))),
      findErasedIdsInTx: vi.fn().mockResolvedValue(ok(new Set([MEMBER]))),
      updateStatusInTx: vi.fn(),
    };
    runInTenantMock.mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ __tx: true }),
    );

    const result = await bulkAction(
      { action: 'unarchive', member_ids: [MEMBER] },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      { ...makeDeps(), memberRepo: memberRepo as never },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: 'state_error',
      memberId: MEMBER,
      code: 'undelete_erased',
    });
    expect(memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('logs the COMMIT refusal server-side before answering — never a silent typed error (round 4, F4-#7)', async () => {
    runInTenantMock.mockRejectedValueOnce(triggerRaise(MEMBER));

    await bulkAction(
      { action: 'unarchive', member_ids: [MEMBER] },
      { actorUserId: 'admin-1', requestId: 'req-log' },
      makeDeps(),
    );

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: MEMBER, requestId: 'req-log' }),
      expect.stringContaining('primary-contact'),
    );
  });

  it('bulk unarchive refuses a member with NO live primary (contact-less included) BEFORE any write — the single undelete rule (round 4, F4-#5)', async () => {
    // 0293 exempts a contact-less member, so without a gate the Undo of a bulk
    // archive brought back a member the single undelete refuses (409
    // no_primary_contact) — active, and silently receiving no receipts.
    const archived = {
      tenantId: 'test-tenant',
      memberId: MEMBER,
      status: 'archived',
      archivedAt: new Date(Date.now() - 86_400_000),
    };
    const memberRepo = {
      findManyByIdsInTx: vi.fn().mockResolvedValue(ok(new Map([[MEMBER, archived]]))),
      findErasedIdsInTx: vi.fn().mockResolvedValue(ok(new Set())),
      findIdsWithoutLivePrimaryInTx: vi.fn().mockResolvedValue(ok(new Set([MEMBER]))),
      updateStatusInTx: vi.fn(),
    };
    runInTenantMock.mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ __tx: true }),
    );

    const result = await bulkAction(
      { action: 'unarchive', member_ids: [MEMBER] },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      { ...makeDeps(), memberRepo: memberRepo as never },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: 'state_error',
      memberId: MEMBER,
      code: 'no_primary_contact',
    });
    expect(memberRepo.findIdsWithoutLivePrimaryInTx).toHaveBeenCalledWith(
      { __tx: true },
      expect.any(String),
      [MEMBER],
    );
    expect(memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('still reports an unrelated DB failure as the sanitized server_error', async () => {
    runInTenantMock.mockRejectedValueOnce(new Error('persist:fk_violation_plan_id'));

    const result = await bulkAction(
      { action: 'unarchive', member_ids: [MEMBER] },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: 'server_error', message: 'bulk operation failed' });
  });
});
