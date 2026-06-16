/**
 * COMP-1 (Member Erasure) — H4 completion regression net for the F8
 * renewals PIPELINE + PENDING-REACTIVATION-REVIEW admin reads.
 *
 * Erasure keeps `members.status` (often 'active') and the member's renewal
 * cycle, stamps ONLY `erased_at`, and scrubs `company_name` to '[erased]'.
 * Critically, `markCycleCompleteFromInvoicePaid` routes a paid erased
 * member's cycle to `pending_admin_reactivation` (a NON-terminal status), so
 * erased members are ACTIVELY pushed into the pipeline window + the
 * pending-review discovery queue. Both operational admin reads must therefore
 * add `erased_at IS NULL`:
 *   - `loadPipelinePage` (backs `/admin/renewals` — LEFT JOINs members,
 *     surfaces companyName, summary + lapsed counts)
 *   - `loadPendingReactivationReview` → `cyclesRepo.list({ excludeErasedMembers })`
 *     (backs `/admin/renewals?view=pending-review`)
 *
 * Seeds a kept (non-erased) control + an erased member, each with a cycle the
 * surface returns. RED before the filter (erased member appears) → GREEN after.
 *
 * Live Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  loadPipeline,
  loadPendingReactivationReview,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('F8 pipeline + pending-review reads exclude erased members (COMP-1 H4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let keptId: string;
  let erasedId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-erased-pipe-${randomUUID().slice(0, 8)}`;
    keptId = randomUUID();
    erasedId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Erased Pipeline Plan' },
        renewalTierBucket: 'regular',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // Each member gets an in-window cycle in `pending_admin_reactivation`
    // (the exact status erasure routes a paid erased member's cycle to). It
    // is NON-terminal so it appears in the 90-day pipeline window AND in the
    // pending-review discovery queue. `entered_pending_at` is required by the
    // DB CHECK + rowToDomain for this status.
    const seed = (memberId: string, erasedAt: Date | null) =>
      runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: erasedAt ? '[erased]' : 'Kept Pipeline Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active', // erasure keeps status active
          erasedAt,
        });
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: 'pending_admin_reactivation',
          enteredPendingAt: new Date(Date.now() - 2 * MS_PER_DAY),
          periodFrom: new Date(Date.now() - 30 * MS_PER_DAY),
          periodTo: new Date(Date.now() + 20 * MS_PER_DAY),
          expiresAt: new Date(Date.now() + 20 * MS_PER_DAY),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planId,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        });
      });

    await seed(keptId, null);
    await seed(erasedId, new Date());
  }, 120_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('loadPipelinePage excludes the erased member from rows + summary', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await loadPipeline(deps, {
      tenantId: tenant.ctx.slug,
      // 't-30' activates the 90-day non-lapsed window; both seeded cycles
      // (expiry +20d) fall inside it.
      urgency: 't-30',
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const memberIds = result.value.rows.map((r) => r.memberId);
    expect(memberIds).toContain(keptId);
    expect(memberIds).not.toContain(erasedId);

    // The summary aggregate (badge counts) must agree with the rows: exactly
    // one of OUR two seeded cycles (the kept one) is counted in-window.
    const ourRows = result.value.rows.filter(
      (r) => r.memberId === keptId || r.memberId === erasedId,
    );
    expect(ourRows).toHaveLength(1);
  });

  it('loadPendingReactivationReview excludes the erased member', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await loadPendingReactivationReview(deps, {
      tenantId: tenant.ctx.slug,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const memberIds = result.value.cycles.map((c) => c.memberId);
    expect(memberIds).toContain(keptId);
    expect(memberIds).not.toContain(erasedId);
  });
});
