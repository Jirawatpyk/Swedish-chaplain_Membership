/**
 * T122 (Phase 7) — Integration: stale-invoice auto-refund against
 * live Neon.
 *
 * Spec authority: F5 spec.md US5, FR-011b, plan.md § 4.1 + PR-A Task A.13
 * (#3 / CRITICAL-2).
 *
 * Scenario: Stripe `payment_intent.succeeded` arrives for a payment
 * tied to an invoice already in a non-payable state (status='paid' /
 * 'void'). `confirmPayment` must:
 *   - Detect the stale invoice via `invoicingBridge.getInvoiceForPayment`.
 *   - Trigger `processorGateway.createRefund` (idempotency-keyed).
 *   - Emit `payment_auto_refunded_stale_invoice` audit row.
 *   - NOT call `invoicingBridge.markPaidFromProcessor`.
 *   - A.13 — TERMINALISE the payment (`pending → auto_refunded`) WITH a
 *     `completed_at` AND durably stamp `auto_refund_processor_refund_id`
 *     (the Stripe `re_…` id) so the later `charge.refund.updated`
 *     webhook (A.11) recognises the auto-refund instead of firing a
 *     false out-of-band alert. Pre-fix the row stayed `pending` forever.
 *   - NOT create a `refunds` row and NOT mint an F4 credit note (tax#4 —
 *     a stale-invoice auto-refund is a payment-level reversal).
 *
 * End-to-end (A.13 WRITE ↔ A.11 READ): once the payment carries the
 * durable marker, a later `charge.refund.updated` for that `re_…` id →
 *   - `succeeded` → `processRefundUpdated` matches the marker via
 *     `findAutoRefundByProcessorRefundId` → `auto_refund_recognized`,
 *     NO false `out_of_band_refund_detected` alert.
 *   - `failed`    → `auto_refund_failed` + the 10y forensic
 *     `auto_refund_failed_needs_manual_reconcile` audit (CRITICAL-2,
 *     money-not-returned; NEVER suppressed).
 *
 * Mocking policy:
 *   - LIVE Neon for `paymentsRepo` + `refundsRepo` +
 *     `processorEventsRepo` + `audit` (drizzle adapters).
 *   - MOCKED `processorGateway` (createRefund + retrievePaymentIntent)
 *     and `invoicingBridge` (getInvoiceForPayment) at the port boundary
 *     — the gateway HTTP layer is covered by `stripe-gateway-mock.test.ts`,
 *     and the F4 `invoices` table integration is covered by
 *     `invoicing-bridge-atomicity.test.ts`. Folding both into this test
 *     would create excessive seed surface without new coverage value.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { confirmPayment } from '@/modules/payments';
import { processRefundUpdated } from '@/modules/payments/application/use-cases/process-refund-updated';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import {
  payments,
  refunds,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

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

interface PaymentSeed {
  readonly invoiceId: string;
  readonly paymentId: PaymentId;
  readonly paymentIntentId: string;
  /** Deterministic Stripe refund id the mocked gateway returns for this seed. */
  readonly refundId: string;
}

function makeSeed(label: string): PaymentSeed {
  return {
    invoiceId: randomUUID(),
    paymentId: asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`),
    paymentIntentId: `pi_test_stale_${label}_${randomUUID().slice(0, 8)}`,
    refundId: `re_test_${label}_${randomUUID().slice(0, 8)}`,
  };
}

describe('confirmPayment stale-invoice auto-refund — live Neon (T122 / A.13)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let paidSeed: PaymentSeed;
  let voidSeed: PaymentSeed;
  let recognizeSeed: PaymentSeed;
  let failSeed: PaymentSeed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    paidSeed = makeSeed('paid');
    voidSeed = makeSeed('void');
    recognizeSeed = makeSeed('recognize');
    failSeed = makeSeed('fail');

    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
      // Parent FK chain: plan → member → invoice settings → sequences → invoice
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'stale-plan',
        planYear: 2026,
        planName: { en: 'Stale Plan' },
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
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Stale Co',
        country: 'TH',
        planId: 'stale-plan',
        planYear: 2026,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 500000n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T',
        creditNoteNumberPrefix: 'TC',
      });
      await tx.insert(tenantDocumentSequences).values({
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: 2026,
      });
      // Four parallel invoice+payment chains: paid/void exercise the pure
      // A.13 flip; recognize/fail exercise the end-to-end A.13→A.11 hop.
      for (const seed of [paidSeed, voidSeed, recognizeSeed, failSeed]) {
        await tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId: seed.invoiceId,
          memberId,
          planYear: 2026,
          planId: 'stale-plan',
          draftByUserId: user.userId,
        });
        await tx.insert(payments).values({
          id: seed.paymentId,
          tenantId: tenant.ctx.slug,
          invoiceId: seed.invoiceId,
          memberId,
          method: 'card',
          status: 'pending',
          amountSatang: 5_350_000n,
          currency: 'THB',
          processorPaymentIntentId: seed.paymentIntentId,
          processorChargeId: null,
          processorEnvironment: 'test',
          attemptSeq: 1,
          cardBrand: null,
          cardLast4: null,
          cardExpMonth: null,
          cardExpYear: null,
          initiatedAt: new Date(),
          completedAt: null,
          actorUserId: user.userId,
          correlationId: 'corr-stale-test',
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  function makeMocks(seed: PaymentSeed, invoiceStatus: 'paid' | 'void') {
    const processorGateway = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(async () =>
        ok({
          id: seed.paymentIntentId,
          status: 'succeeded' as const,
          latestChargeId: 'ch_test_stale',
          livemode: false,
          lastPaymentErrorCode: null,
          card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
          clientSecret: null,
          promptpayQrSvgUrl: null,
        }),
      ),
      cancelPaymentIntent: vi.fn(),
      // Deterministic refund id per seed so the durable-marker assertion
      // (A.13) can pin the exact `re_…` id written to the payments row.
      createRefund: vi.fn(async () =>
        ok({
          id: seed.refundId,
          status: 'succeeded' as const,
          amountSatang: 5_350_000n,
        }),
      ),
    };
    const invoicingBridge = {
      getInvoiceForPayment: vi.fn(async () =>
        ok({
          id: seed.invoiceId,
          status: invoiceStatus,
          totalSatang: 5_350_000n,
          memberId,
          tenantId: tenant.ctx.slug,
        }),
      ),
      markPaidFromProcessor: vi.fn(async () => ok(undefined)),
    };
    return { processorGateway, invoicingBridge };
  }

  async function runConfirmPayment(
    seed: PaymentSeed,
    mocks: ReturnType<typeof makeMocks>,
  ) {
    return runInTenant(tenant.ctx, async () =>
      confirmPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => ({
              tenantId: tenant.ctx.slug,
              processor: 'stripe',
              processorEnvironment: 'test',
              processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
              processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
              enabledMethods: ['card', 'promptpay'],
              onlinePaymentEnabled: true,
              autoEmailOnPayment: true,
              promptpayQrExpirySeconds: 900,
              allowAnonymousPaylink: false,
            }),
            findByProcessorAccountId: async () => null,
          },
          processorGateway:
            mocks.processorGateway as unknown as Parameters<typeof confirmPayment>[0]['processorGateway'],
          invoicingBridge:
            mocks.invoicingBridge as unknown as Parameters<typeof confirmPayment>[0]['invoicingBridge'],
          audit: f5AuditAdapter,
          clock: systemClock,
          // Inert for the confirm READ (reconciliationPath:true → dormant).
          taxAtPayment: 'off',
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          correlationId: 'corr-stale-test',
          requestId: 'req-stale-test',
          eventCreatedAtUnixSeconds: Math.floor(Date.now() / 1000),
        },
      ),
    );
  }

  /**
   * A.11 driver — dispatch a `charge.refund.updated` reconciliation for a
   * given Stripe refund id against the LIVE repos. The auto-refund NOT-FOUND
   * path never touches the invoicing bridge, so it is a never-called stub.
   * `markProcessed` on a not-seeded event id is a harmless no-op UPDATE.
   */
  async function runProcessRefundUpdated(
    processorRefundId: string,
    refundStatus: 'succeeded' | 'failed',
  ) {
    return processRefundUpdated(
      {
        paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
        refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
        processorEventsRepo: makeDrizzleProcessorEventsRepo(),
        invoicingBridge: {
          getInvoiceForPayment: vi.fn(),
          markPaidFromProcessor: vi.fn(),
        } as unknown as Parameters<typeof processRefundUpdated>[0]['invoicingBridge'],
        audit: f5AuditAdapter,
        clock: systemClock,
      },
      {
        tenantId: tenant.ctx.slug,
        requestId: 'req-refund-updated',
        eventId: `evt_test_${randomUUID().slice(0, 12)}`,
        processorRefundId,
        chargeId: 'ch_test_stale',
        refundStatus,
        amountSatang: 5_350_000n,
        processorEnv: 'test',
      },
    );
  }

  it('paid invoice → payment flips pending→auto_refunded WITH completed_at + durable marker + concurrent_manual_mark audit; NO refunds row (A.13, R3 CRIT-A)', async () => {
    const mocks = makeMocks(paidSeed, 'paid');
    const result = await runConfirmPayment(paidSeed, mocks);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // Idempotency key contract: `auto-refund-${payment.id}` so Stripe
    // retries are deduped server-side (confirm-payment.ts).
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auto-refund-${paidSeed.paymentId}`,
      }),
    );

    // R3 CRIT-A (2026-04-28): cause=`invoice_already_paid` →
    // event type `payment_auto_refunded_concurrent_manual_mark` per
    // spec.md edge case (admin-marks-paid-mid-flight race).
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'payment_auto_refunded_concurrent_manual_mark'),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // A.13 — the payment row is TERMINALISED as `auto_refunded` (no longer
    // stuck `pending`), carries the Stripe `re_…` id in the durable marker
    // column, and has `completed_at` set (migration 0033 CHECK).
    const paymentRow = await db
      .select({
        status: payments.status,
        completedAt: payments.completedAt,
        autoRefundProcessorRefundId: payments.autoRefundProcessorRefundId,
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenant.ctx.slug),
          eq(payments.id, paidSeed.paymentId),
        ),
      );
    expect(paymentRow[0]?.status).toBe('auto_refunded');
    expect(paymentRow[0]?.completedAt).not.toBeNull();
    expect(paymentRow[0]?.autoRefundProcessorRefundId).toBe(paidSeed.refundId);

    // tax#4 — NO refunds aggregate row for this stale-invoice reversal.
    const refundRows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.tenantId, tenant.ctx.slug),
          eq(refunds.invoiceId, paidSeed.invoiceId),
        ),
      );
    expect(refundRows.length).toBe(0);
  }, 30_000);

  it('void invoice → same auto_refunded flip (cause=invoice_voided) + durable marker', async () => {
    const mocks = makeMocks(voidSeed, 'void');
    const result = await runConfirmPayment(voidSeed, mocks);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(mocks.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
    expect(mocks.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auto-refund-${voidSeed.paymentId}`,
      }),
    );

    const paymentRow = await db
      .select({
        status: payments.status,
        autoRefundProcessorRefundId: payments.autoRefundProcessorRefundId,
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenant.ctx.slug),
          eq(payments.id, voidSeed.paymentId),
        ),
      );
    expect(paymentRow[0]?.status).toBe('auto_refunded');
    expect(paymentRow[0]?.autoRefundProcessorRefundId).toBe(voidSeed.refundId);
  }, 30_000);

  it('A.13→A.11 end-to-end: later charge.refund.updated(succeeded) → auto_refund_recognized, NO false out-of-band alert', async () => {
    // 1) Auto-refund the stale-invoice payment → durable marker written.
    const mocks = makeMocks(recognizeSeed, 'void');
    const confirmResult = await runConfirmPayment(recognizeSeed, mocks);
    expect(confirmResult.ok).toBe(true);

    // 2) A later Stripe `charge.refund.updated(succeeded)` for that `re_…`
    //    id → the durable marker is recognised; no false OOB alert.
    const result = await runProcessRefundUpdated(recognizeSeed.refundId, 'succeeded');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refund_recognized');
    if (result.value.kind !== 'auto_refund_recognized') return;
    expect(result.value.invoiceId).toBe(recognizeSeed.invoiceId);

    // NO false `out_of_band_refund_detected` audit for this refund id — the
    // money-trail was already recorded at auto-refund time (A.13). Narrow
    // by the payload marker so a genuine OOB for a different refund in the
    // shared suite cannot false-fail this assertion.
    const oobRows = await db.execute(sql`
      SELECT id FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'out_of_band_refund_detected'
         AND payload->>'processor_refund_id' = ${recognizeSeed.refundId}
    `);
    expect(Array.from(oobRows as unknown as Iterable<unknown>).length).toBe(0);
  }, 30_000);

  it('A.13→A.11 end-to-end: later charge.refund.updated(failed) → auto_refund_failed + 10y auto_refund_failed_needs_manual_reconcile audit (CRITICAL-2)', async () => {
    // 1) Auto-refund the stale-invoice payment → durable marker written.
    const mocks = makeMocks(failSeed, 'void');
    const confirmResult = await runConfirmPayment(failSeed, mocks);
    expect(confirmResult.ok).toBe(true);

    // 2) Stripe later reports the auto-refund FAILED for that `re_…` id →
    //    the payment reads `auto_refunded` but the money did NOT reach the
    //    customer → emit the never-suppressed 10y forensic.
    const result = await runProcessRefundUpdated(failSeed.refundId, 'failed');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refund_failed');
    if (result.value.kind !== 'auto_refund_failed') return;
    expect(result.value.invoiceId).toBe(failSeed.invoiceId);

    // The 10y CRITICAL-2 forensic landed in the live audit_log, carrying
    // the durable marker + the failed refund status.
    const forensic = await db.execute(sql`
      SELECT payload FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'auto_refund_failed_needs_manual_reconcile'
         AND payload->>'auto_refund_processor_refund_id' = ${failSeed.refundId}
    `);
    const forensicRows = Array.from(
      forensic as unknown as Iterable<{ payload: Record<string, unknown> }>,
    );
    expect(forensicRows.length).toBeGreaterThanOrEqual(1);
    expect(forensicRows[0]!.payload['refund_status']).toBe('failed');
  }, 30_000);
});
