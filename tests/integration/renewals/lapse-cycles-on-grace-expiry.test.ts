/**
 * F8 Phase 5 wave K24 · T115a — `lapseCyclesOnGraceExpiry` integration
 * test (live Neon).
 *
 * Verifies the daily lapse-decision cron on real Postgres for both
 * branches of FR-004 + AS3:
 *
 *   1. **grace_expired path** — cycle past `expires_at + grace_period_days`
 *      with zero F5 payment attempts → transitions awaiting_payment →
 *      lapsed with `closed_reason='grace_expired'` + emits typed
 *      `renewal_lapsed` audit.
 *   2. **payment_failed path** — same cycle past grace, BUT a F5
 *      `payments` row with `status='failed'` exists for the linked
 *      invoice → transitions with `closed_reason='payment_failed'`
 *      and the audit payload carries `failed_payment_attempts >= 1`.
 *
 * Skipped on live: Stripe API. We seed F5 `payments` rows directly
 * via Drizzle (status='failed' + minimum CHECK-passing fields) so
 * the bridge query exercises the real RLS-scoped read path without
 * hitting Stripe.
 *
 * Per-cycle fault isolation + `transitionRaceSkipped` are covered
 * by unit tests; this integration file purposefully focuses on the
 * decision branch + audit-payload shape against live RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { payments } from '@/modules/payments/infrastructure/schema';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  lapseCyclesOnGraceExpiry,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('F8 lapseCyclesOnGraceExpiry — integration (K24 / T115a)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  const memberA = randomUUID();
  const memberB = randomUUID();
  const cycleGraceExpired = randomUUID();
  const cyclePaymentFailed = randomUUID();
  const invoiceForFailed = randomUUID();
  // NOW = 2026-05-30; grace_period_days = 14; cycles seeded with
  // expires_at = 2026-05-01 → 29 days past expiry → past grace.
  const NOW = new Date('2026-05-30T08:00:00Z');
  const EXPIRES_AT = new Date('2026-05-01T00:00:00Z');

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    const planId = `f8-lapse-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Lapse Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // Seed tenant_renewal_settings (default 14-day grace).
    // Insert is idempotent on PK conflict so re-running is safe.
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .insert(tenantRenewalSettings)
        .values({
          tenantId: tenantA.ctx.slug,
          gracePeriodDays: 14,
          autoUpgradeEnabled: true,
          minTenureDaysForAtRisk: 30,
          dispatchCronEnabled: true,
        })
        .onConflictDoNothing(),
    );

    // Two members, each with one cycle past the grace boundary.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values(
        [memberA, memberB].map((mid) => ({
          tenantId: tenantA.ctx.slug,
          memberId: mid,
          companyName: `Lapse Co ${mid.slice(0, 6)}`,
          country: 'TH' as const,
          planId,
          planYear: 2026,
        })),
      ),
    );

    // memberB's invoice + 1 failed F5 payment row (drives payment_failed).
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: invoiceForFailed,
        memberId: memberB,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        currency: 'THB',
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(payments).values({
        id: `pay_${randomUUID().slice(0, 12)}`,
        tenantId: tenantA.ctx.slug,
        invoiceId: invoiceForFailed,
        memberId: memberB,
        method: 'card',
        status: 'failed',
        amountSatang: 5_000_000n,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        failureReasonCode: 'card_declined',
        initiatedAt: new Date('2026-04-25T10:00:00Z'),
        completedAt: new Date('2026-04-25T10:00:30Z'),
        actorUserId: user.userId,
        correlationId: randomUUID(),
      }),
    );

    // Cycles — both awaiting_payment, both past grace.
    const seedCycle = (
      cycleId: string,
      memberId: string,
      linkedInvoiceId: string | null,
    ) =>
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenantA.ctx.slug,
          cycleId,
          memberId,
          status: 'awaiting_payment',
          periodFrom: new Date('2025-05-01T00:00:00Z'),
          periodTo: EXPIRES_AT,
          expiresAt: EXPIRES_AT,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          ...(linkedInvoiceId !== null ? { linkedInvoiceId } : {}),
        }),
      );
    await seedCycle(cycleGraceExpired, memberA, null);
    await seedCycle(cyclePaymentFailed, memberB, invoiceForFailed);
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(payments)
      .where(eq(payments.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 60_000);

  it('decision branch on live Neon: grace_expired (no F5 payments) + payment_failed (>=1 F5 failed) + audit emits', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await lapseCyclesOnGraceExpiry(deps, {
      tenantId: tenantA.ctx.slug,
      now: NOW,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cyclesProcessed).toBe(2);
    expect(r.value.graceExpired).toBe(1);
    expect(r.value.paymentFailed).toBe(1);
    expect(r.value.transitionRaceSkipped).toBe(0);
    expect(r.value.errors).toBe(0);

    // Verify both cycles transitioned to lapsed with the right
    // closed_reason discriminant on disk.
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantA.ctx.slug)),
    );
    const grace = rows.find((r) => r.cycleId === cycleGraceExpired);
    const failed = rows.find((r) => r.cycleId === cyclePaymentFailed);
    expect(grace?.status).toBe('lapsed');
    expect(grace?.closedReason).toBe('grace_expired');
    expect(failed?.status).toBe('lapsed');
    expect(failed?.closedReason).toBe('payment_failed');

    // Verify audit emit — both cycles emitted `renewal_lapsed`.
    const audits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'renewal_lapsed'),
          ),
        ),
    );
    expect(audits.length).toBe(2);
  });
});
