/**
 * F-3 (money-remediation Task 6) — a Stripe-settled refund whose F4
 * credit-note bridge declines must NOT become retryable (live Neon).
 *
 * ## The bug this pins closed
 *
 * Payment THB 535.00. Admin refunds THB 200.00 (PARTIAL — that matters).
 *
 *   1. Stripe `createRefund` returns `succeeded`. The money is gone.
 *   2. The F4 credit-note bridge declines (PDF render, Blob upload, F4 state,
 *      whatever — all return `err`, none throw).
 *   3. OLD behaviour: the row was flipped to `failed` and the route returned
 *      502 `f4_bridge_error` ("Credit-note issuance failed"), which reads as
 *      retryable. The admin clicks refund again, and every guard that should
 *      have stopped it is blind:
 *        - `pendingCount`  FILTERs on status='pending'   → a `failed` row: 0
 *        - `succeededSum`  FILTERs on status='succeeded' → settled money: 0
 *        - `nextSeq`       is COUNT(*) — status-blind    → key ROTATES
 *      so Stripe sees a brand-new idempotency key, the charge-level cap still
 *      has headroom on a PARTIAL refund, and THB 200.00 goes out a second
 *      time — against a single THB 200.00 §86/10 credit note.
 *   4. NEW behaviour: the row stays `pending` with its `processor_refund_id`,
 *      the route returns a distinct non-retryable-sounding code, and the
 *      second attempt is refused by the pending-refund guard.
 *
 * ## Why this test has to be live-Neon
 *
 * The interlock that stops attempt #2 is a real committed row observed by a
 * second `getRefundContextForUpdate` under the payment's FOR UPDATE lock. A
 * unit test with a stubbed repo asserts that the use-case ASKED; only a real
 * transaction proves the row is actually there to be found.
 *
 * Mocking policy: live Postgres for paymentsRepo + refundsRepo + audit + the
 * REAL `getInvoiceCreditedTotal`. Only `createRefund` (spy: counts calls and
 * records the literal idempotency keys) and `issueCreditNoteFromRefund`
 * (declines on the FIRST call only) are stubbed.
 *
 * Run in isolation to avoid shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/payments/refund-f4-decline-no-double-refund.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { issueRefund } from '@/modules/payments';
import { err, ok } from '@/lib/result';
import type { IssueRefundDeps } from '@/modules/payments';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
import { invoicingBridge as realBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { payments, tenantPaymentSettings } from '@/modules/payments/infrastructure/schema';
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

// THB 535.00 invoice + payment, nothing credited yet.
const TOTAL_SATANG = 53_500n;
const SUBTOTAL_SATANG = 50_000n;
const VAT_SATANG = 3_500n;
// PARTIAL refund — the charge-level cap still has headroom afterwards, which
// is exactly why Stripe would accept a second request under a rotated key.
// A FULL refund would be caught by Stripe's own `charge_already_refunded`;
// that asymmetry is what made this finding HIGH.
const REFUND_SATANG = 20_000n;
const FISCAL_YEAR = 2026;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'F-3 Decline Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

const STRIPE_REFUND_ID = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

interface Spies {
  readonly createRefund: ReturnType<typeof vi.fn>;
  readonly issueCn: ReturnType<typeof vi.fn>;
  readonly idempotencyKeys: string[];
}

function buildDeps(tenantId: string, spies: Spies): IssueRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    tenantSettingsRepo: {
      getByTenantId: async () => ({
        tenantId,
        processor: 'stripe' as const,
        processorEnvironment: 'test' as const,
        processorAccountId: `acct_test_${tenantId.slice(-8)}`,
        processorPublishableKey: `pk_test_${tenantId.slice(-8)}`,
        enabledMethods: ['card', 'promptpay'] as readonly ('card' | 'promptpay')[],
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
      }),
    } as unknown as IssueRefundDeps['tenantSettingsRepo'],
    processorGateway: {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      createRefund: spies.createRefund,
      retrieveRefund: vi.fn(),
    } as unknown as IssueRefundDeps['processorGateway'],
    invoicingBridge: {
      getInvoiceForPayment: vi.fn(),
      markPaidFromProcessor: vi.fn(),
      // REAL read of the invoice's F4-authoritative credited_total + total.
      getInvoiceCreditedTotal: realBridge.getInvoiceCreditedTotal.bind(realBridge),
      getInvoiceStatus: realBridge.getInvoiceStatus.bind(realBridge),
      issueCreditNoteFromRefund: spies.issueCn,
    } as unknown as IssueRefundDeps['invoicingBridge'],
    audit: f5AuditAdapter,
    clock: systemClock,
    generateRefundId: () => `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
    idempotencyKeyFactory: (k) => k,
  };
}

describe('F-3 — F4 decline after a settled Stripe refund does not enable a double refund', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: string;
  let paymentId: PaymentId;
  const planId = 'f3-decline-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const memberId = randomUUID();
    invoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values({
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
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: FISCAL_YEAR,
        planName: { en: 'F-3 Decline Plan' },
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
        companyName: 'F-3 Decline Co',
        country: 'TH',
        planId,
        planYear: FISCAL_YEAR,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
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
        fiscalYear: FISCAL_YEAR,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: FISCAL_YEAR,
        planId,
        status: 'paid',
        draftByUserId: user.userId,
        fiscalYear: FISCAL_YEAR,
        sequenceNumber: 1,
        documentNumber: 'T-2026-000001',
        issueDate: '2026-04-15',
        dueDate: '2026-05-14',
        subtotalSatang: SUBTOTAL_SATANG,
        vatRateSnapshot: '0.0700',
        vatSatang: VAT_SATANG,
        totalSatang: TOTAL_SATANG,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        // `invoices_paid_has_payment` — a `paid` invoice MUST carry both
        // `paid_at` and `payment_method` (migration 0019).
        paidAt: new Date('2026-04-20T03:00:00.000Z'),
        paymentMethod: 'card',
        paymentDate: '2026-04-20',
        // `invoices_paid_has_receipt_status` (migration 0056) — a `paid`
        // invoice MUST carry a non-null `receipt_pdf_status`. This tenant is
        // combined-mode (receipt IS the invoice), so `rendered` with a NULL
        // `receipt_document_number_raw` is the legal shape per 0061.
        receiptPdfStatus: 'rendered',
        pdfBlobKey: 'invoicing/x/2026/seed.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        pdfDocKind: 'invoice',
      });

      paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
      const now = new Date();
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        method: 'card',
        status: 'succeeded',
        amountSatang: TOTAL_SATANG,
        currency: 'THB',
        processorPaymentIntentId: `pi_test_${randomUUID().slice(0, 8)}`,
        processorChargeId: `ch_test_${randomUUID().slice(0, 8)}`,
        processorEnvironment: 'test',
        attemptSeq: 1,
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 12,
        cardExpYear: 2030,
        initiatedAt: now,
        completedAt: now,
        actorUserId: user.userId,
        correlationId: 'corr-pay-f3',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  async function refundRows(): Promise<
    Array<{ status: string; processor_refund_id: string | null; failure_reason_code: string | null }>
  > {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT status, processor_refund_id, failure_reason_code
        FROM refunds
        WHERE tenant_id = ${tenant.ctx.slug} AND payment_id = ${paymentId}
      `)) as unknown as Array<{
        status: string;
        processor_refund_id: string | null;
        failure_reason_code: string | null;
      }>;
      return rows;
    });
  }

  async function auditCount(eventType: string): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM audit_log
        WHERE tenant_id = ${tenant.ctx.slug} AND event_type = ${eventType}::audit_event_type
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  it('defers on the F4 decline, then REFUSES the retry — createRefund is called exactly once', async () => {
    const idempotencyKeys: string[] = [];
    const spies: Spies = {
      idempotencyKeys,
      // A DISTINCT `re_…` per call, which is what Stripe actually does for a
      // request carrying a new idempotency key. An earlier draft returned a
      // constant id; that let `refunds_processor_refund_id_uniq` blow up on
      // the second attach and mask the assertion that matters. A stub that is
      // kinder than reality can hide the very failure the test is for.
      createRefund: vi.fn(async (input: { idempotencyKey: string }) => {
        idempotencyKeys.push(input.idempotencyKey);
        return ok({
          id:
            idempotencyKeys.length === 1
              ? STRIPE_REFUND_ID
              : `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          status: 'succeeded',
          amountSatang: asSatang(REFUND_SATANG),
        });
      }),
      // Declines on the FIRST call only — so if a second refund ever reached
      // the bridge it would SUCCEED, making a double payout maximally visible
      // rather than masked by a repeated decline.
      issueCn: vi
        .fn()
        .mockResolvedValueOnce(
          err({ code: 'pdf_render_failed', detail: 'renderer unavailable' }),
        )
        .mockResolvedValue(
          ok({ creditNoteId: randomUUID(), creditNoteNumber: 'TC-2026-000999' }),
        ),
    };
    const deps = buildDeps(tenant.ctx.slug, spies);

    const baseInput = {
      tenantId: tenant.ctx.slug,
      paymentId: paymentId as string,
      amountSatang: asSatang(REFUND_SATANG),
      reason: 'F-3 partial refund',
      actorUserId: user.userId,
      correlationId: 'corr-f3-1',
      requestId: 'req-f3-1',
    };

    // Both attempts run BEFORE any assertion, and the money-safety assertion
    // is made FIRST. The ordering is deliberate: an earlier draft asserted the
    // error code up front, so reverting the deferral tripped the COSMETIC
    // assertion and the test never reached attempt #2 — it would have reported
    // a kill without ever exercising the double refund it exists to prevent.
    // Assert the property that matters before the one that is convenient.

    // ---- Attempt #1: Stripe settles, F4 declines -------------------------
    const first = await issueRefund(deps, baseInput);

    // ---- Attempt #2: the admin clicks refund again -----------------------
    // This is the click. Before the fix it produced a second real payout.
    const second = await issueRefund(deps, {
      ...baseInput,
      correlationId: 'corr-f3-2',
      requestId: 'req-f3-2',
    });

    // THE ASSERTION THIS FILE EXISTS FOR: the money moved once.
    expect(spies.createRefund).toHaveBeenCalledTimes(1);

    // Attempt #1 deferred rather than terminalising.
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.error.code).toBe('f4_bridge_deferred');
    if (!first.ok && first.error.code === 'f4_bridge_deferred') {
      expect(first.error.processorRefundId).toBe(STRIPE_REFUND_ID);
    }

    // The row is PENDING and carries the Stripe id — the exact shape the
    // stale-pending sweep can reconcile (retrieve → succeeded → retry the
    // idempotent bridge). NOT `failed`.
    const afterFirst = await refundRows();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.status).toBe('pending');
    expect(afterFirst[0]?.processor_refund_id).toBe(STRIPE_REFUND_ID);
    expect(afterFirst[0]?.failure_reason_code).toBeNull();

    // No audit claiming the refund failed…
    expect(await auditCount('refund_failed')).toBe(0);
    // …and the deferral IS on the record for whoever reconciles output VAT.
    expect(await auditCount('refund_cn_deferred')).toBe(1);

    // Attempt #2 was refused by the pending-row interlock.
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('refund_in_progress');

    // And the key is derived from the refund ROW's own id, not from a
    // status-blind COUNT(*). Asserting the LITERAL string rather than the call
    // count, because the two guards cover different things and it is worth
    // being precise about which one did the work here:
    //
    //   - The pending-row guard is what stopped attempt #2. Two distinct
    //     attempts mint two distinct refund rows, so NO key scheme could have
    //     deduped them at Stripe — under the old scheme they were
    //     `…-1` and `…-2`, under the new one two different ULIDs.
    //   - The stable key covers re-SENDS of the SAME row: a retried external
    //     call, a sweep-driven re-create, a replayed request that reuses the
    //     row. Under `COUNT(*)+1` those rotated too, because the count moved
    //     underneath them — which is what made the key useless for the one job
    //     it existed to do.
    //
    // So this assertion pins the shape, and `toHaveBeenCalledTimes(1)` above
    // pins the interlock. Neither substitutes for the other.
    expect(idempotencyKeys).toHaveLength(1);
    expect(idempotencyKeys[0]).toMatch(/^rfnd-rfnd_[0-9a-f]{26}$/);
    expect(idempotencyKeys[0]).not.toContain(paymentId as string);

    // Attempt #2 was refused BEFORE writing anything — still one row, and no
    // phantom `refund_initiated` from a guard placed below the insert.
    const afterSecond = await refundRows();
    expect(afterSecond).toHaveLength(1);
    expect(await auditCount('refund_initiated')).toBe(1);
  }, 90_000);
});
