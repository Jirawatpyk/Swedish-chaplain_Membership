/**
 * Task 7 (054-event-fee-invoices) — issueInvoice for EVENT-fee invoices
 * (live Neon Singapore via .env.local).
 *
 * Exercises the REAL `issueInvoice` use-case (real Drizzle invoice repo + real
 * tenant-settings repo + real §87 sequence allocator + real F4 audit adapter;
 * PDF render + Blob upload are mocked to stay fast, exactly like the membership
 * `vat-source-chain.test.ts` pin). Drafts are created through the REAL
 * `createEventInvoiceDraft` so the buyer-snapshot pinning (non-member at DRAFT,
 * matched member at ISSUE) is end-to-end.
 *
 * Asserts (per Task 7 spec):
 *   1. Issue succeeds for BOTH a non-member event draft (member_id NULL) and a
 *      matched-member event draft — does NOT crash on the member-lock branch and
 *      does NOT trip the relaxed `invoices_non_draft_has_snapshots` CHECK
 *      (proves migration 0203 + the null `pro_rate_policy_snapshot` on event).
 *   2. Each allocates the next INV §87 sequence number + sets `pdf_*` metadata.
 *   3. VAT EXACT (Model B): an inclusive ticket of 10004 satang (100.04 THB) →
 *      total === 10004 (NOT 10005), subtotal + vat === total, vat = total −
 *      subtotal per `splitVatInclusive`. 100.04 is a known mismatch case under a
 *      naive store-subtotal-then-recompute-VAT path.
 *   4. Doc-type drivers (054 Task 9, REVISED by 064 §105 ROOT FIX): the PDF
 *      render `kind` is chosen at issue from invoiceSubject + buyer TIN — a
 *      non-member who supplied a 13-digit TIN renders `kind:'invoice'` (§86/4
 *      full tax invoice), while a non-member WITHOUT one is now REJECTED at
 *      plain issue (`event_no_tin_requires_paid_issue`): a no-TIN buyer's only
 *      legal document is a §105 ใบเสร็จรับเงิน, which may exist ONLY at the
 *      moment payment is recorded (`issueEventInvoiceAsPaid` — see
 *      issue-as-paid.test.ts). The blocked attempt burns no §87 number and
 *      leaves the draft (with its no-TIN buyer snapshot pinned at draft) intact.
 *   5. Audit branch: the non-member issue (memberId NULL) emits `invoice_issued`
 *      via the NON-timeline branch — persisted payload has NO `member_id` key but
 *      carries `event_registration_id`; the matched member emits via the timeline
 *      branch (payload HAS `member_id`).
 *   6. The non-member buyer snapshot persisted at ISSUE is the one PRE-PINNED at
 *      DRAFT — issue does not null it nor re-resolve a member.
 *
 * Lives in tests/integration/** → hits live Neon. Migrations 0200–0203 MUST be
 * applied first (`pnpm db:migrate`).
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
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { splitVatInclusive } from '@/modules/invoicing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

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

// Non-member buyer WITH a Thai TIN → §86/4 tax-invoice doc-type downstream.
const BUYER_WITH_TIN = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
} as const;

// Non-member buyer WITHOUT a TIN (individual) → receipt doc-type downstream.
const BUYER_NO_TIN = {
  legal_name: 'Walk-in Guest',
  tax_id: null,
  address: '99 Charoen Krung Road, Bangkok 10500',
  primary_contact_name: 'Walk-in Guest',
  primary_contact_email: 'walkin@example.com',
} as const;

/** Mocked PDF/Blob deps mirroring the membership vat-source-chain pin. The
 *  optional `captured` array records every render input so a test can assert
 *  the §86/4 doc-type `kind` chosen at issue (Task 9). */
function makeIssueDepsWithMocks(
  tenantSlug: string,
  captured?: PdfRenderInput[],
): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    // Real member-identity adapter — the matched-member branch re-reads the live
    // member at issue (snapshot pinned at issue). Non-member branch never calls it.
    memberIdentity: makeCreateEventInvoiceDraftDeps(tenantSlug).memberIdentity,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        captured?.push(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: 1,
    taxAtPayment: 'off',
  };
}

describe('issueInvoice — EVENT-fee invoices (Model B exact VAT, member + non-member)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'event-issue-plan';

  let eventId: string;
  let regWithTinId: string; // non-member WITH tin, 100.04 THB (VAT-exact case)
  let regNoTinId: string; // non-member WITHOUT tin, 250 THB (receipt doc-type)
  let regMatchedId: string; // matched company member WITH tin, 2,000 THB
  let regFooterEmailId: string; // Task 14 — non-member WITH contact email
  let regFooterNoEmailId: string; // Task 14 — non-member with EMPTY contact email
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    regWithTinId = randomUUID();
    regNoTinId = randomUUID();
    regMatchedId = randomUUID();
    regFooterEmailId = randomUUID();
    regFooterNoEmailId = randomUUID();
    memberId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      // Tenant invoice settings — standard 7% VAT, an event-distinct prefix.
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
        invoiceNumberPrefix: 'EVT',
        creditNoteNumberPrefix: 'EVTC',
      });

      // F2 plan — company scope (drives §86/4 on the matched member).
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Event Issue Plan' },
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

      // F3 matched company member WITH tax_id + a primary contact.
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Gamma Corp',
        country: 'TH',
        taxId: '1111111111111',
        // 059 / PR-A Task 6a — the RECORDED registrant flag now decides whether an
        // EVENT fee may be billed first (§86/4 ใบกำกับภาษี) or must go as-paid
        // (§105 ใบเสร็จรับเงิน). `tax_id` alone no longer implies registrant status
        // — it may hold a foreign natural person's passport. This seed models a
        // VAT-registrant company, which is why bill-first is legal for it.
        isVatRegistered: true,
        addressLine1: '1 Wireless Road',
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
        firstName: 'Som',
        lastName: 'Chai',
        email: 'som.chai@gamma.example',
        isPrimary: true,
      });

      // F6 event.
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_fee_issue_int',
        name: 'Annual Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      // Non-member registration — ticket price irrelevant (we override to 10004).
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regWithTinId,
        eventId,
        externalId: 'att_with_tin',
        attendeeEmail: 'jane@beta.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Beta Imports Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 5000,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      // Non-member registration, no TIN buyer — 250 THB ticket.
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regNoTinId,
        eventId,
        externalId: 'att_no_tin',
        attendeeEmail: 'walkin@example.com',
        attendeeName: 'Walk-in Guest',
        attendeeCompany: null,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      // Matched-member registration — 2,000 THB ticket.
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regMatchedId,
        eventId,
        externalId: 'att_matched',
        attendeeEmail: 'som.chai@gamma.example',
        attendeeName: 'Som Chai',
        attendeeCompany: 'Gamma Corp',
        matchType: 'member_domain',
        matchedMemberId: memberId,
        ticketType: 'Standard',
        ticketPriceThb: 2000,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      // Task 14 — non-member registration WITH a contact email (auto-email
      // enqueues a privacy-footer row).
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regFooterEmailId,
        eventId,
        externalId: 'att_footer_email',
        attendeeEmail: 'footer-buyer@example.com',
        attendeeName: 'Footer Buyer',
        attendeeCompany: null,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      // Task 14 — non-member registration whose buyer has NO contact email
      // (empty-recipient guard: auto-email is skipped, invoice still issues).
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regFooterNoEmailId,
        eventId,
        externalId: 'att_footer_no_email',
        attendeeEmail: 'placeholder-no-email@example.com',
        attendeeName: 'No-Email Buyer',
        attendeeCompany: null,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /** Helper: read the issued invoice row back (owner role — bypass RLS). */
  async function readInvoiceRow(invoiceId: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  /** §87 counter for (tenant, 'invoice', fy) — null when never allocated. */
  async function readInvoiceSeqCounter(fiscalYear: number): Promise<number | null> {
    const [row] = await db
      .select()
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'invoice'),
          eq(tenantDocumentSequences.fiscalYear, fiscalYear),
        ),
      );
    return row?.nextSequenceNumber ?? null;
  }

  it('non-member WITH tin: issues, Model-B EXACT VAT on 100.04 THB (10004 satang), tax-invoice snapshot, non-timeline audit, pre-pinned buyer snapshot', async () => {
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-draft-withtin-${regWithTinId}`,
      eventRegistrationId: regWithTinId,
      amountOverride: 10004, // 100.04 THB inclusive — the known VAT mismatch case.
      buyer: BUYER_WITH_TIN,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    const issueReqId = `int-evt-issue-withtin-${invoiceId}`;
    const captured: PdfRenderInput[] = [];
    const result = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug, captured), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: issueReqId,
      invoiceId,
    });
    expect(result.ok, result.ok ? 'ok' : `issue err: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`issue failed`);

    // §86/4 doc-type: event + buyer TIN → full tax invoice (ใบกำกับภาษี).
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe('invoice');
    expect(captured[0]!.vatInclusive).toBe(true);

    const row = await readInvoiceRow(invoiceId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('issued');
    expect(row!.invoiceSubject).toBe('event');
    expect(row!.vatInclusive).toBe(true);
    // §87 numbering + pdf metadata present.
    expect(row!.fiscalYear).not.toBeNull();
    expect(row!.sequenceNumber).not.toBeNull();
    expect(row!.documentNumber).toContain('EVT');
    expect(row!.pdfBlobKey).not.toBeNull();
    expect(row!.pdfSha256).not.toBeNull();
    expect(row!.pdfTemplateVersion).toBe(1);
    // pro_rate_policy_snapshot is NULL for an event invoice (relaxed CHECK).
    expect(row!.proRatePolicySnapshot).toBeNull();
    // net_days_snapshot IS populated for event (from tenant settings).
    expect(row!.netDaysSnapshot).not.toBeNull();

    // --- Model B EXACT VAT on 10004 satang @ 7% ---
    const total = BigInt(row!.totalSatang!.toString());
    const subtotal = BigInt(row!.subtotalSatang!.toString());
    const vat = BigInt(row!.vatSatang!.toString());
    expect(total).toBe(10004n); // NOT 10005 — the inclusive amount is preserved exactly.
    expect(subtotal + vat).toBe(total); // exact split invariant.
    expect(vat).toBe(total - subtotal); // vat is the derived remainder.
    // Cross-check against the domain helper directly.
    const expected = splitVatInclusive(Money.fromSatangUnsafe(10004n), 700n);
    expect(subtotal).toBe(expected.subtotal.satang);
    expect(vat).toBe(expected.vat.satang);
    expect(row!.vatRateSnapshot).toBe('0.0700');

    // Doc-type driver: buyer snapshot tax_id present → tax invoice downstream.
    const snap = row!.memberIdentitySnapshot as Record<string, unknown>;
    expect(snap.tax_id).toBe('9876543210123');
    // The buyer snapshot is the one PINNED AT DRAFT (issue did not re-resolve it).
    // 055-member-number — the §105 event/non-member receipt path carries BOTH
    // member-number fields as null (no F3 member): the bare integer via
    // makeMemberIdentitySnapshot's zod `.default(null)`, and the formatted
    // display string likewise null, so the PDF buyer block omits the Member No.
    // line.
    expect(snap).toEqual({
      legal_name: 'Beta Imports Ltd',
      tax_id: '9876543210123',
      address: '50 Sukhumvit Road, Bangkok 10110',
      primary_contact_name: 'Jane Doe',
      primary_contact_email: 'jane@beta.example',
      member_number: null,
      member_number_display: null,
      // 088-invoice-tax-flow-redesign (T010) — the read-boundary zod parse
      // materialises the buyer §86/4 branch particulars at their fail-closed
      // defaults for the pinned non-member event buyer.
      buyer_is_head_office: true,
      buyer_branch_code: null,
      buyer_is_vat_registrant: false,
    });

    // Audit: non-member → NON-timeline `invoice_issued` (no member_id, has event_registration_id).
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_issued'),
          eq(auditLog.requestId, issueReqId),
        ),
      );
    expect(auditRow).toBeDefined();
    const payload = auditRow!.payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe(regWithTinId);
    expect(payload.invoice_id).toBe(invoiceId);
  }, 60_000);

  it('064 §105 ROOT FIX — non-member WITHOUT tin: plain issue is REJECTED, no §87 number burned, row stays draft with the no-TIN snapshot pinned', async () => {
    // Migrated from the pre-064 "issues with receipt-type snapshot" test: a
    // no-TIN event buyer can no longer be billed first — their only legal
    // document is a §105 ใบเสร็จรับเงิน, which exists ONLY via the
    // record-as-paid flow (`issueEventInvoiceAsPaid`). What moved where:
    //   - the §105 receipt render + non-timeline audit coverage for non-member
    //     event buyers lives in issue-as-paid.test.ts (section A1 covers the
    //     TIN/receipt_combined shape; the no-TIN/receipt_separate β shape is
    //     covered by its Task 10 receipt-stream section);
    //   - the persisted no-TIN buyer-snapshot assertion (tax_id NULL, pinned
    //     at DRAFT) is preserved HERE against the draft row;
    //   - the 25000-satang Model-B VAT-exact split is already pinned by the
    //     WITH-tin case above (10004 satang, the harder rounding case).
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-draft-notin-${regNoTinId}`,
      eventRegistrationId: regNoTinId,
      buyer: BUYER_NO_TIN,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    // §87 invoice-stream counter BEFORE the blocked attempt (issue clock is
    // 2026-04-18 → FY2026 under the default Jan fiscal-year start).
    const counterBefore = await readInvoiceSeqCounter(2026);

    const issueReqId = `int-evt-issue-notin-${invoiceId}`;
    const captured: PdfRenderInput[] = [];
    const result = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug, captured), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: issueReqId,
      invoiceId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected event_no_tin_requires_paid_issue, got ok');
    expect(result.error.code).toBe('event_no_tin_requires_paid_issue');

    // The gate runs BEFORE allocateNext — no §87 number consumed, no render.
    const counterAfter = await readInvoiceSeqCounter(2026);
    expect(counterAfter).toBe(counterBefore);
    expect(captured).toHaveLength(0);

    // Row stays a DRAFT: no numbering, no PDF, no doc kind.
    const row = await readInvoiceRow(invoiceId);
    expect(row!.status).toBe('draft');
    expect(row!.sequenceNumber).toBeNull();
    expect(row!.documentNumber).toBeNull();
    expect(row!.pdfBlobKey).toBeNull();
    expect(row!.pdfDocKind).toBeNull();

    // The no-TIN buyer snapshot PRE-PINNED at draft is untouched (preserved
    // assertion from the dead test — the rejection must not null it).
    const snap = row!.memberIdentitySnapshot as Record<string, unknown>;
    expect(snap.tax_id).toBeNull();
    expect(snap.legal_name).toBe('Walk-in Guest');

    // No invoice_issued audit was committed for the blocked attempt.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_issued'),
          eq(auditLog.requestId, issueReqId),
        ),
      );
    expect(auditRows).toHaveLength(0);
  }, 60_000);

  it('matched member: issues with snapshot from getForIssue (their tax_id), TIMELINE audit branch (payload has member_id)', async () => {
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-draft-matched-${regMatchedId}`,
      eventRegistrationId: regMatchedId,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    const issueReqId = `int-evt-issue-matched-${invoiceId}`;
    const captured: PdfRenderInput[] = [];
    const result = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug, captured), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: issueReqId,
      invoiceId,
    });
    expect(result.ok, result.ok ? 'ok' : `issue err: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error('issue failed');

    // §86/4 doc-type: matched member carries a TIN → full tax invoice.
    expect(captured[0]!.kind).toBe('invoice');

    const row = await readInvoiceRow(invoiceId);
    expect(row!.status).toBe('issued');
    expect(row!.memberId).toBe(memberId);
    // 2,000 THB = 200000 satang inclusive @ 7%.
    const total = BigInt(row!.totalSatang!.toString());
    const subtotal = BigInt(row!.subtotalSatang!.toString());
    const vat = BigInt(row!.vatSatang!.toString());
    expect(total).toBe(200000n);
    expect(subtotal + vat).toBe(total);
    // Snapshot resolved from getForIssue (the live member) — pinned at ISSUE.
    const snap = row!.memberIdentitySnapshot as Record<string, unknown>;
    expect(snap.tax_id).toBe('1111111111111');
    expect(snap.legal_name).toBe('Gamma Corp');

    // Audit: matched member → TIMELINE branch (payload HAS member_id).
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_issued'),
          eq(auditLog.requestId, issueReqId),
        ),
      );
    const payload = auditRow!.payload as Record<string, unknown>;
    expect(payload.member_id).toBe(memberId);
  }, 60_000);

  // --- Task 14 — auto-email hardening on the issue path (live Neon) -----------
  // The tenant settings seeded above leave `auto_email_enabled` at its
  // DEFAULT true, and `createEventInvoiceDraft` sets `autoEmailOnIssue: null`,
  // so an event invoice auto-emails via the tenant default. Uses the REAL
  // `resendEmailOutboxAdapter` so the assertion lands on a live
  // `notifications_outbox` row.

  it('(Task 14 / B) non-member event WITH buyer email → enqueues outbox row carrying privacy_footer_kind:event_non_member', async () => {
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-draft-footer-email-${regFooterEmailId}`,
      eventRegistrationId: regFooterEmailId,
      buyer: {
        legal_name: 'Footer Buyer Ltd',
        tax_id: '9876543210123',
        address: '1 Footer Road, Bangkok 10110',
        primary_contact_name: 'Footer Buyer',
        primary_contact_email: 'footer-buyer@example.com',
      },
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    const result = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-issue-footer-email-${invoiceId}`,
      invoiceId,
    });
    expect(result.ok, result.ok ? 'ok' : `issue err: ${JSON.stringify(result)}`).toBe(true);

    const [row] = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
        ),
      )
      .then((rows) =>
        rows.filter(
          (r) => (r.contextData as Record<string, unknown>).invoice_id === invoiceId,
        ),
      );
    expect(row, 'expected an invoice_auto_email outbox row for this invoice').toBeDefined();
    expect(row!.toEmail).toBe('footer-buyer@example.com');
    const ctx = row!.contextData as Record<string, unknown>;
    expect(ctx.event_type).toBe('invoice_issued');
    expect(ctx.privacy_footer_kind).toBe('event_non_member');
  }, 60_000);

  it('(Task 14 / A) non-member event with EMPTY buyer email → NO outbox row, invoice still issues', async () => {
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-draft-footer-noemail-${regFooterNoEmailId}`,
      eventRegistrationId: regFooterNoEmailId,
      buyer: {
        legal_name: 'No-Email Buyer Ltd',
        tax_id: '9876543210123',
        address: '2 No-Email Road, Bangkok 10110',
        primary_contact_name: 'No-Email Buyer',
        // Empty contact email — the snapshot contract accepts '' (§86/4: a
        // buyer contact is supplementary, not required).
        primary_contact_email: '',
      },
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    const result = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-evt-issue-footer-noemail-${invoiceId}`,
      invoiceId,
    });
    // Invoice issues successfully — the auto-email is best-effort.
    expect(result.ok, result.ok ? 'ok' : `issue err: ${JSON.stringify(result)}`).toBe(true);
    const row = await readInvoiceRow(invoiceId);
    expect(row!.status).toBe('issued');

    // No outbox row was enqueued for this invoice (empty-recipient guard).
    const rows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
        ),
      )
      .then((all) =>
        all.filter(
          (r) => (r.contextData as Record<string, unknown>).invoice_id === invoiceId,
        ),
      );
    expect(rows).toHaveLength(0);
  }, 60_000);
});
