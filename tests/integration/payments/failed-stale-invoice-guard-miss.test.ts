/**
 * PR-A follow-up (guard-miss sub-case ii) — Integration: a terminal
 * `failed` payment whose invoice is NON-payable receives a late captured
 * charge, routes through the Step-3 stale-invoice auto-refund path, and
 * MUST stamp the durable A.15 marker on the still-`failed` row so the
 * auto-refund's later `charge.refund.updated` is RECOGNISED (A.11
 * `auto_refund_recognized`) instead of firing a FALSE
 * `out_of_band_refund_detected`.
 *
 * The gap (verified reachable): Step 3 (stale-invoice) runs BEFORE the
 * Step 4 transition check and does NOT inspect `payment.status`. So a
 * payment row that already committed `failed`, whose invoice became
 * non-payable (paid / void / credited), reaches Step 3 on a late
 * `payment_intent.succeeded`. There `markAutoRefunded` guards
 * `status='pending'` → returns `null` on a `failed` row → the auto-refund
 * is issued + audited but (pre-fix) NO durable marker is stamped → the
 * later `charge.refund.updated` for that `re_…` fires a FALSE
 * `out_of_band_refund_detected` (noisy, harmless — the refund is correct).
 *
 * Distinct from `fail-then-succeed-resume-race.test.ts` (A.15): there the
 * invoice is STILL payable (`issued`) so the flow reaches the Step-4
 * late-charge branch. HERE the invoice is NON-payable (`void`) so the flow
 * reaches Step 3 — the previously-unhandled marker gap.
 *
 * RED (verify-first): on UNFIXED code the marker column stays NULL and the
 * later `charge.refund.updated(succeeded)` resolves `out_of_band`. After
 * the fix the marker is stamped and the reconcile resolves
 * `auto_refund_recognized` with NO false OOB.
 *
 * Mocking policy (mirrors stale-invoice-auto-refund.test.ts): LIVE Neon for
 * repos + audit; MOCKED `processorGateway` (retrieve + createRefund) and
 * `invoicingBridge` (getInvoiceForPayment) at the port boundary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { asSatang } from '@/lib/money';
import { confirmPayment, failPayment } from '@/modules/payments';
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
  /** Deterministic captured charge id the mocked `succeeded` retrieve returns. */
  readonly chargeId: string;
}

function makeSeed(label: string): PaymentSeed {
  return {
    invoiceId: randomUUID(),
    paymentId: asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`),
    paymentIntentId: `pi_test_gmiss_${label}_${randomUUID().slice(0, 8)}`,
    refundId: `re_test_gmiss_${label}_${randomUUID().slice(0, 8)}`,
    chargeId: `ch_test_gmiss_${label}_${randomUUID().slice(0, 8)}`,
  };
}

const SETTINGS_STUB = (slug: string) => ({
  tenantId: slug,
  processor: 'stripe' as const,
  processorEnvironment: 'test' as const,
  processorAccountId: `acct_test_${slug.slice(-8)}`,
  processorPublishableKey: `pk_test_${slug.slice(-8)}`,
  enabledMethods: ['card', 'promptpay'] as ('card' | 'promptpay')[],
  onlinePaymentEnabled: true,
  autoEmailOnPayment: true,
  promptpayQrExpirySeconds: 900,
  allowAnonymousPaylink: false,
});

describe('confirmPayment failed-row + non-payable invoice stale Step-3 marker — live Neon (guard-miss ii)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let seed: PaymentSeed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    seed = makeSeed('void');

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
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'gmiss-plan',
        planYear: 2026,
        planName: { en: 'Guard-Miss Plan' },
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
        companyName: 'Guard-Miss Co',
        country: 'TH',
        planId: 'gmiss-plan',
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
      // ONE invoice + ONE payment: seed the payment `pending` and drive the
      // genuine `payment_intent.payment_failed` (failPayment) so the row
      // reaches `failed` via the real code path (satisfies every non-pending
      // CHECK constraint the raw seed would have to reproduce by hand).
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: seed.invoiceId,
        memberId,
        planYear: 2026,
        planId: 'gmiss-plan',
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
        correlationId: 'corr-gmiss-test',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /** Drive the genuine payment_intent.payment_failed → row flips pending→failed. */
  async function runFailPayment() {
    const processorGateway = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(async () =>
        ok({
          id: seed.paymentIntentId,
          status: 'requires_payment_method' as const,
          latestChargeId: null,
          livemode: false,
          lastPaymentErrorCode: 'card_declined',
          card: null,
          clientSecret: null,
          promptpayQrSvgUrl: null,
        }),
      ),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(),
    };
    return runInTenant(tenant.ctx, async () =>
      failPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => SETTINGS_STUB(tenant.ctx.slug),
            findByProcessorAccountId: async () => null,
          },
          processorGateway:
            processorGateway as unknown as Parameters<typeof failPayment>[0]['processorGateway'],
          audit: f5AuditAdapter,
          clock: systemClock,
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          requestId: 'req-gmiss-fail',
          eventCreatedAtUnixSeconds: Math.floor(Date.now() / 1000),
        },
      ),
    );
  }

  /**
   * Drive the late payment_intent.succeeded (real captured charge) against a
   * NON-payable (void) invoice → routes through the Step-3 stale path.
   */
  async function runConfirmPayment() {
    const processorGateway = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(async () =>
        ok({
          id: seed.paymentIntentId,
          status: 'succeeded' as const,
          latestChargeId: seed.chargeId,
          livemode: false,
          lastPaymentErrorCode: null,
          card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
          clientSecret: null,
          promptpayQrSvgUrl: null,
        }),
      ),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(async () =>
        ok({
          id: seed.refundId,
          status: 'succeeded' as const,
          amountSatang: 5_350_000n,
        }),
      ),
    };
    const invoicingBridge = {
      // Invoice is NON-payable (`void`) — routes confirmPayment through the
      // Step-3 stale-invoice auto-refund path (NOT the Step-4 late-charge
      // branch, which requires a still-`issued` invoice).
      getInvoiceForPayment: vi.fn(async () =>
        ok({
          id: seed.invoiceId,
          status: 'void' as const,
          totalSatang: 5_350_000n,
          memberId,
          tenantId: tenant.ctx.slug,
        }),
      ),
      markPaidFromProcessor: vi.fn(async () => ok(undefined)),
    };
    const result = await runInTenant(tenant.ctx, async () =>
      confirmPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => SETTINGS_STUB(tenant.ctx.slug),
            findByProcessorAccountId: async () => null,
          },
          processorGateway:
            processorGateway as unknown as Parameters<typeof confirmPayment>[0]['processorGateway'],
          invoicingBridge:
            invoicingBridge as unknown as Parameters<typeof confirmPayment>[0]['invoicingBridge'],
          audit: f5AuditAdapter,
          clock: systemClock,
          taxAtPayment: 'off',
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          correlationId: 'corr-gmiss-test',
          requestId: 'req-gmiss-confirm',
          eventCreatedAtUnixSeconds: Math.floor(Date.now() / 1000),
        },
      ),
    );
    return { result, processorGateway, invoicingBridge };
  }

  /**
   * A.11 driver — dispatch a `charge.refund.updated` reconciliation for the
   * auto-refund's own `re_…` id against the LIVE repos. The auto-refund
   * NOT-FOUND path never touches the invoicing bridge (never-called stub);
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
        requestId: 'req-gmiss-refund-updated',
        eventId: `evt_test_${randomUUID().slice(0, 12)}`,
        processorRefundId,
        chargeId: seed.chargeId,
        refundStatus,
        amountSatang: asSatang(5_350_000n),
        processorEnv: 'test',
      },
    );
  }

  it('failed row + non-payable invoice → Step-3 auto-refund stamps the marker on the still-failed row → later charge.refund.updated is auto_refund_recognized (NOT out_of_band)', async () => {
    // Replay the resume-race precondition: pending → payment_intent.payment_failed
    // → row is `failed`.
    const failResult = await runFailPayment();
    expect(failResult.ok).toBe(true);
    const beforeRow = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)));
    expect(beforeRow[0]?.status).toBe('failed');

    // Late payment_intent.succeeded on a NON-payable (void) invoice → Step-3
    // stale-invoice auto-refund.
    const { result, processorGateway, invoicingBridge } = await runConfirmPayment();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // Step-3 uses the `auto-refund-` idempotency namespace (NOT the Step-4
    // `late-charge-refund-` one), proving the flow reached the stale path.
    expect(processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auto-refund-${seed.paymentId}`,
      }),
    );
    // Never flip a non-payable invoice to paid.
    expect(invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // THE FIX: the still-`failed` row now carries the durable `re_…` marker
    // (stamped via attachAutoRefundMarkerOnFailed — markAutoRefunded's
    // status='pending' guard could never match). Row STAYS `failed` (F-9).
    const afterRow = await db
      .select({
        status: payments.status,
        autoRefundProcessorRefundId: payments.autoRefundProcessorRefundId,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)));
    expect(afterRow[0]?.status).toBe('failed');
    expect(afterRow[0]?.autoRefundProcessorRefundId).toBe(seed.refundId);

    // The forensic money-trail audit still fires with the `re_…` id.
    const forensic = await db.execute(sql`
      SELECT payload FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'payment_auto_refunded_stale_invoice'
         AND payload->>'invoice_id' = ${seed.invoiceId}
    `);
    const forensicRows = Array.from(
      forensic as unknown as Iterable<{ payload: Record<string, unknown> }>,
    );
    expect(forensicRows.length).toBeGreaterThanOrEqual(1);
    expect(forensicRows[0]!.payload['processor_refund_id']).toBe(seed.refundId);

    // tax#4 — NO `refunds` aggregate row (payment-level reversal, no F4 CN).
    const refundRows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenant.ctx.slug), eq(refunds.invoiceId, seed.invoiceId)));
    expect(refundRows.length).toBe(0);

    // END-TO-END: the auto-refund's own later charge.refund.updated(succeeded)
    // is RECOGNISED via the marker on the FAILED row → auto_refund_recognized,
    // NO false out_of_band_refund_detected. (RED pre-fix: marker NULL → the
    // reconcile resolves out_of_band.)
    const rr = await runProcessRefundUpdated(seed.refundId, 'succeeded');
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    expect(rr.value.kind).toBe('auto_refund_recognized');
    if (rr.value.kind !== 'auto_refund_recognized') return;
    expect(rr.value.invoiceId).toBe(seed.invoiceId);

    const oobRows = await db.execute(sql`
      SELECT id FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'out_of_band_refund_detected'
         AND payload->>'processor_refund_id' = ${seed.refundId}
    `);
    expect(Array.from(oobRows as unknown as Iterable<unknown>).length).toBe(0);
  }, 60_000);
});
