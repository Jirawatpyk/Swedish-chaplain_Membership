/**
 * F-4 (money-remediation Task 7) — refund pre-flight parity with F4's
 * credit-note gates (live Neon).
 *
 * ## The bug
 *
 * `issueRefund`'s Phase-A pre-flight mirrored only ONE of F4's three
 * credit-note gates — the AMOUNT gate (B.1 / #4, `refund_exceeds_remaining`).
 * The bridge loads the whole invoice at `invoicing-bridge.ts` (it has
 * `status` in hand) but returned only `{creditedTotalSatang, totalSatang}`,
 * so the other two axes were unreachable even by accident:
 *
 *   - `invalid_status`          — `issue-credit-note.ts:419`
 *   - `receipt_not_creditable`  — `issue-credit-note.ts:476` (§105)
 *   - `receipt_not_rendered`    — `issue-credit-note.ts:491`
 *
 * Reachable today with no feature flag: pay an invoice by card, void it via
 * `POST /api/invoices/[id]/void` (which accepts `paid` per 088 § F.3 and
 * writes nothing to payments/refunds), then refund. Every Phase-A check
 * passes, **Stripe moves real money**, and only then does F4 decline.
 *
 * ## The fix under test
 *
 * The same single `f4GetInvoice` call now also answers F4's credit-note
 * question, as ONE Domain verdict (`resolveRefundCreditNoteRequirement`)
 * rather than three axes each caller ordered by hand. The verdict is consumed
 * inside Phase A's `withTx` **above** the amount check, the `refunds` insert,
 * and the `refund_initiated` emit. Placement is correctness, not style:
 * `err()` inside `runInTenant` COMMITS, so a guard below the insert would
 * leave a phantom `pending` row plus a false audit trail behind a refusal.
 *
 * ## Track B — the VOID case INVERTED, and that is the point
 *
 * Refusing a refund on a voided invoice was itself a bug. `void-invoice`
 * writes nothing to payments and void is irreversible, so a refusal stranded
 * settled member money behind a gate that could never open. And no §86/10 is
 * owed: the VOID stamp already reversed the document, so there is no live
 * §86/4 for a credit note to reduce.
 *
 * A voided invoice therefore now WAIVES — the money goes back and the waiver
 * is recorded on the refund row. The case below asserts that inversion
 * against live Neon, because the waiver is a persisted tax fact and a mock
 * cannot show that the row and its 10-year forensic actually landed.
 *
 * ## What each assertion is for
 *
 * On the REFUSING cases the money fact is asserted FIRST (`createRefund`
 * never called), before any error-code check — an error-code assertion that
 * fires first kills a mutant before it reaches the path that matters. On the
 * WAIVING case the mirror-image applies: `createRefund` WAS called.
 *
 * The final case is a POSITIVE CONTROL: a `paid` + `rendered` invoice must
 * still be allowed through to Stripe AND still get a real credit note.
 * Without it, an implementation that waived everything would pass every other
 * case in this file.
 *
 * Run in isolation to avoid shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/payments/refund-vs-voided-invoice.test.ts
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
// The REAL bridge — the whole point of this test. A stubbed bridge would
// assert nothing about the F4 gates the guards are supposed to mirror.
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
const REFUND_SATANG = 50_000n; // well inside every amount cap — isolates the new axes
const FISCAL_YEAR = 2026;
const PLAN_ID = 'rfnd-void-plan';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Refund-vs-Void Co',
  tax_id: '1234567890123',
  buyer_is_vat_registrant: true,
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Deps: real paymentsRepo + refundsRepo + audit + the REAL bridge read.
 * ONLY `createRefund` is stubbed — it is the spy that answers the money
 * question ("did Stripe get asked to move funds?").
 */
function buildDeps(tenantId: string): IssueRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    // Inline stub — the real settings repo wraps reads in Next.js
    // `unstable_cache`, which throws outside a request context.
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
      // A `pending` Stripe status keeps the allow path at the pre-CN
      // boundary: it proves the pre-flight ALLOWED the refund without
      // needing the full succeeded → F4 CN chain.
      createRefund: vi.fn(async () =>
        ok({
          id: `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          status: 'pending' as const,
          amountSatang: asSatang(0n),
        }),
      ),
      retrieveRefund: vi.fn(),
    } as unknown as IssueRefundDeps['processorGateway'],
    invoicingBridge: {
      getInvoiceForPayment: vi.fn(),
      markPaidFromProcessor: vi.fn(),
      // REAL — reads the seeded invoice's status / creditability / receipt
      // render state through F4's own tenant-scoped `getInvoice`.
      getInvoiceCreditedTotal: realBridge.getInvoiceCreditedTotal.bind(realBridge),
      getInvoiceStatus: realBridge.getInvoiceStatus.bind(realBridge),
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

describe('issueRefund pre-flight mirrors F4 credit-note gates (F-4)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;

  /** One (invoice, payment) pair per axis under test. */
  const voidCase = { invoiceId: '', paymentId: '' as unknown as PaymentId, seq: 1 };
  const notRenderedCase = { invoiceId: '', paymentId: '' as unknown as PaymentId, seq: 2 };
  const controlCase = { invoiceId: '', paymentId: '' as unknown as PaymentId, seq: 3 };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();

    for (const c of [voidCase, notRenderedCase, controlCase]) {
      c.invoiceId = randomUUID();
      c.paymentId = asPaymentId(`pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`);
    }

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
        planName: { en: 'Refund vs Void Plan' },
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
        companyName: 'Refund-vs-Void Co',
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

      const baseInvoice = (invoiceId: string, seq: number) => ({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: FISCAL_YEAR,
        planId: PLAN_ID,
        draftByUserId: user.userId,
        fiscalYear: FISCAL_YEAR,
        sequenceNumber: seq,
        documentNumber: `T-2026-${String(seq).padStart(6, '0')}`,
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
        pdfBlobKey: `invoicing/x/2026/seed-${seq}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        pdfDocKind: 'invoice' as const,
      });

      // AXIS 1 — a VOIDED invoice. Reachable in production today: the void
      // route accepts a `paid` invoice and writes nothing to payments, so
      // the payment stays `succeeded` and looks fully refundable.
      // `receipt_pdf_status` is 'rendered' so this case isolates the STATUS
      // axis — a NULL here would let the receipt guard take the credit.
      // `invoices_void_has_reason` (migration 0019) requires all three void
      // columns together — the void audit trail is not optional.
      await tx.insert(invoices).values({
        ...baseInvoice(voidCase.invoiceId, voidCase.seq),
        status: 'void',
        receiptPdfStatus: 'rendered',
        voidedAt: new Date(),
        voidReason: 'member disputed the whole deal',
        voidedByUserId: user.userId,
      });

      // AXIS 2 — paid, but the async receipt PDF has not materialised. F4
      // refuses to hang a §86/10 credit note off an unrendered §86/4 receipt
      // (`issue-credit-note.ts:491`).
      // `invoices_paid_has_payment` (migration 0019) requires paid_at +
      // payment_method on every `paid` row.
      const paidColumns = {
        status: 'paid' as const,
        paidAt: new Date(),
        paymentMethod: 'card' as const,
        paymentDate: '2026-04-16',
      };
      await tx.insert(invoices).values({
        ...baseInvoice(notRenderedCase.invoiceId, notRenderedCase.seq),
        ...paidColumns,
        receiptPdfStatus: 'pending',
      });

      // CONTROL — an ordinary refundable invoice. Must stay ALLOWED.
      await tx.insert(invoices).values({
        ...baseInvoice(controlCase.invoiceId, controlCase.seq),
        ...paidColumns,
        receiptPdfStatus: 'rendered',
      });

      const now = new Date();
      for (const c of [voidCase, notRenderedCase, controlCase]) {
        await tx.insert(payments).values({
          id: c.paymentId,
          tenantId: tenant.ctx.slug,
          invoiceId: c.invoiceId,
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
          correlationId: `corr-pay-${c.seq}`,
        });
      }
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  async function countRefunds(paymentId: PaymentId): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM refunds
        WHERE tenant_id = ${tenant.ctx.slug} AND payment_id = ${paymentId}
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  /**
   * `refund_initiated` is emitted INSIDE Phase A's tx, after the insert. A
   * guard placed below either would commit both behind a refusal (`err()`
   * inside `runInTenant` commits) — so its absence is the assertion that
   * pins guard PLACEMENT, not merely guard existence.
   */
  async function countRefundInitiatedAudits(paymentId: PaymentId): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM audit_log
        WHERE tenant_id = ${tenant.ctx.slug}
          AND event_type = 'refund_initiated'
          AND payload->>'payment_id' = ${paymentId}
      `)) as unknown as Array<{ c: number | string }>;
      return Number(rows[0]?.c ?? 0);
    });
  }

  /** The refund row's tax documentation, read back from live Neon. */
  async function readRefundDocumentation(paymentId: PaymentId): Promise<{
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

  it('WAIVES on a VOIDED invoice — money goes back, waiver persisted, no credit note', async () => {
    const deps = buildDeps(tenant.ctx.slug);

    const r = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId: voidCase.paymentId,
      amountSatang: asSatang(REFUND_SATANG),
      reason: 'member disputed the whole deal',
      actorUserId: user.userId,
      correlationId: 'corr-void',
      requestId: 'req-void',
    });

    // MONEY FIRST — inverted from the pre-Track-B expectation, and this is the
    // whole finding: void is irreversible and writes nothing to payments, so
    // refusing here stranded the member's settled money permanently.
    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(await countRefunds(voidCase.paymentId)).toBe(1);

    // This file's Stripe stub returns `pending` on purpose (see `buildDeps`),
    // which makes the row a precise probe of the INTENT/OUTCOME split that the
    // 0268 CHECK design turns on:
    //
    //   `credit_note_waiver_reason` — the DECISION, written in Phase A, present
    //                                 the moment the row exists.
    //   `credit_note_waived_at`     — the OUTCOME, stamped only on the
    //                                 succeeded flip. Still NULL here.
    //
    // A completeness CHECK keyed on the reason would reject exactly this row —
    // after Stripe had already been called. That is why it keys on the
    // timestamp, and this is the live-Postgres proof the row is legal.
    const doc = await readRefundDocumentation(voidCase.paymentId);
    expect(doc).not.toBeNull();
    expect(doc?.status).toBe('pending');
    expect(doc?.creditNoteId).toBeNull();
    expect(doc?.waiverReason).toBe('invoice_voided');
    expect(doc?.waivedAt).toBeNull();

    // 10-year forensic, emitted at INTENT — so the decision is on record even
    // for a refund that never settles. Without a row here the accountant's
    // month-close discovery query returns nothing and the waiver is invisible.
    expect(await countWaiverAudits(voidCase.paymentId)).toBe(1);
  }, 60_000);

  it('refuses a refund whose receipt PDF has not rendered — money never moves, no row, no audit', async () => {
    const deps = buildDeps(tenant.ctx.slug);

    const r = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId: notRenderedCase.paymentId,
      amountSatang: asSatang(REFUND_SATANG),
      reason: 'refund before the receipt materialised',
      actorUserId: user.userId,
      correlationId: 'corr-notrendered',
      requestId: 'req-notrendered',
    });

    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
    expect(await countRefunds(notRenderedCase.paymentId)).toBe(0);
    expect(await countRefundInitiatedAudits(notRenderedCase.paymentId)).toBe(0);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Track B — every block now travels under ONE code carrying the Domain
      // reason; the ROUTE fans the reason out to the operator-facing codes
      // (`f4_preflight_receipt_rendering` here). Asserting the reason AND its
      // retryability is what pins the "wait" copy as honest: `transient` is the
      // only classification for which telling an admin to wait is true.
      expect(r.error.code).toBe('f4_preflight_credit_note_blocked');
      if (r.error.code === 'f4_preflight_credit_note_blocked') {
        expect(r.error.reason).toEqual({
          code: 'receipt_render_pending',
          retryability: 'transient',
        });
      }
    }
  }, 60_000);

  it('POSITIVE CONTROL: still allows a refund on a paid, rendered invoice', async () => {
    const deps = buildDeps(tenant.ctx.slug);

    const r = await issueRefund(deps, {
      tenantId: tenant.ctx.slug,
      paymentId: controlCase.paymentId,
      amountSatang: asSatang(REFUND_SATANG),
      reason: 'ordinary partial refund',
      actorUserId: user.userId,
      correlationId: 'corr-control',
      requestId: 'req-control',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('pending');
    }
    // The guards did NOT over-reject: Stripe was asked to move the money and
    // the pending row + its audit row exist.
    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(await countRefunds(controlCase.paymentId)).toBe(1);
    expect(await countRefundInitiatedAudits(controlCase.paymentId)).toBe(1);
  }, 60_000);
});
