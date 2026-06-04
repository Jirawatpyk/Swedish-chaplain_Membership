/**
 * 054-event-fee-invoices (Task 15) — 10-year PII-redaction sweep for
 * NON-MEMBER event-invoice buyers (live Neon Singapore via .env.local).
 *
 * Thai RD §87/3 + §86/10 require a §86/4 tax document be retained for 10
 * years. GDPR Art. 5(1)(e) + Art. 17 then require the personal data on it
 * be minimised / erased once that window elapses. For a NON-MEMBER event
 * invoice the buyer PII lives in `member_identity_snapshot` (member_id IS
 * NULL) — the cron tombstones JUST that column, preserving every financial
 * / §87-numbering field, and emits `event_buyer_pii_redacted`.
 *
 * The immutability trigger (`invoices_enforce_immutability`) locks
 * `member_identity_snapshot` once status != draft, so the cron sets the
 * session GUC `SET LOCAL app.allow_pii_redaction = 'true'` inside its tx
 * to authorise the single-column change (migration 0205). This test pins:
 *
 *   (a) a non-member event invoice issued >10y ago is TOMBSTONED (PII →
 *       '[REDACTED]' / '' / null), financial fields PRESERVED, and an
 *       `event_buyer_pii_redacted` audit row (10y retention, NO PII in
 *       payload) lands.
 *   (b) a non-member event invoice issued <10y ago is UNTOUCHED.
 *   (c) a MEMBERSHIP invoice >10y old is UNTOUCHED (member_id IS NOT NULL
 *       → not eligible; member PII is governed by F3/F9 retention, not
 *       this sweeper).
 *   (d) re-running the cron is IDEMPOTENT (an already-tombstoned row is
 *       skipped — no second audit row).
 *   (e) the trigger is NOT weakened: a normal (GUC-unset) UPDATE to
 *       `member_identity_snapshot` on an issued row STILL raises the
 *       'snapshot columns are immutable' immutability error.
 *   (f) even UNDER the GUC, a financial-field change is STILL blocked by
 *       the per-field check (the exemption is buyer-PII-only).
 *
 * Migrations 0200–0205 MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { POST as redactCron } from '@/app/api/cron/invoicing/redact-expired-event-buyers/route';
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

/** A complete buyer PII snapshot as pinned at draft for a non-member event invoice. */
const BUYER = {
  legal_name: 'Old Buyer Co Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@old-buyer.example',
} as const;

const TOMBSTONE_FIELDS = [
  'legal_name',
  'address',
  'primary_contact_name',
  'primary_contact_email',
  'tax_id',
];

function callCron(): Promise<Response> {
  const req = new NextRequest(
    'http://localhost/api/cron/invoicing/redact-expired-event-buyers',
    { method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
  );
  return redactCron(req);
}

/** Common fully-formed financial/numbering fields for an ISSUED event invoice. */
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
  pdfBlobKey: 'test/redact-evt.pdf',
  pdfSha256: '0'.repeat(64),
  pdfTemplateVersion: 1,
};

describe('redact-expired-event-buyers cron — 10y PII tombstone for non-member event buyers', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let eventId: string;

  // (a) eligible: non-member event invoice issued > 10y ago.
  let oldEventInvoiceId: string;
  let oldRegId: string;
  // (b) ineligible: non-member event invoice issued < 10y ago.
  let recentEventInvoiceId: string;
  let recentRegId: string;
  // (c) ineligible: membership invoice issued > 10y ago.
  let oldMembershipInvoiceId: string;
  let memberId: string;
  const planId = 'redact-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    oldEventInvoiceId = randomUUID();
    oldRegId = randomUUID();
    recentEventInvoiceId = randomUUID();
    recentRegId = randomUUID();
    oldMembershipInvoiceId = randomUUID();
    memberId = randomUUID();

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
        invoiceNumberPrefix: 'EVT',
        creditNoteNumberPrefix: 'EVTC',
      });

      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Redact Plan' },
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

      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Member Co',
        country: 'TH',
        taxId: '1111111111111',
        planId,
        planYear: 2026,
      });

      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_redact_int',
        name: 'Old Gala',
        startDate: new Date('2014-09-10T11:00:00Z'),
      });

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: oldRegId,
        eventId,
        externalId: 'att_old',
        attendeeEmail: 'jane@old-buyer.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Old Buyer Co Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2014-09-01T03:00:00Z'),
      });
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: recentRegId,
        eventId,
        externalId: 'att_recent',
        attendeeEmail: 'jane@old-buyer.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Old Buyer Co Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2024-09-01T03:00:00Z'),
      });

      // (a) NON-MEMBER EVENT invoice, ISSUED, issue_date 11 years ago →
      // eligible. Insert as draft first then promote via a single UPDATE
      // (the trigger's OLD.status='draft' branch lets the issue through).
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: oldEventInvoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: oldRegId,
        vatInclusive: true,
        memberId: null,
        planId: null,
        planYear: null,
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          fiscal_year = 2014,
          sequence_number = 900001,
          document_number = 'EVT14-900001',
          issue_date = (now() - interval '11 years')::date,
          due_date = (now() - interval '11 years' + interval '30 days')::date,
          subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
          vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
          vat_satang = ${ISSUED_NUMBERS.vatSatang},
          total_satang = ${ISSUED_NUMBERS.totalSatang},
          net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
          pro_rate_policy_snapshot = NULL,
          tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
          member_identity_snapshot = ${JSON.stringify(BUYER)}::jsonb,
          pdf_blob_key = ${ISSUED_NUMBERS.pdfBlobKey},
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${oldEventInvoiceId}
      `);

      // (b) NON-MEMBER EVENT invoice, ISSUED, issue_date 2 years ago → NOT eligible.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: recentEventInvoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: recentRegId,
        vatInclusive: true,
        memberId: null,
        planId: null,
        planYear: null,
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.execute(sql`
        UPDATE invoices SET
          status = 'issued',
          fiscal_year = 2024,
          sequence_number = 900002,
          document_number = 'EVT24-900002',
          issue_date = (now() - interval '2 years')::date,
          due_date = (now() - interval '2 years' + interval '30 days')::date,
          subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
          vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
          vat_satang = ${ISSUED_NUMBERS.vatSatang},
          total_satang = ${ISSUED_NUMBERS.totalSatang},
          net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
          pro_rate_policy_snapshot = NULL,
          tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
          member_identity_snapshot = ${JSON.stringify(BUYER)}::jsonb,
          pdf_blob_key = ${ISSUED_NUMBERS.pdfBlobKey},
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${recentEventInvoiceId}
      `);

      // (c) MEMBERSHIP invoice, ISSUED, issue_date 11 years ago → NOT eligible
      // (member_id IS NOT NULL).
      const memberSnapshot = {
        legal_name: 'Member Co',
        tax_id: '1111111111111',
        address: 'Bangkok',
        primary_contact_name: 'Member Contact',
        primary_contact_email: 'member@example.com',
      };
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: oldMembershipInvoiceId,
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
          fiscal_year = 2014,
          sequence_number = 900003,
          document_number = 'EVT14-900003',
          issue_date = (now() - interval '11 years')::date,
          due_date = (now() - interval '11 years' + interval '30 days')::date,
          subtotal_satang = 1000000,
          vat_rate_snapshot = '0.0700',
          vat_satang = 70000,
          total_satang = 1070000,
          net_days_snapshot = 30,
          pro_rate_policy_snapshot = 'none',
          tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
          member_identity_snapshot = ${JSON.stringify(memberSnapshot)}::jsonb,
          pdf_blob_key = 'test/redact-mem.pdf',
          pdf_sha256 = ${'0'.repeat(64)},
          pdf_template_version = 1
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${oldMembershipInvoiceId}
      `);
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function readSnapshot(invoiceId: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row!.memberIdentitySnapshot as Record<string, unknown>;
  }

  it('redacts the >10y non-member event invoice; preserves financial fields; leaves recent + membership untouched; emits 10y audit', async () => {
    const res = await callCron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redactedCount: number;
      tenantsSwept: number;
    };
    expect(body.redactedCount).toBeGreaterThanOrEqual(1);
    expect(body.tenantsSwept).toBeGreaterThanOrEqual(1);

    // (a) eligible row tombstoned.
    const tombstoned = await readSnapshot(oldEventInvoiceId);
    expect(tombstoned.legal_name).toBe('[REDACTED]');
    expect(tombstoned.address).toBe('[REDACTED]');
    expect(tombstoned.primary_contact_name).toBe('[REDACTED]');
    expect(tombstoned.primary_contact_email).toBe('');
    expect(tombstoned.tax_id).toBeNull();

    // Financial / numbering fields PRESERVED untouched (the trigger enforces this).
    const [row] = await db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, oldEventInvoiceId)),
      );
    expect(row!.status).toBe('issued');
    expect(BigInt(row!.totalSatang!.toString())).toBe(10004n);
    expect(BigInt(row!.subtotalSatang!.toString())).toBe(9350n);
    expect(BigInt(row!.vatSatang!.toString())).toBe(654n);
    expect(row!.documentNumber).toBe('EVT14-900001');
    expect(row!.sequenceNumber).toBe(900001);
    expect(row!.fiscalYear).toBe(2014);
    expect(row!.vatRateSnapshot).toBe('0.0700');
    expect(row!.pdfSha256).toBe('0'.repeat(64));

    // Audit row landed: event_buyer_pii_redacted, 10y retention, NO PII in payload.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_buyer_pii_redacted'),
        ),
      );
    const forOldInvoice = auditRows.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === oldEventInvoiceId,
    );
    expect(forOldInvoice).toHaveLength(1);
    const auditRow = forOldInvoice[0]!;
    // `retention_years` is not in the Drizzle auditLog select shape (migration
    // 0039 added it at DB level only) — read it via raw SQL. 10y per §87/3.
    const retRows = (await db.execute(sql`
      SELECT retention_years FROM audit_log WHERE id = ${auditRow.id}
    `)) as unknown as Array<{ retention_years: number }>;
    expect(retRows[0]!.retention_years).toBe(10);
    const payload = auditRow.payload as Record<string, unknown>;
    expect(payload.invoice_id).toBe(oldEventInvoiceId);
    expect(typeof payload.redacted_at).toBe('string');
    expect(payload.redacted_fields).toEqual(
      expect.arrayContaining(TOMBSTONE_FIELDS),
    );
    // No PII value anywhere in the serialised payload.
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain('Old Buyer Co Ltd');
    expect(payloadStr).not.toContain('9876543210123');
    expect(payloadStr).not.toContain('jane@old-buyer.example');
    expect(payloadStr).not.toContain('Sukhumvit');

    // (b) recent event invoice UNTOUCHED.
    const recent = await readSnapshot(recentEventInvoiceId);
    expect(recent.legal_name).toBe('Old Buyer Co Ltd');
    expect(recent.tax_id).toBe('9876543210123');

    // (c) membership invoice UNTOUCHED (member_id IS NOT NULL → not eligible).
    const membership = await readSnapshot(oldMembershipInvoiceId);
    expect(membership.legal_name).toBe('Member Co');
    expect(membership.tax_id).toBe('1111111111111');
  }, 90_000);

  it('is idempotent — re-running does NOT re-redact or emit a second audit row', async () => {
    await callCron(); // second tick

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_buyer_pii_redacted'),
        ),
      );
    const forOldInvoice = auditRows.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === oldEventInvoiceId,
    );
    // Still exactly one — the already-tombstoned row is skipped by the predicate.
    expect(forOldInvoice).toHaveLength(1);
  }, 90_000);

  it('does NOT weaken the trigger: a normal (GUC-unset) member_identity_snapshot UPDATE on an issued row STILL raises immutability', async () => {
    let caught: unknown = null;
    try {
      await runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE invoices
          SET member_identity_snapshot = '{"legal_name":"Hacked","tax_id":null,"address":"x","primary_contact_name":"x","primary_contact_email":""}'::jsonb
          WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${recentEventInvoiceId}
        `),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected the immutability trigger to raise').not.toBeNull();
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(parts.join(' | ')).toMatch(/snapshot columns are immutable/i);

    // And the row is unchanged.
    const recent = await readSnapshot(recentEventInvoiceId);
    expect(recent.legal_name).toBe('Old Buyer Co Ltd');
  }, 60_000);

  it('even UNDER the redaction GUC, a financial-field change is STILL blocked (exemption is buyer-PII-only)', async () => {
    let caught: unknown = null;
    try {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(sql`
          UPDATE invoices
          SET total_satang = 999999
          WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${recentEventInvoiceId}
        `);
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected the per-field GUC check to raise on a financial change').not.toBeNull();
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(parts.join(' | ')).toMatch(/only member_identity_snapshot may change under PII redaction/i);

    // Financial field unchanged.
    const [row] = await db
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, recentEventInvoiceId)),
      );
    expect(BigInt(row!.totalSatang!.toString())).toBe(10004n);
  }, 60_000);
});
