/**
 * Task 4 (064-event-invoice-paid-flow) — `applyIssueAsPaid` repo port
 * (live Neon Singapore via .env.local). REPO-LEVEL test: the use-case
 * consuming this port arrives in Task 5; here we prove the persistence
 * seam alone.
 *
 * `applyIssueAsPaid` is a SINGLE UPDATE that takes an event DRAFT
 * straight to `paid` with every snapshot / numbering / payment / pdf
 * field set in one statement. A successful commit therefore proves the
 * full set of non-draft + paid CHECK constraints simultaneously:
 *
 *   C1 invoices_non_draft_has_snapshots (0203) — subtotal/vat/total/fy/
 *      seq/docnum/issue_date/due_date/net_days/tenant+member snapshots/
 *      pdf triplet; pro_rate exempt for invoice_subject='event'.
 *   C2 invoices_paid_has_payment (0019)        — paid_at + payment_method.
 *   C3 invoices_paid_has_receipt_status (0056) — receipt_pdf_status
 *      NOT NULL on paid (MUST be 'rendered' here — the combined receipt
 *      IS the main PDF; never 'pending').
 *   C4 invoices_pending_has_receipt_doc_num (0061) — n/a ('rendered').
 *   C5 invoices_non_draft_has_doc_kind + invoices_pdf_doc_kind_valid
 *      (0211) — pdf_doc_kind='receipt_combined' for a TIN buyer.
 *   C6 invoices_subject_fields_ck (0208)       — subject columns untouched.
 *   C7 invoices_credited_* (0019)              — defaults (0) stay legal.
 *
 * The immutability trigger (`invoices_enforce_immutability`, latest body
 * migration 0207) early-returns when OLD.status='draft', so the single
 * draft→paid UPDATE passes; the SAME trigger then locks the row — pinned
 * by the post-paid raw-UPDATE rejection test below.
 *
 * NUMBERING SHAPE (β decision): only the TIN shape (`kind:
 * 'invoice_stream'` — sequence_number + document_number set,
 * receipt_document_number_raw NULL) is integration-tested HERE. The
 * no-TIN β shape (`kind: 'receipt_stream'` — seq/docnum NULL +
 * receipt_document_number_raw set) only satisfies
 * `invoices_non_draft_has_snapshots` after the Task 9 CHECK relax
 * migration; its test arrives with Task 9.
 *
 * Lives in tests/integration/** → hits live Neon. Migrations 0200–0211
 * MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { splitVatInclusive } from '@/modules/invoicing';
import type { Invoice, InvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// Non-member buyer WITH a Thai TIN → receipt_combined doc kind at as-paid.
const BUYER_WITH_TIN = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
} as const;

const ISSUE_DATE = '2026-06-10'; // == paymentDate (as-paid: issue at payment)
const TOTAL_SATANG = 10004n; // 100.04 THB inclusive (known VAT-exact case)
const SEQ = 9001;
const DOC_NUM = 'EVT-2026-009001';

/** Full TIN-shaped applyIssueAsPaid input for the seeded draft. */
function buildTinInput(tenantSlug: string, invoiceId: InvoiceId, recordedBy: string) {
  const split = splitVatInclusive(Money.fromSatangUnsafe(TOTAL_SATANG), 700n);
  return {
    tenantId: tenantSlug,
    invoiceId,
    fiscalYear: 2026,
    numbering: {
      kind: 'invoice_stream' as const,
      sequenceNumber: SEQ,
      documentNumber: DOC_NUM,
    },
    issueDate: ISSUE_DATE,
    subtotalSatang: split.subtotal.satang,
    vatRate: '0.0700',
    vatSatang: split.vat.satang,
    totalSatang: Money.fromSatangUnsafe(TOTAL_SATANG).satang,
    tenantIdentitySnapshot: {
      legal_name_th: 'หอการค้า',
      legal_name_en: 'Chamber',
      tax_id: '0000000000000',
      address_th: 'Bangkok',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    // snake_case — must satisfy BOTH the 0045 contact-email CHECK and the
    // zod read-boundary parse (memberIdentitySnapshotSchema) on reload.
    memberIdentitySnapshot: {
      ...BUYER_WITH_TIN,
      member_number: null,
      member_number_display: null,
    },
    pdf: {
      blobKey: `invoices/${tenantSlug}/2026/${DOC_NUM}_v1.pdf`,
      sha256: Sha256Hex.ofUnsafe('c'.repeat(64)),
      templateVersion: 1,
    },
    pdfDocKind: 'receipt_combined' as const,
    paymentMethod: 'bank_transfer' as const,
    paymentReference: 'KBANK-TXN-0042',
    paymentNotes: null,
    paymentRecordedByUserId: recordedBy,
    paymentDate: ISSUE_DATE,
  };
}

describe('applyIssueAsPaid — single UPDATE draft→paid (TIN / invoice_stream shape)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;
  let paidInvoice: Invoice;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const eventId = randomUUID();
    const registrationId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_as_paid_int',
        name: 'As-Paid Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId,
        eventId,
        externalId: 'att_as_paid_tin',
        attendeeEmail: 'jane@beta.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Beta Imports Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // Draft through the REAL use-case so the row is a genuine event draft
    // (subject columns + buyer snapshot pinned at draft, exactly as prod).
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-as-paid-draft-${registrationId}`,
        eventRegistrationId: registrationId,
        amountOverride: Number(TOTAL_SATANG),
        buyer: BUYER_WITH_TIN,
      },
    );
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    invoiceId = draft.value.invoiceId;

    // The act under test — single UPDATE draft→paid inside the repo tx.
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    paidInvoice = await repo.withTx(async (tx) =>
      repo.applyIssueAsPaid(tx, buildTinInput(tenant.ctx.slug, invoiceId, user.userId)),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('returns the paid Invoice: status/pdfDocKind/issue=due=payment date/netDays 0/paidAt', () => {
    expect(paidInvoice.status).toBe('paid');
    expect(paidInvoice.pdfDocKind).toBe('receipt_combined');
    expect(paidInvoice.issueDate).toBe(ISSUE_DATE);
    expect(paidInvoice.dueDate).toBe(ISSUE_DATE); // as-paid ⇒ due = issue
    expect(paidInvoice.paymentDate).toBe(ISSUE_DATE);
    expect(paidInvoice.netDays).toBe(0);
    expect(paidInvoice.paidAt).not.toBeNull();
    // Numbering — TIN shape carries the invoice stream.
    expect(paidInvoice.sequenceNumber).toBe(SEQ);
    expect(paidInvoice.documentNumber?.raw).toBe(DOC_NUM);
    expect(paidInvoice.receiptDocumentNumberRaw).toBeNull();
    // Money round-trips exactly.
    expect(paidInvoice.total?.satang).toBe(TOTAL_SATANG);
  });

  it('raw row passed every CHECK in the single UPDATE (receipt status, null receipt blob, null pro-rate, payment fields)', async () => {
    // Owner-role read (BYPASSRLS) — assert what is actually on disk.
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row).toBeDefined();
    expect(row!.status).toBe('paid');
    // C3 — receipt_pdf_status MUST land as 'rendered' (never 'pending').
    expect(row!.receiptPdfStatus).toBe('rendered');
    // Combined kind: the receipt IS the main PDF — no separate receipt blob.
    expect(row!.receiptPdfBlobKey).toBeNull();
    expect(row!.receiptDocumentNumberRaw).toBeNull();
    // C1 — pro_rate exempt for the event subject (stays NULL).
    expect(row!.proRatePolicySnapshot).toBeNull();
    expect(row!.netDaysSnapshot).toBe(0);
    // C2 — payment fields all set by the same UPDATE.
    expect(row!.paidAt).not.toBeNull();
    expect(row!.paymentMethod).toBe('bank_transfer');
    expect(row!.paymentReference).toBe('KBANK-TXN-0042');
    expect(row!.paymentRecordedByUserId).toBe(user.userId);
    expect(row!.paymentDate).toBe(ISSUE_DATE);
    // C5 — doc kind persisted.
    expect(row!.pdfDocKind).toBe('receipt_combined');
    // C1 — numbering + snapshots + pdf triplet present.
    expect(row!.fiscalYear).toBe(2026);
    expect(row!.sequenceNumber).toBe(SEQ);
    expect(row!.documentNumber).toBe(DOC_NUM);
    expect(row!.issueDate).toBe(ISSUE_DATE);
    expect(row!.dueDate).toBe(ISSUE_DATE);
    expect(row!.tenantIdentitySnapshot).not.toBeNull();
    expect(row!.memberIdentitySnapshot).not.toBeNull();
    expect(row!.pdfBlobKey).not.toBeNull();
    expect(row!.pdfSha256).toBe('c'.repeat(64));
    expect(row!.pdfTemplateVersion).toBe(1);
    // The beforeAll commit not throwing 23514 already proved C1–C7; the
    // field assertions above pin WHICH values made each CHECK pass.
  });

  it('second applyIssueAsPaid on the same row → InvoiceApplyConflictError(applyIssueAsPaid)', async () => {
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    let thrown: unknown = null;
    try {
      await repo.withTx(async (tx) =>
        repo.applyIssueAsPaid(tx, buildTinInput(tenant.ctx.slug, invoiceId, user.userId)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvoiceApplyConflictError);
    if (thrown instanceof InvoiceApplyConflictError) {
      expect(thrown.kind).toBe('applyIssueAsPaid');
    }
  }, 30_000);

  it('post-paid direct UPDATE of member_identity_snapshot → rejected by the immutability trigger', async () => {
    // Owner role bypasses RLS but NOT the BEFORE UPDATE trigger.
    let caught: unknown = null;
    try {
      await db.execute(sql`
        UPDATE invoices
           SET member_identity_snapshot = '{"legal_name":"EVIL"}'::jsonb
         WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected the immutability trigger to raise').not.toBeNull();
    // Drizzle 0.45+ wraps Postgres errors — walk the cause chain
    // (same pattern as settings-form.test.ts / redact-expired-event-buyers).
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(parts.join(' | ')).toMatch(/snapshot columns are immutable/i);
  }, 30_000);
});
