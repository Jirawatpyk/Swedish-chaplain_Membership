/**
 * tax#2 (F5 payment-bugfixes plan, "Cross-fiscal-year CN numbering") —
 * accountant sign-off pinning test. TEST + DOC ONLY — no production logic
 * change.
 *
 * CHARACTERIZED BEHAVIOUR (read `issue-credit-note.ts` directly, T041
 * `postgresSequenceAllocator`, and `src/lib/fiscal-year.ts` to confirm):
 *
 *   - §87 sequence number + the fiscal-year segment embedded in the credit
 *     note's `document_number` (e.g. `CN-2025-000001`) are allocated against
 *     the PARENT INVOICE's `fiscal_year` column (`issue-credit-note.ts` —
 *     `const fy = loaded.fiscalYear;` — a straight passthrough of the
 *     `invoices.fiscal_year` column set once at invoice-issue time; see
 *     `drizzle-invoice-repo.ts:268`). It is NEVER re-derived from the
 *     current wall-clock date.
 *   - The credit note's OWN `issue_date` is `bangkokLocalDate(now)` where
 *     `now = deps.clock.nowIso()` — the wall-clock instant the CN-issuance
 *     transaction actually runs (for an F5 refund-triggered CN, this is the
 *     REFUND SETTLEMENT instant — see `_finalize-succeeded-refund.ts` Step 1,
 *     which calls `invoicingBridge.issueCreditNoteFromRefund` at the moment
 *     the refund is finalised: admin-initiated success, the
 *     `charge.refund.updated` webhook, or the stale-pending sweep).
 *
 *   Net effect: a refund that is INITIATED while the parent invoice's FY is
 *   still "current" but SETTLES after the fiscal-year boundary produces a
 *   credit note numbered/document-yeared in the INVOICE's FY (continuing
 *   that FY's §87 counter — a stream that may otherwise already be "closed"
 *   from the tenant's point of view) while the PRINTED issue date on the
 *   same document falls in the LATER fiscal year. This matches the plan's
 *   description (`docs/superpowers/plans/2026-07-11-f5-payment-bugfixes.md`
 *   § "Cross-fiscal-year CN numbering (tax#2)") exactly — no discrepancy
 *   found. This is flagged as an ACCOUNTANT SIGN-OFF ITEM (see
 *   `docs/superpowers/specs/2026-06-30-f4-accountant-questions.md` § E2),
 *   NOT fixed here — this suite exists to PIN the current behaviour so a
 *   future refactor cannot silently change it without this test going red.
 *
 * Scenario: SweCham uses a calendar fiscal year (`fiscal_year_start_month`
 * defaults to January — FY == CE year). The parent invoice is issued + paid
 * in FY 2025 (`invoices.fiscal_year = 2025`); a full-refund credit note is
 * then issued with the clock frozen at a 2026 instant (FY 2026 in
 * Asia/Bangkok wall-clock time) — simulating a refund that settles after the
 * fiscal-year boundary. Dates are explicit ISO literals throughout — no
 * `Date.now()` — so the test is deterministic regardless of when it runs.
 *
 * `issueCreditNote` is called DIRECTLY (not via the `issueCreditNoteFromRefund`
 * bridge, which always wires `systemClock` with no override hook) with a
 * `sourceRefundId` set, mirroring the F5-origin CN shape exactly — the same
 * pattern the existing A.7 idempotency suite
 * (`credit-note-from-refund-idempotent.test.ts`) already uses to drive a
 * racer through `issueCreditNote` directly.
 *
 * Uses live Neon Singapore. PDF render + Blob upload + outbox are
 * module-mocked (deterministic stubs) so the SYSTEM UNDER TEST is the DB
 * persistence + §87 sequence allocator + fiscal-year wiring, not the
 * external PDF/Blob/email round-trip. Run this file in isolation to avoid
 * shared-Neon concurrent-suite flake:
 *   pnpm test:integration tests/integration/invoicing/credit-note-cross-fiscal-year.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// --- Module-level mocks of external adapters --------------------------------
// Mirrors `credit-note-from-refund-idempotent.test.ts` — the DB side (invoice
// repo, credit-note repo, sequence allocator, audit adapter) stays real so
// the fiscal-year wiring is genuinely exercised against live Neon.
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // '%PDF'
        sha256: S.ofUnsafe('c'.repeat(64)),
      })),
    },
  };
});
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: {
    enqueue: vi.fn(async () => {}),
  },
}));

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { makeIssueCreditNoteDeps } from '@/modules/invoicing/application/invoicing-deps';

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

// The parent invoice's fiscal year — set ONCE at invoice-issue time and
// never re-derived. FY 2025 = calendar year 2025 (SweCham fiscal_year_start_
// month defaults to January).
const INVOICE_FISCAL_YEAR = 2025;
// The clock the CN-issuance transaction observes — frozen at an instant
// whose Asia/Bangkok wall-clock date falls in calendar year 2026 (FY 2026),
// simulating a refund that SETTLES after the invoice's fiscal-year boundary.
// 2026-03-15T10:00:00Z + 7h (Bangkok, no DST) = 2026-03-15 17:00 local —
// safely inside FY 2026 regardless of the UTC->Bangkok day-boundary shift.
const SETTLEMENT_CLOCK_ISO = '2026-03-15T10:00:00.000Z';
const SETTLEMENT_BANGKOK_DATE = '2026-03-15';

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Cross-FY Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Seed a `paid` membership invoice in FY 2025 + a real Payment + a `pending`
 * Refund initiated in FY 2025 (Dec 2025 — "refund started FY N" per the
 * plan's scenario). Settlement (the actual `issueCreditNote` call, below,
 * with the frozen 2026 clock) happens separately in the test body — only
 * `deps.clock.nowIso()` at CN-issuance time drives the CN's `issueDate`, not
 * this row's `initiatedAt`.
 */
async function seedFy2025PaidInvoiceWithPendingRefund(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<{ invoiceId: string; memberId: string; refundId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  const paymentId = `pay-${randomUUID()}`;
  const refundId = `rfnd-${randomUUID()}`;

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Cross-FY Test Co',
      country: 'TH',
      planId,
      planYear: INVOICE_FISCAL_YEAR,
    });

    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: INVOICE_FISCAL_YEAR,
      planId,
      draftByUserId: user.userId,
      status: 'paid',
      pdfDocKind: 'invoice',
      receiptPdfStatus: 'rendered',
      fiscalYear: INVOICE_FISCAL_YEAR,
      sequenceNumber: 1,
      documentNumber: 'XFY-2025-000001',
      issueDate: '2025-11-15',
      dueDate: '2025-12-15',
      subtotalSatang: INVOICE_SUBTOTAL,
      vatRateSnapshot: '0.0700',
      vatSatang: INVOICE_VAT,
      totalSatang: INVOICE_TOTAL,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: 'invoicing/x/2025/seed.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
      paymentNotes: null,
      paymentRecordedByUserId: user.userId,
      paymentDate: '2025-11-20',
      paidAt: new Date('2025-11-20T03:00:00Z'),
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก 2025',
      descriptionEn: 'Membership 2025',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
    await tx.insert(payments).values({
      id: paymentId,
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      method: 'card',
      status: 'succeeded',
      amountSatang: INVOICE_TOTAL,
      currency: 'THB',
      processorPaymentIntentId: `pi_test_${randomUUID()}`,
      processorChargeId: `ch_test_${randomUUID()}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      cardBrand: 'visa',
      cardLast4: '4242',
      cardExpMonth: 12,
      cardExpYear: 2030,
      initiatedAt: new Date('2025-11-20T03:00:00Z'),
      completedAt: new Date('2025-11-20T03:00:10Z'),
      actorUserId: user.userId,
      correlationId: 'test-corr-payment-xfy',
    });
    // "Refund started FY N" — initiated in Dec 2025, still pending. The FY
    // boundary the plan cares about is crossed by WHEN THE CN IS ISSUED
    // (settlement), driven by the frozen clock in the test body below, not
    // by this row's `initiatedAt`.
    await tx.insert(refunds).values({
      id: refundId,
      tenantId: tenant.ctx.slug,
      paymentId,
      invoiceId,
      amountSatang: asSatang(INVOICE_TOTAL),
      reason: 'Customer requested full refund (cross-FY settlement)',
      status: 'pending',
      initiatedAt: new Date('2025-12-20T03:00:00Z'),
      initiatorUserId: user.userId,
      correlationId: 'test-corr-refund-xfy',
    });
  });

  return { invoiceId, memberId, refundId };
}

/**
 * Read the current `next_sequence_number` for the credit-note allocator
 * stream for a given fiscal year. Absent row = bootstrap value 1 (nothing
 * allocated yet in that FY's stream).
 */
async function readCreditNoteSeqForFy(
  tenant: TestTenant,
  fiscalYear: number,
): Promise<number> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ next: tenantDocumentSequences.nextSequenceNumber })
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'credit_note'),
          eq(tenantDocumentSequences.fiscalYear, fiscalYear),
        ),
      ),
  );
  return rows[0]?.next ?? 1;
}

describe('tax#2 — cross-fiscal-year credit-note numbering (accountant sign-off pin)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'xfy-cn-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: INVOICE_FISCAL_YEAR,
        planName: { en: 'Cross-FY CN Plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: asSatang(0n),
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'XFY',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  // NOTE (review fix, 2026-07-12): this intentionally does NOT clear
  // `tenant_document_sequences`. The single `it` below asserts
  // `seq2025Before === 1` (nothing allocated yet in the FY-2025 credit_note
  // stream) — true today only because this suite has exactly ONE `it` and
  // `tenant` is a fresh UUID-suffixed tenant per test run (see
  // `createTestTenant`, never reused across runs). If a future `it` is added
  // to this file that also allocates a FY-2025 credit note, that
  // precondition breaks (the sequence counter carries over from the prior
  // `it`) — either clear `tenantDocumentSequences` for this tenant here too,
  // or make each new `it` read the CURRENT counter instead of assuming 1.
  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(refunds).where(eq(refunds.tenantId, tenant.ctx.slug));
      await tx.delete(payments).where(eq(payments.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('a refund settling in FY 2026 against an FY-2025 invoice is numbered/document-yeared in FY 2025, but issueDate is the FY-2026 settlement date', async () => {
    const { invoiceId, refundId } = await seedFy2025PaidInvoiceWithPendingRefund(
      tenant,
      user,
      planId,
    );

    const seq2025Before = await readCreditNoteSeqForFy(tenant, INVOICE_FISCAL_YEAR);
    expect(seq2025Before).toBe(1); // nothing allocated yet in the FY-2025 stream

    // Compose the F4 deps exactly as `makeIssueCreditNoteDeps` wires them
    // (real DB repos + sequence allocator + audit; mocked PDF/Blob/outbox),
    // but override `clock` to the frozen 2026 settlement instant — the SAME
    // shape `issueCreditNoteFromRefund` would build, with the ONE seam it
    // does not expose (F4's `systemClock` is not caller-overridable through
    // that bridge). `sourceRefundId` mirrors the F5-origin CN shape exactly.
    const deps = {
      ...makeIssueCreditNoteDeps(tenant.ctx.slug),
      clock: { nowIso: () => SETTLEMENT_CLOCK_ISO },
    };

    const result = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: asSatang(INVOICE_TOTAL),
      reason: 'Full refund settling across the fiscal-year boundary',
      sourceRefundId: refundId,
      // Full credit on a membership invoice requires an explicit intent;
      // F5 refunds always declare 'keep' (F-2, 2026-07-08) — mirrored here.
      membershipEffect: 'keep',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cn = result.value.creditNote;

    // --- PIN 1: §87 sequence + fiscal_year come from the INVOICE's FY -----
    expect(Number(cn.fiscalYear)).toBe(INVOICE_FISCAL_YEAR); // 2025, NOT 2026
    expect(cn.documentNumber.fiscalYear).toBe(INVOICE_FISCAL_YEAR);
    expect(cn.documentNumber.raw).toBe('CN-2025-000001');

    // --- PIN 2: issueDate is the SETTLEMENT date (FY 2026) — DIFFERENT year
    // from the document number's embedded fiscal year. This is the crux of
    // the cross-FY discrepancy the accountant question flags.
    expect(cn.issueDate).toBe(SETTLEMENT_BANGKOK_DATE); // '2026-03-15'
    expect(cn.issueDate.startsWith('2026')).toBe(true);
    expect(cn.documentNumber.raw.includes('2025')).toBe(true);

    // --- PIN 3: the §87 counter consumed is the FY-2025 stream, NOT FY-2026.
    const seq2025After = await readCreditNoteSeqForFy(tenant, INVOICE_FISCAL_YEAR);
    expect(seq2025After - seq2025Before).toBe(1);
    // No row ever created for the FY-2026 credit_note stream — proves the
    // settlement year never touched the allocator at all.
    const seq2026 = await readCreditNoteSeqForFy(tenant, 2026);
    expect(seq2026).toBe(1); // bootstrap default — absent row, nothing allocated

    // --- PIN 4: same facts, read back from the DB row directly (not just
    // the in-memory aggregate the use-case returned).
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          fiscalYear: creditNotes.fiscalYear,
          documentNumber: creditNotes.documentNumber,
          issueDate: creditNotes.issueDate,
        })
        .from(creditNotes)
        .where(eq(creditNotes.creditNoteId, cn.creditNoteId)),
    );
    expect(row?.fiscalYear).toBe(INVOICE_FISCAL_YEAR);
    expect(row?.documentNumber).toBe('CN-2025-000001');
    expect(row?.issueDate).toBe(SETTLEMENT_BANGKOK_DATE);
  }, 60_000);
});
