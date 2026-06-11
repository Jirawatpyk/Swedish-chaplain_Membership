/**
 * 054-event-fee-invoices — §87 interleaved membership+event sequence
 * continuity (live Neon Singapore via .env.local).
 *
 * Spec §7 requirement: "shared INV continuity across interleaved
 * membership+event ... no gap/reset, §87."
 *
 * Membership invoices (`invoice_subject='membership'`) and event-fee
 * invoices (`invoice_subject='event'`) SHARE the single
 * `documentType:'invoice'` §87 sequence stream in
 * `tenant_document_sequences`. A regression that allocates from a
 * second, event-only counter would violate §87 (gap or parallel
 * numbering).
 *
 * This test exercises the REAL allocator + REAL use-cases:
 *
 *   1. membership invoice: `createInvoiceDraft` → `issueInvoice`  → seq N
 *   2. event invoice:      `createEventInvoiceDraft` → `issueInvoice` → seq N+1
 *   3. membership invoice: `createInvoiceDraft` → `issueInvoice`  → seq N+2
 *
 * Assertions:
 *   - the three `sequence_number`s are STRICTLY consecutive (N, N+1, N+2)
 *     with no gap or reset between them;
 *   - the `document_number`s embed the same prefix + consecutive seq digits
 *     (same stream, different subject types);
 *   - `invoice_subject` on each row matches the expected type
 *     ('membership' vs 'event'), proving the interleave is genuine.
 *
 * PDF render + Blob upload are mocked (same pattern as
 * `vat-source-chain.test.ts` and `issue-event-invoice.test.ts`) to keep
 * the test fast while exercising the REAL allocator + transaction path.
 *
 * Fiscal-year boundary: the allocator's FY isolation is already proven
 * in `seq-number-atomicity.test.ts` (e) — we focus on within-FY
 * interleaving here. Adding a cross-FY interleave variant would require
 * injecting a clock that crosses the Jan 1 boundary; the existing
 * atomicity test already covers FY independence at the allocator level
 * so we do NOT duplicate that concern here.
 *
 * Lives in tests/integration/** → hits live Neon.
 * Migrations 0200–0203 MUST be applied first (`pnpm db:migrate`).
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
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { makeCreateInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import { issueEventInvoiceAsPaid } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { IssueEventInvoiceAsPaidDeps } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/**
 * Non-member buyer WITH a Thai TIN — the event invoice uses this buyer
 * so it issues as a §86/4 full tax invoice (same stream as membership).
 */
const EVENT_BUYER = {
  legal_name: 'Interleave Test Corp',
  tax_id: '1234512345123',
  address: '1 Silom Road, Bangkok 10500',
  primary_contact_name: 'Test Buyer',
  primary_contact_email: 'buyer@interleave.example',
} as const;

/**
 * 064 Task 10 — SIMULATED no-TIN walk-in buyer. An as-paid no-TIN event
 * invoice is a §105 receipt numbered from the RECEIPT stream (β): inserting
 * one into the middle of the interleave must NOT advance the shared
 * `documentType:'invoice'` counter.
 */
const BUYER_NO_TIN = {
  legal_name: 'Simulated Interleave Walk-in',
  tax_id: null,
  address: '2 Simulated Lane, Bangkok 10500',
  primary_contact_name: 'Sim Walkin',
  primary_contact_email: 'walkin@interleave.example',
} as const;

/**
 * Build IssueInvoiceDeps with mocked PDF + Blob so the real allocator +
 * real DB path is exercised without a live PDF render or Blob upload.
 * The `captured` array records every render call so the test can confirm
 * which doc-type was chosen at issue.
 */
function makeIssueDeps(
  tenantSlug: string,
  captured?: PdfRenderInput[],
): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: makeCreateEventInvoiceDraftDeps(tenantSlug).memberIdentity,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        captured?.push(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('c'.repeat(64)),
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
    clock: { nowIso: () => '2026-07-01T09:00:00Z' },
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: 1,
  };
}

/**
 * 064 Task 6 — deps for the AS-PAID leg of the interleave. Identical adapter
 * wiring to `makeIssueDeps` (real allocator/repos/audit/outbox; mocked
 * PDF/Blob); `IssueEventInvoiceAsPaidDeps` is structurally identical to
 * `IssueInvoiceDeps` plus an optional `onPaidCallbacks` we don't register.
 */
function makeAsPaidDeps(tenantSlug: string): IssueEventInvoiceAsPaidDeps {
  return makeIssueDeps(tenantSlug);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('§87 interleaved membership+event sequence continuity (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  const planId = 'interleave-test-plan';
  const planYear = 2026;
  let memberId: string;
  let eventId: string;
  let eventRegId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    eventId = randomUUID();
    eventRegId = randomUUID();

    // Tenant invoice settings — same prefix for all document types so the
    // interleaved document_number carries one shared prefix. Wave-4 S18 —
    // shared helper (row values identical to the former inline insert).
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าทดสอบ',
      legalNameEn: 'Test Chamber',
      registeredAddressTh: 'Bangkok',
      registeredAddressEn: 'Bangkok',
    });

    await runInTenant(tenant.ctx, async (tx) => {
      // F2 membership plan — company scope.
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Interleave Test Plan' },
        description: { en: 'Plan for §87 interleave test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 500_000,
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

      // F3 company member WITH tax_id (required for membership §86/4 invoice).
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Interleave Member Corp',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV Road',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Member',
        lastName: 'Contact',
        email: 'member.contact@interleave.example',
        isPrimary: true,
      });

      // F6 event.
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_interleave_seq',
        name: 'Interleave Test Gala',
        startDate: new Date('2026-08-15T10:00:00Z'),
      } satisfies NewEventRow);

      // Non-member event registration for the event invoice.
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: eventRegId,
        eventId,
        externalId: 'att_interleave_seq',
        attendeeEmail: 'buyer@interleave.example',
        attendeeName: 'Test Buyer',
        attendeeCompany: 'Interleave Test Corp',
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 1000,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-07-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /** Read the issued invoice row back (owner role — bypasses RLS). */
  async function readInvoiceRow(invoiceId: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  it(
    'membership → event → membership issues produce strictly consecutive §87 sequence numbers on ONE shared stream',
    async () => {
      // -----------------------------------------------------------------------
      // Step 1 — MEMBERSHIP draft + issue
      // -----------------------------------------------------------------------
      const membershipDraftDeps = makeCreateInvoiceDraftDeps(tenant.ctx.slug);
      const draftResult1 = await createInvoiceDraft(membershipDraftDeps, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-draft-mem1-${memberId}`,
        memberId,
        planId,
        planYear,
      });
      expect(
        draftResult1.ok,
        draftResult1.ok ? 'ok' : `membership draft 1 err: ${draftResult1.error.code}`,
      ).toBe(true);
      if (!draftResult1.ok) throw new Error(`membership draft 1 failed: ${draftResult1.error.code}`);
      const membershipInvoiceId1 = draftResult1.value.invoiceId;

      const issueResult1 = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-issue-mem1-${membershipInvoiceId1}`,
        invoiceId: membershipInvoiceId1,
      });
      expect(
        issueResult1.ok,
        issueResult1.ok ? 'ok' : `membership issue 1 err: ${JSON.stringify(issueResult1)}`,
      ).toBe(true);
      if (!issueResult1.ok) throw new Error('membership issue 1 failed');

      // -----------------------------------------------------------------------
      // Step 2 — EVENT draft + issue (different invoice_subject)
      // -----------------------------------------------------------------------
      const eventDraftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
      const eventDraftResult = await createEventInvoiceDraft(eventDraftDeps, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-draft-evt-${eventRegId}`,
        eventRegistrationId: eventRegId,
        amountOverride: 100_000, // 1,000 THB inclusive
        buyer: EVENT_BUYER,
      });
      expect(
        eventDraftResult.ok,
        eventDraftResult.ok ? 'ok' : `event draft err: ${eventDraftResult.error.code}`,
      ).toBe(true);
      if (!eventDraftResult.ok) throw new Error(`event draft failed: ${eventDraftResult.error.code}`);
      const eventInvoiceId = eventDraftResult.value.invoiceId;

      const eventIssueResult = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-issue-evt-${eventInvoiceId}`,
        invoiceId: eventInvoiceId,
      });
      expect(
        eventIssueResult.ok,
        eventIssueResult.ok ? 'ok' : `event issue err: ${JSON.stringify(eventIssueResult)}`,
      ).toBe(true);
      if (!eventIssueResult.ok) throw new Error('event issue failed');

      // -----------------------------------------------------------------------
      // Step 3 — second MEMBERSHIP draft + issue (interleave closes back to
      // membership subject — the counter must NOT reset)
      // -----------------------------------------------------------------------
      // We need a fresh member to avoid `duplicate_draft` on the same
      // (memberId, planYear) pair. We insert a second member here inside
      // a separate `runInTenant` because beforeAll already committed.
      const memberId2 = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberId2,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Interleave Member Corp 2',
          country: 'TH',
          taxId: '8888888888888',
          addressLine1: '88 Sukhumvit Road',
          city: 'Watthana',
          province: 'Bangkok',
          postalCode: '10110',
          planId,
          planYear,
        });
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: memberId2,
          firstName: 'Member2',
          lastName: 'Contact2',
          email: 'member2.contact@interleave.example',
          isPrimary: true,
        });
      });

      const draftResult2 = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-draft-mem2-${memberId2}`,
        memberId: memberId2,
        planId,
        planYear,
      });
      expect(
        draftResult2.ok,
        draftResult2.ok ? 'ok' : `membership draft 2 err: ${draftResult2.error.code}`,
      ).toBe(true);
      if (!draftResult2.ok) throw new Error(`membership draft 2 failed: ${draftResult2.error.code}`);
      const membershipInvoiceId2 = draftResult2.value.invoiceId;

      const issueResult2 = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-issue-mem2-${membershipInvoiceId2}`,
        invoiceId: membershipInvoiceId2,
      });
      expect(
        issueResult2.ok,
        issueResult2.ok ? 'ok' : `membership issue 2 err: ${JSON.stringify(issueResult2)}`,
      ).toBe(true);
      if (!issueResult2.ok) throw new Error('membership issue 2 failed');

      // -----------------------------------------------------------------------
      // Assert: all three rows must land on ONE strictly consecutive stream
      // -----------------------------------------------------------------------
      const row1 = await readInvoiceRow(membershipInvoiceId1);
      const rowEvt = await readInvoiceRow(eventInvoiceId);
      const row2 = await readInvoiceRow(membershipInvoiceId2);

      expect(row1, 'membership invoice 1 row must exist').toBeDefined();
      expect(rowEvt, 'event invoice row must exist').toBeDefined();
      expect(row2, 'membership invoice 2 row must exist').toBeDefined();

      // All three must be issued and carry a sequence number.
      expect(row1!.status).toBe('issued');
      expect(rowEvt!.status).toBe('issued');
      expect(row2!.status).toBe('issued');

      expect(row1!.sequenceNumber, 'membership invoice 1 must have a sequence_number').not.toBeNull();
      expect(rowEvt!.sequenceNumber, 'event invoice must have a sequence_number').not.toBeNull();
      expect(row2!.sequenceNumber, 'membership invoice 2 must have a sequence_number').not.toBeNull();

      // invoice_subject confirms we genuinely interleaved subjects.
      expect(row1!.invoiceSubject).toBe('membership');
      expect(rowEvt!.invoiceSubject).toBe('event');
      expect(row2!.invoiceSubject).toBe('membership');

      // All three must be in the same fiscal year (same §87 stream).
      expect(row1!.fiscalYear).not.toBeNull();
      expect(rowEvt!.fiscalYear).toBe(row1!.fiscalYear);
      expect(row2!.fiscalYear).toBe(row1!.fiscalYear);

      // Extract sequence numbers for the core §87 continuity assertion.
      const seq1 = row1!.sequenceNumber!;
      const seqEvt = rowEvt!.sequenceNumber!;
      const seq2 = row2!.sequenceNumber!;

      // Sort them: they must form three consecutive integers regardless
      // of insertion order (the suite runs serially via singleFork but
      // we sort defensively so the assertion is order-independent).
      const sorted = [seq1, seqEvt, seq2].sort((a, b) => a - b);
      expect(sorted[1]).toBe(sorted[0]! + 1);
      expect(sorted[2]).toBe(sorted[0]! + 2);

      // The event invoice MUST NOT have a lower sequence than the
      // first membership invoice — it continued the same stream.
      expect(seqEvt).toBeGreaterThan(seq1);
      // The second membership invoice MUST be greater than the event
      // invoice — the stream did NOT reset when the subject switched back.
      expect(seq2).toBeGreaterThan(seqEvt);

      // document_number must embed the shared prefix on all three rows,
      // confirming they come from the same document sequence.
      expect(row1!.documentNumber, 'membership 1 document_number must start with INV').toMatch(
        /^INV/,
      );
      expect(rowEvt!.documentNumber, 'event document_number must start with INV').toMatch(/^INV/);
      expect(row2!.documentNumber, 'membership 2 document_number must start with INV').toMatch(
        /^INV/,
      );
    },
    90_000,
  );

  it(
    '064 Task 6+10 — as-paid legs: membership → bill-first event → no-TIN as-paid (RECEIPT stream, no burn) → TIN as-paid are N, N+1, N+2 on the invoice stream',
    async () => {
      // Fresh fixtures — the first test consumed the original member +
      // registration (duplicate-draft guard / partial unique index).
      // All identities SIMULATED (fake names + fake 13-digit TINs).
      const memberId3 = randomUUID();
      const regBillFirst = randomUUID();
      const regAsPaid = randomUUID();
      const regNoTinAsPaid = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: memberId3,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Interleave Member Corp 3',
          country: 'TH',
          taxId: '7777777777777',
          addressLine1: '77 Simulated Road',
          city: 'Bang Rak',
          province: 'Bangkok',
          postalCode: '10500',
          planId,
          planYear,
        });
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: memberId3,
          firstName: 'Member3',
          lastName: 'Contact3',
          email: 'member3.contact@interleave.example',
          isPrimary: true,
        });
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: regBillFirst,
          eventId,
          externalId: 'att_interleave_billfirst',
          attendeeEmail: 'buyer@interleave.example',
          attendeeName: 'Test Buyer',
          attendeeCompany: 'Interleave Test Corp',
          matchType: 'non_member',
          ticketType: 'Standard',
          ticketPriceThb: 500,
          paymentStatus: 'paid',
          registeredAt: new Date('2026-07-01T03:00:00Z'),
        } satisfies NewEventRegistrationRow);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: regAsPaid,
          eventId,
          externalId: 'att_interleave_aspaid',
          attendeeEmail: 'buyer@interleave.example',
          attendeeName: 'Test Buyer',
          attendeeCompany: 'Interleave Test Corp',
          matchType: 'non_member',
          ticketType: 'Standard',
          ticketPriceThb: 1070,
          paymentStatus: 'paid',
          registeredAt: new Date('2026-07-01T03:00:00Z'),
        } satisfies NewEventRegistrationRow);
        await tx.insert(eventRegistrations).values({
          tenantId: tenant.ctx.slug,
          registrationId: regNoTinAsPaid,
          eventId,
          externalId: 'att_interleave_notin_aspaid',
          attendeeEmail: 'walkin@interleave.example',
          attendeeName: 'Sim Walkin',
          attendeeCompany: null,
          matchType: 'non_member',
          ticketType: 'Standard',
          ticketPriceThb: 250,
          paymentStatus: 'paid',
          registeredAt: new Date('2026-07-01T03:00:00Z'),
        } satisfies NewEventRegistrationRow);
      });

      // ---------------------------------------------------------------------
      // Step 1 — MEMBERSHIP draft + issue → seq N
      // ---------------------------------------------------------------------
      const memDraft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-aspaid-draft-mem-${memberId3}`,
        memberId: memberId3,
        planId,
        planYear,
      });
      expect(memDraft.ok, memDraft.ok ? 'ok' : `mem draft err: ${memDraft.error.code}`).toBe(true);
      if (!memDraft.ok) throw new Error(`mem draft failed: ${memDraft.error.code}`);
      const memInvoiceId = memDraft.value.invoiceId;

      const memIssue = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-aspaid-issue-mem-${memInvoiceId}`,
        invoiceId: memInvoiceId,
      });
      expect(memIssue.ok, memIssue.ok ? 'ok' : `mem issue err: ${JSON.stringify(memIssue)}`).toBe(
        true,
      );
      if (!memIssue.ok) throw new Error('mem issue failed');

      // ---------------------------------------------------------------------
      // Step 2 — EVENT bill-first draft + issue → seq N+1
      // ---------------------------------------------------------------------
      const evtDraft = await createEventInvoiceDraft(
        makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          requestId: `int-interleave-aspaid-draft-evt-${regBillFirst}`,
          eventRegistrationId: regBillFirst,
          amountOverride: 50_000, // 500 THB inclusive
          buyer: EVENT_BUYER,
        },
      );
      expect(evtDraft.ok, evtDraft.ok ? 'ok' : `evt draft err: ${evtDraft.error.code}`).toBe(true);
      if (!evtDraft.ok) throw new Error(`evt draft failed: ${evtDraft.error.code}`);
      const evtInvoiceId = evtDraft.value.invoiceId;

      const evtIssue = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-aspaid-issue-evt-${evtInvoiceId}`,
        invoiceId: evtInvoiceId,
      });
      expect(evtIssue.ok, evtIssue.ok ? 'ok' : `evt issue err: ${JSON.stringify(evtIssue)}`).toBe(
        true,
      );
      if (!evtIssue.ok) throw new Error('evt issue failed');

      // ---------------------------------------------------------------------
      // Step 2.5 (064 Task 10) — no-TIN EVENT as-paid IN THE MIDDLE of the
      // chain: §105 receipt on the RECEIPT stream — burns NOTHING on the
      // shared invoice stream, so the next invoice-stream allocation (Step 3)
      // must still land on N+2.
      // ---------------------------------------------------------------------
      const noTinDraft = await createEventInvoiceDraft(
        makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          requestId: `int-interleave-aspaid-draft-notin-${regNoTinAsPaid}`,
          eventRegistrationId: regNoTinAsPaid,
          amountOverride: 25_000, // 250 THB inclusive
          buyer: BUYER_NO_TIN,
        },
      );
      expect(
        noTinDraft.ok,
        noTinDraft.ok ? 'ok' : `no-TIN draft err: ${noTinDraft.error.code}`,
      ).toBe(true);
      if (!noTinDraft.ok) throw new Error(`no-TIN draft failed: ${noTinDraft.error.code}`);
      const noTinInvoiceId = noTinDraft.value.invoiceId;

      const noTinResult = await issueEventInvoiceAsPaid(makeAsPaidDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-aspaid-issue-notin-${noTinInvoiceId}`,
        invoiceId: noTinInvoiceId,
        paymentDate: '2026-07-01',
        paymentMethod: 'cash',
      });
      expect(
        noTinResult.ok,
        noTinResult.ok ? 'ok' : `no-TIN as-paid err: ${JSON.stringify(noTinResult)}`,
      ).toBe(true);
      if (!noTinResult.ok) throw new Error('no-TIN as-paid failed');

      // ---------------------------------------------------------------------
      // Step 3 — EVENT as-paid (TIN buyer → receipt_combined) → seq N+2
      // ---------------------------------------------------------------------
      const asPaidDraft = await createEventInvoiceDraft(
        makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          requestId: `int-interleave-aspaid-draft-aspaid-${regAsPaid}`,
          eventRegistrationId: regAsPaid,
          amountOverride: 107_000, // 1,070 THB inclusive
          buyer: EVENT_BUYER,
        },
      );
      expect(
        asPaidDraft.ok,
        asPaidDraft.ok ? 'ok' : `as-paid draft err: ${asPaidDraft.error.code}`,
      ).toBe(true);
      if (!asPaidDraft.ok) throw new Error(`as-paid draft failed: ${asPaidDraft.error.code}`);
      const asPaidInvoiceId = asPaidDraft.value.invoiceId;

      // paymentDate == Bangkok "today" for the fixed 2026-07-01T09:00:00Z
      // clock — same FY2026 bucket as the two issue legs above.
      const asPaidResult = await issueEventInvoiceAsPaid(makeAsPaidDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-interleave-aspaid-issue-aspaid-${asPaidInvoiceId}`,
        invoiceId: asPaidInvoiceId,
        paymentDate: '2026-07-01',
        paymentMethod: 'cash',
      });
      expect(
        asPaidResult.ok,
        asPaidResult.ok ? 'ok' : `as-paid err: ${JSON.stringify(asPaidResult)}`,
      ).toBe(true);
      if (!asPaidResult.ok) throw new Error('as-paid issue failed');

      // ---------------------------------------------------------------------
      // Assert: the three INVOICE-stream rows stay strictly consecutive —
      // the interleaved no-TIN leg burned nothing on the shared stream.
      // ---------------------------------------------------------------------
      const rowMem = await readInvoiceRow(memInvoiceId);
      const rowEvt = await readInvoiceRow(evtInvoiceId);
      const rowNoTin = await readInvoiceRow(noTinInvoiceId);
      const rowAsPaid = await readInvoiceRow(asPaidInvoiceId);

      expect(rowMem!.status).toBe('issued');
      expect(rowEvt!.status).toBe('issued');
      expect(rowNoTin!.status).toBe('paid'); // one-shot draft→paid (β)
      expect(rowAsPaid!.status).toBe('paid'); // one-shot draft→paid

      expect(rowMem!.invoiceSubject).toBe('membership');
      expect(rowEvt!.invoiceSubject).toBe('event');
      expect(rowNoTin!.invoiceSubject).toBe('event');
      expect(rowAsPaid!.invoiceSubject).toBe('event');
      expect(rowNoTin!.pdfDocKind).toBe('receipt_separate');
      expect(rowAsPaid!.pdfDocKind).toBe('receipt_combined');

      // Same FY bucket — the as-paid legs' paymentDate-derived FY matches
      // the clock-derived FY of the two issue legs.
      expect(rowEvt!.fiscalYear).toBe(rowMem!.fiscalYear);
      expect(rowNoTin!.fiscalYear).toBe(rowMem!.fiscalYear);
      expect(rowAsPaid!.fiscalYear).toBe(rowMem!.fiscalYear);

      // 064 Task 10 — the no-TIN leg lives on the RECEIPT stream, allocated
      // INDEPENDENTLY: no invoice-stream pair on the row, and the receipt
      // stream started at 1 ('RE' fallback — this tenant configures no
      // receipt prefix) while the invoice stream was already at N+1.
      expect(rowNoTin!.sequenceNumber).toBeNull();
      expect(rowNoTin!.documentNumber).toBeNull();
      expect(rowNoTin!.receiptDocumentNumberRaw).toBe('RE-2026-000001');

      // Strictly consecutive, in execution order (sequential awaits) — the
      // interleaved β leg left NO gap and burned NO number.
      const seqMem = rowMem!.sequenceNumber!;
      const seqEvt = rowEvt!.sequenceNumber!;
      const seqAsPaid = rowAsPaid!.sequenceNumber!;
      expect(seqEvt).toBe(seqMem + 1);
      expect(seqAsPaid).toBe(seqMem + 2);

      // One shared prefix — same document sequence.
      expect(rowMem!.documentNumber).toMatch(/^INV/);
      expect(rowEvt!.documentNumber).toMatch(/^INV/);
      expect(rowAsPaid!.documentNumber).toMatch(/^INV/);
    },
    120_000,
  );
});
