/**
 * Round-2 review C-6 + C-7: coverage for the `send_portal_invite`
 * branch + all-or-nothing rollback scenario.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  bulkAction,
  type BulkActionDeps,
  type BulkActionMeta,
} from '@/modules/members/application/use-cases/bulk-action';

const meta: BulkActionMeta = {
  actorUserId: 'admin-branches',
  requestId: 'req-branches',
};

const stubMember = {
  tenantId: 'test-tenant',
  memberId: '11111111-2222-3333-4444-555555555555',
  companyName: 'Test Corp',
  legalEntityType: null,
  country: 'TH',
  taxId: null,
  website: null,
  description: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'plan-1',
  planYear: 2026,
  registrationDate: new Date('2026-01-01'),
  registrationFeePaid: false,
  lastActivityAt: null,
  notes: null,
  status: 'active' as const,
  archivedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function stubDeps(overrides?: Partial<BulkActionDeps>): BulkActionDeps {
  return {
    tenant: { slug: 'test-tenant' } as BulkActionDeps['tenant'],
    memberRepo: {
      findById: vi.fn().mockResolvedValue(ok(stubMember)),
      findByIdInTx: vi.fn().mockResolvedValue(ok(stubMember)),
      findRiskById: vi
        .fn()
        .mockResolvedValue(ok({ riskScore: null, riskScoreBand: null })),
      // Staff-review SB-1 + SW-1: batched lookup is the new default path
      // for bulk-action. Returns a Map<MemberId, Member> keyed by id.
      findManyByIdsInTx: vi.fn().mockImplementation(async (_tx, ids) => {
        const map = new Map();
        for (const id of ids) {
          map.set(id, { ...stubMember, memberId: id });
        }
        return ok(map);
      }),
      findSoftDuplicate: vi.fn(),
      findByLinkedUserId: vi.fn(),
      createWithPrimaryContactInTx: vi.fn(),
      updateStatus: vi.fn(),
      updateStatusInTx: vi.fn().mockResolvedValue(ok({ ...stubMember, status: 'archived' })),
      updateFields: vi.fn(),
      updateFieldsInTx: vi.fn().mockResolvedValue(ok(stubMember)),
      searchDirectory: vi.fn(),
      searchDirectoryWithCount: vi.fn(),
      // F7 Batch C extensions (T029) — interface compliance stubs.
      findMembersBySegmentForBroadcast: vi.fn(),
      findMembersHaltedForBroadcast: vi.fn(),
      updateBroadcastsHaltedInTx: vi.fn(),
      updateBroadcastsAcknowledgedAtInTx: vi.fn(),
      findPrimaryContactEmailInTx: vi.fn(),
      findPreferredLocaleInTx: vi.fn(),
      updatePreferredLocaleInTx: vi.fn(),
      findMemberByPrimaryContactEmailInTx: vi.fn(),
    findLastPlanChangedAt: vi.fn(),
    findPendingInvitationsForMember: vi.fn(),
    findPendingInvitationsForPrimaryContacts: vi.fn(),
    scrubPiiInTx: vi.fn(),
    findErasedAtById: vi.fn(),
    findStuckErasuresInTx: vi.fn(),
    },
    audit: {
      record: vi.fn().mockResolvedValue(ok(undefined)),
      recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
    },
    clock: { now: () => new Date('2026-04-16T10:00:00Z') },
    plans: {
      getPlan: vi.fn().mockResolvedValue(ok({
        tenantId: 'test-tenant',
        planId: 'plan-1',
        planYear: 2026,
        planNameEn: 'Test Plan',
        planCategory: 'corporate' as const,
        memberTypeScope: 'company' as const,
        minTurnoverThb: null,
        maxTurnoverThb: null,
        maxDurationYears: null,
        maxMemberAge: null,
        includesCorporatePlanId: null,
      })),
      countAffectedMembers: vi.fn().mockResolvedValue(ok({ count: 0 })),
    },
    ...overrides,
  };
}

// NOTE: the former `send_portal_invite branch (C-6)` describe was REMOVED in
// go-live P1-17 — send_portal_invite no longer routes through `bulkAction` (it
// is a dedicated best-effort use case `bulkSendPortalInvite`). Real-dispatch
// coverage lives in tests/integration/members/bulk-send-portal-invite.test.ts +
// the unit/contract suites.

describe('integration: bulk all-or-nothing rollback (round-2 review C-7 / FR-019)', () => {
  it('missing id in batched lookup → not_found, no writes (staff-review SB-1)', async () => {
    const deps = stubDeps();
    // Return a Map that is missing the 2nd id — caller's "verify all
    // requested ids returned" loop must throw BulkNotFoundError.
    (deps.memberRepo.findManyByIdsInTx as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(new Map([
        ['11111111-2222-3333-4444-555555555555', stubMember],
        ['33333333-4444-5555-6666-777777777777', { ...stubMember, memberId: '33333333-4444-5555-6666-777777777777' }],
      ])),
    );

    const result = await bulkAction(
      {
        action: 'archive',
        member_ids: [
          '11111111-2222-3333-4444-555555555555',
          '22222222-3333-4444-5555-666666666666',
          '33333333-4444-5555-6666-777777777777',
        ],
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
      if (result.error.type === 'not_found') {
        expect(result.error.memberId).toBe('22222222-3333-4444-5555-666666666666');
      }
    }
    // No writes attempted — entire batch short-circuits on missing id.
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('state error on archived member → state_error returned, no writes', async () => {
    const deps = stubDeps();
    const archivedMember = { ...stubMember, status: 'archived' as const, archivedAt: new Date() };
    (deps.memberRepo.findManyByIdsInTx as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(new Map([['11111111-2222-3333-4444-555555555555', archivedMember]])),
    );

    const result = await bulkAction(
      {
        action: 'archive',
        member_ids: ['11111111-2222-3333-4444-555555555555'],
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.cannot_archive_already_archived');
      }
    }
  });

  it('repo persist failure triggers server_error (sanitized — no internal leak)', async () => {
    const deps = stubDeps();
    (deps.memberRepo.updateStatusInTx as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'repo.unexpected', cause: 'fk_violation_plan_id' }),
    );

    const result = await bulkAction(
      {
        action: 'archive',
        member_ids: ['11111111-2222-3333-4444-555555555555'],
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      // Round-2 review S-2: message is generic — no internal detail
      if (result.error.type === 'server_error') {
        expect(result.error.message).not.toContain('persist');
        expect(result.error.message).not.toContain('fk_violation');
      }
    }
  });

  it('round-3 T5: audit recordInTx failure mid-batch → entire batch rolls back', async () => {
    const deps = stubDeps();
    let auditCallCount = 0;
    (deps.audit.recordInTx as ReturnType<typeof vi.fn>).mockImplementation(() => {
      auditCallCount++;
      // Second audit write in the batch fails (simulating Neon hiccup
      // or constraint violation mid-batch).
      if (auditCallCount === 2) {
        return Promise.resolve(err({ code: 'repo.unexpected', cause: 'audit write failed' }));
      }
      return Promise.resolve(ok(undefined));
    });

    const result = await bulkAction(
      {
        action: 'archive',
        member_ids: [
          '11111111-2222-3333-4444-555555555555',
          '22222222-3333-4444-5555-666666666666',
          '33333333-4444-5555-6666-777777777777',
        ],
      },
      meta,
      deps,
    );

    // Batch MUST fail — entire tx rolls back, no partial audit persisted.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      // Sanitized — no internal audit detail leaked.
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('bulk operation failed');
      }
    }

    // 3rd member's recordInTx NEVER called — loop threw on 2nd.
    expect(auditCallCount).toBe(2);
  });
});

// --- Staff-review SW-2 + SW-5 new coverage ----------------------------------

describe('integration: bulk SW-2 duplicate member_ids rejected', () => {
  it('duplicate ids in batch → invalid_body (no DB work)', async () => {
    const deps = stubDeps();
    const duplicatedIds = [
      '11111111-2222-3333-4444-555555555555',
      '11111111-2222-3333-4444-555555555555', // duplicate
      '33333333-4444-5555-6666-777777777777',
    ];

    const result = await bulkAction(
      { action: 'archive', member_ids: duplicatedIds },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
    // Zod gate rejects BEFORE any DB call
    expect(deps.memberRepo.findManyByIdsInTx).not.toHaveBeenCalled();
  });
});

describe('integration: bulk SW-5 change_plan on archived member rejected', () => {
  it('change_plan on archived member → state_error', async () => {
    const deps = stubDeps();
    const archivedMember = {
      ...stubMember,
      status: 'archived' as const,
      archivedAt: new Date('2026-01-05'),
    };
    (deps.memberRepo.findManyByIdsInTx as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(new Map([['11111111-2222-3333-4444-555555555555', archivedMember]])),
    );

    const result = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['11111111-2222-3333-4444-555555555555'],
        params: {
          new_plan_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          new_plan_year: 2026,
        },
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.cannot_change_plan_archived');
        expect(result.error.memberId).toBe('11111111-2222-3333-4444-555555555555');
      }
    }
    // No write attempted — archived check runs before updateFieldsInTx.
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });
});

// --- Package B2 regression guard: change_plan FK-safety ----------------------
//
// The composite FK `members_plan_tenant_year_fk` is on
// (tenant_id, plan_id, plan_year) (migration 0009). Writing `plan_id`
// WITHOUT a matching `plan_year` would violate it and roll the whole
// all-or-nothing batch back. These guards pin the two properties that keep
// bulk `change_plan` FK-safe. They are GREEN as written — bulk-action already
// (a) validates the plan for the composite key before the tx, (b) writes BOTH
// plan columns together, and (c) rejects the partial input at the zod layer.
// No behavior change; this locks in the invariant the Package B1 discovery
// flagged so a future refactor can't silently drop `plan_year` from the patch.
describe('integration: bulk change_plan FK-safety (Package B2 regression guard)', () => {
  it('successful change_plan writes BOTH planId and planYear in the patch (composite FK satisfied)', async () => {
    const deps = stubDeps();

    const result = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['11111111-2222-3333-4444-555555555555'],
        params: {
          new_plan_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          new_plan_year: 2027,
        },
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);

    // Pre-tx plan-ownership validation runs against the FULL composite key
    // (tenant, plan_id, plan_year) — not just plan_id.
    expect(deps.plans.getPlan).toHaveBeenCalledWith(
      expect.anything(),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      2027,
    );

    // The write carries BOTH plan columns → members_plan_tenant_year_fk holds.
    expect(deps.memberRepo.updateFieldsInTx).toHaveBeenCalledTimes(1);
    const patch = (deps.memberRepo.updateFieldsInTx as ReturnType<typeof vi.fn>)
      .mock.calls[0]![2] as { planId?: unknown; planYear?: unknown };
    expect(patch.planId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(patch.planYear).toBe(2027);
  });

  it('change_plan missing new_plan_year → invalid_body, no plan lookup, no write (prevents FK violation)', async () => {
    const deps = stubDeps();

    const result = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['11111111-2222-3333-4444-555555555555'],
        params: {
          new_plan_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          // new_plan_year deliberately omitted — the partial that would break
          // the composite FK if it ever reached the DB write.
        },
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
    // Zod superRefine rejects at the boundary — BEFORE any plan lookup or
    // write. A `plan_id`-without-`plan_year` can never reach updateFieldsInTx.
    expect(deps.plans.getPlan).not.toHaveBeenCalled();
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });
});
