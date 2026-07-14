/**
 * COMP-1 US3-B — 10-year ERASED-member invoice PII-redaction sweep
 * (invoice arm; live Neon Singapore via .env.local).
 *
 * GDPR Art.17 / PDPA §33 give a member the right to erasure. Their F4 tax
 * documents (membership invoices + matched-member EVENT invoices) carry buyer
 * PII in `member_identity_snapshot` and on the issued §86/4 PDF, but Thai RD
 * §87/3 requires that document be retained for 10 years. Once that statutory
 * hold lifts, the retained copy's PII must also be minimised — this cron
 * (`/api/cron/invoicing/redact-expired-member-invoices`) tombstones JUST that
 * buyer-PII column (preserving every financial / §87-numbering field), purges
 * the PDF BYTES, and emits `event_buyer_pii_redacted` with a member
 * discriminator (`member_id` + `document_kind:'invoice'`).
 *
 * Eligibility (the gap-closing detail, decision #3) is `member_id IS NOT NULL`
 * joined to `members.erased_at IS NOT NULL` — NOT `invoice_subject='membership'`
 * — so a MATCHED-MEMBER EVENT invoice (`invoice_subject='event' AND member_id
 * IS NOT NULL`) is ALSO redacted; it carries the member's buyer PII and would
 * otherwise fall in the gap between the two crons (the event-buyer cron handles
 * only `member_id IS NULL`).
 *
 * Invoice-arm cases pinned here:
 *   1. ERASED member 11y-old MEMBERSHIP invoice → tombstoned + audit
 *      (`member_id` + `document_kind:'invoice'`); financial / numbering
 *      PRESERVED (§87 integrity).
 *   2. ERASED member 11y-old MATCHED-MEMBER EVENT invoice → tombstoned (the gap
 *      case — `invoice_subject='event'` + `member_id IS NOT NULL`).
 *   3. NON-erased member 11y-old invoice → INTACT (relationship still live; the
 *      member's PII retention is governed by the F3/F9 member lifecycle, not
 *      this erasure sweeper).
 *   4. ERASED member <10y invoice → INTACT (statutory retention not elapsed).
 *   5. idempotent — a 2nd run does NOT re-emit the audit.
 *
 * Credit-note-arm cases pinned here (Task 4 — credit_notes has NO member_id, so
 * the cron joins via `original_invoice_id → invoices.member_id`; the 10y anchor
 * is the credit note's OWN issue_date):
 *   6. ERASED member 11y-old CREDIT NOTE → tombstoned + PDF purged + audit
 *      (`member_id` + `document_kind:'credit_note'` + `original_invoice_id`).
 *   7. NON-erased member 11y-old credit note → INTACT.
 *
 * (The cross-tenant RLS isolation test driving
 * `redactExpiredMemberDocumentsForTenant` directly is Task 5.)
 *
 * Migrations through 0227 MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { PDFParse } from 'pdf-parse';

import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  POST as redactCron,
  redactExpiredMemberDocumentsForTenant,
} from '@/app/api/cron/invoicing/redact-expired-member-invoices/route';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
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

/** A complete buyer PII snapshot as pinned at issue on an erased member's invoice. */
const BUYER = {
  legal_name: 'Erased Member Co Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@erased-member.example',
} as const;

/** Common fully-formed financial/numbering fields for an ISSUED invoice. */
const ISSUED_NUMBERS = {
  subtotalSatang: 9350n,
  vatRateSnapshot: '0.0700',
  vatSatang: 654n,
  totalSatang: 10004n,
  netDaysSnapshot: 30,
  tenantIdentitySnapshot: {
    legal_name_en: 'Chamber',
    legal_name_th: 'หอการค้า',
    tax_id: '0000000000000',
    address: 'Bangkok',
  },
  pdfSha256: '0'.repeat(64),
  pdfTemplateVersion: 1,
};

let seqCounter = 940_000;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/**
 * Decompress a rendered PDF's bytes back to plain text (pdf-parse) so the
 * tax-retention regression can assert on glyphs the §86/4 buyer block emits —
 * the SAME extraction the F4 PDF golden tests use
 * (`member-number-pdf-golden.test.ts`). NOT a hand-rolled renderer: the PDF is
 * produced by the REAL `reactPdfRenderAdapter`.
 */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

describe('redact-expired-member-invoices — invoice arm (COMP-1 US3-B, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let blobDeleteSpy: MockInstance<(key: string) => Promise<void>>;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');

    // tenant_invoice_settings is keyed by tenant_id only — seed once (it makes
    // this tenant appear in the cron's cross-tenant tenant-list).
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
        invoiceNumberPrefix: 'MEM',
        creditNoteNumberPrefix: 'MEMC',
      });
    });
  }, 90_000);

  beforeEach(() => {
    // Spy on the blob-storage delete so the cron's PII-PDF purge is observed
    // WITHOUT hitting real Vercel Blob (the seeded keys are synthetic test
    // paths). mockResolvedValue mirrors the adapter's `Promise<void>` contract.
    blobDeleteSpy = vi.spyOn(vercelBlobAdapter, 'delete').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant.cleanup().catch(() => {});
  });

  function callCron(): Promise<Response> {
    const req = new NextRequest(
      'http://localhost/api/cron/invoicing/redact-expired-member-invoices',
      { method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
    );
    return redactCron(req);
  }

  /** Seed a membership plan; returns the planId (each member uses its own). */
  async function seedPlan(): Promise<string> {
    const planId = `mem-redact-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Member Redact Plan' },
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
    });
    return planId;
  }

  /** Seed a member; `erased` decides whether `erased_at` is stamped. */
  async function seedMember(planId: string, erased: boolean): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Erased Member Co',
        country: 'TH',
        taxId: '9876543210123',
        planId,
        planYear: 2026,
      });
      if (erased) {
        await tx.execute(
          sql`UPDATE members SET erased_at = now() WHERE tenant_id = ${tenant.ctx.slug} AND member_id = ${memberId}`,
        );
      }
    });
    return memberId;
  }

  async function seedErasedMember(planId: string): Promise<string> {
    return seedMember(planId, true);
  }
  async function seedActiveMember(planId: string): Promise<string> {
    return seedMember(planId, false);
  }

  /**
   * Seed an ISSUED MEMBERSHIP invoice for a member with a frozen buyer
   * snapshot + a back-dated issue_date. Insert as draft then promote via a
   * single UPDATE (the trigger's OLD.status='draft' branch lets the issue
   * through). Returns the invoice_id + its PDF blob keys.
   */
  async function seedIssuedMembershipInvoice(
    memberId: string,
    planId: string,
    issueDate: string,
  ): Promise<{ invoiceId: string; pdfKey: string }> {
    const invoiceId = randomUUID();
    const seq = nextSeq();
    const pdfKey = `test/redact-mem-${seq}.pdf`;
    // Membership snapshot — decision #4: member_number ⟺ member_number_display
    // both non-null on a membership invoice (the pairing is preserved by the
    // jsonb-merge redaction; the route never zod-validates, but seed it real).
    const snapshot = {
      ...BUYER,
      member_number: 42,
      member_number_display: 'MEM-0042',
    };
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        invoiceSubject: 'membership',
        memberId,
        planId,
        planYear: 2026,
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          pdf_doc_kind = 'invoice',
          fiscal_year = 2014,
          sequence_number = ${seq},
          document_number = ${`MEM14-${seq}`},
          issue_date = ${issueDate}::date,
          due_date = (${issueDate}::date + interval '30 days')::date,
          subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
          vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
          vat_satang = ${ISSUED_NUMBERS.vatSatang},
          total_satang = ${ISSUED_NUMBERS.totalSatang},
          net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
          pro_rate_policy_snapshot = 'none',
          tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
          member_identity_snapshot = ${JSON.stringify(snapshot)}::jsonb,
          pdf_blob_key = ${pdfKey},
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}
      `);
    });
    return { invoiceId, pdfKey };
  }

  /**
   * Seed an ISSUED MATCHED-MEMBER EVENT invoice (`invoice_subject='event'` +
   * `member_id IS NOT NULL`) — the gap-closure case. Needs an event +
   * registration to satisfy the event-discriminator FKs.
   */
  async function seedMatchedMemberEventInvoice(
    memberId: string,
    issueDate: string,
  ): Promise<{ invoiceId: string; pdfKey: string }> {
    const invoiceId = randomUUID();
    const eventId = randomUUID();
    const regId = randomUUID();
    const seq = nextSeq();
    const pdfKey = `test/redact-mem-evt-${seq}.pdf`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt_mem_redact_${seq}`,
        name: 'Old Member Gala',
        startDate: new Date('2014-09-10T11:00:00Z'),
      });
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: `att_mem_${seq}`,
        attendeeEmail: 'jane@erased-member.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Erased Member Co Ltd',
        // A matched-member registration (CHECK allows member_contact /
        // member_domain / member_fuzzy). `member_domain` carries a
        // matched_member_id without the member_contact contact-id requirement.
        matchType: 'member_domain',
        matchedMemberId: memberId,
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2014-09-01T03:00:00Z'),
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: regId,
        vatInclusive: true,
        memberId,
        planId: null,
        planYear: null,
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          pdf_doc_kind = 'invoice',
          fiscal_year = 2014,
          sequence_number = ${seq},
          document_number = ${`MEM14-${seq}`},
          issue_date = ${issueDate}::date,
          due_date = (${issueDate}::date + interval '30 days')::date,
          subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
          vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
          vat_satang = ${ISSUED_NUMBERS.vatSatang},
          total_satang = ${ISSUED_NUMBERS.totalSatang},
          net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
          pro_rate_policy_snapshot = NULL,
          tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
          member_identity_snapshot = ${JSON.stringify(BUYER)}::jsonb,
          pdf_blob_key = ${pdfKey},
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}
      `);
    });
    return { invoiceId, pdfKey };
  }

  /**
   * Seed an ISSUED member CREDIT NOTE against a parent invoice (born-issued, no
   * draft phase). `credit_notes` has NO `member_id` — the cron joins it via
   * `original_invoice_id → invoices.member_id`, so the parent invoice's member
   * drives eligibility. The 10y anchor is the credit note's OWN `issue_date`
   * (decision #1). Returns the credit_note_id + its single PDF blob key.
   */
  async function seedCreditNote(
    originalInvoiceId: string,
    issueDate: string,
  ): Promise<{ creditNoteId: string; pdfKey: string }> {
    const creditNoteId = randomUUID();
    const seq = nextSeq();
    const pdfKey = `test/redact-mem-cn-${seq}.pdf`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(creditNotes).values({
        tenantId: tenant.ctx.slug,
        creditNoteId,
        originalInvoiceId,
        fiscalYear: 2014,
        sequenceNumber: seq,
        documentNumber: `MEMC14-${seq}`,
        issueDate,
        issuedByUserId: user.userId,
        reason: 'US3-B credit-note redaction fixture',
        creditAmountSatang: 9350n,
        vatSatang: 654n,
        totalSatang: 10004n,
        tenantIdentitySnapshot: ISSUED_NUMBERS.tenantIdentitySnapshot,
        memberIdentitySnapshot: BUYER,
        pdfBlobKey: pdfKey,
        pdfSha256: ISSUED_NUMBERS.pdfSha256,
        pdfTemplateVersion: ISSUED_NUMBERS.pdfTemplateVersion,
      });
    });
    return { creditNoteId, pdfKey };
  }

  async function readSnapshot(invoiceId: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row!.memberIdentitySnapshot as Record<string, unknown>;
  }

  async function readInvoicePiiBlobPurgedAt(invoiceId: string): Promise<Date | null> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row!.piiBlobPurgedAt;
  }

  /**
   * Force a row into the "already tombstoned, NOT yet purged" state WITHOUT a
   * prior cron run: a GUC-gated UPDATE that collapses the buyer snapshot to the
   * redacted form (exactly the `jsonb_build_object` merge `redact-buyer-pii-step`
   * applies) while leaving `pii_blob_purged_at` NULL and `pdf_blob_key` intact.
   * `SET LOCAL app.allow_pii_redaction='true'` is the SAME exemption the cron
   * uses (migration 0205/0206) — only `member_identity_snapshot` changes, so the
   * immutability trigger permits it. This reaches the member-arm's retry re-select
   * branch (route.ts: `legal_name='[REDACTED]' AND pii_blob_purged_at IS NULL AND
   * pdf_blob_key IS NOT NULL`) on the FIRST cron tick.
   */
  async function tombstoneInvoiceSnapshotUnpurged(invoiceId: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      await tx.execute(sql`
        UPDATE invoices
        SET member_identity_snapshot = member_identity_snapshot
          || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
               'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL)
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}
      `);
    });
  }

  /** Credit-note analogue of {@link tombstoneInvoiceSnapshotUnpurged}. */
  async function tombstoneCreditNoteSnapshotUnpurged(creditNoteId: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      await tx.execute(sql`
        UPDATE credit_notes
        SET member_identity_snapshot = member_identity_snapshot
          || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
               'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL)
        WHERE tenant_id = ${tenant.ctx.slug} AND credit_note_id = ${creditNoteId}
      `);
    });
  }

  async function readCreditNoteRow(
    creditNoteId: string,
  ): Promise<{ snapshot: Record<string, unknown>; piiBlobPurgedAt: Date | null }> {
    const [row] = await db
      .select()
      .from(creditNotes)
      .where(
        and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.creditNoteId, creditNoteId)),
      );
    return {
      snapshot: row!.memberIdentitySnapshot as Record<string, unknown>,
      piiBlobPurgedAt: row!.piiBlobPurgedAt,
    };
  }

  async function creditNoteAuditPayloadsFor(
    creditNoteId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_buyer_pii_redacted'),
        ),
      );
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p.credit_note_id === creditNoteId);
  }

  async function auditPayloadsFor(invoiceId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_buyer_pii_redacted'),
        ),
      );
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p.invoice_id === invoiceId);
  }

  /** The §87 tax-relevant fields that MUST survive a buyer-PII redaction untouched. */
  interface InvoiceTaxFields {
    readonly status: string;
    readonly documentNumber: string | null;
    readonly fiscalYear: number | null;
    readonly sequenceNumber: number | null;
    readonly totalSatang: bigint | null;
    readonly subtotalSatang: bigint | null;
    readonly vatSatang: bigint | null;
    readonly vatRateSnapshot: string | null;
    readonly issueDate: string | null;
    readonly dueDate: string | null;
    readonly tenantIdentitySnapshot: unknown;
  }

  async function readInvoiceTaxFields(invoiceId: string): Promise<InvoiceTaxFields> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return {
      status: row!.status,
      documentNumber: row!.documentNumber,
      fiscalYear: row!.fiscalYear,
      sequenceNumber: row!.sequenceNumber,
      totalSatang: row!.totalSatang,
      subtotalSatang: row!.subtotalSatang,
      vatSatang: row!.vatSatang,
      vatRateSnapshot: row!.vatRateSnapshot,
      issueDate: row!.issueDate,
      dueDate: row!.dueDate,
      tenantIdentitySnapshot: row!.tenantIdentitySnapshot,
    };
  }

  /**
   * Re-render the issued §86/4 invoice PDF FROM THE FROZEN DB SNAPSHOT and
   * return its extracted text. This proves the document is driven by the
   * `member_identity_snapshot` column (NOT the live, separately-scrubbed member
   * row), so once the cron tombstones that snapshot the re-rendered tax-document
   * copy is genuinely minimised. Reuses the REAL `reactPdfRenderAdapter` +
   * pdf-parse (no hand-rolled renderer) — the buyer block is built straight from
   * the persisted snapshot's `legal_name`/`tax_id`/`address`/contact fields.
   */
  async function reRenderInvoicePdfTextFromSnapshot(invoiceId: string): Promise<string> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    const snapshot = row!.memberIdentitySnapshot as Record<string, unknown>;
    // Rebuild the buyer block directly from the persisted jsonb — exactly the
    // fields the issue-time render-input wiring copies onto the PDF. The redacted
    // form (legal_name='[REDACTED]', tax_id=null, primary_contact_email='') stays
    // a valid MemberIdentitySnapshot, so the template renders it without throwing.
    const member: MemberIdentitySnapshot = {
      legal_name: String(snapshot.legal_name),
      tax_id: snapshot.tax_id === null ? null : String(snapshot.tax_id),
      address: String(snapshot.address),
      primary_contact_name: String(snapshot.primary_contact_name),
      primary_contact_email: String(snapshot.primary_contact_email),
      member_number:
        snapshot.member_number === null || snapshot.member_number === undefined
          ? null
          : Number(snapshot.member_number),
      member_number_display:
        snapshot.member_number_display === null || snapshot.member_number_display === undefined
          ? null
          : String(snapshot.member_number_display),
    };
    const tenantSnap = row!.tenantIdentitySnapshot as {
      legal_name_en: string;
      legal_name_th: string;
      tax_id: string;
      address: string;
    };
    const docR = DocumentNumber.of('MEM', row!.fiscalYear ?? 2014, row!.sequenceNumber ?? 1);
    if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
    const line: InvoiceLine = {
      lineId: asInvoiceLineId(randomUUID()),
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก',
      descriptionEn: 'Membership 2014',
      unitPrice: Money.fromSatangUnsafe(9_350n),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      total: Money.fromSatangUnsafe(9_350n),
      position: 1,
    };
    const input: PdfRenderInput = {
      kind: 'invoice',
      templateVersion: 1,
      documentNumber: docR.value,
      issueDate: '2014-01-01',
      dueDate: '2014-01-31',
      tenant: {
        legal_name_th: tenantSnap.legal_name_th,
        legal_name_en: tenantSnap.legal_name_en,
        tax_id: tenantSnap.tax_id,
        address_th: tenantSnap.address,
        address_en: tenantSnap.address,
        logo_blob_key: null,
      },
      member,
      // 059 / PR-A Task 6b — templateVersion 1 predates the v11 registrant gate
      // (this file's subject is PII redaction, not the Tax ID line).
      lines: [line],
      subtotal: Money.fromSatangUnsafe(9_350n),
      vatRate: VatRate.ofUnsafe('0.0700'),
      vat: Money.fromSatangUnsafe(654n),
      total: Money.fromSatangUnsafe(10_004n),
    };
    const { bytes } = await reactPdfRenderAdapter.render(input);
    return extractPdfText(bytes);
  }

  it('tombstones an ERASED member 11y-old MEMBERSHIP invoice + records the audit; financial fields preserved', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId, pdfKey } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');

    const res = await callCron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redactedCount: number; tenantsSwept: number };
    expect(body.redactedCount).toBeGreaterThanOrEqual(1);
    expect(body.tenantsSwept).toBeGreaterThanOrEqual(1);

    // Snapshot tombstoned (PII → '[REDACTED]' / '' / null).
    const snap = await readSnapshot(invoiceId);
    expect(snap.legal_name).toBe('[REDACTED]');
    expect(snap.address).toBe('[REDACTED]');
    expect(snap.primary_contact_name).toBe('[REDACTED]');
    expect(snap.primary_contact_email).toBe('');
    expect(snap.tax_id).toBeNull();
    // member_number kept (not PII — a per-tenant sequence id; decision #4).
    expect(snap.member_number).toBe(42);
    expect(snap.member_number_display).toBe('MEM-0042');

    // Financial / numbering fields PRESERVED untouched (§87 integrity).
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('issued');
    expect(BigInt(row!.totalSatang!.toString())).toBe(10004n);
    expect(BigInt(row!.subtotalSatang!.toString())).toBe(9350n);
    expect(row!.documentNumber).toBe(`MEM14-${row!.sequenceNumber}`);

    // Audit row present: event_buyer_pii_redacted with member discriminator.
    const payloads = await auditPayloadsFor(invoiceId);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      invoice_id: invoiceId,
      member_id: memberId,
      document_kind: 'invoice',
      invoice_subject: 'membership',
    });
    // No PII value anywhere in the serialised payload.
    const payloadStr = JSON.stringify(payloads[0]);
    expect(payloadStr).not.toContain('Erased Member Co Ltd');
    expect(payloadStr).not.toContain('9876543210123');
    expect(payloadStr).not.toContain('jane@erased-member.example');

    // The issued PDF BYTES were erased.
    const deletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(pdfKey);

    // C2 — the invoice arm's marker-stamp leg of `purgeBuyerPdfBlobsAndStampMarker`:
    // after a fully successful PDF-byte purge the cron stamps `pii_blob_purged_at`
    // (the credit-note happy path already asserts this; the invoice path did not,
    // leaving the invoice marker-stamp leg unverified). NON-NULL proves the purge
    // completed AND the separate GUC-gated marker UPDATE landed.
    expect(await readInvoicePiiBlobPurgedAt(invoiceId)).not.toBeNull();
  }, 60_000);

  it('tombstones an ERASED member 11y-old MATCHED-MEMBER EVENT invoice (the gap case)', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedMatchedMemberEventInvoice(memberId, '2014-01-01');

    await callCron();

    const snap = await readSnapshot(invoiceId);
    expect(snap.legal_name).toBe('[REDACTED]');
    expect(snap.tax_id).toBeNull();

    const payloads = await auditPayloadsFor(invoiceId);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      invoice_id: invoiceId,
      member_id: memberId,
      document_kind: 'invoice',
      invoice_subject: 'event',
    });
  }, 60_000);

  it('LEAVES a NON-erased member 11y-old invoice fully intact (relationship still live)', async () => {
    const planId = await seedPlan();
    const memberId = await seedActiveMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');

    await callCron();

    const snap = await readSnapshot(invoiceId);
    expect(snap.legal_name).toBe('Erased Member Co Ltd');
    expect(snap.tax_id).toBe('9876543210123');
    expect(await auditPayloadsFor(invoiceId)).toHaveLength(0);
  }, 60_000);

  it('LEAVES an erased member <10y invoice intact (retention not elapsed)', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2024-01-01');

    await callCron();

    const snap = await readSnapshot(invoiceId);
    expect(snap.legal_name).toBe('Erased Member Co Ltd');
    expect(await auditPayloadsFor(invoiceId)).toHaveLength(0);
  }, 60_000);

  it('is idempotent — a 2nd run does not re-emit the audit', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');

    await callCron();
    await callCron();

    expect(await auditPayloadsFor(invoiceId)).toHaveLength(1);
  }, 60_000);

  it('LEAVES an erased member >10y DRAFT invoice intact (eligible-query gates on status <> draft)', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    // Seed an erased-member >10y MEMBERSHIP invoice that — but for its status —
    // would be redacted (this same fixture is redacted in the very first test).
    const { invoiceId, pdfKey } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');

    // Flip it BACK to draft. The immutability trigger only locks the snapshot /
    // numbering / financial columns once OLD.status != 'draft'; `status` itself
    // is NOT a locked column, so a plain status-only UPDATE (no GUC) lands. Every
    // non-draft CHECK is `status='draft' OR <X>` form, so a draft carrying the
    // already-populated snapshot/numbering columns stays valid.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(
        sql`UPDATE invoices SET status = 'draft' WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}`,
      );
    });

    await callCron();

    // The draft row is UNTOUCHED — the eligible-query's `i.status <> 'draft'`
    // clause excludes it even though the member is erased + the invoice is >10y.
    const snap = await readSnapshot(invoiceId);
    expect(snap.legal_name).toBe('Erased Member Co Ltd');
    expect(snap.tax_id).toBe('9876543210123');
    // Still draft, snapshot intact, PDF NOT purged, marker NOT stamped.
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row!.status).toBe('draft');
    expect(row!.piiBlobPurgedAt).toBeNull();
    // The draft's PDF key was NEVER purged (the row never entered the purge loop).
    const deletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedKeys).not.toContain(pdfKey);
    // …and ZERO audit rows were emitted for it.
    expect(await auditPayloadsFor(invoiceId)).toHaveLength(0);
  }, 60_000);

  // ── Credit-note arm (Task 4) — joined via original_invoice_id → invoices.member_id ──

  it('tombstones an ERASED member 11y-old CREDIT NOTE + purges its PDF, joined via original invoice', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');
    const { creditNoteId, pdfKey } = await seedCreditNote(invoiceId, '2014-02-01');

    await callCron();

    const { snapshot, piiBlobPurgedAt } = await readCreditNoteRow(creditNoteId);
    expect(snapshot.legal_name).toBe('[REDACTED]');
    expect(snapshot.address).toBe('[REDACTED]');
    expect(snapshot.primary_contact_name).toBe('[REDACTED]');
    expect(snapshot.primary_contact_email).toBe('');
    expect(snapshot.tax_id).toBeNull();
    // A real blob key was seeded → purged → marker stamped.
    expect(piiBlobPurgedAt).not.toBeNull();
    const deletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(pdfKey);

    // Audit row present with the credit-note discriminator.
    const payloads = await creditNoteAuditPayloadsFor(creditNoteId);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      credit_note_id: creditNoteId,
      member_id: memberId,
      document_kind: 'credit_note',
      original_invoice_id: invoiceId,
    });
    // No PII value anywhere in the serialised payload.
    const payloadStr = JSON.stringify(payloads[0]);
    expect(payloadStr).not.toContain('Erased Member Co Ltd');
    expect(payloadStr).not.toContain('9876543210123');
    expect(payloadStr).not.toContain('jane@erased-member.example');
  }, 60_000);

  it('LEAVES a NON-erased member 11y-old credit note intact (relationship still live)', async () => {
    const planId = await seedPlan();
    const memberId = await seedActiveMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');
    const { creditNoteId } = await seedCreditNote(invoiceId, '2014-02-01');

    await callCron();

    const { snapshot } = await readCreditNoteRow(creditNoteId);
    expect(snapshot.legal_name).toBe(BUYER.legal_name);
    expect(snapshot.legal_name).not.toBe('[REDACTED]');
    expect(snapshot.tax_id).toBe('9876543210123');
    expect(await creditNoteAuditPayloadsFor(creditNoteId)).toHaveLength(0);
  }, 60_000);

  // ── C1: member-arm retry purge (redacted-but-unpurged re-select) ──────────
  // Guards the member arm's `legal_name='[REDACTED]' AND pii_blob_purged_at IS
  // NULL AND pdf_blob_key IS NOT NULL` re-select branch (route.ts invoice
  // :173-180 / credit-note :248-255). The event-buyer suite exercises the SAME
  // helper but through a DIFFERENT eligible-query (member_id IS NULL), so it does
  // NOT cover this arm's `JOIN members … erased_at` re-select. The retry must:
  // (1) purge the blob, (2) stamp the marker, (3) NOT re-emit the audit (the
  // `already_tombstoned` arm in `tombstoneBuyerPiiAndAuditInTx` skips the
  // tombstone UPDATE + audit). A fresh audit row on retry would be a real
  // regression (double-audit on a path that is supposed to be audit-once).

  it('C1: retries the blob purge for a redacted-but-unpurged MEMBERSHIP invoice WITHOUT re-emitting the audit', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId, pdfKey } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');
    // Drive the snapshot to the redacted form with the marker STILL NULL + the
    // PDF key intact — the "tombstoned on a prior pass, purge never completed"
    // state, reached without an earlier cron run.
    await tombstoneInvoiceSnapshotUnpurged(invoiceId);
    expect(await readInvoicePiiBlobPurgedAt(invoiceId)).toBeNull();

    await callCron();

    // The retry purge ran: the blob delete WAS called for the row's key …
    const deletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(pdfKey);
    // … and the marker is now stamped (the retry completed the purge).
    expect(await readInvoicePiiBlobPurgedAt(invoiceId)).not.toBeNull();
    // The snapshot stays redacted (no re-exposure).
    const snap = await readSnapshot(invoiceId);
    expect(snap.legal_name).toBe('[REDACTED]');

    // The retry arm did NOT emit an audit. We reach the redacted-but-unpurged
    // state via a direct GUC UPDATE (which does NOT audit) rather than a prior
    // cron run, so this invoice's cron-emitted audit count is 0 — the load-bearing
    // assertion is that the retry purge added ZERO audit rows. If the retry path
    // wrongly fell through to the fresh-tombstone audit emit, this would be 1
    // (a double-audit regression on an audit-once path).
    expect(await auditPayloadsFor(invoiceId)).toHaveLength(0);
  }, 60_000);

  it('C1: retries the blob purge for a redacted-but-unpurged CREDIT NOTE WITHOUT re-emitting the audit', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');
    const { creditNoteId, pdfKey } = await seedCreditNote(invoiceId, '2014-02-01');
    await tombstoneCreditNoteSnapshotUnpurged(creditNoteId);
    {
      const { piiBlobPurgedAt } = await readCreditNoteRow(creditNoteId);
      expect(piiBlobPurgedAt).toBeNull();
    }

    await callCron();

    const deletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(pdfKey);
    const { snapshot, piiBlobPurgedAt } = await readCreditNoteRow(creditNoteId);
    expect(piiBlobPurgedAt).not.toBeNull();
    expect(snapshot.legal_name).toBe('[REDACTED]');
    // Audit not re-emitted on the retry arm.
    expect(await creditNoteAuditPayloadsFor(creditNoteId)).toHaveLength(0);
  }, 60_000);

  // ── I1: credit-note <10y boundary (anchored on the CN's OWN issue_date) ───
  // The parent invoice is >10y (gets redacted), but the credit note's OWN
  // issue_date is <10y → the CN MUST stay intact + un-audited. This pins the
  // decision that the 10y anchor is `cn.issue_date`, NOT `i.issue_date`
  // (route.ts:246). If someone "simplifies" the join to anchor on the parent
  // invoice's date, the CN would wrongly redact and this test fails.

  it('I1: LEAVES a <10y CREDIT NOTE intact even though its >10y parent invoice IS redacted (CN anchored on its OWN issue_date)', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    // Parent invoice >10y → eligible, will be redacted.
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');
    // Credit note <10y → NOT eligible (its own retention window has not elapsed).
    const { creditNoteId } = await seedCreditNote(invoiceId, '2024-02-01');

    await callCron();

    // The PARENT invoice was redacted (proves the cron ran + the member is eligible).
    const invSnap = await readSnapshot(invoiceId);
    expect(invSnap.legal_name).toBe('[REDACTED]');
    expect(await auditPayloadsFor(invoiceId)).toHaveLength(1);

    // The CREDIT NOTE is INTACT — anchored on its own (<10y) issue_date.
    const { snapshot } = await readCreditNoteRow(creditNoteId);
    expect(snapshot.legal_name).toBe(BUYER.legal_name);
    expect(snapshot.legal_name).not.toBe('[REDACTED]');
    expect(snapshot.tax_id).toBe('9876543210123');
    expect(await creditNoteAuditPayloadsFor(creditNoteId)).toHaveLength(0);
  }, 60_000);

  // ── Reviewer-required properties (Task 5) ─────────────────────────────────
  // (a) §87 no-gaps integrity · (b) tax-retention PDF re-render regression ·
  // (c) Principle-I cross-tenant isolation (the Review-Gate blocker).

  it('§87 no-gaps integrity: redaction PRESERVES document_number + amounts + seller identity + member_number (only buyer PII tombstoned)', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');

    const before = await readInvoiceTaxFields(invoiceId);
    await callCron();
    const after = await readInvoiceTaxFields(invoiceId);

    // The §87 sequential-numbering record + the §86/4 amounts + the SELLER
    // identity snapshot are UNCHANGED — a redacted tax document is still a valid,
    // gap-free statutory record (only the BUYER PII is minimised).
    expect(after.status).toBe(before.status);
    expect(after.documentNumber).toBe(before.documentNumber);
    expect(after.fiscalYear).toBe(before.fiscalYear);
    expect(after.sequenceNumber).toBe(before.sequenceNumber);
    expect(after.totalSatang).toBe(before.totalSatang);
    expect(after.subtotalSatang).toBe(before.subtotalSatang);
    expect(after.vatSatang).toBe(before.vatSatang);
    // The VAT-rate snapshot + the §86/4 tax-point dates (issue_date / due_date)
    // are equally load-bearing on a Thai tax document — they are NOT buyer PII,
    // so the redaction MUST leave them untouched (widens the "only buyer PII
    // changed" guarantee beyond the numbering + amount fields).
    expect(after.vatRateSnapshot).toBe(before.vatRateSnapshot);
    expect(after.issueDate).toBe(before.issueDate);
    expect(after.dueDate).toBe(before.dueDate);
    expect(after.tenantIdentitySnapshot).toEqual(before.tenantIdentitySnapshot);

    // member_number / member_number_display are KEPT (master design §5 — a
    // per-tenant sequence id, NOT PII). The buyer block, in contrast, IS redacted.
    const snap = await readSnapshot(invoiceId);
    expect(snap.member_number).toBe(42);
    expect(snap.member_number_display).toBe('MEM-0042');
    expect(snap.legal_name).toBe('[REDACTED]');
  }, 60_000);

  it('tax-retention regression: the re-rendered PDF shows the buyer BEFORE redaction and is [REDACTED] after (the snapshot drives the document)', async () => {
    const planId = await seedPlan();
    const memberId = await seedErasedMember(planId);
    const { invoiceId } = await seedIssuedMembershipInvoice(memberId, planId, '2014-01-01');

    // BEFORE: re-render from the frozen DB snapshot → the buyer legal name prints.
    const pdfBefore = await reRenderInvoicePdfTextFromSnapshot(invoiceId);
    expect(pdfBefore).toContain(BUYER.legal_name);

    await callCron();

    // AFTER: re-render from the (now tombstoned) snapshot → the buyer is gone,
    // replaced by '[REDACTED]'. This proves the retained tax-document COPY is
    // genuinely minimised — the PDF is driven by the frozen snapshot, not the
    // live (separately-scrubbed) member row.
    const pdfAfter = await reRenderInvoicePdfTextFromSnapshot(invoiceId);
    expect(pdfAfter).not.toContain(BUYER.legal_name);
    expect(pdfAfter).toContain('[REDACTED]');
  }, 120_000);

  // ── FIX #6: per-tick LIMIT + forward progress ─────────────────────────────
  // The §87/3 redaction crons must BOUND the per-tick eligibility SELECT so an
  // unbounded backlog cannot starve forward progress. Pre-fix, the eligible
  // SELECT had NO `LIMIT`: a high-volume / backdated tenant accruing tens of
  // thousands of >10y rows would try to tombstone + purge EVERY one in ONE tick,
  // exceed `maxDuration=300`, get the tx killed mid-loop, roll back → ZERO
  // forward progress (the same rows re-selected forever). The fix adds
  // `LIMIT ${MAX_PER_TICK}` to BOTH eligible SELECTs (invoice arm + credit-note
  // arm), where MAX_PER_TICK reads `REDACTION_MAX_PER_TICK` (default 50) live
  // from process.env at request time. With SKIP LOCKED, each tick drains ≤N
  // un-contended rows; the cron's re-ticks drain the rest.
  //
  // Driven via `redactExpiredMemberDocumentsForTenant` against a DEDICATED
  // tenant so the per-tick count is EXACT (the shared describe-tenant carries
  // other tests' rows; a fresh tenant guarantees the only eligible rows are the
  // three seeded here). On HEAD (no LIMIT) the first-tick assertion FAILS — all
  // 3 are redacted at once.

  it('FIX #6: bounds redaction to REDACTION_MAX_PER_TICK per tick and makes forward progress across ticks', async () => {
    const t = await createTestTenant('test-chamber');
    try {
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: t.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 0n,
          legalNameTh: 'หอการค้า',
          legalNameEn: 'Chamber',
          taxId: '0000000000000',
          registeredAddressTh: 'Bangkok',
          registeredAddressEn: 'Bangkok',
          invoiceNumberPrefix: 'MEMBP',
          creditNoteNumberPrefix: 'MEMBPC',
        });
      });

      // Seed a plan + an ERASED member + 3 (= N+1 for N=2) eligible >10y
      // membership invoices, all in tenant `t`.
      const planIdBp = `mem-redact-plan-bp-${randomUUID().slice(0, 8)}`;
      const memberIdBp = randomUUID();
      const bpInvoiceIds: string[] = [];
      let bpSeq = 980_000;
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: planIdBp,
          planYear: 2026,
          planName: { en: 'BP Plan' },
          description: { en: 'BP' },
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
          tenantId: t.ctx.slug,
          memberId: memberIdBp,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'BP Erased Co',
          country: 'TH',
          taxId: '9876543210123',
          planId: planIdBp,
          planYear: 2026,
        });
        await tx.execute(
          sql`UPDATE members SET erased_at = now() WHERE tenant_id = ${t.ctx.slug} AND member_id = ${memberIdBp}`,
        );
        for (let i = 0; i < 3; i += 1) {
          const invoiceId = randomUUID();
          bpSeq += 1;
          bpInvoiceIds.push(invoiceId);
          await tx.insert(invoices).values({
            tenantId: t.ctx.slug,
            invoiceId,
            invoiceSubject: 'membership',
            memberId: memberIdBp,
            planId: planIdBp,
            planYear: 2026,
            draftByUserId: user.userId,
            status: 'draft',
          });
          await tx.execute(sql`
            UPDATE invoices SET
              status = 'issued',
              pdf_doc_kind = 'invoice',
              fiscal_year = 2014,
              sequence_number = ${bpSeq},
              document_number = ${`MEMBP14-${bpSeq}`},
              issue_date = '2014-01-01'::date,
              due_date = '2014-01-31'::date,
              subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
              vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
              vat_satang = ${ISSUED_NUMBERS.vatSatang},
              total_satang = ${ISSUED_NUMBERS.totalSatang},
              net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
              pro_rate_policy_snapshot = 'none',
              tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
              member_identity_snapshot = ${JSON.stringify(BUYER)}::jsonb,
              pdf_blob_key = ${`test/redact-mem-bp-${bpSeq}.pdf`},
              pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
              pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
            WHERE tenant_id = ${t.ctx.slug} AND invoice_id = ${invoiceId}
          `);
        }
      });

      const legalNameOf = async (invoiceId: string): Promise<unknown> => {
        const [row] = await db
          .select()
          .from(invoices)
          .where(and(eq(invoices.tenantId, t.ctx.slug), eq(invoices.invoiceId, invoiceId)));
        return (row!.memberIdentitySnapshot as Record<string, unknown>).legal_name;
      };
      const redactedNow = async (): Promise<number> => {
        let n = 0;
        for (const id of bpInvoiceIds) {
          if ((await legalNameOf(id)) === '[REDACTED]') n += 1;
        }
        return n;
      };

      // Shrink the per-tick cap to 2 (default 50) — read live from process.env.
      process.env.REDACTION_MAX_PER_TICK = '2';

      // Tick 1 — at most 2 of the 3 eligible rows are redacted. Drive THIS
      // tenant only (the route sweep would visit every tenant; this isolates
      // the bound to the 3 seeded rows). The returned `redacted` count is the
      // per-tick bound itself.
      const tick1 = await redactExpiredMemberDocumentsForTenant(t.ctx, null);
      expect(tick1.redacted).toBe(2);
      expect(await redactedNow()).toBe(2);

      // Exactly ONE row is still live — the per-tick LIMIT held. On HEAD (no
      // LIMIT) all 3 redact at once and this is 0.
      const stillLive = (await Promise.all(bpInvoiceIds.map((id) => legalNameOf(id)))).filter(
        (name) => name !== '[REDACTED]',
      );
      expect(stillLive).toHaveLength(1);
      expect(stillLive[0]).toBe(BUYER.legal_name);

      // Tick 2 — the remaining row is drained (forward progress).
      const tick2 = await redactExpiredMemberDocumentsForTenant(t.ctx, null);
      expect(tick2.redacted).toBe(1);
      expect(await redactedNow()).toBe(3);
    } finally {
      delete process.env.REDACTION_MAX_PER_TICK;
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('cross-tenant isolation (Principle I gate-blocker): a tenant-A run does NOT redact tenant-B documents', async () => {
    // A GENUINE 2-tenant live-Neon RLS test: seed an erased member + an 11y
    // invoice in a SEPARATE tenant B, then drive the REAL per-tenant body for
    // tenant A ONLY. Under tenant A's `runInTenant`/RLS the `JOIN members` cannot
    // reach tenant B's rows, so B's invoice stays intact. We drive
    // `redactExpiredMemberDocumentsForTenant` directly (NOT the full route sweep,
    // which would visit EVERY tenant and redact B too — proving nothing).
    const b = await createTestTenant('test-swecham');
    try {
      // Tenant B settings — makes B a real, independently-scoped tenant.
      await runInTenant(b.ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: b.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 0n,
          legalNameTh: 'หอการค้า B',
          legalNameEn: 'Chamber B',
          taxId: '0000000000000',
          registeredAddressTh: 'Bangkok',
          registeredAddressEn: 'Bangkok',
          invoiceNumberPrefix: 'MEMB',
          creditNoteNumberPrefix: 'MEMBC',
        });
      });

      // Tenant B: plan + ERASED member + an 11y issued membership invoice.
      const planIdB = `mem-redact-plan-b-${randomUUID().slice(0, 8)}`;
      const memberIdB = randomUUID();
      const invoiceIdB = randomUUID();
      const seqB = nextSeq();
      const snapshotB = {
        ...BUYER,
        legal_name: 'Tenant B Erased Co Ltd',
        member_number: 7,
        member_number_display: 'MEMB-0007',
      };
      await runInTenant(b.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: b.ctx.slug,
          planId: planIdB,
          planYear: 2026,
          planName: { en: 'B Plan' },
          description: { en: 'B' },
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
          tenantId: b.ctx.slug,
          memberId: memberIdB,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Tenant B Erased Co',
          country: 'TH',
          taxId: '9876543210123',
          planId: planIdB,
          planYear: 2026,
        });
        await tx.execute(
          sql`UPDATE members SET erased_at = now() WHERE tenant_id = ${b.ctx.slug} AND member_id = ${memberIdB}`,
        );
        await tx.insert(invoices).values({
          tenantId: b.ctx.slug,
          invoiceId: invoiceIdB,
          invoiceSubject: 'membership',
          memberId: memberIdB,
          planId: planIdB,
          planYear: 2026,
          draftByUserId: user.userId,
          status: 'draft',
        });
        await tx.execute(sql`
          UPDATE invoices SET
            status = 'issued',
            pdf_doc_kind = 'invoice',
            fiscal_year = 2014,
            sequence_number = ${seqB},
            document_number = ${`MEMB14-${seqB}`},
            issue_date = '2014-01-01'::date,
            due_date = '2014-01-31'::date,
            subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
            vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
            vat_satang = ${ISSUED_NUMBERS.vatSatang},
            total_satang = ${ISSUED_NUMBERS.totalSatang},
            net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
            pro_rate_policy_snapshot = 'none',
            tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
            member_identity_snapshot = ${JSON.stringify(snapshotB)}::jsonb,
            pdf_blob_key = ${`test/redact-mem-b-${seqB}.pdf`},
            pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
            pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
          WHERE tenant_id = ${b.ctx.slug} AND invoice_id = ${invoiceIdB}
        `);
      });

      // Drive ONLY tenant A's per-tenant redaction body (the shared default
      // tenant). It must NOT cross into tenant B (RLS scopes both invoices + the
      // joined members to tenant A).
      await redactExpiredMemberDocumentsForTenant(tenant.ctx, null);

      // Tenant B's invoice is UNTOUCHED — the buyer snapshot is still live.
      const [rowB] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.tenantId, b.ctx.slug), eq(invoices.invoiceId, invoiceIdB)));
      const snapB = rowB!.memberIdentitySnapshot as Record<string, unknown>;
      expect(snapB.legal_name).toBe('Tenant B Erased Co Ltd');
      expect(snapB.legal_name).not.toBe('[REDACTED]');
      expect(snapB.tax_id).toBe('9876543210123');
    } finally {
      await b.cleanup().catch(() => {});
    }
  }, 60_000);
});
