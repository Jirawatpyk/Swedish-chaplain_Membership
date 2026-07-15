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
  // Task 13 — member with a real `issued`, not-yet-past-due MEMBERSHIP
  // invoice. The InvoiceDueBridge guard must defer this member's lapse
  // instead of terminating benefit access mid-credit-window.
  const memberC = randomUUID();
  const cycleGraceExpired = randomUUID();
  const cyclePaymentFailed = randomUUID();
  const cycleDeferredInvoiceNotDue = randomUUID();
  const invoiceForFailed = randomUUID();
  const invoiceForCreditWindow = randomUUID();
  // NOW = 2026-05-30; grace_period_days = 14; cycles seeded with
  // expires_at = 2026-05-01 → 29 days past expiry → past grace.
  const NOW = new Date('2026-05-30T08:00:00Z');
  const EXPIRES_AT = new Date('2026-05-01T00:00:00Z');
  // Task 13 — F4's `invoices.due_date` is a plain `YYYY-MM-DD` date
  // column; well past `bangkokLocalDate(NOW)` ('2026-05-30') so the
  // guard's `due_date >= todayBkk` predicate is unambiguously true.
  const FUTURE_DUE_DATE = '2026-06-30';
  const SNAP_TENANT = {
    legal_name_th: 'ทดสอบ',
    legal_name_en: 'Test',
    tax_id: '0000000000000',
    address_th: 'Bangkok',
    address_en: 'Bangkok',
    logo_blob_key: null,
  };
  const SNAP_MEMBER = {
    legal_name: 'Lapse Co (credit window)',
    tax_id: '1234567890123',
    address: 'Bangkok',
    primary_contact_name: 'n',
    primary_contact_email: 'test@example.com',
  };

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

    // Three members, each with one cycle past the grace boundary.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values(
        [memberA, memberB, memberC].map((mid, i) => ({
          tenantId: tenantA.ctx.slug,
          memberId: mid,
          // 055-member-number — NOT NULL + per-tenant UNIQUE; map index → 1..N.
          memberNumber: i + 1,
          companyName: `Lapse Co ${mid.slice(0, 6)}`,
          country: 'TH' as const,
          planId,
          planYear: 2026,
        })),
      ),
    );

    // Task 13 — memberC's real `issued`, not-yet-past-due MEMBERSHIP
    // invoice (F4's 90-day net terms). Must satisfy
    // `invoices_non_draft_has_snapshots` (full snapshot + pdf set) —
    // same CHECK-satisfying shape as
    // `tests/integration/renewals/invoice-due-bridge.test.ts`.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: invoiceForCreditWindow,
        memberId: memberC,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'issued',
        dueDate: FUTURE_DUE_DATE,
        pdfDocKind: 'invoice',
        fiscalYear: 2025,
        sequenceNumber: 900001,
        documentNumber: 'INV-2025-900001',
        issueDate: '2025-01-15',
        currency: 'THB',
        subtotalSatang: 5_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 350_000n,
        totalSatang: 5_350_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 90,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2025/${invoiceForCreditWindow}.pdf`,
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
      }),
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
    //
    // Staff-Review-2026-05-09 R2-S9: align seed with the canonical
    // post-0113 pattern (use the F2 plan slug 'regular', not a
    // UUID-shaped string). The migration-0113 backward-compat path
    // is already covered by `tests/integration/renewals/
    // plan-id-at-cycle-start-text.test.ts` "legacy UUID-shaped values
    // still queryable as text" — duplicating the legacy pattern in
    // this lapse test was misaligned with the canonical seed shape
    // used by `tests/e2e/helpers/renewals-seed.ts:101`.
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
          planIdAtCycleStart: 'regular',
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          ...(linkedInvoiceId !== null ? { linkedInvoiceId } : {}),
        }),
      );
    await seedCycle(cycleGraceExpired, memberA, null);
    await seedCycle(cyclePaymentFailed, memberB, invoiceForFailed);
    // Task 13 — memberC's cycle is ALSO past grace, but the member has
    // a real unpaid, not-yet-past-due membership invoice: the guard
    // must defer the lapse instead of terminating benefit access.
    await seedCycle(cycleDeferredInvoiceNotDue, memberC, invoiceForCreditWindow);
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
    expect(r.value.cyclesProcessed).toBe(3);
    expect(r.value.graceExpired).toBe(1);
    expect(r.value.paymentFailed).toBe(1);
    expect(r.value.transitionRaceSkipped).toBe(0);
    // Task 13 — memberC's cycle is deferred, not lapsed and not an error.
    expect(r.value.deferredInvoiceNotDue).toBe(1);
    expect(r.value.deferredGuardErrors).toBe(0);
    expect(r.value.errors).toBe(0);

    // Verify all three cycles landed in the right terminal/non-terminal
    // state with the right closed_reason discriminant on disk.
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
    const deferred = rows.find((r) => r.cycleId === cycleDeferredInvoiceNotDue);
    expect(grace?.status).toBe('lapsed');
    expect(grace?.closedReason).toBe('grace_expired');
    expect(failed?.status).toBe('lapsed');
    expect(failed?.closedReason).toBe('payment_failed');
    // Task 13 — the guarded cycle SURVIVES: still awaiting_payment, no
    // closed_reason ever written (no transition attempted at all).
    expect(deferred?.status).toBe('awaiting_payment');
    expect(deferred?.closedReason).toBeNull();

    // Verify audit emit — both LAPSED cycles emitted `renewal_lapsed`.
    const lapsedAudits = await runInTenant(tenantA.ctx, (tx) =>
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
    expect(lapsedAudits.length).toBe(2);

    // Task 13 — the deferred member emitted the new forensic event
    // (own fire-and-forget `emit()`, no state-change tx to piggyback on).
    const deferredAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'renewal_lapse_deferred_invoice_not_due'),
          ),
        ),
    );
    expect(deferredAudits.length).toBe(1);
    expect(deferredAudits[0]?.payload).toMatchObject({
      cycle_id: cycleDeferredInvoiceNotDue,
      member_id: memberC,
      invoice_subject: 'membership',
    });
  });
});
