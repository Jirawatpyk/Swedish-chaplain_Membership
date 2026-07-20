/**
 * A.18 (#2) — `processRefundUpdated` cross-tenant isolation, live Neon.
 *
 * Principle I (NON-NEGOTIABLE) Review-Gate blocker: a Stripe refund id
 * (`re_…`) created under **tenant A** MUST NOT resolve, finalize, or in any
 * way mutate under **tenant B**. Two REAL two-tenant rows in live Neon prove
 * BOTH isolation layers hold together:
 *
 *   - DB layer — the tenant-scoped `refundsRepo.lockForUpdateByProcessorRefundId`
 *     runs inside `runInTenant(tenantB, …)` (RLS + `SET LOCAL app.current_tenant`)
 *     AND carries the explicit `tenant_id = ?` app-layer filter. Under tenant B
 *     the lookup for tenant A's `re_…` id returns `null`.
 *   - App layer — with no matching refund row AND no auto-refund marker under
 *     tenant B, `processRefundUpdated` falls through to `out_of_band` for
 *     tenant B and NEVER touches tenant A's refund.
 *
 * Adversarial choice: the cross-tenant probe uses `refundStatus: 'succeeded'`
 * — the ONLY branch that would book an F4 credit note + flip the payment if
 * isolation leaked. The `invoicingBridge` is a never-called stub, and we
 * assert it is NEVER invoked under tenant B: a leak that reached the
 * succeeded-finalise path would call it and fail loudly.
 *
 * Positive control: the SAME `re_…` id under tenant A (its owning tenant)
 * DOES resolve (`reconciled_failed`, flipping A's refund → failed) — proving
 * the cross-tenant no-op is genuine tenant isolation, not a dead/unknown id.
 *
 * Mocking policy: live Postgres for paymentsRepo + refundsRepo +
 * processorEventsRepo + audit (real Drizzle adapters). Only the F4
 * invoicing bridge is a never-called stub (no CN is issued on either the
 * out-of-band or the reconciled_failed path).
 *
 * Run in isolation (shared-Neon parallel suites flake cross-tenant probes):
 *   pnpm test:integration tests/integration/payments/process-refund-updated-cross-tenant.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { processRefundUpdated } from '@/modules/payments/application/use-cases/process-refund-updated';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { payments } from '@/modules/payments/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

const PAYMENT_AMOUNT = 5_350_000n;
const REFUND_AMOUNT = 100_000n;

/** A never-called F4 bridge — neither the out-of-band nor the failed path issues a CN. */
function neverCalledBridge(): Parameters<typeof processRefundUpdated>[0]['invoicingBridge'] {
  return {
    getInvoiceForPayment: vi.fn(),
    markPaidFromProcessor: vi.fn(),
    issueCreditNoteFromRefund: vi.fn(),
  } as unknown as Parameters<typeof processRefundUpdated>[0]['invoicingBridge'];
}

function makeDeps(
  slug: string,
  invoicingBridge: Parameters<typeof processRefundUpdated>[0]['invoicingBridge'],
) {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(slug),
    refundsRepo: makeDrizzleRefundsRepo(slug),
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
  };
}

async function refundStatus(slug: string, refundId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT status FROM refunds
    WHERE tenant_id = ${slug} AND id = ${refundId}
  `)) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? 'MISSING';
}

async function creditNoteCountForRefund(slug: string, refundId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM credit_notes
    WHERE tenant_id = ${slug} AND source_refund_id = ${refundId}
  `)) as unknown as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

async function auditCount(
  slug: string,
  eventType: string,
  refundOrProcessorId: string,
  key: 'refund_id' | 'processor_refund_id',
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM audit_log
    WHERE tenant_id = ${slug}
      AND event_type = ${eventType}::audit_event_type
      AND payload->>${key} = ${refundOrProcessorId}
  `)) as unknown as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

describe('processRefundUpdated — cross-tenant isolation, live Neon (A.18 #2)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let paymentA: PaymentId;
  let invoiceA: string;
  const refundA = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const reA = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');

    const memberId = randomUUID();
    invoiceA = randomUUID();
    paymentA = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);

    // Seed ONLY tenant A: plan → member → invoice → succeeded payment → pending refund.
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenantA.ctx.slug,
        planId: 'xtenant-plan',
        planYear: 2026,
        planName: { en: 'Cross-Tenant Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Cross-Tenant Co',
        country: 'TH',
        planId: 'xtenant-plan',
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: invoiceA,
        memberId,
        planYear: 2026,
        planId: 'xtenant-plan',
        draftByUserId: user.userId,
      });
      await tx.insert(payments).values({
        id: paymentA,
        tenantId: tenantA.ctx.slug,
        invoiceId: invoiceA,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: PAYMENT_AMOUNT,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: new Date(),
        completedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-xtenant-pay',
      });
    });

    // A pending refund with the Stripe id reA, owned by tenant A.
    await runInTenant(tenantA.ctx, async (tx) => {
      await makeDrizzleRefundsRepo(tenantA.ctx.slug).insert(tx, {
        id: refundA,
        tenantId: tenantA.ctx.slug,
        paymentId: paymentA,
        invoiceId: invoiceA,
        amountSatang: asSatang(REFUND_AMOUNT),
        reason: 'cross-tenant isolation seed',
        status: 'pending',
        processorRefundId: reA,
        initiatorUserId: user.userId,
        correlationId: 'corr-xtenant-refund',
        creditNoteWaiverReason: null,
        initiatedAt: new Date(),
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it("tenant B cannot resolve tenant A's re_ id → out_of_band, A's refund untouched", async () => {
    const bridgeB = neverCalledBridge();
    // Adversarial: succeeded is the ONLY branch that would issue a CN + flip
    // if isolation leaked.
    const result = await processRefundUpdated(makeDeps(tenantB.ctx.slug, bridgeB), {
      tenantId: tenantB.ctx.slug,
      requestId: 'req-xtenant-probe',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      processorRefundId: reA,
      chargeId: 'ch_x',
      refundStatus: 'succeeded',
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Tenant B sees an out-of-band refund (no in-app row, no auto-refund marker).
    expect(result.value.kind).toBe('out_of_band');

    // The F4 bridge was NEVER called under tenant B (a leak into the succeeded
    // finalise path would have invoked issueCreditNoteFromRefund).
    expect(bridgeB.issueCreditNoteFromRefund).not.toHaveBeenCalled();

    // Tenant A's refund is UNTOUCHED — still pending.
    expect(await refundStatus(tenantA.ctx.slug, refundA)).toBe('pending');

    // No credit note materialised for A's refund under EITHER tenant.
    expect(await creditNoteCountForRefund(tenantA.ctx.slug, refundA)).toBe(0);
    expect(await creditNoteCountForRefund(tenantB.ctx.slug, refundA)).toBe(0);

    // No refund_succeeded audit under tenant B referencing A's refund.
    expect(
      await auditCount(tenantB.ctx.slug, 'refund_succeeded', refundA, 'refund_id'),
    ).toBe(0);
    // Finding 4 (split ownership) — `charge.refund.updated` emits the
    // `out_of_band_refund_detected` forensic REDUNDANTLY (paired with the
    // `charge.refunded` handler; deduped on read by processor_refund_id). The
    // forensic landed under tenant B (scoped correctly to the tenant that ran
    // the handler), NOT A — the isolation guarantee: tenant B resolves NOTHING
    // of A's (returns `out_of_band`, never calls the F4 bridge, leaves A's
    // refund untouched) and A gets no cross-tenant forensic leak.
    expect(
      await auditCount(
        tenantB.ctx.slug,
        'out_of_band_refund_detected',
        reA,
        'processor_refund_id',
      ),
    ).toBe(1);
    expect(
      await auditCount(
        tenantA.ctx.slug,
        'out_of_band_refund_detected',
        reA,
        'processor_refund_id',
      ),
    ).toBe(0);
  }, 60_000);

  // ORDER-COUPLED: this positive control MUTATES tenant A's refund
  // (pending → failed), so it MUST run AFTER the negative isolation test above
  // (which asserts A's refund is still `pending`). vitest executes `it` blocks
  // in file order within a describe, so the ordering holds; do NOT reorder
  // these two, add an `it` between them that reads A's refund status, or run
  // them with a randomised sequencer — the negative test would then observe
  // A's refund already `failed` and misreport a false isolation leak.
  it("positive control: the SAME re_ id resolves under tenant A → reconciled_failed (proves isolation, not a dead id)", async () => {
    const bridgeA = neverCalledBridge();
    const result = await processRefundUpdated(makeDeps(tenantA.ctx.slug, bridgeA), {
      tenantId: tenantA.ctx.slug,
      requestId: 'req-xtenant-owner',
      eventId: `evt_${randomUUID().slice(0, 12)}`,
      processorRefundId: reA,
      chargeId: 'ch_x',
      refundStatus: 'failed',
      amountSatang: asSatang(REFUND_AMOUNT),
      processorEnv: 'test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('reconciled_failed');
    if (result.value.kind === 'reconciled_failed') {
      expect(result.value.invoiceId).toBe(invoiceA);
    }

    // The refund is now failed under its OWNING tenant — the id genuinely
    // resolves under A (so the tenant-B no-op above was isolation, not a dead id).
    expect(await refundStatus(tenantA.ctx.slug, refundA)).toBe('failed');
    // Failed path issues no CN; the never-called bridge stays untouched.
    expect(bridgeA.issueCreditNoteFromRefund).not.toHaveBeenCalled();
    expect(await creditNoteCountForRefund(tenantA.ctx.slug, refundA)).toBe(0);
  }, 60_000);
});
