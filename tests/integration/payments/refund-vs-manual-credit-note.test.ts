/**
 * B.1 (#4) — refund pre-flight vs a pre-existing F4 credit note (live Neon).
 *
 * Bug #4: today the refund pre-flight only caps against the PAYMENT side
 * (`payment.amount − Σ F5 succeeded refunds`). It ignores F4 credit notes
 * already issued against the invoice. So on a 107,000-satang invoice/payment
 * with a manual F4 credit note of 53,500 already booked (invoice.credited_total
 * = 53,500), an F5 refund of 60,000 clears the payment cap (60,000 ≤ 107,000),
 * Stripe moves the money, then F4 REJECTS the over-credit credit note → an
 * orphaned Stripe refund with no CN.
 *
 * The fix caps the refundable at
 *   remaining = min(
 *     payment.amount − Σ F5 succeeded refunds,   // 107,000
 *     invoice.total − invoice.creditedTotal,      // 107,000 − 53,500 = 53,500
 *   ) = 53,500
 * and REJECTS the 60,000 refund with `refund_exceeds_remaining` BEFORE any
 * Stripe `createRefund` call. A 53,500 refund (== the invoice headroom) is
 * still allowed.
 *
 * Mocking policy: live Postgres for paymentsRepo + refundsRepo + audit +
 * the F4 invoice read (the REAL `invoicingBridge.getInvoiceCreditedTotal`
 * reads the seeded invoice's authoritative `credited_total_satang`), so the
 * pre-flight math runs against real DB state. `processorGateway.createRefund`
 * is a spy (asserted NEVER called on the reject path) and
 * `issueCreditNoteFromRefund` is stubbed (the allow path stops at a `pending`
 * Stripe refund — the full succeeded → CN chain is covered by
 * refund-multi-partial.test.ts).
 *
 * Run in isolation to avoid shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/payments/refund-vs-manual-credit-note.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { issueRefund } from '@/modules/payments';
import { ok } from '@/lib/result';
import type { IssueRefundDeps } from '@/modules/payments';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
// The REAL bridge — its `getInvoiceCreditedTotal` reads the live invoice's
// F4-authoritative credited_total via F4's tenant-scoped `getInvoice`.
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

// THB 1,070.00 invoice/payment; a manual F4 CN already credited THB 535.00.
const TOTAL_SATANG = 107_000n;
const SUBTOTAL_SATANG = 100_000n;
const VAT_SATANG = 7_000n;
const MANUAL_CN_CREDITED = 53_500n; // invoice.credited_total after the manual CN
const HEADROOM = TOTAL_SATANG - MANUAL_CN_CREDITED; // 53,500
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
  legal_name: 'Refund-vs-CN Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Deps: real paymentsRepo + refundsRepo + audit + REAL
 * `getInvoiceCreditedTotal` (reads the seeded invoice). `createRefund` is a
 * fresh spy per call so each test asserts its own invocation count. The
 * `stripeRefundStatus` param controls the allow-path Stripe response.
 */
function buildDeps(
  tenantId: string,
  stripeRefundStatus: 'succeeded' | 'pending' = 'pending',
): IssueRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    // Inline stub — the real settings repo wraps reads in Next.js
    // `unstable_cache` which throws outside a request context.
    tenantSettingsRepo: {
      async getByTenantId() {
        return {
          tenantId,
          processor: 'stripe' as const,
          processorEnvironment: 'test' as const,
          processorAccountId: `acct_test_${tenantId.slice(-8)}`,
          processorPublishableKey: `pk_test_${tenantId.slice(-8)}`,
          enabledMethods: ['card', 'promptpay'] as const,
          onlinePaymentEnabled: true,
          autoEmailOnPayment: true,
          promptpayQrExpirySeconds: 900,
          allowAnonymousPaylink: false,
        };
      },
      async findByProcessorAccountId() {
        return null;
      },
    } as unknown as IssueRefundDeps['tenantSettingsRepo'],
    processorGateway: {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      // Spy — the reject path MUST never reach this (money never moves).
      createRefund: vi.fn(async () =>
        ok({
          id: `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          status: stripeRefundStatus,
          amountSatang: asSatang(0n),
        }),
      ),
      retrieveRefund: vi.fn(),
    } as unknown as IssueRefundDeps['processorGateway'],
    invoicingBridge: {
      getInvoiceForPayment: vi.fn(),
      markPaidFromProcessor: vi.fn(),
      // REAL read of the invoice's F4-authoritative credited_total + total.
      getInvoiceCreditedTotal: realBridge.getInvoiceCreditedTotal.bind(realBridge),
      // Stubbed — the allow path stops at a `pending` Stripe refund so no CN
      // is booked (the succeeded → CN chain is covered by refund-multi-partial).
      issueCreditNoteFromRefund: vi.fn(async () =>
        ok({ creditNoteId: randomUUID(), creditNoteNumber: 'TC-2026-000999' }),
      ),
    } as unknown as IssueRefundDeps['invoicingBridge'],
    audit: f5AuditAdapter,
    clock: systemClock,
    generateRefundId: () => `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
    idempotencyKeyFactory: (k) => k,
  };
}

describe('issueRefund pre-flight caps at F4 credited_total (#4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: string;
  let paymentId: PaymentId;
  const planId = 'rfnd-cn-plan';

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
        planName: { en: 'Refund vs CN Plan' },
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
        companyName: 'Refund-vs-CN Co',
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

      // A `partially_credited` membership invoice: a manual F4 credit note has
      // already booked 53,500 of the 107,000 total (invoice.credited_total =
      // 53,500). All non-draft snapshot columns satisfy the CHECK constraints.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: FISCAL_YEAR,
        planId,
        status: 'partially_credited',
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
        creditedTotalSatang: MANUAL_CN_CREDITED,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: 'invoicing/x/2026/seed.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        pdfDocKind: 'invoice',
        // CORRECTED FIXTURE (F-4 / money-remediation Task 7), not a value bent
        // to fit a new guard. `partially_credited` means a credit note was
        // already issued against this invoice; issuing one requires passing
        // `issue-credit-note.ts:491`, which demands
        // `receipt_pdf_status = 'rendered'`. So the pre-fix row — NULL — was a
        // state F4 itself could not have produced.
        //
        // The DB CHECK does not catch it: `invoices_paid_has_receipt_status`
        // (migration 0056) constrains only `status = 'paid'` and deliberately
        // leaves the credited statuses free to be NULL.
        //
        // Production confirms the correction rather than the fixture: all 70
        // paid invoices carry 'rendered', and zero rows exist in any credited
        // status (no credit note has ever been issued in prod), so there is no
        // legacy NULL population this fixture could have been representing.
        receiptPdfStatus: 'rendered',
      });

      // The REAL F4 credit-note row backing the invoice's credited_total. A
      // manual CN (no source_refund_id): net 50,000 + VAT 3,500 = 53,500.
      await tx.execute(sql`
        INSERT INTO credit_notes (
          tenant_id, credit_note_id, original_invoice_id,
          fiscal_year, sequence_number, document_number,
          issue_date, issued_by_user_id, reason,
          credit_amount_satang, vat_satang, total_satang,
          tenant_identity_snapshot, member_identity_snapshot,
          pdf_blob_key, pdf_sha256, pdf_template_version,
          created_at, updated_at
        ) VALUES (
          ${tenant.ctx.slug}, ${randomUUID()}, ${invoiceId},
          ${FISCAL_YEAR}, 1, 'TC-2026-000001',
          '2026-04-20', ${user.userId}, 'manual partial credit note',
          50000, 3500, ${MANUAL_CN_CREDITED.toString()},
          '{}'::jsonb, '{}'::jsonb,
          'placeholder', ${'b'.repeat(64)}, 1,
          NOW(), NOW()
        )
      `);

      // A succeeded F5 payment covering the whole invoice (one PI per invoice).
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
        correlationId: 'corr-pay-rfnd-cn',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  async function countRefunds(): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM refunds
        WHERE tenant_id = ${tenant.ctx.slug} AND payment_id = ${paymentId}
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  it('rejects a 60,000 refund that clears the payment cap but exceeds F4 headroom — createRefund NEVER called', async () => {
    const deps = buildDeps(tenant.ctx.slug);

    // 60,000 ≤ payment remaining (107,000) so the payment-only cap would PASS
    // it (the pre-B.1 bug) — but 60,000 > invoice headroom (53,500), so the
    // fix rejects it BEFORE Stripe.
    const r = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(60_000n),
      reason: 'over the F4 credit headroom',
      actorUserId: user.userId,
      correlationId: 'corr-reject',
      requestId: 'req-reject',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('refund_exceeds_remaining');
      if (r.error.code === 'refund_exceeds_remaining') {
        expect(r.error.requestedSatang).toBe(60_000n);
        // The surfaced cap is the invoice-credit headroom (the binding bound).
        expect(r.error.remainingSatang).toBe(HEADROOM); // 53,500
      }
    }

    // The core money-safety assertion: Stripe was NEVER asked to move money,
    // so no refund can orphan without a credit note.
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
    // Pre-flight rejection wrote no refund row (AS6: no state change).
    expect(await countRefunds()).toBe(0);
  }, 60_000);

  it('allows a 53,500 refund that exactly equals the F4 headroom — createRefund IS called', async () => {
    // A `pending` Stripe status keeps this at the pre-CN boundary: it proves
    // the pre-flight ALLOWED the refund (createRefund invoked) without needing
    // the full succeeded → F4 CN chain (covered by refund-multi-partial).
    const deps = buildDeps(tenant.ctx.slug, 'pending');

    const r = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId,
      amountSatang: asSatang(HEADROOM), // 53,500
      reason: 'exactly at the F4 headroom',
      actorUserId: user.userId,
      correlationId: 'corr-allow',
      requestId: 'req-allow',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      // Pending Stripe refund → kind:'pending' (awaits the async webhook).
      expect(r.value.kind).toBe('pending');
    }
    // The pre-flight let it through → Stripe was asked to move the money.
    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(await countRefunds()).toBe(1);
  }, 60_000);
});
