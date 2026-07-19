/**
 * PR-A Task A.15 (#8 resume-race) — Integration: reconcile a
 * `failed → succeeded` late captured charge against live Neon.
 *
 * Spec authority: F5 PR-A bug #8 + architect decision F-9.
 *
 * The resume-race bug (#8): payment attempt-1 is `pending`; a retry
 * resumes the SAME PaymentIntent (`findPending` keys only on
 * `status='pending'`); Stripe fires `payment_intent.payment_failed` which
 * commits the row `failed`; THEN a late `payment_intent.succeeded` (a REAL
 * captured charge) arrives. Because `failed` is a terminal state,
 * `confirmPayment` currently drops it as an `already_succeeded` no-op:
 * NO invoice flip, NO auto-refund, NO forensic audit — the invoice is left
 * unpaid even though Stripe captured the money.
 *
 * The fix (Option (i) + F-9): when the locked row is terminal `failed` AND
 * a genuine `payment_intent.succeeded` with a REAL captured charge arrives
 * (confirmed via `retrievePaymentIntent`), `confirmPayment` must:
 *   - NOT silently no-op;
 *   - auto-refund the captured funds (reuse the A.13 Stripe `createRefund`
 *     path; idempotency key `late-charge-refund-${paymentId}`; NO `refunds`
 *     aggregate row; NO F4 credit note — a payment-level reversal);
 *   - emit the forensic `payment_auto_refunded_stale_invoice` audit with
 *     the new `cause = 'payment_terminal_failed_late_charge'`;
 *   - LEAVE the row `failed` (architect F-9: NO `failed → auto_refunded`
 *     edge) while durably stamping `auto_refund_processor_refund_id` on it
 *     (RR-6) so the auto-refund's own later `charge.refund.updated`
 *     webhook is RECOGNISED (A.11) instead of firing a false OOB alert.
 *   - Trigger ONLY on `failed → succeeded`, NEVER on `succeeded → succeeded`
 *     or any other prior state.
 *
 * Mocking policy (mirrors stale-invoice-auto-refund.test.ts): LIVE Neon for
 * repos + audit; MOCKED `processorGateway` (retrieve + createRefund) and
 * `invoicingBridge` (getInvoiceForPayment) at the port boundary.
 *
 * NOTE (RED phase): this file is authored verify-first. On UNFIXED code it
 * asserts the buggy silent no-op (kind='already_succeeded', createRefund
 * NOT called, marker NULL, no forensic audit) to DEMONSTRATE bug #8. After
 * the fix lands the assertions flip to the reconciled behaviour + the
 * RR-6 A.11 recognition hop + the untouched-path regressions.
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
    paymentIntentId: `pi_test_late_${label}_${randomUUID().slice(0, 8)}`,
    refundId: `re_test_late_${label}_${randomUUID().slice(0, 8)}`,
    chargeId: `ch_test_late_${label}_${randomUUID().slice(0, 8)}`,
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

describe('confirmPayment failed→succeeded late-charge reconcile — live Neon (A.15 / #8)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let seed: PaymentSeed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    seed = makeSeed('reconcile');

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
        planId: 'late-plan',
        planYear: 2026,
        planName: { en: 'Late Plan' },
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
        companyName: 'Late Co',
        country: 'TH',
        planId: 'late-plan',
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
      // reaches `failed` via the real code path — a faithful replay of the
      // resume-race precondition.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: seed.invoiceId,
        memberId,
        planYear: 2026,
        planId: 'late-plan',
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
        correlationId: 'corr-late-test',
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
          requestId: 'req-late-fail',
          eventCreatedAtUnixSeconds: Math.floor(Date.now() / 1000),
        },
      ),
    );
  }

  /** Drive the late payment_intent.succeeded (real captured charge). */
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
      // Invoice is STILL payable (`issued`) — the whole point of #8: the
      // invoice was never paid because the payment "failed".
      getInvoiceForPayment: vi.fn(async () =>
        ok({
          id: seed.invoiceId,
          status: 'issued' as const,
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
          // money-remediation Task 4 — flag OFF preserves the pre-remediation
          // commit-on-bridge-decline behaviour this suite was written against.
          settlementAbort: false,
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          correlationId: 'corr-late-test',
          requestId: 'req-late-confirm',
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
        requestId: 'req-late-refund-updated',
        eventId: `evt_test_${randomUUID().slice(0, 12)}`,
        processorRefundId,
        chargeId: seed.chargeId,
        refundStatus,
        amountSatang: asSatang(5_350_000n),
        processorEnv: 'test',
      },
    );
  }

  it('failed→succeeded late charge → auto-refund issued, forensic audit, marker stamped; row stays failed (F-9); invoice NOT left silently unpaid', async () => {
    // Replay the resume-race: pending → payment_intent.payment_failed →
    // row is `failed`.
    const failResult = await runFailPayment();
    expect(failResult.ok).toBe(true);
    const beforeRow = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)));
    expect(beforeRow[0]?.status).toBe('failed');

    // Late payment_intent.succeeded (real captured charge) arrives.
    const { result, processorGateway, invoicingBridge } = await runConfirmPayment();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // The captured funds ARE auto-refunded — distinct idempotency namespace.
    expect(processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `late-charge-refund-${seed.paymentId}`,
        metadata: expect.objectContaining({
          cause: 'payment_terminal_failed_late_charge',
        }),
      }),
    );
    // The invoice is NOT flipped paid.
    expect(invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // F-9: the row STAYS `failed` (NO failed→auto_refunded edge) while the
    // durable `re_…` marker is stamped for RR-6 recognition. completed_at
    // is the fail-step value (unchanged by the marker write).
    const afterRow = await db
      .select({
        status: payments.status,
        completedAt: payments.completedAt,
        autoRefundProcessorRefundId: payments.autoRefundProcessorRefundId,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)));
    expect(afterRow[0]?.status).toBe('failed');
    expect(afterRow[0]?.completedAt).not.toBeNull();
    expect(afterRow[0]?.autoRefundProcessorRefundId).toBe(seed.refundId);

    // The invoice row is NEVER silently flipped `paid` — the member was
    // charged AND refunded, so no money was kept against the invoice. (The
    // F4 bridge is mocked here, so the seeded row keeps its pre-existing
    // non-paid status; `markPaidFromProcessor` was asserted not-called above,
    // which is the behavioural invariant. `not paid` is seed-independent.)
    const invoiceRow = await db.execute(sql`
      SELECT status FROM invoices
       WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${seed.invoiceId}
    `);
    const invoiceStatus = Array.from(
      invoiceRow as unknown as Iterable<{ status: string }>,
    )[0]?.status;
    expect(invoiceStatus).not.toBe('paid');

    // The 10y forensic money-trail landed with the new cause + the `re_…` id.
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
    expect(forensicRows[0]!.payload['cause']).toBe('payment_terminal_failed_late_charge');
    expect(forensicRows[0]!.payload['processor_refund_id']).toBe(seed.refundId);

    // tax#4 — NO `refunds` aggregate row (payment-level reversal, no F4 CN).
    const refundRows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(eq(refunds.tenantId, tenant.ctx.slug), eq(refunds.invoiceId, seed.invoiceId)),
      );
    expect(refundRows.length).toBe(0);

    // RR-6 end-to-end: the auto-refund's own later
    // charge.refund.updated(succeeded) is RECOGNISED via the marker on the
    // FAILED row (findAutoRefundByProcessorRefundId) → NO false OOB alert.
    const rr6 = await runProcessRefundUpdated(seed.refundId, 'succeeded');
    expect(rr6.ok).toBe(true);
    if (!rr6.ok) return;
    expect(rr6.value.kind).toBe('auto_refund_recognized');
    if (rr6.value.kind !== 'auto_refund_recognized') return;
    expect(rr6.value.invoiceId).toBe(seed.invoiceId);

    const oobRows = await db.execute(sql`
      SELECT id FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'out_of_band_refund_detected'
         AND payload->>'processor_refund_id' = ${seed.refundId}
    `);
    expect(Array.from(oobRows as unknown as Iterable<unknown>).length).toBe(0);
  }, 60_000);
});
