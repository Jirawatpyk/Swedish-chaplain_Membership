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
 * Fixture (REBUILT by 064 Task 10): the paid no-TIN event row is built on the
 * REAL use-case chain — `createEventInvoiceDraft` (buyer snapshot pinned at
 * draft) → `issueEventInvoiceAsPaid` (β receipt-STREAM numbering, migration
 * 0212): status 'paid', pdf_doc_kind 'receipt_separate',
 * sequence_number/document_number NULL, receipt_document_number_raw set from
 * the tenant's receipt prefix. This is the ONLY live writer of a §105
 * receipt_separate row (plain issueInvoice rejects no-TIN event drafts with
 * `event_no_tin_requires_paid_issue`; recordPayment rejects legacy issued
 * no-TIN rows with `legacy_no_tin_event_needs_remediation`). The use-case
 * under test is unchanged:
 *   issueCreditNote → MUST return err({ code: 'receipt_not_creditable' })
 *   (the §86/10 gate fires BEFORE the snapshot-completeness guard — a β row
 *   carries a legal NULL document_number and must hit the doc-type verdict,
 *   not no_snapshot_on_invoice; pinned by the Task 10 unit test in
 *   issue-credit-note.test.ts)
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
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { issueEventInvoiceAsPaid } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { IssueEventInvoiceAsPaidDeps } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

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

/**
 * Deps for the FIXTURE-building `issueEventInvoiceAsPaid` call (064 Task 10):
 * real repos + §87 allocator + identity + audit + outbox; mocked PDF render
 * (returns ISSUE_SHA so the byte-identical assertion below pins the AS-PAID
 * sha) + mocked Blob.
 */
function makeAsPaidFixtureDeps(tenantSlug: string): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: PDF_BYTES,
        sha256: Sha256Hex.ofUnsafe(ISSUE_SHA),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-20T10:00:00Z' },
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: 1,
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

    // PAID §105 no-TIN event row — built on the REAL use-case chain (064
    // Task 10): draft via createEventInvoiceDraft (no-TIN buyer snapshot
    // pinned at DRAFT) → issueEventInvoiceAsPaid (β receipt-stream
    // numbering). The committed row carries pdf_doc_kind 'receipt_separate',
    // sequence_number/document_number NULL, and
    // receipt_document_number_raw 'RCPR-2026-000001' (fresh tenant, receipt
    // prefix 'RCPR') — exactly what production writes for a walk-in buyer.
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-cnblock-draft-${regId}`,
        eventRegistrationId: regId,
        amountOverride: 25_000, // 250 THB inclusive @ 7% → 23364 + 1636
        buyer: BUYER_NO_TIN,
      },
    );
    if (!draft.ok) throw new Error(`fixture draft failed: ${draft.error.code}`);
    invoiceId = draft.value.invoiceId;

    const asPaid = await issueEventInvoiceAsPaid(makeAsPaidFixtureDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cnblock-aspaid-${invoiceId}`,
      invoiceId,
      paymentDate: '2026-04-19',
      paymentMethod: 'cash',
    });
    if (!asPaid.ok) {
      throw new Error(`fixture as-paid failed: ${asPaid.error.code}`);
    }
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
    // β fixture shape (064 Task 10) — the REAL as-paid no-TIN path committed
    // a receipt-STREAM row: no invoice-stream pair, RCPR receipt number.
    expect(before!.sequenceNumber).toBeNull();
    expect(before!.documentNumber).toBeNull();
    expect(before!.receiptDocumentNumberRaw).toBe('RCPR-2026-000001');
    expect(before!.pdfDocKind).toBe('receipt_separate');

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
