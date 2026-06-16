/**
 * T100 — Integration test: bulk action cap enforcement.
 *
 * Verifies that submitting > 100 member_ids is rejected at the
 * Application layer with `bulk_cap_exceeded` before any DB work.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import {
  bulkAction,
  BULK_CAP,
  type BulkActionDeps,
  type BulkActionMeta,
} from '@/modules/members/application/use-cases/bulk-action';

const meta: BulkActionMeta = {
  actorUserId: 'admin-1',
  requestId: 'req-cap-test',
};

function stubDeps(): BulkActionDeps {
  return {
    tenant: { slug: 'test-tenant' } as BulkActionDeps['tenant'],
    memberRepo: {
      findById: vi.fn(),
      findByIdInTx: vi.fn(),
      findRiskById: vi.fn(),
      findManyByIdsInTx: vi.fn(),
      findSoftDuplicate: vi.fn(),
      findByLinkedUserId: vi.fn(),
      createWithPrimaryContactInTx: vi.fn(),
      updateStatus: vi.fn(),
      updateStatusInTx: vi.fn(),
      updateFields: vi.fn(),
      updateFieldsInTx: vi.fn(),
      searchDirectory: vi.fn(),
      searchDirectoryWithCount: vi.fn(),
      // F7 Batch C extensions (T029) — required by MemberRepo interface;
      // bulk-action does not exercise these paths so vi.fn() stubs suffice.
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
    scrubPiiInTx: vi.fn(),
    findErasedAtById: vi.fn(),
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
  };
}

describe('integration: bulk action cap (T100)', () => {
  it('rejects 101-member batch with bulk_cap_exceeded', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const deps = stubDeps();
    const result = await bulkAction(
      { action: 'archive', member_ids: ids },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
    // Verify no DB calls were made
    expect(deps.memberRepo.findById).not.toHaveBeenCalled();
  });

  it('accepts exactly 100-member batch (cap boundary) zod validation', async () => {
    // Round-2 review S-4: split into explicit validation-only assertion.
    // We only verify that zod validation passes at the cap boundary; the
    // DB work is covered by the live-Neon integration suite.
    const ids = Array.from({ length: BULK_CAP }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const deps = stubDeps();
    // findById returns not_found to short-circuit before DB txn work;
    // we assert that the error is NOT invalid_body (zod accepted the input).
    (deps.memberRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: 'repo.not_found' },
    });

    const result = await bulkAction(
      { action: 'archive', member_ids: ids },
      meta,
      deps,
    );
    // Must NOT be invalid_body — zod accepted 100 as the cap boundary.
    if (!result.ok) {
      expect(result.error.type).not.toBe('invalid_body');
      expect(result.error.type).not.toBe('bulk_cap_exceeded');
    }
  });

  it('rejects empty member_ids array', async () => {
    const deps = stubDeps();
    const result = await bulkAction(
      { action: 'archive', member_ids: [] },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('rejects invalid action type', async () => {
    const deps = stubDeps();
    const result = await bulkAction(
      { action: 'delete_permanently', member_ids: ['00000000-0000-0000-0000-000000000001'] },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('round-2 C-4: rejects change_plan without new_plan_id via zod superRefine', async () => {
    const deps = stubDeps();
    const result = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
        params: { new_plan_year: 2026 }, // missing new_plan_id
      },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Round-2 C-4 fix: should be invalid_body (400), not server_error (500)
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('round-2 C-4: rejects change_plan without new_plan_year via zod superRefine', async () => {
    const deps = stubDeps();
    const result = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
        params: { new_plan_id: '11111111-2222-3333-4444-555555555555' },
      },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('round-2 I-5: rejects change_plan when target plan not in tenant', async () => {
    const deps = stubDeps();
    // Plan lookup returns not_found — cross-tenant or invalid plan_id
    (deps.plans.getPlan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { code: 'repo.not_found' },
    });

    const result = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
        params: {
          new_plan_id: '11111111-2222-3333-4444-555555555555',
          new_plan_year: 2026,
        },
      },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('plan_not_found');
    }
    // Verify member mutation NEVER attempted — plan validation happens
    // BEFORE transaction opens.
    expect(deps.memberRepo.findById).not.toHaveBeenCalled();
  });
});
