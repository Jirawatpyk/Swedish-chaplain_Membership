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
import { describe, expect, it, vi } from 'vitest';

import { pruneExpiredDrafts, type PruneExpiredDraftsDeps } from '@/modules/broadcasts/application/use-cases/prune-expired-drafts';
import { asTenantContext } from '@/modules/tenants';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';

const tenant = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const clock = { now: (): Date => FROZEN_NOW };
/** The sentinel the fixture's `withTx` hands out — asserted on for co-commit. */
const PRUNE_TX = Symbol('prune-tx');

/**
 * F2-1 — the image side of the prune. Every case wires it so the use case has
 * somewhere to stamp; the behaviour itself is pinned in
 * `tests/unit/broadcasts/application/eblast-image-lifecycle.test.ts`.
 */
function imageDeps(): Pick<PruneExpiredDraftsDeps, 'imagesRepo' | 'audit' | 'requestId'> {
  return {
    // ROUND-2 R-M1 — the prune stamps a whole batch in ONE statement now.
    imagesRepo: { markDeletedByOwners: vi.fn(async () => []) },
    audit: { emit: vi.fn(async () => undefined), emitTyped: vi.fn(async () => undefined) } as never,
    requestId: 'cron-prune-test',
  };
}

function makeRepo(opts: {
  prunedCount?: number;
  shouldThrow?: boolean;
  /**
   * ROUND-3 #3 — a POOL of expired drafts the fake serves `limit` at a time,
   * so the loop's own arithmetic is what decides the batch count. The older
   * `prunedCount` arm ignores `limit` entirely and therefore cannot tell a
   * bounded loop from an unbounded one.
   */
  expired?: number;
}): {
  port: BroadcastsRepo;
  calls: Array<{ tenantId: string; olderThan: Date; limit: number | undefined }>;
} {
  const calls: Array<{ tenantId: string; olderThan: Date; limit: number | undefined }> = [];
  let remaining = opts.expired ?? 0;
  return {
    calls,
    port: {
      // F2-1 — the use case now owns the transaction so the DELETE and each
      // pruned draft's image stamp co-commit.
      async withTx(fn) {
        return fn(PRUNE_TX);
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
      async attachBroadcastId() {},
      async attachAudienceId() {},
      // Phase 9b (T147) — unused by this use case; present so the stub
      // still satisfies BroadcastsRepo.
      // T086 — unused here; present so the stub still satisfies BroadcastsRepo.
      async attachAudienceImport() {},
      async markAudienceImportCompleted() {},
      async markDispatchRetryStarted() { return null; },
      async clearDispatchRetryClock() {},
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
      async pruneExpiredDrafts(tenantId, olderThan, _tx, limit) {
        calls.push({ tenantId, olderThan, limit });
        if (opts.shouldThrow) {
          throw new Error('Neon: connection terminated');
        }
        // ROUND-3 #3 — serve at most `limit` from the pool when one is set.
        if (opts.expired !== undefined) {
          const take = Math.min(limit ?? remaining, remaining);
          remaining -= take;
          return {
            prunedDrafts: Array.from({ length: take }, (_v, i) => ({
              broadcastId: `pooled-${remaining + take - i}`,
              requestedByMemberId: null,
            })),
          };
        }
        const n = opts.prunedCount ?? 0;
        return {
          // F2-1 — the ids the caller needs to stamp each draft's images.
          prunedDrafts: Array.from({ length: n }, (_v, i) => ({
            broadcastId: `pruned-${i}`,
            requestedByMemberId: null,
          })),
        };
      },
      async listInFlightOwnedByMember() {
        return [];
      },
      async scrubContentForMemberInTx() {
        return { scrubbedCount: 0 };
      },
      async tombstoneDeliveriesForMemberInTx() {
        return { tombstonedCount: 0 };
      },
      async listMemberResendAudienceContactsInTx() {
        return [];
      },
      async redactMemberEmailFromCustomRecipientsInTx() {
        return { redactedCount: 0 };
      },
      async listTerminalBroadcastsWithLiveAudience() { throw new Error('not used in prune-expired-drafts fixture'); },
      async markAudienceDeletedInTx() { throw new Error('not used in prune-expired-drafts fixture'); },
      async deleteExpiredForRetention() { throw new Error('not used in prune-expired-drafts fixture'); },
      async listExpiredForRetention() { throw new Error('not used in prune-expired-drafts fixture'); },
      async existingBroadcastIds() { throw new Error('not used in prune-expired-drafts fixture'); },
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
      ...imageDeps(),
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
      ...imageDeps(),
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
      ...imageDeps(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBe(0);
    }
  });

  /**
   * ROUND-3 #3 — the R-M1 loop itself was never asserted.
   *
   * `batches`, `budgetExhausted`, the short-batch exit and the clock-budget
   * exit were all unmeasured: every existing case used a fixture that IGNORED
   * `limit` and returned the whole set in one go, so a loop that dropped its
   * bound, or one that never broke, looked identical from here. The bound is
   * the whole point of R-M1 — it is what stops one transaction holding row
   * locks on every expired draft of the tenant.
   */
  it('R-M1: the loop runs bounded batches and stops on the SHORT one', async () => {
    const repo = makeRepo({ expired: 3 });
    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock,
      ...imageDeps(),
      batchSize: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBe(3);
      // 2 (full) then 1 (short) — the short batch ends the loop.
      expect(result.value.batches).toBe(2);
      expect(result.value.budgetExhausted).toBe(false);
    }
    // Every DELETE carried the bound.
    expect(repo.calls.map((c) => c.limit)).toEqual([2, 2]);
  });

  /**
   * ROUND-3 #3 — the OTHER exit. A tenant with more expired drafts than one
   * tick can clear must stop on wall-clock and leave the rest for tomorrow,
   * with `budgetExhausted` saying so: a tick that silently ran long is how a
   * 300 s cron gets killed mid-sweep.
   */
  it('R-M1: a tick that runs past its time budget stops between batches and reports it', async () => {
    const repo = makeRepo({ expired: 100 });
    // Advances 30 s per read; the first read is the cutoff, the second is the
    // between-batch check.
    let tick = 0;
    const advancingClock = {
      now: (): Date => new Date(FROZEN_NOW.getTime() + tick++ * 30_000),
    };

    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock: advancingClock,
      ...imageDeps(),
      batchSize: 2,
      timeBudgetMs: 20_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.budgetExhausted).toBe(true);
      expect(result.value.batches).toBe(1);
      expect(result.value.prunedCount).toBe(2);
    }
    expect(repo.calls).toHaveLength(1);
  });

  /**
   * ROUND-3 #3 — and the loop TERMINATES when the batch is never short. With
   * a pool deeper than the tick, the only exit is the clock; if the budget
   * check were dropped or checked against a frozen clock this test would hang
   * rather than fail, which is precisely why the budget is read from the
   * injected clock and not from `Date.now()`.
   */
  it('R-M1: a pool that never goes short still terminates, on the budget', async () => {
    const repo = makeRepo({ expired: 1_000 });
    let tick = 0;
    // 6 s per read: cutoff at +0, then +6, +12, +18, +24 — four batches before
    // the 20 s budget is spent.
    const advancingClock = {
      now: (): Date => new Date(FROZEN_NOW.getTime() + tick++ * 6_000),
    };

    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock: advancingClock,
      ...imageDeps(),
      batchSize: 2,
      timeBudgetMs: 20_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.batches).toBe(4);
      expect(result.value.budgetExhausted).toBe(true);
      expect(result.value.prunedCount).toBe(8);
    }
    expect(repo.calls).toHaveLength(4);
  });

  it('repo throws → returns prune.server_error with the original message', async () => {
    const repo = makeRepo({ shouldThrow: true });
    const result = await pruneExpiredDrafts({
      tenant,
      broadcastsRepo: repo.port,
      clock,
      ...imageDeps(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('prune.server_error');
      expect(result.error.message).toContain('Neon');
    }
  });
});
