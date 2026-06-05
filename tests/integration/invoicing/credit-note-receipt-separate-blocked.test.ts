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
 * End-to-end through the REAL use-cases:
 *   createEventInvoiceDraft (non-member, NO TIN → buyer snapshot pinned at DRAFT)
 *     → issueInvoice (resolves kind 'receipt_separate' — §105 receipt)
 *     → recordPayment (now works after HIGH 2; flips issued → paid)
 *     → issueCreditNote → MUST return err({ code: 'receipt_not_creditable' })
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

function makeIssueDeps(tenantSlug: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: makeCreateEventInvoiceDraftDeps(tenantSlug).memberIdentity,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe(ISSUE_SHA) })),
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
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
}

/**
 * Real recordPayment composition root with PDF/Blob mocked + the async-receipt
 * flag forced OFF (the shared integration setup forces it ON, which skips the
 * inline receipt render). We don't assert on the receipt here — we only need the
 * invoice to reach `paid` so issueCreditNote's status guard passes.
 */
function makeRecordPaymentDepsForPay(tenantSlug: string): RecordPaymentDeps {
  const real = makeRecordPaymentDeps(tenantSlug);
  const { receiptPdfRenderEnqueue: _omitEnqueue, ...rest } = real;
  void _omitEnqueue;
  return {
    ...rest,
    asyncReceiptPdf: false,
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe('c'.repeat(64)) })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as RecordPaymentDeps['blob'],
  };
}

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

    // 1) Draft (non-member, NO TIN → 250 THB inclusive → 25000 satang).
    const draft = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cnblock-draft-${regId}`,
      eventRegistrationId: regId,
      buyer: BUYER_NO_TIN,
    });
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    invoiceId = draft.value.invoiceId;

    // 2) Issue — resolves kind 'receipt_separate' (§105 receipt; no-TIN event buyer).
    const issued = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cnblock-issue-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);

    // 3) Pay via the REAL recordPayment use-case (works after HIGH 2) → paid.
    const paid = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsForPay(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-cnblock-pay-${invoiceId}`,
        invoiceId,
        paymentMethod: 'cash',
        paymentDate: '2026-04-19',
      }),
    );
    if (!paid.ok) throw new Error(`pay failed: ${JSON.stringify(paid)}`);
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
