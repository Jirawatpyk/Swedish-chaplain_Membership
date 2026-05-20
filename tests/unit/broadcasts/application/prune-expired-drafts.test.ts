/**
 * Phase 8 / T171a — unit tests for prune-expired-drafts.ts.
 *
 * Verifies the use-case computes the cutoff = now - retentionDays
 * correctly, calls broadcastsRepo.pruneExpiredDrafts with the right
 * args, and surfaces server errors as `prune.server_error`.
 *
 * Integration-side correctness (RLS, tenant isolation, only draft
 * rows touched) is covered by `tests/integration/broadcasts/prune-expired-drafts.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { pruneExpiredDrafts } from '@/modules/broadcasts/application/use-cases/prune-expired-drafts';
import { asTenantContext } from '@/modules/tenants';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';

const tenant = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const clock = { now: (): Date => FROZEN_NOW };

function makeRepo(opts: {
  prunedCount?: number;
  shouldThrow?: boolean;
}): {
  port: BroadcastsRepo;
  calls: Array<{ tenantId: string; olderThan: Date }>;
} {
  const calls: Array<{ tenantId: string; olderThan: Date }> = [];
  return {
    calls,
    port: {
      async withTx() {
        throw new Error('not used');
      },
      async insertDraft() {
        throw new Error('not used');
      },
      async updateDraft() {
        throw new Error('not used');
      },
      async updateDraftFromTemplate() {
        throw new Error('not used in prune-expired-drafts fixture');
      },
      async findById() {
        return null;
      },
      async findByIdInTx() {
        return null;
      },
      async lockForUpdate() {
        return null;
      },
      async applyTransition() {
        throw new Error('not used');
      },
      async attachResendIds() {},
      async attachAudienceId() {},
      async listByTenantStatus() {
        return { rows: [], nextCursor: null };
      },
      async countForMemberQuota() {
        return { submittedOrApproved: 0, sent: 0 };
      },
      async findByResendBroadcastIdBypassRls() {
        return null;
      },
      async listForMemberPaginated() {
        return { rows: [], total: 0, totalPages: 0, page: 1 };
      },
      async findOwnedByMember() {
        return { broadcast: null, probeKind: 'not_found' as const };
      },
      async aggregateDeliveryCountsForBroadcast() {
        return { delivered: 0, bounced: 0, softBounced: 0, complained: 0, sent: 0 };
      },
      async pruneExpiredDrafts(tenantId, olderThan) {
        calls.push({ tenantId, olderThan });
        if (opts.shouldThrow) {
          throw new Error('Neon: connection terminated');
        }
        return { prunedCount: opts.prunedCount ?? 0 };
      },
      async listInFlightOwnedByMember() {
        return [];
      },
    },
  };
}

describe('pruneExpiredDrafts (Phase 8 / T171a)', () => {
  it('happy path — calls repo with cutoff = now - 30 days (default), returns prunedCount + ISO cutoff', async () => {
    const repo = makeRepo({ prunedCount: 7 });
    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBe(7);
      expect(result.value.cutoff).toBe('2026-05-16T05:00:00.000Z');
    }
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0]?.tenantId).toBe('test-tenant');
    // 30 days = 2,592,000,000 ms before FROZEN_NOW
    expect(repo.calls[0]?.olderThan.getTime()).toBe(
      FROZEN_NOW.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
  });

  it('respects retentionDays override (e.g. 7 days for testing)', async () => {
    const repo = makeRepo({ prunedCount: 3 });
    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock,
      retentionDays: 7,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cutoff).toBe('2026-06-08T05:00:00.000Z');
    }
    expect(repo.calls[0]?.olderThan.getTime()).toBe(
      FROZEN_NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
    );
  });

  it('zero prune is the steady-state happy path', async () => {
    const repo = makeRepo({ prunedCount: 0 });
    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBe(0);
    }
  });

  it('repo throws → returns prune.server_error with the original message', async () => {
    const repo = makeRepo({ shouldThrow: true });
    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('prune.server_error');
      expect(result.error.message).toContain('Neon');
    }
  });
});
