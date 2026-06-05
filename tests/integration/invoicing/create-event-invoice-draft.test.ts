/**
 * Task 6b (054-event-fee-invoices) — createEventInvoiceDraft integration test
 * (live Neon Singapore via .env.local).
 *
 * Exercises the REAL use-case wired through the REAL composition root
 * (`makeCreateEventInvoiceDraftDeps`) — real Drizzle invoice repo + real F6
 * lookup adapters + real member-identity adapter + real F4 audit adapter —
 * for BOTH a matched-member registration and a non-member registration.
 *
 * Asserts:
 *   - the draft row persists with `invoice_subject='event'`, `vat_inclusive=true`;
 *   - matched member → `member_id` set, `member_identity_snapshot` NULL (pinned
 *     at issue); non-member → `member_id` NULL, `member_identity_snapshot`
 *     populated (pinned at DRAFT — the key Task-6b behaviour);
 *   - the single `event_fee` line stores the VAT-INCLUSIVE satang
 *     (`ticketPriceThb × 100`); subtotal/vat/total stay null at draft (Model B);
 *   - the duplicate guard: a second draft for the same registration → `duplicate`
 *     (partial unique index `invoices_event_registration_uniq`);
 *   - the §86/4 doc-type model (054 Task 9): a matched company member with null
 *     tax_id is NOT blocked at draft — it succeeds and is issued later as a
 *     §105 receipt (only MEMBERSHIP invoices require a buyer TIN, enforced in
 *     issue-invoice).
 *
 * Lives in tests/integration/** → hits live Neon. Migration 0202 (+0200/0201)
 * MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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

const NON_MEMBER_BUYER = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
} as const;

describe('createEventInvoiceDraft — live-Neon integration (Model B, member + non-member)', () => {
  let tenant: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  const planId = 'event-co-plan';

  let eventId: string;
  let nonMemberRegId: string;
  let matchedRegId: string;
  let companyNoTinRegId: string;
  let archivedRegId: string;
  let memberId: string;
  let companyNoTinMemberId: string;
  let archivedMemberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');

    eventId = randomUUID();
    nonMemberRegId = randomUUID();
    matchedRegId = randomUUID();
    companyNoTinRegId = randomUUID();
    archivedRegId = randomUUID();
    memberId = randomUUID();
    companyNoTinMemberId = randomUUID();
    archivedMemberId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      // F2 plan — `memberTypeScope='company'` drives the §86/4 gate.
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Event Co Plan' },
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

      // F3 matched member (company, WITH tax_id) + a primary contact.
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Gamma Corp',
        country: 'TH',
        taxId: '1111111111111',
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

      // F3 company member WITHOUT tax_id → drives the tax_id_required gate.
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: companyNoTinMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Delta Co',
        country: 'TH',
        taxId: null,
        planId,
        planYear: 2026,
      });

      // F3 ARCHIVED member (HIGH-1) → matched-member event draft must reject it
      // with `member_archived` (the live member-identity adapter derives
      // isArchived from `archived_at IS NOT NULL`).
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: archivedMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Epsilon Archived Co',
        country: 'TH',
        taxId: '2222222222222',
        planId,
        planYear: 2026,
        status: 'archived',
        archivedAt: new Date('2026-01-15T00:00:00Z'),
      });

      // F6 event.
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_fee_draft_int',
        name: 'Annual Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      // Non-member registration (ticket 3,500 THB).
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: nonMemberRegId,
        eventId,
        externalId: 'att_nonmember',
        attendeeEmail: 'guest@beta.example',
        attendeeName: 'Beta Guest',
        attendeeCompany: 'Beta Imports Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 3500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      // Matched-member registration (ticket 2,000 THB).
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: matchedRegId,
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

      // Matched to the company-no-TIN member.
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: companyNoTinRegId,
        eventId,
        externalId: 'att_company_no_tin',
        attendeeEmail: 'ops@delta.example',
        attendeeName: 'Delta Ops',
        attendeeCompany: 'Delta Co',
        matchType: 'member_domain',
        matchedMemberId: companyNoTinMemberId,
        ticketType: 'Standard',
        ticketPriceThb: 1500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      // Matched to the ARCHIVED member (HIGH-1).
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: archivedRegId,
        eventId,
        externalId: 'att_archived',
        attendeeEmail: 'ops@epsilon.example',
        attendeeName: 'Epsilon Ops',
        attendeeCompany: 'Epsilon Archived Co',
        matchType: 'member_domain',
        matchedMemberId: archivedMemberId,
        ticketType: 'Standard',
        ticketPriceThb: 1800,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('non-member: persists event draft with member_id NULL + buyer snapshot pinned at DRAFT + inclusive event_fee line', async () => {
    const deps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const result = await createEventInvoiceDraft(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-nonmember-${nonMemberRegId}`,
      eventRegistrationId: nonMemberRegId,
      buyer: NON_MEMBER_BUYER,
    });

    expect(result.ok, result.ok ? 'ok' : `err: ${result.error.code}`).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
    const invoiceId = result.value.invoiceId;

    // Read the persisted row back (owner role — bypass RLS for verification).
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row).toBeDefined();
    expect(row!.invoiceSubject).toBe('event');
    expect(row!.vatInclusive).toBe(true);
    expect(row!.memberId).toBeNull();
    expect(row!.planId).toBeNull();
    expect(row!.eventId).toBe(eventId);
    expect(row!.eventRegistrationId).toBe(nonMemberRegId);
    expect(row!.status).toBe('draft');
    // Model B — no VAT split at draft.
    expect(row!.subtotalSatang).toBeNull();
    expect(row!.vatSatang).toBeNull();
    expect(row!.totalSatang).toBeNull();
    // Non-member buyer snapshot pinned at DRAFT (THE Task-6b behaviour).
    // 055-member-number — the snapshot persisted to JSONB now carries BOTH
    // member_number: null AND member_number_display: null (zod `.default(null)`
    // via makeMemberIdentitySnapshot); the §105 receipt path must never carry a
    // member number nor its formatted display string.
    expect(row!.memberIdentitySnapshot).toEqual({
      legal_name: 'Beta Imports Ltd',
      tax_id: '9876543210123',
      address: '50 Sukhumvit Road, Bangkok 10110',
      primary_contact_name: 'Jane Doe',
      primary_contact_email: 'jane@beta.example',
      member_number: null,
      member_number_display: null,
    });

    // event_fee line = ticketPriceThb × 100 inclusive.
    const lineRows = await db
      .select()
      .from(invoiceLines)
      .where(
        and(eq(invoiceLines.tenantId, tenant.ctx.slug), eq(invoiceLines.invoiceId, invoiceId)),
      );
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]!.kind).toBe('event_fee');
    expect(lineRows[0]!.unitPriceSatang).toBe(350000n);
    expect(lineRows[0]!.totalSatang).toBe(350000n);
    expect(lineRows[0]!.proRateFactor).toBeNull();
    expect(lineRows[0]!.descriptionEn).toContain('2026-09-10');
    expect(lineRows[0]!.descriptionEn).toContain('Annual Gala');
  }, 30_000);

  it('matched member: persists event draft with member_id set + buyer snapshot NULL (pinned at issue) + inclusive line', async () => {
    const deps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const result = await createEventInvoiceDraft(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-matched-${matchedRegId}`,
      eventRegistrationId: matchedRegId,
    });

    expect(result.ok, result.ok ? 'ok' : `err: ${result.error.code}`).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
    const invoiceId = result.value.invoiceId;

    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(row).toBeDefined();
    expect(row!.invoiceSubject).toBe('event');
    expect(row!.vatInclusive).toBe(true);
    expect(row!.memberId).toBe(memberId);
    expect(row!.eventRegistrationId).toBe(matchedRegId);
    // Matched-member buyer is re-read + snapshotted at ISSUE → null at draft.
    expect(row!.memberIdentitySnapshot).toBeNull();

    const lineRows = await db
      .select()
      .from(invoiceLines)
      .where(
        and(eq(invoiceLines.tenantId, tenant.ctx.slug), eq(invoiceLines.invoiceId, invoiceId)),
      );
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]!.unitPriceSatang).toBe(200000n); // 2000 THB × 100
  }, 30_000);

  it('matched ARCHIVED member: rejects with member_archived and persists no invoice (HIGH-1)', async () => {
    const deps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const result = await createEventInvoiceDraft(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-archived-${archivedRegId}`,
      eventRegistrationId: archivedRegId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('member_archived');

    // No draft invoice persisted for the archived-member registration.
    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          eq(invoices.eventRegistrationId, archivedRegId),
        ),
      );
    expect(rows).toHaveLength(0);
  }, 30_000);

  it('duplicate guard: a second draft for the same registration → duplicate', async () => {
    const deps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    // The matched-member registration already has a non-void event invoice
    // from the prior test → a second draft trips the partial unique index.
    const result = await createEventInvoiceDraft(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-dup-${matchedRegId}`,
      eventRegistrationId: matchedRegId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('duplicate');
  }, 30_000);

  it('§86/4 doc-type model: matched company member with null tax_id → succeeds as a draft (events do NOT block; issued later as a §105 receipt — 054 Task 9)', async () => {
    // The old tax_id_required gate is REMOVED from create-event-invoice-draft.
    // A TIN-less EVENT buyer is not blocked at draft — issue-invoice resolves it
    // to a ใบเสร็จรับเงิน (receipt) since the ticket was already paid. Only
    // MEMBERSHIP invoices require a buyer TIN (enforced in issue-invoice).
    const deps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const result = await createEventInvoiceDraft(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-notin-${companyNoTinRegId}`,
      eventRegistrationId: companyNoTinRegId,
    });
    expect(result.ok, result.ok ? 'ok' : `unexpected err: ${result.error.code}`).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
    expect(result.value.memberId).toBe(companyNoTinMemberId);
    expect(result.value.invoiceSubject).toBe('event');
  }, 30_000);

  it('cross-tenant: tenant B drafting against tenant A registration → registration_not_found + registration_cross_tenant_probe audit (Principle I — REVIEW-GATE BLOCKER)', async () => {
    // Tenant B runs the use-case (under tenant B's RLS) against tenant A's
    // registration id. RLS hides the row → lookup ok(null) → typed
    // registration_not_found + a probe audit scoped to tenant B. NO tenant-A
    // data leaks; nothing is persisted as an invoice.
    const probeRequestId = `int-xtenant-${randomUUID()}`;
    const deps = makeCreateEventInvoiceDraftDeps(tenantB.ctx.slug);
    const result = await createEventInvoiceDraft(deps, {
      tenantId: tenantB.ctx.slug,
      actorUserId: user.userId,
      requestId: probeRequestId,
      eventRegistrationId: nonMemberRegId, // belongs to tenant A
      buyer: NON_MEMBER_BUYER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('registration_not_found');

    // The probe audit row landed for tenant B (owner role — bypass RLS to read).
    const probeRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'registration_cross_tenant_probe'),
          eq(auditLog.requestId, probeRequestId),
        ),
      );
    expect(probeRows).toHaveLength(1);
    expect((probeRows[0]!.payload as Record<string, unknown>).event_registration_id).toBe(
      nonMemberRegId,
    );

    // No event invoice was created in tenant B for tenant A's registration.
    const leaked = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantB.ctx.slug),
          eq(invoices.eventRegistrationId, nonMemberRegId),
        ),
      );
    expect(leaked).toHaveLength(0);
  }, 30_000);
});
