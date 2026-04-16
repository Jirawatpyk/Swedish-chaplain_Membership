/**
 * T101 — Integration test: bulk action rate limit enforcement.
 *
 * Verifies that the 11th bulk action within a 10-minute window
 * returns `rate_limited` error + emits `bulk_action_rate_limit_exceeded`
 * audit event.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import {
  bulkAction,
  BULK_RATE_MAX,
  BULK_RATE_WINDOW_SECONDS,
  type BulkActionDeps,
  type BulkActionMeta,
} from '@/modules/members/application/use-cases/bulk-action';

const meta: BulkActionMeta = {
  actorUserId: 'admin-rl',
  requestId: 'req-rl-test',
};

function stubDeps(rateLimitSuccess: boolean): BulkActionDeps {
  return {
    tenant: { slug: 'test-tenant' } as BulkActionDeps['tenant'],
    memberRepo: {
      findById: vi.fn(),
      findSoftDuplicate: vi.fn(),
      createWithPrimaryContact: vi.fn(),
      updateStatus: vi.fn(),
      updateFields: vi.fn(),
      updateFieldsInTx: vi.fn(),
      searchDirectory: vi.fn(),
    },
    audit: {
      record: vi.fn().mockResolvedValue(ok(undefined)),
      recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
    },
    clock: { now: () => new Date('2026-04-16T10:00:00Z') },
    rateLimit: {
      check: vi.fn().mockResolvedValue({
        success: rateLimitSuccess,
        remaining: rateLimitSuccess ? BULK_RATE_MAX - 1 : 0,
        reset: Date.now() + BULK_RATE_WINDOW_SECONDS * 1000,
      }),
    },
  };
}

describe('integration: bulk action rate limit (T101)', () => {
  it('11th action in 10min → rate_limited error', async () => {
    const deps = stubDeps(false); // Rate limit exhausted
    const result = await bulkAction(
      {
        action: 'archive',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('rate_limited');
    }

    // Verify audit event was emitted for the rate-limit breach
    expect(deps.audit.record).toHaveBeenCalledWith(
      deps.tenant,
      expect.objectContaining({
        type: 'bulk_action_rate_limit_exceeded',
        actorUserId: meta.actorUserId,
        payload: expect.objectContaining({
          action: 'archive',
          attempted_count: 1,
        }),
      }),
    );
  });

  it('rate limit check uses correct key shape (tenant + actor)', async () => {
    const deps = stubDeps(false);
    await bulkAction(
      {
        action: 'archive',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
      },
      meta,
      deps,
    );

    expect(deps.rateLimit.check).toHaveBeenCalledWith(
      `bulk:test-tenant:${meta.actorUserId}`,
      BULK_RATE_MAX,
      BULK_RATE_WINDOW_SECONDS,
    );
  });

  it('allowed action within rate limit proceeds to execution', async () => {
    const deps = stubDeps(true); // Rate limit OK

    // findById will fail (no DB) but that's after rate limit check
    (deps.memberRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({
        tenantId: 'test-tenant',
        memberId: '00000000-0000-0000-0000-000000000001',
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
        status: 'active',
        archivedAt: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      }),
    );

    await bulkAction(
      {
        action: 'archive',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
      },
      meta,
      deps,
    );

    // Rate limit check passed — the error will be from runInTenant (no real DB)
    // but the rate limit audit was NOT emitted (good — not rate limited)
    expect(deps.audit.record).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'bulk_action_rate_limit_exceeded' }),
    );
  });
});
