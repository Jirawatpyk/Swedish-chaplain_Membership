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
 * NUMBERING SHAPE (β decision): the TIN shape (`kind: 'invoice_stream'` —
 * sequence_number + document_number set, receipt_document_number_raw NULL)
 * is tested in the first describe. The no-TIN β shape (`kind:
 * 'receipt_stream'` — seq/docnum NULL + receipt_document_number_raw set)
 * satisfies the two numbering CHECKs since the Task 9 conditional relax
 * (migration 0212); its repo-level section (T9-1..T9-4) pins the happy
 * commit AND that the relax stays scoped to (event subject AND receipt
 * number present) — never blanket. The Task 10 section (END of file) then
 * proves the USE-CASE wires the β shape end-to-end: receipt-STREAM
 * allocation, invoice-stream counter untouched, audits + outbox parity.
 *
 * Lives in tests/integration/** → hits live Neon. Migrations 0200–0212
 * MUST be applied first (`pnpm db:migrate`).
 *
 * Task 6 EXTENSION — use-case-level sections for `issueEventInvoiceAsPaid`
 * follow the repo-level describe: end-to-end TIN happy path (non-member +
 * matched member audit branches), same-route double-call concurrency,
 * cross-route race vs `issueInvoice`, FY-from-paymentDate boundary,
 * blob-upload rollback (no §87 gap), and the Principle-I cross-tenant probe.
 * Deps pattern mirrors `issue-event-invoice.test.ts` / `event-invoice-
 * schema.test.ts`: REAL repos + allocator + identity + audit + outbox,
 * mocked PDF render + Blob.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  createEventInvoiceDraft,
  type CreateEventInvoiceDraftInput,
} from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { issueEventInvoiceAsPaid } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { IssueEventInvoiceAsPaidDeps } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { asFiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { splitVatInclusive } from '@/modules/invoicing';
import type { Invoice, InvoiceId } from '@/modules/invoicing/domain/invoice';
import {
  createTestTenant,
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

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
    // Wave-4 S26/S28 — mirror the production caller contract: lock + load
    // the draft via the combined findByIdInTxForUpdate read and pass ITS
    // lines through (the repo no longer re-selects them).
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    paidInvoice = await repo.withTx(async (tx) => {
      const locked = await repo.findByIdInTxForUpdate(tx, invoiceId, tenant.ctx.slug);
      if (!locked) throw new Error('locked draft load failed');
      return repo.applyIssueAsPaid(tx, {
        ...buildTinInput(tenant.ctx.slug, invoiceId, user.userId),
        lines: locked.lines,
      });
    });
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
        repo.applyIssueAsPaid(tx, {
          ...buildTinInput(tenant.ctx.slug, invoiceId, user.userId),
          // S26 — lines from the already-paid row; the WHERE status='draft'
          // guard throws before they are ever echoed.
          lines: paidInvoice.lines,
        }),
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

  it('post-paid direct UPDATE of pdf_doc_kind → rejected by the immutability trigger (migration 0214, wave-3 S11)', async () => {
    // The §86/4 document identity of a paid row is frozen: flipping
    // receipt_combined → invoice would let a later re-render silently
    // re-title the legal document into a different RD document class.
    // 0214 added pdf_doc_kind to the trigger's locked-column lists; the
    // draft→paid single-UPDATE writers (applyIssue / applyIssueAsPaid) are
    // unaffected — OLD.status='draft' early-return, proven by this file's
    // beforeAll having committed pdf_doc_kind='receipt_combined' above.
    let caught: unknown = null;
    try {
      await db.execute(sql`
        UPDATE invoices
           SET pdf_doc_kind = 'invoice'
         WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected the immutability trigger to raise on pdf_doc_kind').not.toBeNull();
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(parts.join(' | ')).toMatch(/snapshot columns are immutable/i);
  }, 30_000);
});

// =============================================================================
// Task 6 — USE-CASE-LEVEL sections (`issueEventInvoiceAsPaid`, live Neon).
// Real repos + §87 allocator + identity adapter + audit adapter + outbox
// adapter; PDF render + Blob mocked (issue-event-invoice.test.ts pattern).
// All fixture buyers/members are SIMULATED (fake names + fake 13-digit TINs).
// =============================================================================

/** Fixed Bangkok-safe clock for the use-case sections (matches "today"). */
const UC_NOW_ISO = '2026-06-10T10:00:00Z';
/** Out-of-band payment settled a few days before UC_NOW_ISO. */
const UC_PAYMENT_DATE = '2026-06-07';
/** FY containing UC_PAYMENT_DATE under fiscalYearStartMonth=1 (default). */
const UC_FISCAL_YEAR = 2026;

/** SIMULATED non-member buyer WITH a fake 13-digit Thai TIN — never real PII. */
const UC_BUYER_TIN = {
  legal_name: 'Simulated As-Paid Co Ltd',
  tax_id: '1234512345123',
  address: '123 Simulated Road, Bangkok 10110',
  primary_contact_name: 'Sim Buyer',
  primary_contact_email: 'sim.buyer@as-paid.test',
} as const;

const UC_MATRIX: BenefitMatrix = {
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

interface UseCaseDepsOptions {
  readonly nowIso: string;
  /** Records every PDF render input so tests can pin the doc-kind + dates. */
  readonly captured?: PdfRenderInput[];
  /** Override the render mock (section E2 — distinct bytes per attempt). */
  readonly render?: (
    renderInput: PdfRenderInput,
  ) => Promise<{ bytes: Uint8Array; sha256: ReturnType<typeof Sha256Hex.ofUnsafe> }>;
  /**
   * Override the uploadPdf mock (section E blob-failure injection; section
   * E2 receives the full adapter input incl. body + allowOverwrite so the
   * fake store can honour the real conflict semantics).
   */
  readonly uploadPdf?: (input: {
    key: string;
    body: Uint8Array;
    contentType: 'application/pdf';
    allowOverwrite?: boolean;
  }) => Promise<{ key: string; url: string }>;
  /** Spy on the orphan-blob cleanup delete (section E). */
  readonly blobDelete?: (key: string) => Promise<void>;
}

/**
 * REAL repos/allocator/identity/audit/outbox + mocked PDF/Blob. The
 * intersection type lets ONE builder feed both routes in the cross-route
 * race — `IssueInvoiceDeps` and `IssueEventInvoiceAsPaidDeps` are
 * structurally identical (the latter only adds optional onPaidCallbacks).
 */
function makeUseCaseDeps(
  tenantSlug: string,
  opts: UseCaseDepsOptions,
): IssueInvoiceDeps & IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        opts.captured?.push(renderInput);
        if (opts.render) return opts.render(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('d'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(
        opts.uploadPdf ??
          (async ({ key }: { key: string }) => ({
            key,
            url: `https://blob.test/${key}`,
          })),
      ),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(opts.blobDelete ?? (async () => {})),
      list: vi.fn(),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => opts.nowIso },
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: 1,
    // Default: flag not carried (legacy §87 stream), exact-equivalent of the
    // pre-refactor `undefined`. The 088 RC-stream behaviour is covered elsewhere.
    taxAtPayment: 'not-forwarded',
  };
}

/**
 * Seed minimal tenant invoice settings (defaults: VAT 7%, FY start Jan,
 * auto-email ON). Wave-4 S18 — thin wrapper over the shared
 * `seedTenantFiscal` helper (this file's identity values + per-test prefix
 * threading preserved verbatim).
 */
async function seedUcSettings(
  tenant: TestTenant,
  prefix: string,
  opts?: { readonly receiptPrefix?: string },
): Promise<void> {
  await seedTenantFiscal({
    tenant,
    legalNameTh: 'หอการค้าจำลอง',
    legalNameEn: 'Simulated Chamber',
    registeredAddressTh: 'Bangkok',
    registeredAddressEn: 'Bangkok',
    invoiceNumberPrefix: prefix,
    creditNoteNumberPrefix: `${prefix}C`,
    ...(opts?.receiptPrefix !== undefined
      ? { receiptNumberPrefix: opts.receiptPrefix }
      : {}),
  });
}

/** Seed one F6 event + one registration; returns ids. */
async function seedUcEventWithRegistration(
  tenant: TestTenant,
  opts?: {
    readonly matchType?: 'non_member' | 'member_domain';
    readonly matchedMemberId?: string;
    readonly ticketPriceThb?: number;
    readonly attendeeEmail?: string;
  },
): Promise<{ eventId: string; registrationId: string }> {
  const eventId = randomUUID();
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt-aspaid-uc-${registrationId.slice(0, 8)}`,
      name: 'As-Paid Use-Case Gala',
      startDate: new Date('2026-09-10T11:00:00Z'),
    } satisfies NewEventRow);
    await tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId,
      eventId,
      externalId: `att-aspaid-uc-${registrationId.slice(0, 8)}`,
      attendeeEmail: opts?.attendeeEmail ?? UC_BUYER_TIN.primary_contact_email,
      attendeeName: 'Sim Attendee',
      attendeeCompany: 'Simulated As-Paid Co Ltd',
      matchType: opts?.matchType ?? 'non_member',
      ...(opts?.matchedMemberId !== undefined
        ? { matchedMemberId: opts.matchedMemberId }
        : {}),
      ticketType: 'Standard',
      ticketPriceThb: opts?.ticketPriceThb ?? 1000,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-09-01T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
  });
  return { eventId, registrationId };
}

/** Create a genuine event draft via the REAL use-case; throws on err. */
async function createUcDraft(
  tenant: TestTenant,
  user: TestUser,
  registrationId: string,
  opts?: {
    readonly amountOverrideSatang?: number;
    readonly buyer?: CreateEventInvoiceDraftInput['buyer'];
  },
): Promise<InvoiceId> {
  const draft = await createEventInvoiceDraft(
    makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
    {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-draft-${registrationId}`,
      eventRegistrationId: registrationId,
      ...(opts?.amountOverrideSatang !== undefined
        ? { amountOverride: opts.amountOverrideSatang }
        : {}),
      ...(opts?.buyer !== undefined ? { buyer: opts.buyer } : {}),
    },
  );
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
  return draft.value.invoiceId;
}

/** Owner-role (BYPASSRLS) read of one invoice row. */
async function readInvoiceRowOwner(tenantSlug: string, invoiceId: string) {
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantSlug), eq(invoices.invoiceId, invoiceId)));
  return row;
}

/** §87 counter for (tenant, docType, fy) — null when never allocated. */
async function readSeqCounterFor(
  tenantSlug: string,
  documentType: 'invoice' | 'receipt' | 'credit_note' | 'receipt_105',
  fiscalYear: number,
): Promise<number | null> {
  const [row] = await db
    .select()
    .from(tenantDocumentSequences)
    .where(
      and(
        eq(tenantDocumentSequences.tenantId, tenantSlug),
        eq(tenantDocumentSequences.documentType, documentType),
        eq(tenantDocumentSequences.fiscalYear, fiscalYear),
      ),
    );
  return row?.nextSequenceNumber ?? null;
}

/** §87 counter for (tenant, 'invoice', fy) — null when never allocated. */
async function readInvoiceSeqCounter(
  tenantSlug: string,
  fiscalYear: number,
): Promise<number | null> {
  return readSeqCounterFor(tenantSlug, 'invoice', fiscalYear);
}

/** All audit rows whose payload.invoice_id matches (owner read). */
async function auditRowsForInvoice(tenantSlug: string, invoiceId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  return rows.filter(
    (r) => (r.payload as Record<string, unknown> | null)?.invoice_id === invoiceId,
  );
}

/** All invoice_auto_email outbox rows for one invoice (owner read). */
async function outboxRowsForInvoice(tenantSlug: string, invoiceId: string) {
  const rows = await db
    .select()
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.tenantId, tenantSlug),
        eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
      ),
    );
  return rows.filter(
    (r) => (r.contextData as Record<string, unknown>).invoice_id === invoiceId,
  );
}

// -----------------------------------------------------------------------------
// Section A — TIN as-paid end-to-end (non-member + matched-member audit branch)
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — use-case end-to-end (TIN buyer, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'aspaid-uc-plan';
  let memberId: string;
  let regNonMember: string;
  let regMatched: string;
  let draftNonMember: InvoiceId;
  let draftMatched: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVP');

    // SIMULATED matched company member (fake TIN) + primary contact.
    memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'As-Paid UC Plan' },
        description: { en: 'Simulated plan for as-paid use-case test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: UC_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Simulated Matched Corp',
        country: 'TH',
        taxId: '3210987654321',
        addressLine1: '1 Simulated Avenue',
        city: 'Pathum Wan',
        province: 'Bangkok',
        postalCode: '10330',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Sim',
        lastName: 'Contact',
        email: 'sim.contact@as-paid.test',
        isPrimary: true,
      });
    });

    ({ registrationId: regNonMember } = await seedUcEventWithRegistration(tenant));
    ({ registrationId: regMatched } = await seedUcEventWithRegistration(tenant, {
      matchType: 'member_domain',
      matchedMemberId: memberId,
      ticketPriceThb: 2000,
      attendeeEmail: 'sim.contact@as-paid.test',
    }));

    draftNonMember = await createUcDraft(tenant, user, regNonMember, {
      amountOverrideSatang: 10004, // 100.04 THB inclusive — VAT-exact case
      buyer: UC_BUYER_TIN,
    });
    draftMatched = await createUcDraft(tenant, user, regMatched);
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('A1 — non-member TIN: ONE paid row, combined PDF + as-paid date pin, dual in-tx audits (non-timeline), exactly ONE outbox email', async () => {
    const captured: PdfRenderInput[] = [];
    const deps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO, captured });
    const reqId = `int-aspaid-uc-a1-${draftNonMember}`;

    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: reqId,
      invoiceId: draftNonMember,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
      paymentReference: 'SIM-DOOR-001',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    // Exactly ONE invoice row exists for the registration — the one-shot
    // issuance produced no sibling/intermediate row.
    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.eventRegistrationId, regNonMember),
        ),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('paid');
    expect(row.pdfDocKind).toBe('receipt_combined');
    // As-paid date pin: issue = due = payment (raw row).
    expect(row.issueDate).toBe(UC_PAYMENT_DATE);
    expect(row.dueDate).toBe(UC_PAYMENT_DATE);
    expect(row.paymentDate).toBe(UC_PAYMENT_DATE);
    expect(row.netDaysSnapshot).toBe(0);
    // Model-B exact VAT round-trip on the 100.04 THB case.
    const split = splitVatInclusive(Money.fromSatangUnsafe(10004n), 700n);
    expect(BigInt(row.totalSatang!.toString())).toBe(10004n);
    expect(BigInt(row.subtotalSatang!.toString())).toBe(split.subtotal.satang);
    expect(BigInt(row.vatSatang!.toString())).toBe(split.vat.satang);

    // Render input — the ONE combined document, inclusive, dates pinned.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe('receipt_combined');
    expect(captured[0]!.vatInclusive).toBe(true);
    expect(captured[0]!.issueDate).toBe(UC_PAYMENT_DATE);
    expect(captured[0]!.dueDate).toBe(UC_PAYMENT_DATE);

    // Audits — BOTH lifecycle facts committed with the row.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, reqId)));
    const issued = audits.filter((a) => a.eventType === 'invoice_issued');
    const paid = audits.filter((a) => a.eventType === 'invoice_paid');
    expect(issued).toHaveLength(1);
    expect(paid).toHaveLength(1);
    for (const a of [issued[0]!, paid[0]!]) {
      const payload = a.payload as Record<string, unknown>;
      expect(payload.invoice_id).toBe(draftNonMember);
      expect(payload.invoice_subject).toBe('event');
      expect(payload.event_registration_id).toBe(regNonMember);
      // Non-member → non-timeline branch: member_id key FORBIDDEN.
      expect('member_id' in payload).toBe(false);
    }
    // W9 — raw payment reference never lands in audit (sha256 only).
    const paidPayload = paid[0]!.payload as Record<string, unknown>;
    expect(paidPayload.payment_reference_sha256).toBeTruthy();
    expect(JSON.stringify(paidPayload)).not.toContain('SIM-DOOR-001');

    // Outbox — exactly ONE invoice_paid receipt email for the buyer, with
    // the §87/3 PDPA transparency footer (non-member event buyer).
    const outboxRows = await outboxRowsForInvoice(tenant.ctx.slug, draftNonMember);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.toEmail).toBe(UC_BUYER_TIN.primary_contact_email);
    const ctx = outboxRows[0]!.contextData as Record<string, unknown>;
    expect(ctx.event_type).toBe('invoice_paid');
    expect(ctx.privacy_footer_kind).toBe('event_non_member');
  }, 60_000);

  it('A2 — matched member: audits use the TIMELINE branch (member_id present), combined receipt to the member contact', async () => {
    const deps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO });
    const reqId = `int-aspaid-uc-a2-${draftMatched}`;

    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: reqId,
      invoiceId: draftMatched,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'bank_transfer',
      paymentReference: 'SIM-KBANK-002',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    const row = await readInvoiceRowOwner(tenant.ctx.slug, draftMatched);
    expect(row!.status).toBe('paid');
    expect(row!.pdfDocKind).toBe('receipt_combined');
    expect(row!.memberId).toBe(memberId);

    // Member branch ⇒ member_id present on BOTH audit rows (F3 timeline),
    // alongside the event correlation fields.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, reqId)));
    const issued = audits.filter((a) => a.eventType === 'invoice_issued');
    const paid = audits.filter((a) => a.eventType === 'invoice_paid');
    expect(issued).toHaveLength(1);
    expect(paid).toHaveLength(1);
    for (const a of [issued[0]!, paid[0]!]) {
      const payload = a.payload as Record<string, unknown>;
      expect(payload.member_id).toBe(memberId);
      expect(payload.invoice_subject).toBe('event');
      expect(payload.event_registration_id).toBe(regMatched);
    }

    // Matched member → no PDPA non-member footer on the receipt email.
    const outboxRows = await outboxRowsForInvoice(tenant.ctx.slug, draftMatched);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.toEmail).toBe('sim.contact@as-paid.test');
    const ctx = outboxRows[0]!.contextData as Record<string, unknown>;
    expect(ctx.event_type).toBe('invoice_paid');
    expect(ctx.privacy_footer_kind).toBeNull();
  }, 60_000);
});

// -----------------------------------------------------------------------------
// Section B — same-route double-call concurrency
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — same-route double-call concurrency (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVB');
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('two concurrent as-paid calls: exactly one ok, loser typed invoice_already_issued, §87 consumes exactly 1, ONE audit pair', async () => {
    const before = (await readInvoiceSeqCounter(tenant.ctx.slug, UC_FISCAL_YEAR)) ?? 1;

    // SAME deps object for both calls (same route, double-submit).
    const deps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO });
    const mkInput = (n: number) => ({
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-b${n}-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash' as const,
    });

    const settled = await Promise.allSettled([
      issueEventInvoiceAsPaid(deps, mkInput(1)),
      issueEventInvoiceAsPaid(deps, mkInput(2)),
    ]);
    const results = settled.map((s) => {
      if (s.status !== 'fulfilled') {
        throw new Error(`unexpected rejection: ${String(s.reason)}`);
      }
      return s.value;
    });
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    // NB: summarise codes only — a winner Invoice carries BigInt satang,
    // which JSON.stringify cannot serialize (and the message arg is eager).
    const summary = results
      .map((r) => (r.ok ? 'ok' : `err:${r.error.code}`))
      .join(', ');
    expect(winners, `results: ${summary}`).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    if (loser.ok) throw new Error('unreachable');
    // Deterministic under the FOR UPDATE row lock: the loser re-reads the
    // committed status. The applyIssueAsPaid conflict translation lands on
    // the SAME code, so this assertion holds either way.
    expect(loser.error.code).toBe('invoice_already_issued');

    // §87 consumption = exactly 1 (counter advanced by one).
    const after = await readInvoiceSeqCounter(tenant.ctx.slug, UC_FISCAL_YEAR);
    expect(after).toBe(before + 1);

    // Winner's row took the pre-increment number.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row!.status).toBe('paid');
    expect(row!.sequenceNumber).toBe(before);

    // Exactly ONE pair of lifecycle audits for the invoice.
    const audits = await auditRowsForInvoice(tenant.ctx.slug, invoiceId);
    expect(audits.filter((a) => a.eventType === 'invoice_issued')).toHaveLength(1);
    expect(audits.filter((a) => a.eventType === 'invoice_paid')).toHaveLength(1);
  }, 90_000);
});

// -----------------------------------------------------------------------------
// Section C — cross-route race (issueInvoice vs issueEventInvoiceAsPaid)
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid vs issueInvoice — cross-route race (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVC');
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('exactly one winner across routes (either is legal), loser typed conflict, NO §87 gap — next allocation = winner seq + 1', async () => {
    const depsIssue = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO });
    const depsAsPaid = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO });

    const settled = await Promise.allSettled([
      issueInvoice(depsIssue, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-aspaid-uc-c-issue-${invoiceId}`,
        invoiceId: invoiceId as string,
      }),
      issueEventInvoiceAsPaid(depsAsPaid, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-aspaid-uc-c-aspaid-${invoiceId}`,
        invoiceId: invoiceId as string,
        paymentDate: UC_PAYMENT_DATE,
        paymentMethod: 'cash',
      }),
    ]);
    const results = settled.map((s) => {
      if (s.status !== 'fulfilled') {
        throw new Error(`unexpected rejection: ${String(s.reason)}`);
      }
      return s.value;
    });
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    // NB: codes-only summary — Invoice payloads carry BigInt satang which
    // JSON.stringify rejects (and the message arg is evaluated eagerly).
    const summary = results
      .map((r) => (r.ok ? 'ok' : `err:${r.error.code}`))
      .join(', ');
    expect(winners, `results: ${summary}`).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    if (loser.ok) throw new Error('unreachable');
    // Both routes translate the race loss to the same typed code.
    expect(loser.error.code).toBe('invoice_already_issued');

    // Either winner is legal — bill-first leaves 'issued', as-paid 'paid'.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(['issued', 'paid']).toContain(row!.status);
    expect(row!.sequenceNumber).not.toBeNull();
    const winnerSeq = row!.sequenceNumber!;

    // §87 no-gap proof: the NEXT allocation from the shared invoice stream
    // is exactly winnerSeq + 1 — the loser's rolled-back attempt left no hole.
    const fyRes = asFiscalYear(row!.fiscalYear!);
    if (!fyRes.ok) throw new Error(`bad fiscal year on winner row: ${row!.fiscalYear}`);
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const nextSeq = await repo.withTx(async (tx) =>
      postgresSequenceAllocator.allocateNext(tx, {
        tenantId: tenant.ctx.slug,
        documentType: 'invoice',
        fiscalYear: fyRes.value,
      }),
    );
    expect(nextSeq).toBe(winnerSeq + 1);
  }, 90_000);
});

// -----------------------------------------------------------------------------
// Section D — fiscal year derives from paymentDate, not now()
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — FY boundary from paymentDate (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVD'); // fiscalYearStartMonth defaults to 1
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 50000,
      buyer: UC_BUYER_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('January 2027 back-dated December 2026 payment numbers into FY2026 (doc number, row, blob path)', async () => {
    // Clock is January 2027 — the admin back-dates a December payment.
    const deps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: '2027-01-15T10:00:00Z' });
    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-d-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: '2026-12-28',
      paymentMethod: 'bank_transfer',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    // Fresh tenant ⇒ FY2026 allocator starts at 1 ⇒ fully deterministic.
    expect(res.value.documentNumber?.raw).toBe('EVD-2026-000001');

    const row = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row!.fiscalYear).toBe(2026); // NOT 2027 — bucket follows the payment
    expect(row!.documentNumber).toBe('EVD-2026-000001');
    expect(row!.issueDate).toBe('2026-12-28');
    expect(row!.dueDate).toBe('2026-12-28');
    expect(row!.paymentDate).toBe('2026-12-28');
    expect(row!.pdfBlobKey).toContain('/2026/');
  }, 60_000);
});

// -----------------------------------------------------------------------------
// Section E — blob-upload failure rollback (no §87 gap, retry reuses the number)
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — blob-upload failure rollback (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVE');
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('failed upload → typed err, row stays draft, counter unchanged, ZERO audits, orphan cleanup; retry succeeds with the SAME number', async () => {
    const before = await readInvoiceSeqCounter(tenant.ctx.slug, UC_FISCAL_YEAR);
    const expectedSeq = before ?? 1;

    const deleteSpy = vi.fn(async () => {});
    const failingDeps = makeUseCaseDeps(tenant.ctx.slug, {
      nowIso: UC_NOW_ISO,
      uploadPdf: async () => {
        throw new Error('simulated blob outage');
      },
      blobDelete: deleteSpy,
    });
    const res1 = await issueEventInvoiceAsPaid(failingDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-e1-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res1.ok).toBe(false);
    if (res1.ok) throw new Error('expected blob_upload_failed');
    expect(res1.error.code).toBe('blob_upload_failed');

    // Row STILL draft — the single UPDATE never committed.
    const rowAfterFail = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(rowAfterFail!.status).toBe('draft');
    expect(rowAfterFail!.sequenceNumber).toBeNull();

    // §87 counter unchanged — the allocator INSERT/UPDATE rolled back
    // with the tx (both reads null on a fresh tenant, or the same value).
    const counterAfterFail = await readInvoiceSeqCounter(tenant.ctx.slug, UC_FISCAL_YEAR);
    expect(counterAfterFail).toBe(before);

    // Orphan-blob mitigation fired against the deterministic key.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(
      `invoicing/${tenant.ctx.slug}/${UC_FISCAL_YEAR}/${invoiceId}_v1.pdf`,
    );

    // ZERO LIFECYCLE audit rows for the invoice — issued/paid emitted
    // in-tx and rolled back; blob failure has no post-rollback forensic
    // event (only pdf_render_failed does). The draft-created audit from
    // the beforeAll seeding legitimately exists, so filter to lifecycle.
    const audits = (await auditRowsForInvoice(tenant.ctx.slug, invoiceId)).filter(
      (a) => a.eventType === 'invoice_issued' || a.eventType === 'invoice_paid',
    );
    expect(audits).toHaveLength(0);

    // Retry with a WORKING blob → succeeds with the SAME sequence number
    // the failed attempt would have used (no §87 gap).
    const retryDeps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO });
    const res2 = await issueEventInvoiceAsPaid(retryDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-e2-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res2.ok, res2.ok ? 'ok' : `retry err: ${JSON.stringify(res2)}`).toBe(true);
    if (!res2.ok) throw new Error('retry failed');
    expect(res2.value.sequenceNumber).toBe(expectedSeq);

    const row2 = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row2!.status).toBe('paid');
    expect(row2!.sequenceNumber).toBe(expectedSeq);
  }, 90_000);
});

// -----------------------------------------------------------------------------
// Section E2 — 065 H-1a: stale-bytes overwrite on retry (tax-document drift)
// -----------------------------------------------------------------------------
//
// The drift mechanism: attempt 1 lands bytes at the deterministic key but the
// upload call FAILS (timeout-after-write class), the best-effort catch-path
// cleanup ALSO fails, and the tx rolls back (row stays draft). A retry renders
// DIFFERENT bytes (e.g. a corrected paymentDate — the key has no paymentDate
// component). Pre-H-1a the adapter's allowOverwrite=false arm treated
// "already exists" as success returning the OLD bytes WITHOUT a sha compare —
// the retry committed a row whose pdf_sha256 didn't match the stored
// document. With `allowOverwrite: true` from the as-paid call site the retry
// REPLACES the stale bytes. The fake store below mimics the real
// vercel-blob-adapter conflict semantics exactly.

describe('issueEventInvoiceAsPaid — 065 H-1a stale-bytes overwrite on retry (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVH');
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('fail-after-upload with FAILED cleanup, then retry with different bytes → blob holds the NEW render and the committed sha matches it', async () => {
    const STALE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01]); // attempt-1 render
    const FRESH_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x02]); // retry render
    const STALE_SHA = '1'.repeat(64);
    const FRESH_SHA = '2'.repeat(64);

    // Fake blob store honouring the REAL vercel-blob-adapter semantics:
    // conflict + allowOverwrite=false → success returning the OLD bytes
    // WITHOUT writing (the drift arm); allowOverwrite=true → replace.
    const store = new Map<string, Uint8Array>();
    const adapterLikeUpload = async (input: {
      key: string;
      body: Uint8Array;
      allowOverwrite?: boolean;
    }): Promise<{ key: string; url: string }> => {
      if (store.has(input.key) && !(input.allowOverwrite ?? false)) {
        return { key: input.key, url: `https://blob.test/${input.key}` };
      }
      store.set(input.key, input.body);
      return { key: input.key, url: `https://blob.test/${input.key}` };
    };

    // Attempt 1 — the bytes LAND in storage but the call fails afterwards
    // (timeout-after-write), and the orphan-cleanup delete ALSO fails →
    // stale bytes survive at the deterministic key.
    const failingDeps = makeUseCaseDeps(tenant.ctx.slug, {
      nowIso: UC_NOW_ISO,
      render: async () => ({ bytes: STALE_BYTES, sha256: Sha256Hex.ofUnsafe(STALE_SHA) }),
      uploadPdf: async (input) => {
        await adapterLikeUpload(input);
        throw new Error('simulated timeout after write');
      },
      blobDelete: async () => {
        throw new Error('simulated cleanup outage');
      },
    });
    const res1 = await issueEventInvoiceAsPaid(failingDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-h1a-1-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res1.ok).toBe(false);
    if (res1.ok) throw new Error('expected blob_upload_failed');
    expect(res1.error.code).toBe('blob_upload_failed');

    const blobKey = `invoicing/${tenant.ctx.slug}/${UC_FISCAL_YEAR}/${invoiceId}_v1.pdf`;
    expect(store.get(blobKey)).toEqual(STALE_BYTES); // the orphan survived
    const rowAfterFail = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(rowAfterFail!.status).toBe('draft');

    // Retry — different render bytes (e.g. corrected paymentDate); the
    // upload now works. allowOverwrite must thread through so the stale
    // bytes are REPLACED, never silently kept.
    const retryDeps = makeUseCaseDeps(tenant.ctx.slug, {
      nowIso: UC_NOW_ISO,
      render: async () => ({ bytes: FRESH_BYTES, sha256: Sha256Hex.ofUnsafe(FRESH_SHA) }),
      uploadPdf: adapterLikeUpload,
    });
    const res2 = await issueEventInvoiceAsPaid(retryDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-h1a-2-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res2.ok, res2.ok ? 'ok' : `retry err: ${JSON.stringify(res2)}`).toBe(true);

    // The live wire: the as-paid call site passes allowOverwrite: true.
    const uploadInput = vi.mocked(retryDeps.blob.uploadPdf).mock.calls[0]![0] as {
      allowOverwrite?: boolean;
    };
    expect(uploadInput.allowOverwrite).toBe(true);

    // Drift closed: the stored bytes ARE the retry's render, and the
    // committed row's sha256 matches THOSE bytes — never the stale ones.
    expect(store.get(blobKey)).toEqual(FRESH_BYTES);
    const row = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row!.status).toBe('paid');
    expect(row!.pdfSha256).toBe(FRESH_SHA);
    expect(row!.pdfBlobKey).toBe(blobKey);
  }, 90_000);
});

// -----------------------------------------------------------------------------
// Section G — cross-tenant probe (Constitution Principle I clause 3)
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — cross-tenant probe (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let draftA: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    ({ a: tenantA, b: tenantB } = await createTwoTestTenants());
    // Tenant B needs settings — the use-case reads getForIssue BEFORE the
    // tx; without them it would short-circuit on settings_missing and the
    // probe would never fire.
    await seedUcSettings(tenantA, 'EVA');
    await seedUcSettings(tenantB, 'EVX');
    const { registrationId } = await seedUcEventWithRegistration(tenantA);
    draftA = await createUcDraft(tenantA, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it("tenant B as-paid against tenant A's draft → invoice_not_found + invoice_cross_tenant_probe audit with the as-paid route tag", async () => {
    const reqId = `int-aspaid-uc-probe-${draftA}`;
    const depsB = makeUseCaseDeps(tenantB.ctx.slug, { nowIso: UC_NOW_ISO });

    const res = await issueEventInvoiceAsPaid(depsB, {
      tenantId: tenantB.ctx.slug,
      actorUserId: user.userId,
      requestId: reqId,
      invoiceId: draftA as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected invoice_not_found');
    expect(res.error.code).toBe('invoice_not_found');

    // Probe audit landed in TENANT B's namespace (null tx — survives the
    // withTx rollback), tagged with the new as-paid route.
    const [probe] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
          eq(auditLog.requestId, reqId),
        ),
      );
    expect(probe, 'expected an invoice_cross_tenant_probe audit row').toBeDefined();
    const payload = probe!.payload as Record<string, unknown>;
    expect(payload.route).toBe('issue-event-invoice-as-paid');
    expect(payload.attempted_invoice_id).toBe(draftA);

    // Tenant A's draft is untouched — RLS hid it, nothing mutated it.
    const rowA = await readInvoiceRowOwner(tenantA.ctx.slug, draftA);
    expect(rowA!.status).toBe('draft');
    expect(rowA!.sequenceNumber).toBeNull();
  }, 60_000);
});

// =============================================================================
// Task 9 (β numbering) — REPO-LEVEL no-TIN receipt_stream shape + conditional
// CHECK relax (migration 0212, live Neon).
//
// An as-paid no-TIN EVENT invoice is a §105 receipt: its number comes from the
// RECEIPT stream and lives in receipt_document_number_raw with
// sequence_number/document_number NULL — the invoices_tenant_fiscal_seq_unique
// index has NO stream discriminator, so a receipt-stream number occupying
// sequence_number would collide with invoice-stream numbers in the same
// (tenant, fiscal_year) bucket. Migration 0212 relaxes the two numbering
// CHECKs (invoices_non_draft_has_snapshots + invoices_draft_has_no_number)
// CONDITIONALLY: the invoice-stream pair must BOTH be NULL and the relax
// applies ONLY when invoice_subject='event' AND receipt_document_number_raw
// IS NOT NULL. T9-2/T9-3/T9-4 are the negative probes proving the condition
// holds (T9-4 pins the half-pair §87 anomaly: a sequence slot consumed
// without a document number must never slip through the relaxed leg).
// =============================================================================

/**
 * β §105 receipt number on the SEPARATE `receipt_105`/`RE` register (US7/T050).
 * A §105 event-no-TIN receipt is 'RE-…', never the §86/4 'RC-…' — this repo-seam
 * section hand-feeds the number to prove the persistence CHECK relax; the
 * allocation-driven end-to-end split proof is the Task 10 section below.
 * (Passes receipt_document_number_raw_format_check either way.)
 */
const NO_TIN_RECEIPT_RAW = 'RE-2026-000001';

/** SIMULATED no-TIN walk-in buyer (tax_id null ⇒ §105 receipt) — never real PII. */
const BUYER_NO_TIN = {
  legal_name: 'Simulated Walk-in Guest Co',
  tax_id: null,
  address: '99 Simulated Lane, Bangkok 10110',
  primary_contact_name: 'Sim Walkin',
  primary_contact_email: 'sim.walkin@as-paid.test',
} as const;

/** Seller identity snapshot reused by the β happy path + raw-UPDATE probes. */
const T9_TENANT_SNAPSHOT = {
  legal_name_th: 'หอการค้าจำลอง',
  legal_name_en: 'Simulated Chamber',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
} as const;

/** Full β no-TIN applyIssueAsPaid input (receipt_stream + receipt_separate). */
function buildNoTinInput(tenantSlug: string, invoiceId: InvoiceId, recordedBy: string) {
  const split = splitVatInclusive(Money.fromSatangUnsafe(TOTAL_SATANG), 700n);
  return {
    tenantId: tenantSlug,
    invoiceId,
    fiscalYear: 2026,
    numbering: {
      kind: 'receipt_stream' as const,
      receiptDocumentNumberRaw: NO_TIN_RECEIPT_RAW,
    },
    issueDate: ISSUE_DATE,
    subtotalSatang: split.subtotal.satang,
    vatRate: '0.0700',
    vatSatang: split.vat.satang,
    totalSatang: Money.fromSatangUnsafe(TOTAL_SATANG).satang,
    tenantIdentitySnapshot: T9_TENANT_SNAPSHOT,
    // snake_case — must satisfy BOTH the 0045 contact-email CHECK and the
    // zod read-boundary parse (memberIdentitySnapshotSchema; tax_id is the
    // one nullable field) on reload.
    memberIdentitySnapshot: {
      ...BUYER_NO_TIN,
      member_number: null,
      member_number_display: null,
    },
    pdf: {
      blobKey: `invoices/${tenantSlug}/2026/${NO_TIN_RECEIPT_RAW}_v1.pdf`,
      sha256: Sha256Hex.ofUnsafe('e'.repeat(64)),
      templateVersion: 1,
    },
    pdfDocKind: 'receipt_separate' as const,
    paymentMethod: 'cash' as const,
    paymentReference: 'SIM-DOOR-RC-001',
    paymentNotes: null,
    paymentRecordedByUserId: recordedBy,
    paymentDate: ISSUE_DATE,
  };
}

/**
 * Assert fn rejects with SQLSTATE 23514 (check_violation) raised by one of
 * the two NUMBERING CHECKs. T9-2/T9-3 violate BOTH simultaneously (Postgres
 * reports whichever it evaluates first); T9-4's half-pair satisfies
 * `invoices_draft_has_no_number` (sequence_number IS NOT NULL) and violates
 * only `invoices_non_draft_has_snapshots` — so match EITHER name (via
 * postgres.js constraint_name, falling back to the error message text).
 */
async function expectNumberingCheckViolation(fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected a check_violation (23514)').not.toBeNull();
  // Drizzle 0.45+ wraps the PostgresError — walk the cause chain.
  let code: string | null = null;
  let constraint: string | null = null;
  const messages: string[] = [];
  let cur: unknown = caught;
  while (cur !== null && typeof cur === 'object') {
    const c = cur as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (code === null && typeof c.code === 'string') code = c.code;
    if (constraint === null && typeof c.constraint_name === 'string') {
      constraint = c.constraint_name;
    }
    if (typeof c.message === 'string') messages.push(c.message);
    cur = c.cause ?? null;
  }
  expect(code).toBe('23514');
  expect(`${constraint ?? ''} ${messages.join(' | ')}`).toMatch(
    /invoices_(non_draft_has_snapshots|draft_has_no_number)/,
  );
}

describe('applyIssueAsPaid — β no-TIN shape (receipt_stream) + conditional CHECK relax (0212, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let noTinDraft: InvoiceId; // T9-1 happy path
  let probeEventDraft: InvoiceId; // T9-2 — event, ALL numbering NULL
  let probeMembershipDraft: string; // T9-3 — membership, NULL pair + raw SET
  let probeHalfPairDraft: InvoiceId; // T9-4 — event, seq SET + docnum NULL + raw SET
  let memberId: string;
  const planId = 'aspaid-t9-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Two genuine event drafts via the REAL use-case (one registration each —
    // the partial unique index allows one non-void event invoice per
    // registration). Buyer snapshot (incl. tax_id:null) pins at draft.
    const regHappy = await seedUcEventWithRegistration(tenant, {
      attendeeEmail: BUYER_NO_TIN.primary_contact_email,
    });
    noTinDraft = await createUcDraft(tenant, user, regHappy.registrationId, {
      amountOverrideSatang: Number(TOTAL_SATANG),
      buyer: BUYER_NO_TIN,
    });
    const regProbe = await seedUcEventWithRegistration(tenant, {
      attendeeEmail: BUYER_NO_TIN.primary_contact_email,
    });
    probeEventDraft = await createUcDraft(tenant, user, regProbe.registrationId, {
      amountOverrideSatang: Number(TOTAL_SATANG),
      buyer: BUYER_NO_TIN,
    });
    const regHalfPair = await seedUcEventWithRegistration(tenant, {
      attendeeEmail: BUYER_NO_TIN.primary_contact_email,
    });
    probeHalfPairDraft = await createUcDraft(tenant, user, regHalfPair.registrationId, {
      amountOverrideSatang: Number(TOTAL_SATANG),
      buyer: BUYER_NO_TIN,
    });

    // SIMULATED membership draft (fake plan + fake-TIN member) for the
    // T9-3 subject-scope probe.
    memberId = randomUUID();
    probeMembershipDraft = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T9 Probe Plan' },
        description: { en: 'Simulated plan for the Task 9 membership probe' },
        sortOrder: 11,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: UC_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Simulated T9 Probe Corp',
        country: 'TH',
        taxId: '1111111111111',
        addressLine1: '9 Simulated Probe Avenue',
        city: 'Pathum Wan',
        province: 'Bangkok',
        postalCode: '10330',
        planId,
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: probeMembershipDraft,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('T9-1 — receipt_stream commit: paid row, seq/docnum NULL, receipt raw set, receipt_separate; every other CHECK satisfied', async () => {
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const paid = await repo.withTx(async (tx) => {
      // Wave-4 S26/S28 — production caller contract: combined locked read
      // supplies the lines (the repo no longer re-selects them).
      const locked = await repo.findByIdInTxForUpdate(tx, noTinDraft, tenant.ctx.slug);
      if (!locked) throw new Error('locked draft load failed');
      return repo.applyIssueAsPaid(tx, {
        ...buildNoTinInput(tenant.ctx.slug, noTinDraft, user.userId),
        lines: locked.lines,
      });
    });

    // Domain mapping (rowsToInvoice handles the NULL document_number).
    expect(paid.status).toBe('paid');
    expect(paid.sequenceNumber).toBeNull();
    expect(paid.documentNumber).toBeNull();
    expect(paid.receiptDocumentNumberRaw).toBe(NO_TIN_RECEIPT_RAW);
    expect(paid.pdfDocKind).toBe('receipt_separate');
    expect(paid.fiscalYear).toBe(2026);

    // Raw row — the single committing UPDATE satisfied EVERY live CHECK at
    // once; pin which values made each one pass.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, noTinDraft);
    expect(row!.status).toBe('paid');
    // β numbering: receipt stream only — the invoice-stream pair stays NULL
    // so it can never collide inside invoices_tenant_fiscal_seq_unique.
    expect(row!.sequenceNumber).toBeNull();
    expect(row!.documentNumber).toBeNull();
    expect(row!.receiptDocumentNumberRaw).toBe(NO_TIN_RECEIPT_RAW);
    expect(row!.pdfDocKind).toBe('receipt_separate');
    // invoices_paid_has_payment + invoices_paid_has_receipt_status.
    expect(row!.paidAt).not.toBeNull();
    expect(row!.paymentMethod).toBe('cash');
    expect(row!.paymentRecordedByUserId).toBe(user.userId);
    expect(row!.receiptPdfStatus).toBe('rendered');
    // β separate-at-as-paid: the §105 receipt IS the main PDF — no separate
    // receipt bytes triplet.
    expect(row!.receiptPdfBlobKey).toBeNull();
    expect(row!.receiptPdfSha256).toBeNull();
    // invoices_non_draft_has_snapshots — every NON-numbering leg present.
    expect(row!.fiscalYear).toBe(2026);
    expect(row!.issueDate).toBe(ISSUE_DATE);
    expect(row!.dueDate).toBe(ISSUE_DATE); // as-paid ⇒ due = issue = payment
    expect(row!.paymentDate).toBe(ISSUE_DATE);
    expect(row!.netDaysSnapshot).toBe(0);
    expect(row!.proRatePolicySnapshot).toBeNull(); // 0203 event carve-out preserved
    expect(row!.tenantIdentitySnapshot).not.toBeNull();
    expect(row!.memberIdentitySnapshot).not.toBeNull();
    expect(row!.pdfBlobKey).not.toBeNull();
    expect(row!.pdfSha256).toBe('e'.repeat(64));
    expect(row!.pdfTemplateVersion).toBe(1);
    expect(BigInt(row!.totalSatang!.toString())).toBe(TOTAL_SATANG);
  }, 60_000);

  it('W1 (064 remediation) — admin search by the printed §105 receipt number finds the β row in BOTH list variants', async () => {
    // β rows have document_number NULL — pre-fix, the search predicate
    // ilike'd ONLY invoices.document_number so the row's printed §105 RE number
    // was unfindable in /admin/invoices. Seed an INDEPENDENT β row (own
    // registration + RE number — the 0213 receipt-raw unique backstop bars
    // reuse of NO_TIN_RECEIPT_RAW) and prove a SUBSTRING of the RE number
    // surfaces it through both `list` (cursor) and `listPaged` (offset).
    const W1_RECEIPT_RAW = 'RE-2026-000771';
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const reg = await seedUcEventWithRegistration(tenant, {
      attendeeEmail: BUYER_NO_TIN.primary_contact_email,
    });
    const draftId = await createUcDraft(tenant, user, reg.registrationId, {
      amountOverrideSatang: Number(TOTAL_SATANG),
      buyer: BUYER_NO_TIN,
    });
    const base = buildNoTinInput(tenant.ctx.slug, draftId, user.userId);
    await repo.withTx(async (tx) => {
      // Wave-4 S26/S28 — combined locked read supplies the lines.
      const locked = await repo.findByIdInTxForUpdate(tx, draftId, tenant.ctx.slug);
      if (!locked) throw new Error('locked draft load failed');
      return repo.applyIssueAsPaid(tx, {
        ...base,
        lines: locked.lines,
        numbering: {
          kind: 'receipt_stream' as const,
          receiptDocumentNumberRaw: W1_RECEIPT_RAW,
        },
        pdf: {
          ...base.pdf,
          blobKey: `invoices/${tenant.ctx.slug}/2026/${W1_RECEIPT_RAW}_v1.pdf`,
        },
      });
    });

    // Cursor variant (`list`) — substring match, case-insensitive ilike.
    const cursorPage = await repo.list(tenant.ctx.slug, {
      pageSize: 20,
      search: '000771',
    });
    expect(cursorPage.rows.map((r) => r.invoiceId)).toContain(draftId);

    // Offset variant (`listPaged`) — the /admin/invoices list path.
    const paged = await repo.listPaged(tenant.ctx.slug, {
      offset: 0,
      pageSize: 20,
      search: '000771',
    });
    expect(paged.rows.map((r) => r.invoiceId)).toContain(draftId);
    expect(paged.total).toBeGreaterThanOrEqual(1);

    // Searching by the FULL printed number works too (the obvious admin
    // paste-from-PDF flow).
    const byFull = await repo.listPaged(tenant.ctx.slug, {
      offset: 0,
      pageSize: 20,
      search: W1_RECEIPT_RAW,
    });
    expect(byFull.rows.map((r) => r.invoiceId)).toContain(draftId);
  }, 90_000);

  it('T9-2 — NEGATIVE: non-draft EVENT row with NULL seq/docnum AND NULL receipt raw → still 23514 (relax requires the receipt number)', async () => {
    // Raw owner-role UPDATE draft→issued satisfying every OTHER non-draft
    // CHECK (member_identity_snapshot already pinned at draft) — ONLY the
    // numbering legs are violated, so 23514 here pins exactly them. The
    // immutability trigger early-returns for OLD.status='draft'.
    await expectNumberingCheckViolation(() =>
      db.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          subtotal_satang = 9350, vat_rate_snapshot = '0.0700',
          vat_satang = 654, total_satang = 10004,
          fiscal_year = 2026,
          issue_date = ${ISSUE_DATE}, due_date = ${ISSUE_DATE}, net_days_snapshot = 0,
          tenant_identity_snapshot = ${JSON.stringify(T9_TENANT_SNAPSHOT)}::jsonb,
          pdf_blob_key = ${'invoices/t9-probe/event-null-numbering.pdf'},
          pdf_sha256 = ${'f'.repeat(64)}, pdf_template_version = 1,
          pdf_doc_kind = 'invoice'
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${probeEventDraft}
      `),
    );
    // Rolled back — the probe draft is untouched.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, probeEventDraft);
    expect(row!.status).toBe('draft');
    expect(row!.sequenceNumber).toBeNull();
  }, 30_000);

  it('T9-3 — NEGATIVE: non-draft MEMBERSHIP row with NULL seq/docnum, even WITH receipt raw set → still 23514 (relax is subject-scoped)', async () => {
    await expectNumberingCheckViolation(() =>
      db.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          subtotal_satang = 1000000, vat_rate_snapshot = '0.0700',
          vat_satang = 70000, total_satang = 1070000,
          fiscal_year = 2026,
          issue_date = ${ISSUE_DATE}, due_date = ${ISSUE_DATE}, net_days_snapshot = 0,
          pro_rate_policy_snapshot = 'none',
          tenant_identity_snapshot = ${JSON.stringify(T9_TENANT_SNAPSHOT)}::jsonb,
          member_identity_snapshot = ${JSON.stringify({
            legal_name: 'Simulated T9 Probe Corp',
            tax_id: '1111111111111',
            address: '9 Simulated Probe Avenue, Bangkok',
            primary_contact_name: 'Sim Probe',
            primary_contact_email: 'sim.probe@as-paid.test',
          })}::jsonb,
          pdf_blob_key = ${'invoices/t9-probe/membership-null-pair.pdf'},
          pdf_sha256 = ${'f'.repeat(64)}, pdf_template_version = 1,
          pdf_doc_kind = 'invoice',
          receipt_document_number_raw = 'RC-2026-000002'
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${probeMembershipDraft}
      `),
    );
    const row = await readInvoiceRowOwner(tenant.ctx.slug, probeMembershipDraft);
    expect(row!.status).toBe('draft');
    expect(row!.sequenceNumber).toBeNull();
    expect(row!.receiptDocumentNumberRaw).toBeNull();
  }, 30_000);

  it('T9-4 — NEGATIVE: non-draft EVENT row with HALF-PAIR (seq SET, docnum NULL) + receipt raw set → still 23514 (no §87 sequence slot without a document number)', async () => {
    // The relaxed leg must require BOTH invoice-stream numbers NULL — a
    // half-pair (sequence_number consumed, document_number missing) is a §87
    // gap-numbering anomaly the pre-0212 predicate rejected and the tightened
    // 0212 leg must keep rejecting. Same surgical-UPDATE pattern as T9-2:
    // every OTHER non-draft CHECK is satisfied so 23514 pins the numbering
    // legs (here only invoices_non_draft_has_snapshots — the half sequence
    // satisfies invoices_draft_has_no_number).
    await expectNumberingCheckViolation(() =>
      db.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          subtotal_satang = 9350, vat_rate_snapshot = '0.0700',
          vat_satang = 654, total_satang = 10004,
          fiscal_year = 2026,
          sequence_number = 424242,
          receipt_document_number_raw = 'RE-2026-000003',
          issue_date = ${ISSUE_DATE}, due_date = ${ISSUE_DATE}, net_days_snapshot = 0,
          tenant_identity_snapshot = ${JSON.stringify(T9_TENANT_SNAPSHOT)}::jsonb,
          pdf_blob_key = ${'invoices/t9-probe/event-half-pair.pdf'},
          pdf_sha256 = ${'f'.repeat(64)}, pdf_template_version = 1,
          pdf_doc_kind = 'invoice'
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${probeHalfPairDraft}
      `),
    );
    // Rolled back — the probe draft is untouched.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, probeHalfPairDraft);
    expect(row!.status).toBe('draft');
    expect(row!.sequenceNumber).toBeNull();
    expect(row!.receiptDocumentNumberRaw).toBeNull();
  }, 30_000);
});

// =============================================================================
// Task 10 (β numbering) — USE-CASE-LEVEL no-TIN as-paid end-to-end: the
// receipt-STREAM allocation is live in `issueEventInvoiceAsPaid` (the Task 9
// repo-level section above proved only the persistence seam). Real repos +
// REAL §87 allocator + audit + outbox; mocked PDF/Blob.
// =============================================================================

describe('issueEventInvoiceAsPaid — no-TIN β receipt-stream end-to-end (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let regNoTin: string;
  let draftNoTin: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // §86/4 receipt prefix 'RC' configured — this PROVES the US7/T050 split:
    // despite 'RC', the §105 event-no-TIN receipt numbers from its own separate
    // `receipt_105`/'RE' register, so the FIRST allocation is RE-2026-000001
    // (fresh tenant ⇒ deterministic) and the 'RC' register is never touched.
    await seedUcSettings(tenant, 'EVN', { receiptPrefix: 'RC' });
    ({ registrationId: regNoTin } = await seedUcEventWithRegistration(tenant, {
      attendeeEmail: BUYER_NO_TIN.primary_contact_email,
    }));
    draftNoTin = await createUcDraft(tenant, user, regNoTin, {
      amountOverrideSatang: 10004, // 100.04 THB inclusive — VAT-exact case
      buyer: BUYER_NO_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('T10-1 — no-TIN as-paid: §105 receipt on the SEPARATE receipt_105 register (RE-2026-000001), §87 invoice AND §86/4 RC counters UNTOUCHED, dual non-timeline audits + outbox', async () => {
    // THREE stream counters before the act — the core US7/T050 split claim is
    // that a §105 event-no-TIN receipt burns ONLY its own `receipt_105`/RE
    // register: NEITHER the shared §87 `invoice` stream NOR the §86/4 `RC`
    // receipt stream is touched (even though 'RC' is the configured prefix).
    const invoiceCounterBefore = await readSeqCounterFor(
      tenant.ctx.slug,
      'invoice',
      UC_FISCAL_YEAR,
    );
    const rcCounterBefore = await readSeqCounterFor(
      tenant.ctx.slug,
      'receipt',
      UC_FISCAL_YEAR,
    );
    const receipt105Before = await readSeqCounterFor(
      tenant.ctx.slug,
      'receipt_105',
      UC_FISCAL_YEAR,
    );
    expect(receipt105Before).toBeNull(); // fresh tenant — lazy bootstrap in-tx

    const captured: PdfRenderInput[] = [];
    const deps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO, captured });
    const reqId = `int-aspaid-uc-t10-${draftNoTin}`;

    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: reqId,
      invoiceId: draftNoTin,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
      paymentReference: 'SIM-DOOR-T10',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    // Domain mapping — receipt-stream numbering, NO invoice-stream pair.
    expect(res.value.status).toBe('paid');
    expect(res.value.sequenceNumber).toBeNull();
    expect(res.value.documentNumber).toBeNull();
    expect(res.value.receiptDocumentNumberRaw).toBe('RE-2026-000001');
    expect(res.value.pdfDocKind).toBe('receipt_separate');

    // Raw row — β shape committed through the REAL use-case path.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, draftNoTin);
    expect(row!.status).toBe('paid');
    expect(row!.sequenceNumber).toBeNull();
    expect(row!.documentNumber).toBeNull();
    expect(row!.receiptDocumentNumberRaw).toBe('RE-2026-000001');
    expect(row!.pdfDocKind).toBe('receipt_separate');
    expect(row!.fiscalYear).toBe(UC_FISCAL_YEAR);
    // As-paid date pin + payment fields (TIN-path parity).
    expect(row!.issueDate).toBe(UC_PAYMENT_DATE);
    expect(row!.dueDate).toBe(UC_PAYMENT_DATE);
    expect(row!.paymentDate).toBe(UC_PAYMENT_DATE);
    expect(row!.netDaysSnapshot).toBe(0);
    expect(row!.paymentMethod).toBe('cash');
    expect(row!.receiptPdfStatus).toBe('rendered');
    // The §105 receipt IS the main PDF — no separate receipt-bytes triplet.
    expect(row!.receiptPdfBlobKey).toBeNull();
    expect(row!.receiptPdfSha256).toBeNull();

    // Render input — ONE §105 receipt carrying the receipt_105-register
    // document number (the printed 'RE-…' number on the ใบเสร็จรับเงิน),
    // dates pinned to payment.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe('receipt_separate');
    expect(captured[0]!.documentNumber?.raw).toBe('RE-2026-000001');
    expect(captured[0]!.vatInclusive).toBe(true);
    expect(captured[0]!.issueDate).toBe(UC_PAYMENT_DATE);
    expect(captured[0]!.dueDate).toBe(UC_PAYMENT_DATE);

    // §87 — invoice-stream counter UNTOUCHED (no burn for a §105 receipt), and
    // the §86/4 'RC' receipt stream is ALSO untouched (US7/T050 split — even
    // with 'RC' configured). Only the separate receipt_105/RE register advances
    // (lazily bootstrapped in-tx, next = 2).
    const invoiceCounterAfter = await readSeqCounterFor(
      tenant.ctx.slug,
      'invoice',
      UC_FISCAL_YEAR,
    );
    expect(invoiceCounterAfter).toBe(invoiceCounterBefore);
    const rcCounterAfter = await readSeqCounterFor(
      tenant.ctx.slug,
      'receipt',
      UC_FISCAL_YEAR,
    );
    // §86/4 RC register stays pure — never touched by a §105 receipt.
    expect(rcCounterAfter).toBe(rcCounterBefore);
    const receipt105After = await readSeqCounterFor(
      tenant.ctx.slug,
      'receipt_105',
      UC_FISCAL_YEAR,
    );
    expect(receipt105After).toBe(2);

    // Audits — BOTH lifecycle facts, non-timeline branch (non-member buyer),
    // the receipt_105-register RE number as the forensic document number.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, reqId)));
    const issued = audits.filter((a) => a.eventType === 'invoice_issued');
    const paid = audits.filter((a) => a.eventType === 'invoice_paid');
    expect(issued).toHaveLength(1);
    expect(paid).toHaveLength(1);
    for (const a of [issued[0]!, paid[0]!]) {
      const payload = a.payload as Record<string, unknown>;
      expect(payload.invoice_id).toBe(draftNoTin);
      expect(payload.invoice_subject).toBe('event');
      expect(payload.event_registration_id).toBe(regNoTin);
      expect('member_id' in payload).toBe(false);
      expect(payload.receipt_document_number).toBe('RE-2026-000001');
    }
    const issuedPayload = issued[0]!.payload as Record<string, unknown>;
    expect(issuedPayload.sequence_number).toBeNull();
    expect(issuedPayload.document_number).toBeNull();
    // W9 — raw payment reference never lands in audit (sha256 only).
    const paidPayload = paid[0]!.payload as Record<string, unknown>;
    expect(paidPayload.payment_reference_sha256).toBeTruthy();
    expect(JSON.stringify(paidPayload)).not.toContain('SIM-DOOR-T10');

    // Outbox — exactly ONE receipt email with the §87/3 PDPA transparency
    // footer (non-member event buyer).
    const outboxRows = await outboxRowsForInvoice(tenant.ctx.slug, draftNoTin);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.toEmail).toBe(BUYER_NO_TIN.primary_contact_email);
    const ctx = outboxRows[0]!.contextData as Record<string, unknown>;
    expect(ctx.event_type).toBe('invoice_paid');
    expect(ctx.privacy_footer_kind).toBe('event_non_member');
  }, 60_000);
});

// -----------------------------------------------------------------------------
// Section Eβ — no-TIN blob-upload failure rollback (receipt_105 register, live
// Neon). β twin of Section E above (T10 reliability review Important #1): the
// no-TIN arm allocates from the SEPARATE receipt_105/RE register (US7/T050), so
// the no-gap proof must cover THAT counter — Section E only proves the invoice
// stream rolls back.
// -----------------------------------------------------------------------------

describe('issueEventInvoiceAsPaid — no-TIN β blob-upload failure rollback (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // §86/4 prefix 'RC' configured (T10 pattern) — but the §105 no-TIN arm uses
    // its own separate receipt_105/RE register, so the first SUCCESSFUL §105
    // allocation is deterministic RE-2026-000001 (US7/T050 split).
    await seedUcSettings(tenant, 'EVB', { receiptPrefix: 'RC' });
    const { registrationId } = await seedUcEventWithRegistration(tenant, {
      attendeeEmail: BUYER_NO_TIN.primary_contact_email,
    });
    invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 10004,
      buyer: BUYER_NO_TIN,
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('failed upload → typed err, row stays draft, receipt_105 counter unchanged, ZERO audits, orphan cleanup; retry gets RE-2026-000001 (no RE burn)', async () => {
    // Fresh tenant: neither stream has ever allocated (absent → null). On a
    // reused tenant the same assertions degrade gracefully to value→same.
    const receiptBefore = await readSeqCounterFor(tenant.ctx.slug, 'receipt_105', UC_FISCAL_YEAR);
    const invoiceBefore = await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR);
    expect(receiptBefore).toBeNull();

    const deleteSpy = vi.fn(async () => {});
    const failingDeps = makeUseCaseDeps(tenant.ctx.slug, {
      nowIso: UC_NOW_ISO,
      uploadPdf: async () => {
        throw new Error('simulated blob outage');
      },
      blobDelete: deleteSpy,
    });
    const res1 = await issueEventInvoiceAsPaid(failingDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-eb1-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res1.ok).toBe(false);
    if (res1.ok) throw new Error('expected blob_upload_failed');
    expect(res1.error.code).toBe('blob_upload_failed');

    // Row STILL draft — the single UPDATE never committed; the β shape never
    // landed (no receipt raw, no invoice-stream pair).
    const rowAfterFail = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(rowAfterFail!.status).toBe('draft');
    expect(rowAfterFail!.sequenceNumber).toBeNull();
    expect(rowAfterFail!.receiptDocumentNumberRaw).toBeNull();

    // §87 — the receipt_105-register counter rolled back with the tx (the β arm's
    // allocateNext ran with documentType:'receipt_105' before the upload threw).
    // Fresh tenant ⇒ absent→absent: the failed attempt burned NO RE number.
    const receiptAfterFail = await readSeqCounterFor(tenant.ctx.slug, 'receipt_105', UC_FISCAL_YEAR);
    expect(receiptAfterFail).toBe(receiptBefore);
    // β never touches the invoice stream — failure path included.
    const invoiceAfterFail = await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR);
    expect(invoiceAfterFail).toBe(invoiceBefore);

    // Orphan-blob mitigation fired against the deterministic key (built from
    // the invoiceId — IDENTICAL on both arms, never from the RC number).
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(
      `invoicing/${tenant.ctx.slug}/${UC_FISCAL_YEAR}/${invoiceId}_v1.pdf`,
    );

    // ZERO LIFECYCLE audit rows — issued/paid emitted in-tx and rolled back
    // (Section E rationale verbatim; the draft-created seed audit is legal).
    const audits = (await auditRowsForInvoice(tenant.ctx.slug, invoiceId)).filter(
      (a) => a.eventType === 'invoice_issued' || a.eventType === 'invoice_paid',
    );
    expect(audits).toHaveLength(0);

    // Retry with a WORKING blob → succeeds with the FIRST receipt_105-register
    // number — RE-2026-000001 proves the failed attempt left no RE gap.
    const retryDeps = makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO });
    const res2 = await issueEventInvoiceAsPaid(retryDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-eb2-${invoiceId}`,
      invoiceId: invoiceId as string,
      paymentDate: UC_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res2.ok, res2.ok ? 'ok' : `retry err: ${JSON.stringify(res2)}`).toBe(true);
    if (!res2.ok) throw new Error('retry failed');
    expect(res2.value.receiptDocumentNumberRaw).toBe('RE-2026-000001');
    expect(res2.value.sequenceNumber).toBeNull();
    expect(res2.value.documentNumber).toBeNull();

    const row2 = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row2!.status).toBe('paid');
    expect(row2!.receiptDocumentNumberRaw).toBe('RE-2026-000001');
    expect(row2!.sequenceNumber).toBeNull();
    expect(row2!.pdfDocKind).toBe('receipt_separate');

    // Exactly ONE receipt_105 allocation across fail+retry (next = 2); the
    // invoice stream stayed untouched end-to-end.
    expect(await readSeqCounterFor(tenant.ctx.slug, 'receipt_105', UC_FISCAL_YEAR)).toBe(2);
    expect(await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR)).toBe(
      invoiceBefore,
    );
  }, 90_000);
});

// -----------------------------------------------------------------------------
// Section G — 064 S1: registration refunded BETWEEN draft and issuance (TOCTOU)
// -----------------------------------------------------------------------------
// createEventInvoiceDraft hard-blocks refunded registrations at DRAFT time
// only. These tests flip the registration row to 'refunded' AFTER the real
// draft was created (direct UPDATE under runInTenant — the same shape the F6
// refund webhook/CSV import writes), then prove BOTH issuance paths reject
// with `registration_refunded`, the row stays draft, and no §87/receipt
// sequence is consumed.

describe('064 S1 — registration refunded between draft and issuance (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedUcSettings(tenant, 'EVG', { receiptPrefix: 'RG' });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  async function flipRegistrationToRefunded(registrationId: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(eventRegistrations)
        .set({ paymentStatus: 'refunded' })
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.registrationId, registrationId),
          ),
        );
    });
  }

  it('as-paid path: refunded flip after drafting → registration_refunded, row stays draft, NO sequence burned', async () => {
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    const invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
    await flipRegistrationToRefunded(registrationId);

    const invoiceSeqBefore = await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR);
    const receiptSeqBefore = await readSeqCounterFor(tenant.ctx.slug, 'receipt', UC_FISCAL_YEAR);

    const r = await issueEventInvoiceAsPaid(
      makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO }),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-aspaid-uc-g1-${invoiceId}`,
        invoiceId: invoiceId as string,
        paymentDate: UC_PAYMENT_DATE,
        paymentMethod: 'cash',
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected registration_refunded, got ok');
    expect(r.error.code).toBe('registration_refunded');

    // Row untouched — still a draft with no numbering and no payment fields.
    const row = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row!.status).toBe('draft');
    expect(row!.sequenceNumber).toBeNull();
    expect(row!.receiptDocumentNumberRaw).toBeNull();
    expect(row!.paidAt).toBeNull();

    // PRE-allocation reject: neither stream's counter moved.
    expect(await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR)).toBe(
      invoiceSeqBefore,
    );
    expect(await readSeqCounterFor(tenant.ctx.slug, 'receipt', UC_FISCAL_YEAR)).toBe(
      receiptSeqBefore,
    );
  }, 90_000);

  it('bill-first path (issueInvoice): refunded flip after drafting → registration_refunded, row stays draft, NO §87 burn', async () => {
    const { registrationId } = await seedUcEventWithRegistration(tenant);
    const invoiceId = await createUcDraft(tenant, user, registrationId, {
      amountOverrideSatang: 107000,
      buyer: UC_BUYER_TIN,
    });
    await flipRegistrationToRefunded(registrationId);

    const invoiceSeqBefore = await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR);

    const r = await issueInvoice(makeUseCaseDeps(tenant.ctx.slug, { nowIso: UC_NOW_ISO }), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-aspaid-uc-g2-${invoiceId}`,
      invoiceId: invoiceId as string,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected registration_refunded, got ok');
    expect(r.error.code).toBe('registration_refunded');

    const row = await readInvoiceRowOwner(tenant.ctx.slug, invoiceId);
    expect(row!.status).toBe('draft');
    expect(row!.sequenceNumber).toBeNull();

    expect(await readSeqCounterFor(tenant.ctx.slug, 'invoice', UC_FISCAL_YEAR)).toBe(
      invoiceSeqBefore,
    );
  }, 90_000);
});
