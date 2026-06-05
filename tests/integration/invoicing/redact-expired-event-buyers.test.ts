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
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
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
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
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

/** Issued tax-document PDF blob keys for the eligible (>10y) event invoice. */
const OLD_INVOICE_PDF_KEY = 'test/redact-evt.pdf';
const OLD_RECEIPT_PDF_KEY = 'test/redact-evt-receipt.pdf';

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

  // Spy on the blob-storage delete so the cron's PII-PDF purge is observed
  // WITHOUT hitting real Vercel Blob (the seeded keys are synthetic test
  // paths that do not exist in the live store). mockResolvedValue mirrors
  // the adapter's `Promise<void>` contract; the spy records every (key) the
  // cron asks to erase so we can assert complete erasure.
  let blobDeleteSpy: MockInstance<(key: string) => Promise<void>>;

  beforeAll(async () => {
    blobDeleteSpy = vi
      .spyOn(vercelBlobAdapter, 'delete')
      .mockResolvedValue(undefined);

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
          pdf_blob_key = ${OLD_INVOICE_PDF_KEY},
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion},
          receipt_pdf_blob_key = ${OLD_RECEIPT_PDF_KEY},
          receipt_pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          receipt_pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
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
          pdf_blob_key = ${'test/redact-evt-recent.pdf'},
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
    blobDeleteSpy.mockRestore();
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

    // FIX 1 — the issued PDF BYTES (which print the buyer name / address /
    // tax_id) are also erased: the cron deletes BOTH the invoice PDF blob
    // and the receipt PDF blob for the redacted row. A DB tombstone without
    // the blob purge would be INCOMPLETE erasure (the PII would still sit at
    // a public, non-expiring Blob URL). Keys (not URLs) are not PII.
    const deletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(OLD_INVOICE_PDF_KEY);
    expect(deletedKeys).toContain(OLD_RECEIPT_PDF_KEY);

    // The forensic audit record proves the blob purge happened alongside the
    // DB tombstone: `blob_purged_keys` lists the KEYS erased (not URLs → not PII).
    expect(payload.blob_purged_keys).toEqual(
      expect.arrayContaining([OLD_INVOICE_PDF_KEY, OLD_RECEIPT_PDF_KEY]),
    );
    expect((payload.blob_purged_keys as string[]).length).toBe(2);

    // (b) recent event invoice UNTOUCHED.
    const recent = await readSnapshot(recentEventInvoiceId);
    expect(recent.legal_name).toBe('Old Buyer Co Ltd');
    expect(recent.tax_id).toBe('9876543210123');

    // (c) membership invoice UNTOUCHED (member_id IS NOT NULL → not eligible).
    const membership = await readSnapshot(oldMembershipInvoiceId);
    expect(membership.legal_name).toBe('Member Co');
    expect(membership.tax_id).toBe('1111111111111');

    // And their PDF blobs are NEVER purged — only the eligible row's bytes
    // are erased. (recent <10y event + >10y membership both retain their
    // documents.)
    const allDeletedKeys = blobDeleteSpy.mock.calls.map((c) => c[0]);
    expect(allDeletedKeys).not.toContain('test/redact-evt-recent.pdf');
    expect(allDeletedKeys).not.toContain('test/redact-mem.pdf');
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

/**
 * 054-event-fee-invoices (code-review HIGH-2) — the immutability trigger MUST
 * lock the four event discriminator/identity columns added by migration 0201
 * (`invoice_subject`, `event_id`, `event_registration_id`, `vat_inclusive`)
 * AND the redaction marker `pii_blob_purged_at` (migration 0206), exactly like
 * `member_id`/`plan_id`/`plan_year`. Migration 0201's "no trigger change
 * needed" note relied on the Application layer never updating those columns;
 * the trigger is the defence-in-depth layer that must ENFORCE that. These tests
 * pin both the NORMAL (GUC-unset) path and the GUC-exempt path.
 *
 * Migrations 0200–0206 MUST be applied first (`pnpm db:migrate`).
 */
describe('invoices immutability — event discriminator cols + pii_blob_purged_at locked (HIGH-2/HIGH-3)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let eventId: string;
  let otherEventId: string;
  let issuedInvoiceId: string;
  let regId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    otherEventId = randomUUID();
    issuedInvoiceId = randomUUID();
    regId = randomUUID();
    const otherRegId = randomUUID();

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

      // Two events so an event_id flip targets a real (but different) event.
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_lock_int',
        name: 'Lock Gala',
        startDate: new Date('2024-09-10T11:00:00Z'),
      });
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId: otherEventId,
        source: 'eventcreate',
        externalId: 'evt_lock_other',
        name: 'Other Gala',
        startDate: new Date('2024-10-10T11:00:00Z'),
      });

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: 'att_lock',
        attendeeEmail: 'buyer@lock.example',
        attendeeName: 'Lock Buyer',
        attendeeCompany: 'Lock Co Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2024-09-01T03:00:00Z'),
      });
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: otherRegId,
        eventId: otherEventId,
        externalId: 'att_lock_other',
        attendeeEmail: 'buyer@lock.example',
        attendeeName: 'Lock Buyer',
        attendeeCompany: 'Lock Co Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2024-09-01T03:00:00Z'),
      });

      // Issued non-member event invoice (recent → never eligible for the
      // sweeper, so these immutability probes don't race the cron).
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: issuedInvoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: regId,
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
          sequence_number = 910001,
          document_number = 'EVT24-910001',
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
          pdf_blob_key = 'test/lock-evt.pdf',
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${issuedInvoiceId}
      `);
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /** Runs `setClause` as a no-GUC UPDATE on the issued row; returns the chained error messages or null. */
  async function expectNormalRaise(setClause: ReturnType<typeof sql>): Promise<string | null> {
    let caught: unknown = null;
    try {
      await runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE invoices SET ${setClause}
          WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${issuedInvoiceId}
        `),
      );
    } catch (e) {
      caught = e;
    }
    if (caught === null) return null;
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }

  it('NORMAL path locks invoice_subject (flip event→membership raises)', async () => {
    const msg = await expectNormalRaise(sql`invoice_subject = 'membership'`);
    expect(msg, 'expected immutability raise on invoice_subject change').not.toBeNull();
    expect(msg!).toMatch(/snapshot columns are immutable/i);
  }, 60_000);

  it('NORMAL path locks event_id (raises)', async () => {
    const msg = await expectNormalRaise(sql`event_id = ${otherEventId}`);
    expect(msg, 'expected immutability raise on event_id change').not.toBeNull();
    expect(msg!).toMatch(/snapshot columns are immutable/i);
  }, 60_000);

  it('NORMAL path locks event_registration_id (raises)', async () => {
    const msg = await expectNormalRaise(sql`event_registration_id = ${randomUUID()}`);
    expect(msg, 'expected immutability raise on event_registration_id change').not.toBeNull();
    expect(msg!).toMatch(/snapshot columns are immutable/i);
  }, 60_000);

  it('NORMAL path locks vat_inclusive (flip true→false raises)', async () => {
    const msg = await expectNormalRaise(sql`vat_inclusive = false`);
    expect(msg, 'expected immutability raise on vat_inclusive change').not.toBeNull();
    expect(msg!).toMatch(/snapshot columns are immutable/i);
  }, 60_000);

  it('NORMAL path locks pii_blob_purged_at (raises — no normal write path may set it)', async () => {
    const msg = await expectNormalRaise(sql`pii_blob_purged_at = now()`);
    expect(msg, 'expected immutability raise on pii_blob_purged_at change').not.toBeNull();
    expect(msg!).toMatch(/snapshot columns are immutable/i);
  }, 60_000);

  it('GUC path STILL locks the 4 event cols + financials (raises with the redaction-only message)', async () => {
    // Under the GUC, every event/financial column is still rejected — only
    // member_identity_snapshot + pii_blob_purged_at may change.
    for (const set of [
      sql`invoice_subject = 'membership'`,
      sql`event_id = ${otherEventId}`,
      sql`event_registration_id = ${randomUUID()}`,
      sql`vat_inclusive = false`,
      sql`total_satang = 1`,
    ]) {
      let caught: unknown = null;
      try {
        await runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
          await tx.execute(sql`
            UPDATE invoices SET ${set}
            WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${issuedInvoiceId}
          `);
        });
      } catch (e) {
        caught = e;
      }
      expect(caught, 'expected a GUC-path raise for a locked column').not.toBeNull();
      const parts: string[] = [];
      let cur: unknown = caught;
      while (cur instanceof Error) {
        parts.push(cur.message);
        cur = (cur as { cause?: unknown }).cause;
      }
      expect(parts.join(' | ')).toMatch(/only member_identity_snapshot may change under PII redaction/i);
    }
  }, 90_000);

  it('GUC path PERMITS member_identity_snapshot + pii_blob_purged_at to change together', async () => {
    // The redaction flow stamps both columns under the GUC — this must NOT raise.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      await tx.execute(sql`
        UPDATE invoices
        SET member_identity_snapshot = member_identity_snapshot
              || jsonb_build_object('legal_name', '[REDACTED]'),
            pii_blob_purged_at = now()
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${issuedInvoiceId}
      `);
    });

    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, issuedInvoiceId)));
    expect((row!.memberIdentitySnapshot as Record<string, unknown>).legal_name).toBe('[REDACTED]');
    expect(row!.piiBlobPurgedAt).not.toBeNull();
    // Financials/event identity untouched.
    expect(row!.invoiceSubject).toBe('event');
    expect(row!.eventId).toBe(eventId);
    expect(row!.vatInclusive).toBe(true);
    expect(BigInt(row!.totalSatang!.toString())).toBe(10004n);
  }, 60_000);
});

/**
 * 054-event-fee-invoices (code-review HIGH-3) — the PDF-blob purge is RETRYABLE
 * via the `pii_blob_purged_at` marker so a crash between the DB-tombstone commit
 * and the blob purge cannot strand PII PDF bytes on Blob forever (GDPR Art.17).
 *
 * Scenario (crash simulation):
 *   Pass 1 — the row is eligible (un-redacted, >10y). The cron tombstones the
 *     snapshot + emits the audit + commits, then attempts the blob purge —
 *     which THROWS (simulating the crash / Blob outage). Because the purge did
 *     not complete, `pii_blob_purged_at` stays NULL.
 *   Pass 2 — the row is STILL eligible (tombstoned but pii_blob_purged_at IS
 *     NULL and a blob key is present). The blob purge now SUCCEEDS, so the cron
 *     stamps `pii_blob_purged_at = now()`. The audit is NOT re-emitted (the
 *     snapshot was already tombstoned on pass 1).
 *   Pass 3 — the row is NO LONGER eligible (pii_blob_purged_at IS NOT NULL).
 *     No re-selection, no purge, no audit.
 *
 * Assertions: the audit is emitted EXACTLY ONCE across all three passes; the
 * blob key is eventually purged; pii_blob_purged_at is NULL after pass 1 and
 * set after pass 2.
 *
 * Migrations 0200–0206 MUST be applied first (`pnpm db:migrate`).
 */
describe('redact cron — retryable PDF-blob purge via pii_blob_purged_at (HIGH-3)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let eventId: string;
  let regId: string;
  let invoiceId: string;
  const CRASH_PDF_KEY = 'test/retry-evt.pdf';

  let blobDeleteSpy: MockInstance<(key: string) => Promise<void>>;

  beforeAll(async () => {
    // First call rejects (crash mid-purge); every later call resolves.
    blobDeleteSpy = vi
      .spyOn(vercelBlobAdapter, 'delete')
      .mockRejectedValueOnce(new Error('simulated blob outage'))
      .mockResolvedValue(undefined);

    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    regId = randomUUID();
    invoiceId = randomUUID();

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

      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_retry_int',
        name: 'Retry Gala',
        startDate: new Date('2013-09-10T11:00:00Z'),
      });
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: 'att_retry',
        attendeeEmail: 'buyer@retry.example',
        attendeeName: 'Retry Buyer',
        attendeeCompany: 'Retry Co Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 100,
        paymentStatus: 'paid',
        registeredAt: new Date('2013-09-01T03:00:00Z'),
      });

      // Eligible (>10y) non-member event invoice. Single blob key (invoice PDF)
      // so the purge is a single delete call — easier to drive the crash.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: regId,
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
          fiscal_year = 2013,
          sequence_number = 920001,
          document_number = 'EVT13-920001',
          issue_date = (now() - interval '12 years')::date,
          due_date = (now() - interval '12 years' + interval '30 days')::date,
          subtotal_satang = ${ISSUED_NUMBERS.subtotalSatang},
          vat_rate_snapshot = ${ISSUED_NUMBERS.vatRateSnapshot},
          vat_satang = ${ISSUED_NUMBERS.vatSatang},
          total_satang = ${ISSUED_NUMBERS.totalSatang},
          net_days_snapshot = ${ISSUED_NUMBERS.netDaysSnapshot},
          pro_rate_policy_snapshot = NULL,
          tenant_identity_snapshot = ${JSON.stringify(ISSUED_NUMBERS.tenantIdentitySnapshot)}::jsonb,
          member_identity_snapshot = ${JSON.stringify(BUYER)}::jsonb,
          pdf_blob_key = ${CRASH_PDF_KEY},
          pdf_sha256 = ${ISSUED_NUMBERS.pdfSha256},
          pdf_template_version = ${ISSUED_NUMBERS.pdfTemplateVersion}
        WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}
      `);
    });
  }, 90_000);

  afterAll(async () => {
    blobDeleteSpy.mockRestore();
    await tenant.cleanup().catch(() => {});
  });

  async function auditCountFor(id: string): Promise<number> {
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'event_buyer_pii_redacted'),
        ),
      );
    return rows.filter((r) => (r.payload as Record<string, unknown>).invoice_id === id).length;
  }

  async function readRow() {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row!;
  }

  it('pass 1: tombstones + audits + commits, but the blob purge crashes → pii_blob_purged_at stays NULL', async () => {
    const res = await callCron();
    expect(res.status).toBe(200);

    const row = await readRow();
    // Snapshot tombstoned despite the blob crash (DB tombstone is committed first).
    expect((row.memberIdentitySnapshot as Record<string, unknown>).legal_name).toBe('[REDACTED]');
    // Purge did NOT complete → marker still NULL → row remains eligible next pass.
    expect(row.piiBlobPurgedAt).toBeNull();
    // Audit landed exactly once.
    expect(await auditCountFor(invoiceId)).toBe(1);
    // The cron DID attempt the purge (and it threw).
    expect(blobDeleteSpy.mock.calls.map((c) => c[0])).toContain(CRASH_PDF_KEY);
  }, 90_000);

  it('pass 2: row re-selected; purge succeeds → pii_blob_purged_at set; audit NOT re-emitted', async () => {
    const callsBefore = blobDeleteSpy.mock.calls.length;
    const res = await callCron();
    expect(res.status).toBe(200);

    const row = await readRow();
    // Purge succeeded this pass → marker stamped.
    expect(row.piiBlobPurgedAt).not.toBeNull();
    // Snapshot is still the tombstone (no PII re-exposure on retry).
    expect((row.memberIdentitySnapshot as Record<string, unknown>).legal_name).toBe('[REDACTED]');
    // The row WAS re-selected → the cron asked to purge the key again.
    expect(blobDeleteSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    // Audit still exactly ONE — not re-emitted on retry (gated on "tombstoned this run").
    expect(await auditCountFor(invoiceId)).toBe(1);
  }, 90_000);

  it('pass 3: marker set → row NOT re-selected (no purge, no second audit)', async () => {
    const callsBefore = blobDeleteSpy.mock.calls.length;
    const res = await callCron();
    expect(res.status).toBe(200);

    // No further purge for this key (row no longer eligible).
    const callsAfter = blobDeleteSpy.mock.calls.slice(callsBefore).map((c) => c[0]);
    expect(callsAfter).not.toContain(CRASH_PDF_KEY);
    // Audit STILL exactly one across all three passes.
    expect(await auditCountFor(invoiceId)).toBe(1);
  }, 90_000);
});
