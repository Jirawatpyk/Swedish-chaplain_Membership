/**
 * 8B (money-remediation) — refund TOCTOU: a void that lands in window W
 * (after Phase A commits, before the Phase-B credit note) converts to a clean
 * waived-success, against LIVE NEON.
 *
 * ## The bug
 *
 * `issueRefund` pre-flights the invoice's F4 credit-note verdict UNDER THE
 * PAYMENT LOCK, then commits Phase A, then calls Stripe OUTSIDE any tx, then
 * books the §86/10 credit note in Phase B. `void-invoice` locks the INVOICE
 * row in a DIFFERENT transaction. Nothing serialises the two. A refund that
 * pre-flighted `issue` (invoice still `paid`) can therefore have its invoice
 * VOIDED in the window between the Phase-A commit and the Phase-B credit note:
 *
 *   Phase A (verdict `issue`, no waiver pinned) → COMMIT
 *     → Stripe settles the money            ← window W: a concurrent void commits
 *   Phase B → issueCreditNoteFromRefund → F4 declines (invoice is now void)
 *
 * Pre-fix, that decline DEFERRED: the money is out of Stripe, the row stays
 * `pending` forever (the sweep retrying into the same permanent refusal), and
 * every future refund on the payment is blocked by `ctx.pendingCount > 0`.
 *
 * ## The fix under test
 *
 * On the Phase-B decline the finaliser RE-CONSULTS F4's Domain verdict. A void
 * invoice now answers `waive` (no §86/10 owed — the void already reversed the
 * document), so the refund CONVERTS to a waived-success: the row flips
 * `succeeded` with `credit_note_waived_at` + `credit_note_waiver_reason`, and a
 * 10-year `refund_credit_note_waived` forensic lands.
 *
 * ## Why this MUST be a live-Neon test (not a unit mock)
 *
 * The converted flip writes `credit_note_waived_at` on a row whose reason Phase
 * A pinned NULL (it took the `issue` arm). The DB CHECK
 * `refunds_waived_at_requires_reason` rejects that unless the SAME write also
 * sets `credit_note_waiver_reason`. A fix that converts but forgets to persist
 * the reason aborts the Phase-B tx — the row stays `pending`, the SAME red as
 * an unfixed bug — and a unit mock (no CHECK) cannot see the difference. This
 * test drives the real `refunds` CHECK, so it is the only place that proves the
 * conversion is legal at the storage layer (per feedback_migration_apply_before_commit).
 *
 * Run in isolation to avoid shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/payments/refund-vs-concurrent-void.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { issueRefund } from '@/modules/payments';
import { ok, err } from '@/lib/result';
import type { IssueRefundDeps } from '@/modules/payments';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import { makeDrizzleRefundsRepo } from '@/modules/payments/infrastructure/repos/drizzle-refunds-repo';
// The REAL bridge — the re-check must read the real void state through F4's
// own tenant-scoped `getInvoice`, or this proves nothing about the conversion.
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

const TOTAL_SATANG = 107_000n; // THB 1,070.00
const SUBTOTAL_SATANG = 100_000n;
const VAT_SATANG = 7_000n;
const REFUND_SATANG = 50_000n;
const FISCAL_YEAR = 2026;
const PLAN_ID = 'rfnd-race-plan';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Refund-vs-Concurrent-Void Co',
  tax_id: '1234567890123',
  buyer_is_vat_registrant: true,
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

const raceCase = { invoiceId: '', paymentId: '' as unknown as PaymentId, seq: 1 };

/**
 * Deps: real paymentsRepo + refundsRepo + audit + the REAL bridge re-check.
 * `issueCreditNoteFromRefund` is stubbed to DECLINE (modelling F4 refusing a
 * §86/10 on the now-void invoice — F4's own decline logic is tested
 * elsewhere); `getInvoiceCreditedTotal` is REAL so the Phase-B re-check reads
 * the true void state and returns the `waive` verdict from live Domain.
 * `createRefund` is the injection point for window W.
 */
function buildDeps(
  tenantId: string,
  onStripeRefund: () => Promise<void>,
): IssueRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
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
      // Window W — the void lands HERE: after Phase A committed the pending
      // refund row, before Phase B books the credit note. Then Stripe reports
      // `succeeded`, so issueRefund proceeds into Phase B against a now-void
      // invoice.
      createRefund: vi.fn(async () => {
        await onStripeRefund();
        return ok({
          id: `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          status: 'succeeded' as const,
          amountSatang: asSatang(REFUND_SATANG),
        });
      }),
      retrieveRefund: vi.fn(),
    } as unknown as IssueRefundDeps['processorGateway'],
    invoicingBridge: {
      getInvoiceForPayment: vi.fn(),
      markPaidFromProcessor: vi.fn(),
      // REAL — Phase A reads `issue` (paid+rendered), Phase B re-reads `waive`
      // (now void). This is the whole point of the test.
      getInvoiceCreditedTotal: realBridge.getInvoiceCreditedTotal.bind(realBridge),
      getInvoiceStatus: realBridge.getInvoiceStatus.bind(realBridge),
      // The concurrent void makes F4 refuse the §86/10 (invalid_status). The
      // finaliser catches this err and re-consults the verdict.
      issueCreditNoteFromRefund: vi.fn(async () =>
        err({ code: 'invalid_status', detail: 'void' }),
      ),
    } as unknown as IssueRefundDeps['invoicingBridge'],
    audit: f5AuditAdapter,
    clock: systemClock,
    generateRefundId: () => `rfnd_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
    idempotencyKeyFactory: (k) => k,
  };
}

describe('issueRefund — concurrent void in window W converts to waive (8B)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    raceCase.invoiceId = randomUUID();
    raceCase.paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);

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
        planId: PLAN_ID,
        planYear: FISCAL_YEAR,
        planName: { en: 'Refund vs Concurrent Void Plan' },
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
        companyName: 'Refund-vs-Concurrent-Void Co',
        country: 'TH',
        planId: PLAN_ID,
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

      // A `paid`, `rendered` invoice — F4 answers `issue` at pre-flight (a
      // credit note IS owed + issuable). The void arrives later, in window W.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: raceCase.invoiceId,
        memberId,
        planYear: FISCAL_YEAR,
        planId: PLAN_ID,
        draftByUserId: user.userId,
        fiscalYear: FISCAL_YEAR,
        sequenceNumber: raceCase.seq,
        documentNumber: `T-2026-${String(raceCase.seq).padStart(6, '0')}`,
        issueDate: '2026-04-15',
        dueDate: '2026-05-14',
        subtotalSatang: SUBTOTAL_SATANG,
        vatRateSnapshot: '0.0700',
        vatSatang: VAT_SATANG,
        totalSatang: TOTAL_SATANG,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly' as const,
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/x/2026/seed-${raceCase.seq}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        pdfDocKind: 'invoice' as const,
        status: 'paid',
        receiptPdfStatus: 'rendered',
        paidAt: new Date(),
        paymentMethod: 'card',
        paymentDate: '2026-04-16',
      });

      await tx.insert(payments).values({
        id: raceCase.paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId: raceCase.invoiceId,
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
        initiatedAt: new Date(),
        completedAt: new Date(),
        actorUserId: user.userId,
        correlationId: 'corr-pay-race',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /** Model the concurrent void as a direct DB transition (all void columns per
   *  `invoices_void_has_reason`). Fires from inside `createRefund` = window W. */
  async function voidInvoiceInWindow(): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`
        UPDATE invoices
           SET status = 'void',
               voided_at = now(),
               void_reason = 'member disputed the whole deal',
               voided_by_user_id = ${user.userId}
         WHERE tenant_id = ${tenant.ctx.slug}
           AND invoice_id = ${raceCase.invoiceId}
      `);
    });
  }

  async function readRefund(paymentId: PaymentId): Promise<{
    status: string;
    creditNoteId: string | null;
    waiverReason: string | null;
    waivedAt: Date | null;
  } | null> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT status, credit_note_id, credit_note_waiver_reason, credit_note_waived_at
          FROM refunds
         WHERE tenant_id = ${tenant.ctx.slug} AND payment_id = ${paymentId}
      `)) as unknown as Array<{
        status: string;
        credit_note_id: string | null;
        credit_note_waiver_reason: string | null;
        credit_note_waived_at: Date | null;
      }>;
      const row = rows[0];
      return row
        ? {
            status: row.status,
            creditNoteId: row.credit_note_id,
            waiverReason: row.credit_note_waiver_reason,
            waivedAt: row.credit_note_waived_at,
          }
        : null;
    });
  }

  async function countCreditNotes(invoiceId: string): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM credit_notes
        WHERE tenant_id = ${tenant.ctx.slug} AND original_invoice_id = ${invoiceId}
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  async function countWaiverAudits(paymentId: PaymentId): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM audit_log
        WHERE tenant_id = ${tenant.ctx.slug}
          AND event_type = 'refund_credit_note_waived'
          AND payload->>'payment_id' = ${paymentId}
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  it('void in window W → refund succeeds as a WAIVE (row + reason + forensic persisted, no credit note)', async () => {
    const deps = buildDeps(tenant.ctx.slug, voidInvoiceInWindow);

    const r = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId: raceCase.paymentId,
      amountSatang: asSatang(REFUND_SATANG),
      reason: 'member disputed the whole deal',
      actorUserId: user.userId,
      correlationId: 'corr-race',
      requestId: 'req-race',
    });

    // Money moved exactly once; the refund is a SUCCESS, not a dead-end defer.
    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.refund.creditNote.kind).toBe('waived');
      expect(r.value.invoice.status).toBe('void');
    } else {
      throw new Error(`expected kind=succeeded, got ${r.ok ? r.value.kind : r.error.code}`);
    }

    // THE LIVE-CHECK PROOF — the converted flip stamped BOTH the timestamp AND
    // the reason on a row Phase A pinned NULL. If Change B were missing, the
    // `refunds_waived_at_requires_reason` CHECK would have aborted Phase B and
    // this status would read `pending` (the unfixed red).
    const row = await readRefund(raceCase.paymentId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('succeeded');
    expect(row?.waivedAt).not.toBeNull();
    expect(row?.waiverReason).toBe('invoice_voided');
    expect(row?.creditNoteId).toBeNull();

    // No §86/10 was booked for a voided invoice.
    expect(await countCreditNotes(raceCase.invoiceId)).toBe(0);

    // The 10-year forensic for the accountant's ภ.พ.30 reconciliation.
    expect(await countWaiverAudits(raceCase.paymentId)).toBe(1);
  }, 60_000);
});
