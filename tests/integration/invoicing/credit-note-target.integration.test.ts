/**
 * T046 (088-invoice-tax-flow-redesign US6) — issueCreditNote re-targets the
 * §86/10 ใบลดหนี้ from the non-tax ใบแจ้งหนี้ bill to the §86/4 TAX RECEIPT
 * (live Neon Singapore via .env.local).
 *
 * End-to-end through the REAL use-cases on the Shape-1 (record-payment) path,
 * which is the shape US6 actually changes:
 *   createEventInvoiceDraft (TIN buyer → §86/4-creditable)
 *     → issueInvoice            (bill sha frozen on pdf_sha256)
 *     → recordPayment (SYNC, separate receipt mode → allocates a distinct RC
 *                      into receipt_document_number_raw; writes the §86/4
 *                      receipt to the SEPARATE receipt blob → receiptPdf
 *                      non-null, receipt_pdf_status='rendered')
 *     → issueCreditNote
 *
 * Asserts (SC-006 / § A.4 / contracts/issue-credit-note.md):
 *   1. Crediting the UNPAID ใบแจ้งหนี้ (status='issued') is rejected with
 *      `invalid_status` — no §86/4 receipt exists yet, nothing to credit.
 *   2. Once PAID, the CN references the §86/4 RC receipt number (NOT the
 *      invoice-stream / bill number) AND the receipt (payment) date (NOT the
 *      bill's issue date) — captured from the CN render input's `creditNote`
 *      reference block + the single synthetic line.
 *   3. The CREDITED annotation re-renders the RECEIPT blob (kind
 *      'receipt_combined', uploaded at `receiptPdf.blobKey` with
 *      allowOverwrite=true) and updates `receipt_pdf_sha256` — while the bill's
 *      `pdf_sha256` stays FROZEN at its issue-time value.
 *
 * PDF render + Blob upload + outbox are mocked (fast, deterministic shas); the
 * DB + §87 allocator + RLS + the real F4 audit adapter are live so the
 * tax-document path is genuinely exercised. Migrations through 0235 MUST be
 * applied (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  recordPayment,
  type RecordPaymentDeps,
} from '@/modules/invoicing/application/use-cases/record-payment';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueCreditNote,
  type IssueCreditNoteDeps,
} from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

// TIN buyer → §86/4-creditable (kind='invoice' at issue, receipt_combined at pay).
const BUYER = {
  legal_name: 'Gamma Trading Co., Ltd.',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Ken Trader',
  primary_contact_email: 'ken@gamma.example',
} as const;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const BILL_SHA = 'b'.repeat(64); // issue-time bill bytes (pdf_sha256)
const RECEIPT_SHA = 'd'.repeat(64); // record-payment receipt bytes (receipt_pdf_sha256)
const ANNOTATION_SHA = 'c'.repeat(64); // credit-note re-render bytes

const ISSUE_DATE = '2026-04-18';
const PAYMENT_DATE = '2026-04-19';

function makeIssueDeps(
  tenantSlug: string,
  opts: { taxAtPayment?: boolean } = {},
): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: makeCreateEventInvoiceDraftDeps(tenantSlug).memberIdentity,
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe(BILL_SHA) })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as IssueInvoiceDeps['blob'],
    audit: f4AuditAdapter,
    clock: { nowIso: () => `${ISSUE_DATE}T10:00:00Z` },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
    // Pin the flow EXPLICITLY rather than inheriting the ambient
    // FEATURE_088_TAX_AT_PAYMENT env flag (frozen at boot; ON in the dev env).
    // false → legacy §87 ใบกำกับภาษี at issue; true → NON-tax ใบแจ้งหนี้ bill
    // (documentNumber NULL + billDocumentNumberRaw set). This keeps the legacy
    // case deterministic regardless of the env flag.
    taxAtPayment: opts.taxAtPayment === true ? 'on' : 'off',
  };
}

/**
 * Real recordPayment with PDF/Blob mocked + async-receipt flag forced OFF so the
 * receipt renders INLINE into the separate receipt blob (receiptPdf non-null,
 * receipt_pdf_status='rendered', receiptDocumentNumberRaw=RC in separate mode).
 */
function makeRecordPaymentDepsForPay(
  tenantSlug: string,
  opts: { taxAtPayment?: boolean } = {},
): RecordPaymentDeps {
  const real = makeRecordPaymentDeps(tenantSlug);
  const { receiptPdfRenderEnqueue: _omitEnqueue, ...rest } = real;
  void _omitEnqueue;
  return {
    ...rest,
    asyncReceiptPdf: false,
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe(RECEIPT_SHA) })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as RecordPaymentDeps['blob'],
    // Pin the flow EXPLICITLY rather than inheriting the ambient
    // FEATURE_088_TAX_AT_PAYMENT env flag (makeRecordPaymentDeps injects it from
    // env; it is ON in the dev env). false → legacy combined-reuse (receipt reuses
    // the invoice number, dated at issueDate); true → mint a DISTINCT §86/4 RC
    // (receiptDocumentNumberRaw) dated at the payment date. Forcing it here keeps
    // the legacy case from tripping the FR-017 `legacy_invoice_needs_reissue`
    // guard when the ambient flag is ON.
    taxAtPayment: opts.taxAtPayment === true ? 'on' : 'off',
  };
}

function makeCreditNoteDeps(tenantSlug: string): {
  deps: IssueCreditNoteDeps;
  captured: PdfRenderInput[];
  uploads: Array<{ key: string; allowOverwrite: boolean | undefined }>;
} {
  const captured: PdfRenderInput[] = [];
  const uploads: Array<{ key: string; allowOverwrite: boolean | undefined }> = [];
  const deps: IssueCreditNoteDeps = {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async (input: PdfRenderInput) => {
        captured.push(input);
        return { bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe(ANNOTATION_SHA) };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async (input: { key: string; allowOverwrite?: boolean }) => {
        uploads.push({ key: input.key, allowOverwrite: input.allowOverwrite });
        return { key: input.key, url: `https://blob.test/${input.key}` };
      }),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as IssueCreditNoteDeps['blob'],
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-20T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
  return { deps, captured, uploads };
}

describe('issueCreditNote — US6 re-targets the CN to the §86/4 receipt (T046, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const eventId = randomUUID();
    const regId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'หอการค้า',
        legalNameEn: 'Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
        // Separate receipt mode → record-payment allocates a DISTINCT RC number
        // into receipt_document_number_raw, so we can prove the CN references the
        // RC receipt number (not the invoice-stream / bill number).
        receiptNumberPrefix: 'RC',
        receiptNumberingMode: 'separate',
        autoEmailEnabled: false,
      });

      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-us6-target-${regId.slice(0, 8)}`,
        name: 'US6 Target Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: `att-us6-target-${regId.slice(0, 8)}`,
        attendeeEmail: BUYER.primary_contact_email,
        attendeeName: 'Ken Trader',
        attendeeCompany: BUYER.legal_name,
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // Draft (250 THB inclusive → 25000 satang) + issue (bill).
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-us6-draft-${regId}`,
        eventRegistrationId: regId,
        buyer: BUYER,
      },
    );
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    invoiceId = draft.value.invoiceId;

    const issued = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-us6-issue-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function readInvoiceRow() {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  it('AS3 — crediting the UNPAID ใบแจ้งหนี้ (status=issued) is rejected with invalid_status', async () => {
    const before = await readInvoiceRow();
    expect(before!.status).toBe('issued'); // not yet paid → no §86/4 receipt

    const { deps } = makeCreditNoteDeps(tenant.ctx.slug);
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-us6-unpaid-${invoiceId}`,
      invoiceId,
      creditTotalSatang: 25_000n,
      reason: 'should be blocked — unpaid bill',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invalid_status, got ok');
    expect(r.error.code).toBe('invalid_status');
    if (r.error.code === 'invalid_status') {
      expect(r.error.status).toBe('issued');
    }

    // No credit note written; invoice stays issued.
    const cnRows = await db
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.originalInvoiceId, invoiceId)));
    expect(cnRows.length).toBe(0);
    expect((await readInvoiceRow())!.status).toBe('issued');
  }, 90_000);

  it('paid → CN references the RC receipt number + payment date; annotation updates receipt_pdf_sha256 (NOT pdf_sha256) on the receipt blob', async () => {
    // Pay it (issued → paid). Sync render → separate §86/4 receipt blob + RC.
    const paid = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsForPay(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-us6-pay-${invoiceId}`,
        invoiceId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'seed-ref',
        paymentDate: PAYMENT_DATE,
      }),
    );
    if (!paid.ok) throw new Error(`pay failed: ${JSON.stringify(paid)}`);

    const beforeCn = await readInvoiceRow();
    expect(beforeCn!.status).toBe('paid');
    // Shape 1 — a SEPARATE §86/4 receipt blob exists + is rendered.
    expect(beforeCn!.receiptPdfStatus).toBe('rendered');
    expect(beforeCn!.receiptPdfBlobKey).not.toBeNull();
    expect(beforeCn!.receiptPdfSha256).toBe(RECEIPT_SHA);
    // The §86/4 receipt number the CN must reference, resolved exactly as the
    // use-case resolves it: the payment-time RC when one was allocated (088 flag
    // / separate mode), else the combined receipt reuses the invoice-stream
    // number. Either way it is the RECEIPT's number. (Under the current env the
    // legacy combined-reuse path leaves receiptDocumentNumberRaw null → the
    // number equals documentNumber; the RC-distinct case is pinned by the unit
    // test. The DATE + separate-blob re-targets below are the flag-independent
    // proofs that the CN targets the receipt, not the bill.)
    const receiptNumber = beforeCn!.receiptDocumentNumberRaw ?? beforeCn!.documentNumber;
    expect(receiptNumber).not.toBeNull();
    const billPdfSha = beforeCn!.pdfSha256; // must stay frozen across the CN
    const billBlobKey = beforeCn!.pdfBlobKey;
    const receiptBlobKey = beforeCn!.receiptPdfBlobKey;
    // Shape 1 — the §86/4 receipt lives in a SEPARATE blob from the bill.
    expect(receiptBlobKey).not.toBeNull();
    expect(receiptBlobKey).not.toBe(billBlobKey);

    const { deps, captured, uploads } = makeCreditNoteDeps(tenant.ctx.slug);
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-us6-cn-${invoiceId}`,
      invoiceId,
      creditTotalSatang: 12_500n, // 50% partial → parent stays partially_credited
      reason: 'US6 target test',
    });
    expect(r.ok, r.ok ? 'ok' : `cn err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('cn failed');

    // (2) CN render input references the resolved §86/4 receipt number + the date
    //     the receipt was ACTUALLY rendered with. This parent is the FLAG-OFF
    //     legacy combined-reuse path (documentNumber non-null reused §87,
    //     receiptDocumentNumberRaw NULL), whose receipt is dated at the bill's
    //     issueDate (render-receipt-pdf: documentNumber non-null → issueDate). So
    //     the §86/10 CN cites issueDate here — the re-render must reproduce the
    //     receipt byte-faithfully (US6 review HIGH: NOT paymentDate). The NEW-flow
    //     documentNumber-NULL → paymentDate case is pinned in the unit test.
    const cnRender = captured.find((c) => c.kind === 'credit_note');
    expect(cnRender, 'expected a credit_note render call').toBeDefined();
    expect(cnRender!.creditNote?.originalDocumentNumber).toBe(receiptNumber);
    expect(cnRender!.creditNote?.originalIssueDate).toBe(ISSUE_DATE);
    expect(cnRender!.creditNote?.originalIssueDate).not.toBe(PAYMENT_DATE);
    // The single synthetic line references the receipt number too.
    expect(cnRender!.lines[0]!.descriptionEn).toContain(receiptNumber!);
    expect(cnRender!.lines[0]!.descriptionTh).toContain(receiptNumber!);

    // (3) The CREDITED annotation re-renders the RECEIPT blob (kind
    //     receipt_combined) and overwrites at receiptPdf.blobKey.
    const annotation = captured.find((c) => c.kind !== 'credit_note');
    expect(annotation, 'expected a J2 annotation re-render call').toBeDefined();
    expect(annotation!.kind).toBe('receipt_combined');
    expect(annotation!.creditedAnnotation).toBeTruthy();
    const overwriteUpload = uploads.find((u) => u.allowOverwrite === true);
    expect(overwriteUpload, 'annotation re-render upload (allowOverwrite=true)').toBeDefined();
    expect(overwriteUpload!.key).toBe(receiptBlobKey);

    // receipt_pdf_sha256 updated to the re-rendered bytes; bill pdf_sha256 FROZEN.
    const afterCn = await readInvoiceRow();
    expect(afterCn!.status).toBe('partially_credited');
    expect(afterCn!.receiptPdfSha256).toBe(ANNOTATION_SHA); // receipt re-annotated
    expect(afterCn!.receiptPdfSha256).not.toBe(RECEIPT_SHA);
    expect(afterCn!.pdfSha256).toBe(billPdfSha); // bill blob untouched (frozen)
    expect(afterCn!.receiptPdfBlobKey).toBe(receiptBlobKey); // same content-addressed key
    // The receipt NUMBER is immutable (migration 0235) and unchanged by the CN.
    expect(afterCn!.receiptDocumentNumberRaw).toBe(beforeCn!.receiptDocumentNumberRaw);
  }, 120_000);

  // Fix #10 (whole-feature review) — the legacy case above runs the flag-OFF
  // combined-reuse path, so `receiptDocumentNumberRaw` is NULL, the receipt
  // number EQUALS the bill number, and the receipt is dated at the bill's
  // issueDate → the "CN cites the receipt (not the bill) / payment date (not the
  // issue date)" assertions are VACUOUS there (a revert to citing the bill number
  // / issue date would still pass). This case runs the NEW flow (taxAtPayment)
  // where the parent gets documentNumber NULL + a DISTINCT §86/4 RC
  // (receiptDocumentNumberRaw, `RC-…`) dated at the PAYMENT date, so the same
  // assertions now have real TEETH: the CN must cite the DISTINCT RC — never the
  // `INV-…` bill number — and the PAYMENT date — never the ISSUE date.
  it('NEW FLOW (taxAtPayment): CN cites the DISTINCT RC receipt number + PAYMENT date (not the INV bill number / issue date)', async () => {
    // Fresh event + TIN-buyer registration for a self-contained new-flow sale.
    const nfEventId = randomUUID();
    const nfRegId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId: nfEventId,
        source: 'eventcreate',
        externalId: `evt-us6-nf-${nfRegId.slice(0, 8)}`,
        name: 'US6 New-Flow Gala',
        startDate: new Date('2026-09-20T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: nfRegId,
        eventId: nfEventId,
        externalId: `att-us6-nf-${nfRegId.slice(0, 8)}`,
        attendeeEmail: BUYER.primary_contact_email,
        attendeeName: 'Ken Trader',
        attendeeCompany: BUYER.legal_name,
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // Draft → issue as a NON-tax ใบแจ้งหนี้ bill (documentNumber NULL,
    // billDocumentNumberRaw = INV-…).
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-us6-nf-draft-${nfRegId}`,
        eventRegistrationId: nfRegId,
        buyer: BUYER,
      },
    );
    if (!draft.ok) throw new Error(`nf draft failed: ${draft.error.code}`);
    const nfInvoiceId = draft.value.invoiceId;

    const issued = await issueInvoice(
      makeIssueDeps(tenant.ctx.slug, { taxAtPayment: true }),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-us6-nf-issue-${nfInvoiceId}`,
        invoiceId: nfInvoiceId,
      },
    );
    if (!issued.ok) throw new Error(`nf issue failed: ${JSON.stringify(issued)}`);

    async function readNfRow() {
      const [row] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, nfInvoiceId)));
      return row;
    }

    const billRow = await readNfRow();
    expect(billRow!.status).toBe('issued');
    // New-flow bill: §87 doc/seq NULL; the non-§87 bill number lives in
    // billDocumentNumberRaw (INV prefix).
    expect(billRow!.documentNumber).toBeNull();
    expect(billRow!.billDocumentNumberRaw).not.toBeNull();
    expect(billRow!.billDocumentNumberRaw).toMatch(/^INV-2026-\d{6}$/);
    expect(billRow!.receiptDocumentNumberRaw).toBeNull();
    const billNumber = billRow!.billDocumentNumberRaw;

    // Pay → mint the DISTINCT §86/4 RC receipt, dated at the payment date.
    const paid = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsForPay(tenant.ctx.slug, { taxAtPayment: true }), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-us6-nf-pay-${nfInvoiceId}`,
        invoiceId: nfInvoiceId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'seed-ref-nf',
        paymentDate: PAYMENT_DATE,
      }),
    );
    if (!paid.ok) throw new Error(`nf pay failed: ${JSON.stringify(paid)}`);

    const paidRow = await readNfRow();
    expect(paidRow!.status).toBe('paid');
    // The distinct RC is minted at payment; documentNumber stays NULL; the RC is
    // in the SEPARATE `receiptDocumentNumberRaw` (Shape 1) and dated at payment.
    expect(paidRow!.documentNumber).toBeNull();
    expect(paidRow!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
    expect(paidRow!.receiptPdfStatus).toBe('rendered');
    expect(paidRow!.paymentDate).toBe(PAYMENT_DATE);
    const rcNumber = paidRow!.receiptDocumentNumberRaw;
    // Sanity — the RC is genuinely DISTINCT from the bill number (different §87
    // stream + prefix), which is exactly what makes the CN assertions non-vacuous.
    expect(rcNumber).not.toBe(billNumber);

    // Issue a §86/10 credit note against the paid parent.
    const { deps, captured } = makeCreditNoteDeps(tenant.ctx.slug);
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-us6-nf-cn-${nfInvoiceId}`,
      invoiceId: nfInvoiceId,
      creditTotalSatang: 12_500n, // 50% partial
      reason: 'US6 new-flow target test',
    });
    expect(r.ok, r.ok ? 'ok' : `nf cn err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('nf cn failed');

    const cnRender = captured.find((c) => c.kind === 'credit_note');
    expect(cnRender, 'expected a credit_note render call').toBeDefined();
    // TEETH #1 — the CN cites the DISTINCT RC receipt number, NEVER the bill.
    expect(cnRender!.creditNote?.originalDocumentNumber).toBe(rcNumber);
    expect(cnRender!.creditNote?.originalDocumentNumber).not.toBe(billNumber);
    // TEETH #2 — the CN cites the PAYMENT date (the RC's date), NEVER the bill's
    // issue date.
    expect(cnRender!.creditNote?.originalIssueDate).toBe(PAYMENT_DATE);
    expect(cnRender!.creditNote?.originalIssueDate).not.toBe(ISSUE_DATE);
    // The single synthetic line references the RC number too (not the bill).
    expect(cnRender!.lines[0]!.descriptionEn).toContain(rcNumber!);
    expect(cnRender!.lines[0]!.descriptionTh).toContain(rcNumber!);
    expect(cnRender!.lines[0]!.descriptionEn).not.toContain(billNumber!);
  }, 120_000);
});
