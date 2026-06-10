/**
 * final-review HIGH 1 (054-event-fee-invoices) — issueCreditNote MUST BLOCK a
 * §105 ใบเสร็จรับเงิน (`receipt_separate`) event invoice issued to a no-TIN
 * buyer (live Neon Singapore via .env.local).
 *
 * Thai-tax ruling (§86/10): a credit note (ใบลดหนี้) can legally adjust ONLY a
 * §86/4 tax invoice (kind='invoice'). It can NEVER reference a §105 receipt
 * (`receipt_separate`, the document a TIN-less event buyer receives at issue).
 * After HIGH 2 made `recordPayment` work for non-member/no-TIN event invoices,
 * such an invoice can now reach `paid` and be reached by `issueCreditNote` — at
 * which point the J2 re-annotation (hardcoded kind='invoice') would illegally
 * stamp "ใบกำกับภาษี / Tax Invoice" onto a §105 receipt. The fix BLOCKS the
 * credit note entirely with `receipt_not_creditable`.
 *
 * Fixture (REVISED by 064 §105 ROOT FIX): the paid no-TIN event row is
 * DIRECT-inserted (raw insert, pre-064 prod shape: status 'paid', pdf_doc_kind
 * 'receipt_separate', full payment + receipt fields). It can no longer be
 * built through the use-case chain because (a) plain issueInvoice now REJECTS
 * a no-TIN event draft (`event_no_tin_requires_paid_issue`), (b) recordPayment
 * rejects a legacy issued no-TIN row (`legacy_no_tin_event_needs_remediation`),
 * and (c) the no-TIN leg of `issueEventInvoiceAsPaid` is β-GATED until Task 10
 * (returns `no_tin_numbering_pending`). TODO(064 Task 10): rebuild this
 * fixture on the real `issueEventInvoiceAsPaid` no-TIN path once the gate
 * lifts. The use-case under test is unchanged:
 *   issueCreditNote → MUST return err({ code: 'receipt_not_creditable' })
 *
 * Asserts (per HIGH 1 spec):
 *   1. issueCreditNote returns err({ code: 'receipt_not_creditable' }).
 *   2. NO credit-note §87 sequence number was consumed (the guard fires BEFORE
 *      allocateNext — the `credit_note` stream counter is untouched).
 *   3. The parent invoice PDF was NOT re-rendered/overwritten: the CN deps'
 *      pdfRender.render mock was never invoked AND the parent's pdf_sha256 is
 *      byte-identical to its issue-time value.
 *   4. No creditNotes row was inserted; the parent invoice stays `paid`.
 *
 * Migrations 0200–0203 MUST be applied (`pnpm db:migrate`).
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
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
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
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// Non-member buyer WITHOUT a Thai TIN → issued as `receipt_separate` (§105).
const BUYER_NO_TIN = {
  legal_name: 'Walk-in Guest',
  tax_id: null,
  address: '99 Charoen Krung Road, Bangkok 10500',
  primary_contact_name: 'Walk-in Guest',
  primary_contact_email: 'walkin-cn@example.com',
} as const;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const ISSUE_SHA = 'b'.repeat(64);

// Tenant identity snapshot for the DIRECT-inserted legacy row — mirrors the
// tenant_invoice_settings seeded in beforeAll (snake_case snapshot shape).
const SNAP_TENANT = {
  legal_name_th: 'หอการค้า',
  legal_name_en: 'Chamber',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
} as const;

function makeCreditNoteDeps(tenantSlug: string): {
  deps: IssueCreditNoteDeps;
  pdfRenderMock: ReturnType<typeof vi.fn>;
} {
  // CRITICAL: capture the render mock so the test can prove the parent invoice
  // PDF was NEVER re-rendered (the guard must return BEFORE G+H render + before
  // the J2 re-annotation).
  const pdfRenderMock = vi.fn(async () => ({
    bytes: PDF_BYTES,
    sha256: Sha256Hex.ofUnsafe('d'.repeat(64)),
  }));
  const deps: IssueCreditNoteDeps = {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: { render: pdfRenderMock },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
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
  return { deps, pdfRenderMock };
}

describe('issueCreditNote — BLOCKS §105 receipt_separate (HIGH 1, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  let eventId: string;
  let regId: string;
  let invoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    regId = randomUUID();

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
        invoiceNumberPrefix: 'RCP',
        creditNoteNumberPrefix: 'RCPC',
        receiptNumberPrefix: 'RCPR',
        receiptNumberingMode: 'separate',
      });

      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_cn_block',
        name: 'Walk-in Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: 'att_cn_block',
        attendeeEmail: 'walkin-cn@example.com',
        attendeeName: 'Walk-in Guest',
        attendeeCompany: null,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // PAID §105 no-TIN event row — DIRECT insert (064 §105 ROOT FIX killed the
    // use-case chain that previously built this: plain issueInvoice now rejects
    // a no-TIN event draft, recordPayment rejects legacy issued no-TIN rows,
    // and the no-TIN as-paid leg is β-gated until Task 10 returning
    // `no_tin_numbering_pending`). The raw insert mirrors the pre-064 prod
    // shape exactly (migration 0211 backfill: pdf_doc_kind 'receipt_separate')
    // and populates every paid-row CHECK field (paid_at + payment_method per
    // 0019, receipt_pdf_status per 0056, snapshots/numbering/pdf per 0203).
    // TODO(064 Task 10): switch to the real issueEventInvoiceAsPaid no-TIN
    // path once the β gate lifts.
    invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: regId,
        vatInclusive: true,
        memberId: null,
        planYear: null,
        planId: null,
        draftByUserId: user.userId,
        status: 'paid',
        pdfDocKind: 'receipt_separate',
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'RCP-2026-000001',
        issueDate: '2026-04-18',
        dueDate: '2026-05-18',
        // 250 THB = 25000 satang inclusive @ 7% → subtotal 23364, vat 1636.
        subtotalSatang: 23_364n,
        vatRateSnapshot: '0.0700',
        vatSatang: 1_636n,
        totalSatang: 25_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: null,
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: BUYER_NO_TIN,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_v1.pdf`,
        pdfSha256: ISSUE_SHA,
        pdfTemplateVersion: 1,
        // Payment fields (CHECK invoices_paid_has_payment) + the separate-mode
        // receipt artefacts a pre-064 paid no-TIN row carries.
        paidAt: new Date('2026-04-19T10:00:00Z'),
        paymentMethod: 'cash',
        paymentDate: '2026-04-19',
        paymentRecordedByUserId: user.userId,
        receiptPdfStatus: 'rendered',
        receiptPdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_receipt_v1.pdf`,
        receiptPdfSha256: 'c'.repeat(64),
        receiptPdfTemplateVersion: 1,
        receiptDocumentNumberRaw: 'RCPR-2026-000001',
      });
    });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant.cleanup().catch(() => {});
  });

  async function readInvoiceRow() {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  async function readCreditNoteSequence(): Promise<number | null> {
    const [row] = await db
      .select()
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'credit_note'),
        ),
      );
    return row ? row.nextSequenceNumber : null;
  }

  it('rejects a credit note against a §105 receipt_separate invoice with receipt_not_creditable, burning no CN sequence number and re-rendering no PDF', async () => {
    const before = await readInvoiceRow();
    expect(before!.status).toBe('paid');
    expect(before!.memberId).toBeNull(); // non-member event invoice
    expect(before!.invoiceSubject).toBe('event');
    // No TIN on the pinned buyer snapshot → this was issued as receipt_separate.
    const snapBefore = before!.memberIdentitySnapshot as { tax_id: string | null };
    expect((snapBefore.tax_id ?? '').trim()).toBe('');
    const issueSha = before!.pdfSha256;
    expect(issueSha).toBe(ISSUE_SHA);

    // §87 credit-note sequence counter BEFORE the blocked attempt. The guard
    // fires before allocateNext, so this must be untouched after.
    const cnSeqBefore = await readCreditNoteSequence();

    const { deps, pdfRenderMock } = makeCreditNoteDeps(tenant.ctx.slug);
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cnblock-cn-${invoiceId}`,
      invoiceId,
      creditTotalSatang: 25_000n, // full
      reason: 'event cancelled — should be blocked',
    });

    // (1) Typed reject — a §105 receipt cannot be credited.
    expect(r.ok, r.ok ? 'expected receipt_not_creditable but got ok' : 'rejected').toBe(false);
    if (r.ok) throw new Error('expected receipt_not_creditable, got ok');
    expect(r.error.code).toBe('receipt_not_creditable');

    // (2) NO §87 credit-note sequence number consumed (guard before allocateNext).
    const cnSeqAfter = await readCreditNoteSequence();
    expect(cnSeqAfter).toBe(cnSeqBefore);

    // (3) The parent invoice PDF was NEVER re-rendered (no G+H, no J2 annotation).
    expect(pdfRenderMock).not.toHaveBeenCalled();
    const after = await readInvoiceRow();
    expect(after!.pdfSha256).toBe(issueSha); // byte-identical: never overwritten

    // (4) No credit_notes row inserted; parent stays paid.
    const cnRows = await db
      .select()
      .from(creditNotes)
      .where(
        and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.originalInvoiceId, invoiceId)),
      );
    expect(cnRows.length).toBe(0);
    expect(after!.status).toBe('paid');
  }, 120_000);
});
