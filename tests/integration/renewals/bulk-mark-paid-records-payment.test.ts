/**
 * 059-membership-suspension Task 11 — C1 fix (whole-branch review) proof:
 * bulk "Mark paid" records payment on the EXISTING issued renewal invoice via
 * the F4 record-payment path, NOT the mint-and-pay `mark-paid-offline` route.
 *
 * The old fan-out POSTed `…/[cycleId]/mark-paid-offline`, which REFUSES any
 * cycle that already has a live membership bill — and every bulk-batch row is
 * `previewable` (its linked invoice is `status='issued'`), so it always has
 * one. Result: the whole batch 409'd and marked NOTHING paid. The fix routes
 * the fan-out to `POST /api/invoices/[invoiceId]/pay`, keyed on each row's
 * linked invoice id.
 *
 * This live-Neon test drives the EXACT deps that route builds —
 *   recordPayment(
 *     makeRecordPaymentDeps(slug, undefined, f8OnPaidCallbacks(slug)),
 *     { …, triggeredBy: 'admin_manual' },
 *   )
 * — against a seeded `awaiting_payment` renewal cycle whose linked invoice is
 * `status='issued'` (the settlement-preview `previewable` shape, reusing that
 * test's seed idiom). It proves the fan-out actually SETTLES:
 *   - the invoice → `paid`,
 *   - the RenewalCycle → `completed`,
 *   - the NEXT cycle is opened (steady-state renewal rollover), and
 *   - NO duplicate §86/4 is minted — the member still holds EXACTLY ONE
 *     membership invoice for the plan year (record-payment settles the
 *     existing bill; unlike mint-and-pay it never creates a second one).
 *
 * A TERMINAL predecessor cycle (cancelled + anchored) gives the member renewal
 * history so the shared payment classifier resolves the paid cycle as a
 * STEADY-STATE renewal (completes + opens next) rather than a `first_payment`
 * re-anchor — the same seed discipline create-next-cycle-on-paid.test.ts uses.
 *
 * PDF render + Blob upload are mocked (deterministic; bill-to-receipt.integration
 * pattern). `taxAtPayment: 'off'` + the seeded invoice's legacy §87
 * `document_number` runs the receipt-number-reuse path (no fresh RC allocated),
 * so the "no new invoice row" invariant is clean and needs no sequence seed.
 *
 * Run in isolation (file PATH positional, not `-- <pattern>`):
 *   pnpm test:integration tests/integration/renewals/bulk-mark-paid-records-payment.test.ts
 *
 * --- 059-membership-suspension Task 11 (financial-integrity re-review, C1 M1 + L3) ---
 *
 * The re-review gave a MONEY-SAFE-TO-MERGE verdict on the C1 fix above but
 * flagged two coverage gaps, both closed test-only in this pass (no source
 * changes):
 *
 *   M1 — the test above only proves the LEGACY shape (`taxAtPayment: 'off'`,
 *   a §87 `document_number` bill, receipt-number REUSE). Production runs
 *   `FEATURE_088_TAX_AT_PAYMENT` ON, where a real renewal bill is a NEW-FLOW
 *   088 bill (`billDocumentNumberRaw` non-null, `documentNumber` NULL) and
 *   `recordPayment` takes the OTHER branch: it mints a FRESH §86/4 `RC`
 *   receipt number (`reuseInvoiceNumber = false` — see
 *   `record-payment.ts`'s `reuseInvoiceNumber` / `taxAtPayment` locals) and
 *   fires a `tax_receipt_issued` audit alongside `invoice_paid`. That
 *   prod-shape settlement path was not exercised by any test. The second
 *   `it(...)` below drives the identical bulk-fan-out deps shape against a
 *   `seedIssuedInvoiceNewFlow` 088-shaped bill under `taxAtPayment: 'on'`
 *   and asserts the RC was actually minted (not just that payment
 *   succeeded) — proving the fan-out settles the EXACT bill shape prod
 *   creates. No `tenant_document_sequences` seed row is required: the
 *   Postgres allocator self-bootstraps via `INSERT … ON CONFLICT DO
 *   NOTHING` (see `postgres-sequence-allocator.ts`) — the same reason
 *   `088-invoice-tax-flow-redesign`'s `renewal-parity.integration.test.ts`
 *   never seeds one either.
 *
 *   L3 — neither test asserted the `invoice_paid` audit row itself (only
 *   `tax_receipt_issued` is new-flow-specific). Both `it(...)` blocks now
 *   assert an `invoice_paid` row exists for the settled invoice carrying
 *   the correct `member_id` (the F3 timeline join key).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { f8OnPaidCallbacks } from '@/modules/renewals';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

const FIXED_NOW = '2026-07-01T09:00:00Z';
const PAYMENT_DATE = '2026-07-01';
const PLAN_YEAR = 2026;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Bulk Pay Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'bulk-pay@example.com',
};

/** Deterministic PDF/Blob seams so the receipt render never touches real infra. */
function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async (_renderInput: PdfRenderInput) => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

/**
 * The EXACT deps shape the /pay route builds (f8OnPaidCallbacks threaded), with
 * only the deterministic seams overridden: mocked PDF/Blob, a fixed clock (for
 * the §87 payment-date guard), sync receipt render (dev env has async ON), a
 * stub outbox + recipient-locale (no real Resend row / preference read), and
 * `taxAtPayment: 'off'` so the legacy §87-reuse path runs (no fresh RC).
 */
function recordDeps(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug, undefined, f8OnPaidCallbacks(slug)),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'off',
    asyncReceiptPdf: false,
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
  };
}

/**
 * (M1) The PROD flag-on twin of `recordDeps` above: `taxAtPayment: 'on'`
 * takes record-payment's OTHER branch — mint a fresh §86/4 `RC` receipt
 * number now, rather than reuse the bill's own §87 number (which is NULL
 * on a new-flow bill; pairing `taxAtPayment: 'off'` with one would 409
 * `new_flow_bill_requires_flag_on`). `asyncReceiptPdf: false` forces the
 * SYNCHRONOUS render so the RC allocation + `tax_receipt_issued` audit
 * commit in-tx and are assertable immediately (same override
 * `renewal-parity.integration.test.ts`'s `recordDepsFlagOn` uses).
 */
function recordDepsFlagOn(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug, undefined, f8OnPaidCallbacks(slug)),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
    asyncReceiptPdf: false,
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
  };
}

describe('bulk mark-paid records payment on the issued invoice — integration (C1 fix, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Bulk Pay Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: PLAN_YEAR,
      }),
    );
    return memberId;
  }

  /**
   * A `status='issued'` membership invoice with a legacy §87 `document_number`
   * (the settlement-preview `previewable` shape). Returns its id.
   */
  async function seedIssuedInvoice(memberId: string, seq: number): Promise<string> {
    const invoiceId = randomUUID();
    const totalSatang = 107000n; // ฿1,070.00
    const subtotal = (totalSatang * 100n) / 107n;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: PLAN_YEAR,
        planId,
        draftByUserId: user.userId,
        status: 'issued',
        pdfDocKind: 'invoice',
        fiscalYear: PLAN_YEAR,
        sequenceNumber: seq,
        documentNumber: `SC-2026-${String(seq).padStart(6, '0')}`,
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        currency: 'THB',
        subtotalSatang: subtotal,
        vatRateSnapshot: '0.0700',
        vatSatang: totalSatang - subtotal,
        totalSatang,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        autoEmailOnIssue: true,
      }),
    );
    return invoiceId;
  }

  /**
   * (M1) A `status='issued'` NEW-FLOW membership bill (088 shape): the
   * non-§87 `bill_document_number_raw` (e.g. `SC-2026-000002`) is set;
   * `document_number` + `sequence_number` are NULL. This is what a real
   * renewal bill looks like once `FEATURE_088_TAX_AT_PAYMENT` is on —
   * record-payment's fresh-RC-allocation branch (`reuseInvoiceNumber =
   * false`) only runs against a row shaped exactly like this one, never
   * against the legacy `seedIssuedInvoice` shape above. Returns its id.
   */
  async function seedIssuedInvoiceNewFlow(memberId: string, seq: number): Promise<string> {
    const invoiceId = randomUUID();
    const totalSatang = 107000n; // ฿1,070.00
    const subtotal = (totalSatang * 100n) / 107n;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: PLAN_YEAR,
        planId,
        draftByUserId: user.userId,
        status: 'issued',
        pdfDocKind: 'invoice',
        fiscalYear: PLAN_YEAR,
        sequenceNumber: null,
        documentNumber: null,
        billDocumentNumberRaw: `SC-2026-${String(seq).padStart(6, '0')}`,
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        currency: 'THB',
        subtotalSatang: subtotal,
        vatRateSnapshot: '0.0700',
        vatSatang: totalSatang - subtotal,
        totalSatang,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        autoEmailOnIssue: true,
      }),
    );
    return invoiceId;
  }

  /** A terminal (cancelled + anchored) predecessor → steady-state renewal history. */
  async function seedTerminalPredecessor(memberId: string): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      }),
    );
  }

  /** The `awaiting_payment` cycle linked to the issued invoice (future-anchored). */
  async function seedAwaitingCycle(memberId: string, invoiceId: string): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-01-01T00:00:00.000Z'),
        periodTo: new Date('2027-01-01T00:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '1070.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      }),
    );
    return cycleId;
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, invoiceNumberPrefix: 'SC' });
    planId = `bulk-pay-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Bulk Pay Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant?.cleanup().catch(() => {});
  }, 60_000);

  it('settles the issued invoice → paid, completes the cycle, opens the next, and mints NO duplicate §86/4', async () => {
    const memberId = await seedMember();
    await seedTerminalPredecessor(memberId);
    const invoiceId = await seedIssuedInvoice(memberId, 1);
    const awaitingCycleId = await seedAwaitingCycle(memberId, invoiceId);

    // Drive the record-payment path EXACTLY as POST /api/invoices/[id]/pay does.
    const result = await recordPayment(recordDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: null,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BULK-BANK-TRANSFER-1',
      paymentDate: PAYMENT_DATE,
      triggeredBy: 'admin_manual',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('paid');

    // (1) The invoice is `paid` in the DB.
    const invoiceRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId, status: invoices.status })
        .from(invoices)
        .where(and(eq(invoices.memberId, memberId), eq(invoices.planYear, PLAN_YEAR))),
    );
    // (4) NO duplicate §86/4 — the member still holds EXACTLY ONE membership
    // invoice for the plan year. record-payment settled the existing bill; it
    // did not mint a second one (the mint-and-pay hazard the C1 fix removes).
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0]?.invoiceId).toBe(invoiceId);
    expect(invoiceRows[0]?.status).toBe('paid');

    // (2) + (3) The awaiting_payment cycle → completed AND a NEW upcoming
    // cycle is opened (steady-state renewal rollover fired in F4's tx via
    // f8OnPaidCallbacks — the same completion the online rail performs).
    const cycleRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          periodFrom: renewalCycles.periodFrom,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );

    const settled = cycleRows.find((r) => r.cycleId === awaitingCycleId);
    expect(settled?.status).toBe('completed');

    const next = cycleRows.find(
      (r) => r.cycleId !== awaitingCycleId && r.status === 'upcoming',
    );
    expect(next).toBeDefined();
    // Gapless rollover: the next cycle starts where the paid one ended.
    expect(next?.periodFrom.toISOString()).toBe('2027-01-01T00:00:00.000Z');

    // (L3, financial-integrity re-review) — an `invoice_paid` audit row
    // fired for THIS invoice carrying the correct `member_id` (the F3
    // member-timeline join key — see record-payment.ts's TIMELINE branch).
    // `requestId` is null on this call (the bulk fan-out doesn't set one —
    // see the recordPayment input above), so match on `payload.invoice_id`
    // instead (the same idiom record-payment-rollback.test.ts uses).
    const invoicePaidRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'invoice_paid')),
      );
    const matchedInvoicePaid = invoicePaidRows.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === invoiceId,
    );
    expect(matchedInvoicePaid).toHaveLength(1);
    expect((matchedInvoicePaid[0]!.payload as Record<string, unknown>).member_id).toBe(memberId);
  }, 120_000);

  it('PROD FLAG-ON — settles a NEW-FLOW (088) bill, mints a fresh RC §86/4 receipt, completes the cycle, opens the next (C1 M1)', async () => {
    const memberId = await seedMember();
    await seedTerminalPredecessor(memberId);
    const invoiceId = await seedIssuedInvoiceNewFlow(memberId, 2);
    const awaitingCycleId = await seedAwaitingCycle(memberId, invoiceId);

    // Drive the record-payment path EXACTLY as POST /api/invoices/[id]/pay
    // does — the only difference from the legacy `it` above is the deps'
    // `taxAtPayment: 'on'` (the prod flag state).
    const result = await recordPayment(recordDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: null,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BULK-BANK-TRANSFER-2',
      paymentDate: PAYMENT_DATE,
      triggeredBy: 'admin_manual',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('paid');

    // (a) invoice → paid, and (b) a FRESH RC §86/4 receipt number was
    // minted — proof the prod-shape branch actually ran (a legacy-shape
    // row would instead reuse its own §87 documentNumber and mint
    // nothing). (e) still exactly ONE invoice row for the member's plan
    // year — no duplicate §86/4 alongside the existing bill.
    const invoiceRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          invoiceId: invoices.invoiceId,
          status: invoices.status,
          documentNumber: invoices.documentNumber,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
          receiptDocumentNumberRaw: invoices.receiptDocumentNumberRaw,
        })
        .from(invoices)
        .where(and(eq(invoices.memberId, memberId), eq(invoices.planYear, PLAN_YEAR))),
    );
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0]?.invoiceId).toBe(invoiceId);
    expect(invoiceRows[0]?.status).toBe('paid');
    expect(invoiceRows[0]?.documentNumber).toBeNull();
    expect(invoiceRows[0]?.billDocumentNumberRaw).toBe('SC-2026-000002');
    expect(invoiceRows[0]?.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);

    // (c) the `tax_receipt_issued` audit fired for the freshly-minted RC.
    const taxReceiptRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'tax_receipt_issued')),
      );
    const matchedTaxReceipt = taxReceiptRows.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === invoiceId,
    );
    expect(matchedTaxReceipt).toHaveLength(1);
    const taxReceiptPayload = matchedTaxReceipt[0]!.payload as Record<string, unknown>;
    expect(taxReceiptPayload.receipt_document_number_raw).toBe(
      invoiceRows[0]?.receiptDocumentNumberRaw,
    );
    expect(taxReceiptPayload.member_id).toBe(memberId);

    // (L3) the `invoice_paid` audit also fired, carrying the correct member_id.
    const invoicePaidRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'invoice_paid')),
      );
    const matchedInvoicePaid = invoicePaidRows.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === invoiceId,
    );
    expect(matchedInvoicePaid).toHaveLength(1);
    expect((matchedInvoicePaid[0]!.payload as Record<string, unknown>).member_id).toBe(memberId);

    // (d) the RenewalCycle → completed AND a NEW upcoming cycle is opened
    // (steady-state renewal rollover fired in F4's tx via f8OnPaidCallbacks
    // — the same completion the online rail performs).
    const cycleRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          periodFrom: renewalCycles.periodFrom,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    const settled = cycleRows.find((r) => r.cycleId === awaitingCycleId);
    expect(settled?.status).toBe('completed');
    const next = cycleRows.find(
      (r) => r.cycleId !== awaitingCycleId && r.status === 'upcoming',
    );
    expect(next).toBeDefined();
    expect(next?.periodFrom.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  }, 120_000);
});
