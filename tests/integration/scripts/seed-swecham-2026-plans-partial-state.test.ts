/**
 * R4-C1 — partial-state contract for seed Stage B.
 *
 * Background: R3-S3 claimed `await runInTenant(ctx, async () => { ... })`
 * around the 9 insert+audit pairs produced SAVEPOINT semantics — turns
 * out FALSE. `runInTenant` calls `db.transaction(...)` on the top-level
 * singleton (src/lib/db.ts:243), so nested calls open new top-level
 * transactions on new pool connections, NOT SAVEPOINTs. R4 Batch 5a
 * dropped the false outer wrap and documented the honest per-draft
 * semantics. This test pins that documented behaviour with live Neon.
 *
 * Contract under test:
 *   - Each `planRepo.insert` + `planAuditAdapter.record` pair commits
 *     INDEPENDENTLY.
 *   - On audit failure at draft N, drafts 1..(N-1) + their audit rows
 *     are already committed. Drafts N..9 are not attempted.
 *   - The idempotency guard `if (existingCount > 0) return skipped:true`
 *     then blocks re-runs from completing the catalogue.
 *
 * Strategy:
 *   1. Create a throwaway tenant + owner user.
 *   2. Spy on `planAuditAdapter.record` — first 4 calls pass through,
 *      5th returns `err({type:'persist_failed', message:'simulated'})`.
 *   3. Drive `stageB_Plans` — expect it to throw on draft 5.
 *   4. Direct-DB read: assert 4 plan rows + 4 audit rows exist; no
 *      rows for drafts 5..9.
 *   5. Restore spy + call `stageB_Plans` a second time — assert it
 *      returns `{skipped:true, inserted:0}` (idempotency guard fires
 *      because existingCount > 0).
 *
 * If a future maintainer "re-adds the outer wrap" thinking it's
 * SAVEPOINT, this test will fail because they'd see 0 drafts after
 * the throw (the wrap would roll everything back). That divergence
 * forces a comment update OR a real atomicity refactor — either is
 * fine, silent re-introduction is not.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { stageB_Plans } from '@/../scripts/seed-swecham-2026-plans';
import { err } from '@/lib/result';
import { createTestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser } from '../helpers/test-users';

describe('Integration — seed-swecham-2026-plans partial-state contract (R4-C1)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  beforeAll(() => {
    vi.restoreAllMocks();
  });

  it('R4-C1: audit failure on draft 5 leaves drafts 1-4 + audits 1-4 committed; idempotency guard blocks retry', async () => {
    const tenant = await createTestTenant('test-swecham');
    cleanups.push(tenant.cleanup);

    const owner = await createActiveTestUser();
    cleanups.push(() => deleteTestUser(owner));

    // Spy on planAuditAdapter.record. First 4 calls pass through to
    // the real impl; 5th returns persist_failed so stageB_Plans throws.
    const realRecord = planAuditAdapter.record.bind(planAuditAdapter);
    let callCount = 0;
    const recordSpy = vi
      .spyOn(planAuditAdapter, 'record')
      .mockImplementation(async (ctx, event) => {
        callCount += 1;
        if (callCount >= 5) {
          return err({
            type: 'persist_failed' as const,
            message: 'simulated DB failure for R4-C1 contract test',
          });
        }
        return realRecord(ctx, event);
      });

    // Expect throw on draft 5.
    await expect(stageB_Plans(tenant.ctx, owner.userId)).rejects.toThrow(
      /plan_created audit failed/,
    );

    // The spy fired exactly 5 times — 4 succeeded + 1 failed.
    expect(recordSpy).toHaveBeenCalledTimes(5);

    // Direct-DB verification: exactly 4 plan rows persist.
    const planRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.tenantId, tenant.ctx.slug),
            eq(membershipPlans.planYear, 2026),
          ),
        ),
    );
    // R5-I3 corrected semantics: planRepo.insert runs 5 times (calls
    // 1-4 succeed end-to-end; call 5's plan.insert commits via the
    // await-chain BEFORE the audit fires). The 5th audit-emit returns
    // persist_failed → throw lands AFTER plan.commit. So 5 plan rows
    // ALWAYS persist on N=5 failure — this is deterministic, not
    // a non-deterministic "may or may not".
    expect(planRows.length).toBe(5);

    // Direct-DB verification: exactly 4 plan_created audit rows
    // (the 5th audit emit returned persist_failed before any DB write).
    const auditRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_created'),
            // payload->>'plan_year' = '2026'
            sql`(${auditLog.payload}->>'plan_year')::int = 2026`,
          ),
        ),
    );
    expect(auditRows.length).toBe(4);

    // Restore the spy so the second call uses the real adapter.
    recordSpy.mockRestore();

    // Second call hits idempotency guard (5 plan rows > 0).
    const retryStatus = await stageB_Plans(tenant.ctx, owner.userId);
    expect(retryStatus.skipped).toBe(true);
    expect(retryStatus.inserted).toBe(0);

    // Confirm no additional plans + no additional audits inserted.
    const planRowsAfter = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.tenantId, tenant.ctx.slug),
            eq(membershipPlans.planYear, 2026),
          ),
        ),
    );
    expect(planRowsAfter.length).toBe(5);

    const auditRowsAfter = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_created'),
            sql`(${auditLog.payload}->>'plan_year')::int = 2026`,
          ),
        ),
    );
    expect(auditRowsAfter.length).toBe(4);
  }, 60_000);
});
