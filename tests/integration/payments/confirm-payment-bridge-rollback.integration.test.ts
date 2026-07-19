/**
 * money-remediation Task 4 / finding F-1 — settlement rolls back on a bridge
 * decline. LIVE Neon.
 *
 * ## Why this test can only be an integration test
 *
 * The defect is a property of `runInTenant`: it COMMITS whenever the callback
 * returns, so `return err(...)` out of a settlement transaction persists the
 * writes it is refusing. Every unit double in this repo stubs `withTx` as
 * `fn({})` — a function that neither commits nor rolls back — so a unit test
 * cannot observe the bug OR the fix. It would pass against both.
 *
 * Consequently: **every assertion here reads the DATABASE. None reads the
 * return value.** A `Result` that says `bridge_error` is identical before and
 * after the fix; only the rows differ.
 *
 * ## Why the decline is `pdf_render_failed` specifically
 *
 * `recordPayment` has eight `return err(...)` guards and every one of them
 * sits ABOVE both the `members.registration_fee_paid` flip and
 * `sequenceAllocator.allocateNext`. A decline from any of those would leave
 * nothing behind to roll back, and the assertions below would be VACUOUS —
 * green with or without the fix.
 *
 * Failures AFTER the allocation instead throw `RecordPaymentInternalError`,
 * which `recordPayment`'s outer catch converts into `return err(...)`. That is
 * the only decline shape that reaches the bridge with F4 writes already
 * issued, and it is the shape that burns a §87 number. `pdf_render_failed` is
 * the controllable member of that family — which is why the PDF adapter is
 * both the stub and the trigger.
 *
 * `asyncReceiptPdf` is pinned OFF for the same reason: the integration harness
 * defaults it ON (`integration-setup.ts`), which SKIPS the render entirely and
 * would make the trigger unreachable.
 *
 * ## Why 088 is pinned ON
 *
 * Production runs `FEATURE_088_TAX_AT_PAYMENT=true`. Under the flag the
 * fixture's new-flow bill allocates a real §87 `RC` receipt number at payment
 * time, which is what makes `next_sequence_number` a genuine §87 register
 * assertion rather than a counter that was never touched.
 *
 * ## Fixture shape and why each part is load-bearing
 *
 *   - MEMBERSHIP invoice (not event): only a membership invoice carries a
 *     `registration_fee` line, and that line is what arms the
 *     `registration_fee_paid` flip.
 *   - NEW-FLOW bill (`bill_document_number_raw` set, `document_number` NULL):
 *     under 088 ON this takes the `allocate` arm. A legacy row would take
 *     `reuseInvoiceNumber` and never touch the receipt counter.
 *   - `registration_fee_paid = false` on the member: the flip has somewhere
 *     to go.
 *
 * Mocking policy: LIVE Neon for payments + invoices + members + audit +
 * sequences. REAL `invoicingBridge`, REAL `makeDrizzlePaymentsRepo`, REAL F5
 * audit adapter — so `withTx` is a genuine `runInTenant` and F4 truly shares
 * the transaction. Only the PDF render + Blob adapters are stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { confirmPayment } from '@/modules/payments';
import { systemClock } from '@/modules/payments/application/ports/clock-port';
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
import { invoicingBridge } from '@/modules/payments/infrastructure/invoicing-bridge';
import { makeDrizzlePaymentsRepo } from '@/modules/payments/infrastructure/repos/drizzle-payments-repo';
import {
  payments,
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import { asPaymentId, type PaymentId } from '@/modules/payments/domain/payment';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---------------------------------------------------------------------------
// The ONLY stubbed adapters. `render` THROWS — that throw is the decline
// trigger, not incidental isolation.
// ---------------------------------------------------------------------------

vi.mock(
  '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter',
  () => ({
    reactPdfRenderAdapter: {
      render: vi.fn(async () => {
        throw new Error('forced render failure (money-remediation Task 4)');
      }),
    },
  }),
);

vi.mock(
  '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter',
  () => ({
    vercelBlobAdapter: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      getSignedReadUrl: vi.fn(async () => 'https://blob.test/signed'),
    },
  }),
);

// Pin the two flags the harness would otherwise decide for us:
//   - `asyncReceiptPdf: false` — the harness defaults it TRUE, which skips the
//     render and disarms the trigger above.
//   - `taxAtPayment: 'on'` — production's setting, and what makes the receipt
//     sequence allocation (and therefore the §87 assertion) happen at all.
// Everything else, including the real repos and the mocked adapters the real
// factory reads, passes through untouched.
vi.mock('@/modules/invoicing/application/invoicing-deps', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/invoicing/application/invoicing-deps')>();
  return {
    ...actual,
    makeRecordPaymentDeps: ((
      tenantId: string,
      externalTx?: unknown,
      onPaidCallbacks?: Parameters<typeof actual.makeRecordPaymentDeps>[2],
    ) => ({
      ...actual.makeRecordPaymentDeps(tenantId, externalTx, onPaidCallbacks),
      taxAtPayment: 'on',
      asyncReceiptPdf: false,
    })) as typeof actual.makeRecordPaymentDeps,
  };
});

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

const FISCAL_YEAR = 2026;
/** Deliberately not 1 — a counter that starts at 1 cannot distinguish
 *  "unchanged" from "reset". */
const RECEIPT_SEQ_START = 7;
const PAYMENT_DATE_UNIX = Math.floor(Date.UTC(2026, 4 - 1, 10, 7, 3, 0) / 1000);

interface Seed {
  readonly invoiceId: string;
  readonly memberId: string;
  readonly paymentId: PaymentId;
  readonly paymentIntentId: string;
  readonly chargeId: string;
}

describe('F-1 — settlement transaction rolls back when the F4 bridge declines', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let seed: Seed;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    seed = {
      invoiceId: randomUUID(),
      memberId: randomUUID(),
      paymentId: asPaymentId(
        `pmt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      ),
      paymentIntentId: `pi_test_f1_${randomUUID().slice(0, 8)}`,
      chargeId: `ch_test_f1_${randomUUID().slice(0, 8)}`,
    };

    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };

    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .insert(tenantPaymentSettings)
        .values(settings)
        .onConflictDoNothing({ target: tenantPaymentSettings.tenantId });

      const planId = `f1-plan-${randomUUID().slice(0, 8)}`;
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: FISCAL_YEAR,
        planName: { en: 'F-1 Plan' },
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

      await tx
        .insert(tenantInvoiceSettings)
        .values({
          tenantId: tenant.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 500000n,
          legalNameTh: 'ทดสอบ',
          legalNameEn: 'Test',
          taxId: '0000000000000',
          registeredAddressTh: 'Bangkok',
          registeredAddressEn: 'Bangkok',
          invoiceNumberPrefix: 'F1',
          creditNoteNumberPrefix: 'F1C',
        })
        .onConflictDoNothing({ target: tenantInvoiceSettings.tenantId });

      // The §87 register under test. Starts at a non-1 value so "unchanged"
      // is distinguishable from "recreated".
      await tx
        .insert(tenantDocumentSequences)
        .values({
          tenantId: tenant.ctx.slug,
          documentType: 'receipt',
          fiscalYear: FISCAL_YEAR,
          nextSequenceNumber: RECEIPT_SEQ_START,
        })
        .onConflictDoUpdate({
          target: [
            tenantDocumentSequences.tenantId,
            tenantDocumentSequences.documentType,
            tenantDocumentSequences.fiscalYear,
          ],
          set: { nextSequenceNumber: RECEIPT_SEQ_START },
        });

      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: seed.memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'F-1 Co',
        country: 'TH',
        planId,
        planYear: FISCAL_YEAR,
        // The flip target. If the settlement commits, this becomes true.
        registrationFeePaid: false,
      });

      // NEW-FLOW BILL: non-§87 `SC` bill number, NULL §87 document_number.
      // Under 088 ON this takes the `allocate` arm at payment time.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: seed.invoiceId,
        memberId: seed.memberId,
        planYear: FISCAL_YEAR,
        planId,
        status: 'issued',
        // `invoices_pdf_doc_kind_valid` admits only invoice /
        // receipt_combined / receipt_separate — there is no 'bill' doc kind.
        // A new-flow bill renders as 'invoice' (pinned by
        // bill-to-receipt.integration.test.ts).
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: FISCAL_YEAR,
        // Both NULL: `invoices_non_draft_has_snapshots` admits a new-flow bill
        // only as (bill_document_number_raw NOT NULL AND sequence_number NULL
        // AND document_number NULL) — the §87 identity belongs to the receipt
        // that has not been minted yet.
        sequenceNumber: null,
        documentNumber: null,
        billDocumentNumberRaw: `SC-${FISCAL_YEAR}-${String(
          Math.floor(Math.random() * 1_000_000),
        ).padStart(6, '0')}`,
        issueDate: '2026-04-01',
        dueDate: '2026-05-01',
        subtotalSatang: 1_500_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 105_000n,
        totalSatang: 1_605_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: {
          legal_name_th: 'ทดสอบ',
          legal_name_en: 'Test',
          tax_id: '0000000000000',
          address_th: 'Bangkok',
          address_en: 'Bangkok',
          logo_blob_key: null,
        },
        memberIdentitySnapshot: {
          legal_name: 'F-1 Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'f1@example.com',
        },
        pdfBlobKey: 'invoices/f1-bill.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });

      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId: seed.invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership fee',
        unitPriceSatang: 1_000_000n,
        quantity: '1',
        proRateFactor: null,
        totalSatang: 1_000_000n,
        position: 1,
      });
      // Arms the `members.registration_fee_paid` flip.
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId: seed.invoiceId,
        kind: 'registration_fee',
        descriptionTh: 'ค่าแรกเข้า',
        descriptionEn: 'Registration fee',
        unitPriceSatang: 500_000n,
        quantity: '1',
        proRateFactor: null,
        totalSatang: 500_000n,
        position: 2,
      });

      await tx.insert(payments).values({
        id: seed.paymentId,
        tenantId: tenant.ctx.slug,
        invoiceId: seed.invoiceId,
        memberId: seed.memberId,
        method: 'card',
        status: 'pending',
        amountSatang: 1_605_000n,
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
        correlationId: 'corr-f1',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  const processorGateway = {
    createPaymentIntent: vi.fn(),
    retrievePaymentIntent: vi.fn(async () =>
      ok({
        id: seed.paymentIntentId,
        status: 'succeeded' as const,
        latestChargeId: seed.chargeId,
        livemode: false,
        lastPaymentErrorCode: null,
        card: {
          brand: 'visa' as const,
          last4: '4242',
          expMonth: 12,
          expYear: 2030,
        },
        clientSecret: null,
        promptpayQrSvgUrl: null,
      }),
    ),
    cancelPaymentIntent: vi.fn(),
    createRefund: vi.fn(),
  };

  async function runConfirm() {
    return runInTenant(tenant.ctx, async () =>
      confirmPayment(
        {
          paymentsRepo: makeDrizzlePaymentsRepo(tenant.ctx.slug),
          tenantSettingsRepo: {
            getByTenantId: async () => ({
              tenantId: tenant.ctx.slug,
              processor: 'stripe' as const,
              processorEnvironment: 'test' as const,
              processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
              processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
              enabledMethods: ['card' as const],
              onlinePaymentEnabled: true,
              autoEmailOnPayment: true,
              promptpayQrExpirySeconds: 900,
              allowAnonymousPaylink: false,
            }),
            findByProcessorAccountId: async () => null,
          } as unknown as Parameters<typeof confirmPayment>[0]['tenantSettingsRepo'],
          processorGateway:
            processorGateway as unknown as Parameters<
              typeof confirmPayment
            >[0]['processorGateway'],
          // REAL bridge — F4 genuinely shares this transaction.
          invoicingBridge,
          audit: f5AuditAdapter,
          clock: systemClock,
          taxAtPayment: 'on',
          // The subject of this test.
          settlementAbort: true,
        },
        {
          tenantId: tenant.ctx.slug,
          paymentIntentId: seed.paymentIntentId,
          correlationId: 'corr-f1',
          requestId: 'req-f1',
          eventCreatedAtUnixSeconds: PAYMENT_DATE_UNIX,
        },
      ),
    );
  }

  // ── The single settlement run under test ────────────────────────────────
  //
  // Deliberately ONE run captured into a snapshot, with each concern asserted
  // in its OWN `it()`. A single fat assertion block fails fast on the first
  // expect, which would make the §87 and registration-fee assertions
  // unobservable under mutation — you could not tell whether they were doing
  // work or merely riding on the payments-row assertion ahead of them.
  let seqBefore: number | undefined;
  let seqAfter: number | undefined;
  let paymentAfter: Awaited<ReturnType<typeof readPayment>>;
  let invoiceAfter: Awaited<ReturnType<typeof readInvoice>>;
  let memberAfter: Awaited<ReturnType<typeof readMember>>;
  let succeededRows: Awaited<ReturnType<typeof readAuditRows>>;
  let forensicRows: Awaited<ReturnType<typeof readAuditRows>>;

  beforeAll(async () => {
    seqBefore = await readReceiptSeq();
    await runConfirm();
    paymentAfter = await readPayment();
    invoiceAfter = await readInvoice();
    memberAfter = await readMember();
    seqAfter = await readReceiptSeq();
    succeededRows = await readAuditRows('payment_succeeded');
    forensicRows = await readAuditRows('payment_settlement_rolled_back');
  }, 60_000);

  it('fixture precondition: the receipt counter starts where we seeded it', () => {
    expect(seqBefore).toBe(RECEIPT_SEQ_START);
  });

  // ── Mutation 1 ──────────────────────────────────────────────────────────
  // Revert the bridge-decline exit to `commitTxWithRefusal` (or flip the flag
  // off) and this reddens. If it stays GREEN, the harness is running a mocked
  // `withTx` and every other assertion in this file is theatre.
  it('unwinds the payments row to pending', () => {
    expect(paymentAfter?.status).toBe('pending');
    expect(paymentAfter?.processorChargeId).toBeNull();
    expect(paymentAfter?.completedAt).toBeNull();
  });

  it('leaves no payment_succeeded audit row behind', () => {
    expect(succeededRows.length).toBe(0);
  });

  /**
   * NOT a discriminating assertion — verified GREEN under both mutants, and
   * deliberately kept anyway.
   *
   * `renderAndUploadPdf` runs BEFORE `applyPayment`, so when the render is the
   * thing that fails the invoice row was never updated in the first place.
   * Nothing is rolled back here because nothing was written. It holds under
   * the bug exactly as it holds under the fix.
   *
   * Do not cite it as evidence that the rollback works — that is what the
   * registration-fee and §87-sequence assertions are for (both of which sit
   * BEFORE the render and both of which redden under mutation). This stays as
   * a plain invariant guard: if a future refactor moves `applyPayment` above
   * the render, this becomes discriminating and will start earning its keep.
   */
  it('leaves the F4 invoice issued with no receipt number assigned', () => {
    expect(invoiceAfter?.status).toBe('issued');
    expect(invoiceAfter?.receiptDocumentNumberRaw).toBeNull();
    expect(invoiceAfter?.paidAt ?? null).toBeNull();
  });

  // ── Mutation 2 ──────────────────────────────────────────────────────────
  // An F4-side write issued BEFORE the allocation and the render, and
  // therefore invisible to every payments-row assertion above. Also
  // flag-independent, so it holds on both sides of FEATURE_088.
  it('unwinds the F4 registration-fee flip on the member row', () => {
    expect(
      memberAfter?.registrationFeePaid,
      'a committed flip would silently suppress the registration fee on the ' +
        "member's NEXT invoice — money lost with no error anywhere",
    ).toBe(false);
  });

  // ── Mutation 2b — SHIP GATE ─────────────────────────────────────────────
  // Production runs FEATURE_088_TAX_AT_PAYMENT=true, so this fixture really
  // allocates a §87 RC number before the failure. A committed decline
  // consumes it and leaves a gap in a register Thai RD §87 requires to be
  // gapless — and a consumed number cannot be reclaimed.
  it('does not burn a §87 receipt sequence number', () => {
    expect(seqAfter).toBe(seqBefore);
  });

  // ── The forensic that must OUTLIVE the rollback ─────────────────────────
  it('emits exactly one 10-year settlement-rollback forensic row', () => {
    expect(forensicRows.length).toBe(1);
    expect(forensicRows[0]?.retention_years).toBe(10);
    const payload = forensicRows[0]?.payload ?? null;
    expect(payload?.['bridge_error_code']).toBe('pdf_render_failed');
    expect(
      payload?.['money_captured'],
      'the row must state plainly that Stripe still holds the money',
    ).toBe(true);
    expect(payload?.['payment_id']).toBe(seed.paymentId);
    expect(payload?.['invoice_id']).toBe(seed.invoiceId);
  });


  // ─── Mutation 3: anti-tautology control ────────────────────────────────
  // A test that reddens on everything localises nothing. This perturbs an
  // knob with no bearing on transaction semantics and must stay GREEN.
  //
  // Note the ORIGINAL control (perturbing `expectedCurrentStatus`) was
  // discarded deliberately: this branch adds a real CAS guard on that value,
  // so it stops being an inert knob and becomes a second rollback trigger.
  it('control: perturbing the invoice payment_notes does not change the outcome', async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(invoices)
        .set({ paymentNotes: 'perturbed control text — semantically inert' })
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, seed.invoiceId),
          ),
        );
    });

    const seqBefore = await readReceiptSeq();
    await runConfirm();

    const payment = await readPayment();
    expect(payment?.status).toBe('pending');
    const invoice = await readInvoice();
    expect(invoice?.status).toBe('issued');
    const member = await readMember();
    expect(member?.registrationFeePaid).toBe(false);
    expect(await readReceiptSeq()).toBe(seqBefore);
  }, 60_000);

  // ── helpers ────────────────────────────────────────────────────────────

  async function readPayment() {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, tenant.ctx.slug),
            eq(payments.id, seed.paymentId),
          ),
        );
      return rows[0];
    });
  }

  async function readInvoice() {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, seed.invoiceId),
          ),
        );
      return rows[0];
    });
  }

  async function readMember() {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(members)
        .where(
          and(
            eq(members.tenantId, tenant.ctx.slug),
            eq(members.memberId, seed.memberId),
          ),
        );
      return rows[0];
    });
  }

  async function readReceiptSeq(): Promise<number | undefined> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'receipt'),
            eq(tenantDocumentSequences.fiscalYear, FISCAL_YEAR),
          ),
        );
      return rows[0]?.nextSequenceNumber;
    });
  }

  /**
   * Raw SQL rather than the Drizzle model: `retention_years` was added by
   * migration 0039 and never synced into the `auditLog` table definition, so
   * `select()` silently omits it and every retention assertion would read
   * `undefined` — i.e. pass vacuously under `toBeUndefined`, or fail
   * confusingly under `toBe(10)`. Read the column by name.
   */
  async function readAuditRows(eventType: string): Promise<
    ReadonlyArray<{ retention_years: number; payload: Record<string, unknown> | null }>
  > {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT retention_years, payload
              FROM audit_log
             WHERE tenant_id = ${tenant.ctx.slug}
               AND event_type = ${eventType}::audit_event_type`,
      );
      return rows as unknown as ReadonlyArray<{
        retention_years: number;
        payload: Record<string, unknown> | null;
      }>;
    });
  }
});
