/**
 * Guard-miss sub-case (i) — Integration: a stuck-`pending` online payment on a
 * NON-payable invoice is auto-refunded, but a concurrent writer flips the row
 * `pending → succeeded` in the narrow window between Phase A's lock release and
 * the Phase B marker write. The status-agnostic marker-attach MUST still stamp
 * the durable A.13 marker on the now-`succeeded` row so the auto-refund's later
 * `charge.refund.updated` / `charge.refunded` webhook is RECOGNISED
 * (`auto_refund_recognized`) instead of firing a FALSE
 * `out_of_band_refund_detected`.
 *
 * The race (verified reachable): `createRefund` runs OUTSIDE the Phase-A
 * `withTx` (so the 10s Stripe SDK call does not hold the payment-row FOR UPDATE
 * lock) and BEFORE the Phase-B `withTx` that does `markAutoRefunded`. A
 * concurrent admin mark-paid flip / late `payment_intent.succeeded` webhook can
 * therefore terminalise the row to `succeeded` in that window. `markAutoRefunded`
 * guards `status='pending'` → returns `null` on the now-`succeeded` row → the
 * else branch (`payment.status` was `pending` at Phase A, NOT `failed`) reaches
 * the sub-case (i) path.
 *
 * Distinct from `failed-stale-invoice-guard-miss.test.ts` (sub-case ii): there
 * the Phase-A-locked row was ALREADY terminal `failed`; HERE it was `pending`
 * at Phase A and a concurrent writer raced it to `succeeded`.
 *
 * RED (verify-first): on UNFIXED code the else branch is log-only, so the marker
 * column stays NULL and the later `charge.refund.updated(succeeded)` resolves
 * `out_of_band`. After the fix (status-agnostic `attachAutoRefundMarkerIfAbsent`
 * called in the else branch) the marker is stamped on the `succeeded` row and
 * the reconcile resolves `auto_refund_recognized` with NO false OOB.
 *
 * Mocking policy (mirrors stale-invoice-auto-refund.test.ts): LIVE Neon for
 * repos + audit; MOCKED `processorGateway` (retrieve + createRefund) and
 * `invoicingBridge` (getInvoiceForPayment) at the port boundary. The concurrent
 * flip is a real UPDATE committed by a SEPARATE tenant tx from inside the
 * `createRefund` mock (own connection — no lock held at that point in the flow).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { asSatang } from '@/lib/money';
import { confirmPayment } from '@/modules/payments';
import { processRefundUpdated } from '@/modules/payments/application/use-cases/process-refund-updated';
import { processChargeRefunded } from '@/modules/payments/application/use-cases/process-charge-refunded';
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
  /** Deterministic captured charge id the concurrent-succeeded flip writes. */
  readonly chargeId: string;
}

function makeSeed(label: string): PaymentSeed {
  return {
    invoiceId: randomUUID(),
    paymentId: asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`),
    paymentIntentId: `pi_test_cgmiss_${label}_${randomUUID().slice(0, 8)}`,
    refundId: `re_test_cgmiss_${label}_${randomUUID().slice(0, 8)}`,
    chargeId: `ch_test_cgmiss_${label}_${randomUUID().slice(0, 8)}`,
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

describe('confirmPayment pending-row raced to succeeded on non-payable invoice — live Neon (guard-miss i)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let seed: PaymentSeed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    memberId = randomUUID();
    seed = makeSeed('paid');

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
        planId: 'cgmiss-plan',
        planYear: 2026,
        planName: { en: 'Concurrent Guard-Miss Plan' },
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
        companyName: 'Concurrent Guard-Miss Co',
        country: 'TH',
        planId: 'cgmiss-plan',
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
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: seed.invoiceId,
        memberId,
        planYear: 2026,
        planId: 'cgmiss-plan',
        draftByUserId: user.userId,
      });
      // Seed the payment `pending` (a card attempt) — this is the stuck-pending
      // row Phase A locks and observes `pending` before deciding stale.
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
        correlationId: 'corr-cgmiss-test',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /**
   * Drive the late `payment_intent.succeeded` against the NON-payable (paid)
   * invoice → Step-3 stale-invoice auto-refund. The `createRefund` mock injects
   * the concurrent `pending → succeeded` flip (a separate tenant tx) so
   * `markAutoRefunded`'s `status='pending'` guard misses at Phase B.
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
      createRefund: vi.fn(async () => {
        // RACE INJECTION — a concurrent writer (admin mark-paid flip / late
        // payment_intent.succeeded webhook) terminalises the still-`pending`
        // row to `succeeded` in the window between Phase A's lock release and
        // the Phase B markAutoRefunded write. A SEPARATE tenant tx (own
        // connection) commits immediately; no lock is held at this point in the
        // flow (createRefund runs OUTSIDE both withTx blocks).
        await runInTenant(tenant.ctx, async (tx) => {
          await tx
            .update(payments)
            .set({
              status: 'succeeded',
              completedAt: new Date(),
              cardBrand: 'visa',
              cardLast4: '4242',
              cardExpMonth: 12,
              cardExpYear: 2030,
              processorChargeId: seed.chargeId,
            })
            .where(
              and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)),
            );
        });
        return ok({
          id: seed.refundId,
          status: 'succeeded' as const,
          amountSatang: 5_350_000n,
        });
      }),
    };
    const invoicingBridge = {
      // Invoice is NON-payable (`paid`) — routes confirmPayment through the
      // Step-3 stale-invoice auto-refund path with cause=invoice_already_paid
      // (→ payment_auto_refunded_concurrent_manual_mark audit).
      getInvoiceForPayment: vi.fn(async () =>
        ok({
          id: seed.invoiceId,
          status: 'paid' as const,
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
          correlationId: 'corr-cgmiss-test',
          requestId: 'req-cgmiss-confirm',
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
        requestId: 'req-cgmiss-refund-updated',
        eventId: `evt_test_${randomUUID().slice(0, 12)}`,
        processorRefundId,
        chargeId: seed.chargeId,
        refundStatus,
        amountSatang: asSatang(5_350_000n),
        processorEnv: 'test',
      },
    );
  }

  /**
   * Finding-2 driver — dispatch a `charge.refunded` for the auto-refund's own
   * `re_…` id against the LIVE repos. Both webhooks must consult the durable
   * marker and SUPPRESS the false OOB.
   */
  async function runProcessChargeRefunded(processorRefundId: string) {
    return processChargeRefunded(
      {
        paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
        refundsRepo: makeDrizzleRefundsRepo(tenant.ctx.slug),
        processorEventsRepo: makeDrizzleProcessorEventsRepo(),
        audit: f5AuditAdapter,
        clock: systemClock,
      },
      {
        tenantId: tenant.ctx.slug,
        requestId: 'req-cgmiss-charge-refunded',
        eventId: `evt_test_${randomUUID().slice(0, 12)}`,
        chargeId: seed.chargeId,
        refundIds: [processorRefundId],
        amountSatang: 5_350_000n,
        processorEnv: 'test',
      },
    );
  }

  it('pending row raced to succeeded → Step-3 auto-refund stamps the marker on the now-succeeded row → later charge.refund.updated is auto_refund_recognized (NOT out_of_band)', async () => {
    const beforeRow = await db
      .select({ status: payments.status })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)));
    expect(beforeRow[0]?.status).toBe('pending');

    const { result, processorGateway, invoicingBridge } = await runConfirmPayment();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // Step-3 stale path (auto-refund- idempotency namespace) — the refund WAS
    // issued exactly once against the stuck-pending row Phase A observed.
    expect(processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `auto-refund-${seed.paymentId}` }),
    );
    // Never flip a non-payable invoice to paid.
    expect(invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // THE FIX: the concurrent flip won (row is `succeeded`, NOT `auto_refunded`),
    // yet the status-agnostic marker-attach still stamped the durable `re_…` id
    // on the now-`succeeded` row so a later webhook recognises the auto-refund.
    // (RED pre-fix: else branch was log-only → marker column stays NULL.)
    const afterRow = await db
      .select({
        status: payments.status,
        autoRefundProcessorRefundId: payments.autoRefundProcessorRefundId,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.ctx.slug), eq(payments.id, seed.paymentId)));
    expect(afterRow[0]?.status).toBe('succeeded');
    expect(afterRow[0]?.autoRefundProcessorRefundId).toBe(seed.refundId);

    // The `payment_auto_refunded_concurrent_manual_mark` money-trail audit still
    // fires (cause=invoice_already_paid; emitted before the flip-guard branch).
    const concurrentMarkRows = await db.execute(sql`
      SELECT payload FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'payment_auto_refunded_concurrent_manual_mark'
         AND payload->>'invoice_id' = ${seed.invoiceId}
    `);
    const markRows = Array.from(
      concurrentMarkRows as unknown as Iterable<{ payload: Record<string, unknown> }>,
    );
    expect(markRows.length).toBeGreaterThanOrEqual(1);
    expect(markRows[0]!.payload['processor_refund_id']).toBe(seed.refundId);

    // tax#4 — NO `refunds` aggregate row (payment-level reversal, no F4 CN).
    const refundRows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenant.ctx.slug), eq(refunds.invoiceId, seed.invoiceId)));
    expect(refundRows.length).toBe(0);

    // END-TO-END: the auto-refund's own later charge.refund.updated(succeeded)
    // is RECOGNISED via the marker on the SUCCEEDED row → auto_refund_recognized,
    // NO false out_of_band_refund_detected. (RED pre-fix: marker NULL → out_of_band.)
    const rr = await runProcessRefundUpdated(seed.refundId, 'succeeded');
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    expect(rr.value.kind).toBe('auto_refund_recognized');
    if (rr.value.kind !== 'auto_refund_recognized') return;
    expect(rr.value.invoiceId).toBe(seed.invoiceId);

    // Finding-2 — Stripe ALSO delivers charge.refunded for the same `re_…` id;
    // that handler must consult the same marker and SUPPRESS the false OOB too.
    const cr = await runProcessChargeRefunded(seed.refundId);
    expect(cr.ok).toBe(true);

    const oobRows = await db.execute(sql`
      SELECT id FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'out_of_band_refund_detected'
         AND payload->>'processor_refund_id' = ${seed.refundId}
    `);
    expect(Array.from(oobRows as unknown as Iterable<unknown>).length).toBe(0);
  }, 60_000);
});
