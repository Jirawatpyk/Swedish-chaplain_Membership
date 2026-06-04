/**
 * Integration — `listInvoicesPaged` subject filter (054-event-fee-invoices Task 13).
 *
 * The admin invoices list gained a type filter (All / Membership / Event). It
 * threads a `?subject=membership|event` URL param → use-case `invoiceSubject`
 * → repo `listPaged` `WHERE invoice_subject = ?`. This test locks the SQL
 * translation against live Neon: an event-only filter must return exactly the
 * event-fee invoices and exclude the membership ones (and vice-versa); absent
 * filter returns both.
 *
 * Inserts one ISSUED membership invoice + one ISSUED event invoice (the event
 * subject relaxes only `pro_rate_policy_snapshot`; every other non-draft field
 * stays required, so we populate the full numbering + snapshot + pdf set). The
 * event invoice carries a real `events` + `event_registrations` row to satisfy
 * the composite FK `(tenant_id, event_registration_id)`.
 *
 * Lives in tests/integration/** → hits live Neon. Migration 0202 (+0200/0201/
 * 0203) MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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
const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Subject Filter Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};
const SNAP_BUYER = {
  legal_name: 'Walk-in Guest Ltd',
  tax_id: null,
  address: 'Bangkok',
  primary_contact_name: 'Guest',
  primary_contact_email: 'guest@example.com',
};

const MEMBER_ID = '00000000-0000-4000-8000-0000000000e1';

describe('invoice listPaged — subject filter (054 Task 13)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const membershipInv = randomUUID();
  const eventInv = randomUUID();
  const eventId = randomUUID();
  const regId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'sf-plan',
        planYear: 2026,
        planName: { en: 'SF Plan' },
        description: { en: 'desc' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: SNAP_TENANT.legal_name_th,
        legalNameEn: SNAP_TENANT.legal_name_en,
        taxId: SNAP_TENANT.tax_id,
        registeredAddressTh: SNAP_TENANT.address_th,
        registeredAddressEn: SNAP_TENANT.address_en,
        invoiceNumberPrefix: 'SF',
        creditNoteNumberPrefix: 'SFC',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: MEMBER_ID,
        companyName: 'Subject Filter Co',
        country: 'TH',
        planId: 'sf-plan',
        planYear: 2026,
      });
      // F6 event + non-member registration for the event invoice FK.
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_subject_filter',
        name: 'Subject Filter Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: 'att_subject_filter',
        attendeeEmail: 'guest@example.com',
        attendeeName: 'Walk-in Guest',
        attendeeCompany: 'Walk-in Guest Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 3500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      await tx.insert(invoices).values([
        {
          // ISSUED membership invoice.
          tenantId: tenant.ctx.slug,
          invoiceId: membershipInv,
          invoiceSubject: 'membership',
          memberId: MEMBER_ID,
          planYear: 2026,
          planId: 'sf-plan',
          draftByUserId: user.userId,
          status: 'issued',
          fiscalYear: 2026,
          sequenceNumber: 1,
          documentNumber: 'SF-2026-000001',
          issueDate: '2026-01-05',
          dueDate: '2026-02-05',
          subtotalSatang: 100_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 7_000n,
          totalSatang: 107_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: 'monthly',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_MEMBER,
          pdfBlobKey: 'invoicing/sf/2026/1.pdf',
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        },
        {
          // ISSUED event-fee invoice (pro_rate_policy_snapshot NULL — relaxed
          // for the event subject; member_id/plan_id NULL).
          tenantId: tenant.ctx.slug,
          invoiceId: eventInv,
          invoiceSubject: 'event',
          eventId,
          eventRegistrationId: regId,
          vatInclusive: true,
          memberId: null,
          planYear: null,
          planId: null,
          draftByUserId: user.userId,
          status: 'issued',
          fiscalYear: 2026,
          sequenceNumber: 2,
          documentNumber: 'SF-2026-000002',
          issueDate: '2026-01-06',
          dueDate: '2026-02-06',
          subtotalSatang: 327_103n,
          vatRateSnapshot: '0.0700',
          vatSatang: 22_897n,
          totalSatang: 350_000n,
          creditedTotalSatang: 0n,
          proRatePolicySnapshot: null,
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: SNAP_TENANT,
          memberIdentitySnapshot: SNAP_BUYER,
          pdfBlobKey: 'invoicing/sf/2026/2.pdf',
          pdfSha256: 'b'.repeat(64),
          pdfTemplateVersion: 1,
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('?subject=event returns ONLY event invoices', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      invoiceSubject: 'event',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).toEqual([eventInv]);
    expect(result.value.total).toBe(1);
    for (const row of result.value.rows) {
      expect(row.invoiceSubject).toBe('event');
    }
  });

  it('?subject=membership returns ONLY membership invoices', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      invoiceSubject: 'membership',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).toEqual([membershipInv]);
    expect(result.value.total).toBe(1);
    for (const row of result.value.rows) {
      expect(row.invoiceSubject).toBe('membership');
    }
  });

  it('no subject filter returns BOTH subjects', async () => {
    const result = await listInvoicesPaged(makeListInvoicesDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.invoiceId).sort();
    expect(ids).toEqual([membershipInv, eventInv].sort());
    expect(result.value.total).toBe(2);
  });
});
