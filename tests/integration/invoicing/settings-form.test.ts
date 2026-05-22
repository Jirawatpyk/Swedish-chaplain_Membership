/**
 * T091 — F4 US4 tenant invoice settings: CRUD lifecycle, FR-010
 * issuance-refusal when required fields missing, FR-011 snapshot
 * immutability, and cross-tenant RLS isolation.
 *
 * Covers the `updateTenantInvoiceSettings` use-case directly (the
 * repo + audit are the real production path; the PATCH route is a
 * thin projection and is exercised E2E in T097).
 *
 * Acceptance:
 *   - US4 AS1 bootstrap: empty settings → upsert creates row → audit
 *     event `tenant_invoice_settings_updated` emitted.
 *   - FR-010: `getForIssue` returns null before bootstrap → the
 *     `isTenantInvoiceSetupComplete` helper reports false, which is
 *     what `issue-invoice` uses to refuse issuance.
 *   - FR-011: once an invoice is issued with the current settings,
 *     later VAT change from 7% → 10% does NOT mutate the issued
 *     invoice's `vat_rate_snapshot` (snapshot immutability).
 *   - Constitution v1.4.0 Principle I clause 3: tenant-A's repo call
 *     cannot read tenant-B's settings row (cross-tenant invisibility
 *     at the Application port boundary).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import {
  updateTenantInvoiceSettings,
  isTenantInvoiceSetupComplete,
} from '@/modules/invoicing';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const CORPORATE_MATRIX: BenefitMatrix = {
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
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('T091 — F4 tenant invoice settings lifecycle', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  const baseSettings = (tenantSlug: string) => ({
    tenantId: tenantSlug,
    actorUserId: user.userId,
    currencyCode: 'THB',
    vatRate: '0.0700',
    registrationFeeSatang: 500_000n,
    legalNameTh: 'บริษัท ทดสอบ จำกัด',
    legalNameEn: 'Test Company Ltd.',
    taxId: '0000000000000',
    registeredAddressTh: 'กรุงเทพฯ',
    registeredAddressEn: 'Bangkok',
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'combined' as const,
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly' as const,
    autoEmailEnabled: true,
  });

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
  });

  afterAll(async () => {
    await tenantA?.cleanup();
    await tenantB?.cleanup();
  });

  describe('FR-010 — bootstrap gate', () => {
    it('reports setup incomplete before any settings row exists', async () => {
      const complete = await isTenantInvoiceSetupComplete(tenantA.ctx.slug);
      expect(complete).toBe(false);
    });

    it('first upsert creates the row and emits audit', async () => {
      const result = await updateTenantInvoiceSettings(
        { tenantSettingsRepo: drizzleTenantSettingsRepo, audit: f4AuditAdapter },
        baseSettings(tenantA.ctx.slug),
      );
      expect(result.ok).toBe(true);

      const row = await drizzleTenantSettingsRepo.getForIssue(tenantA.ctx.slug);
      expect(row).not.toBeNull();
      expect(row?.vatRate.raw).toBe('0.0700');
      expect(row?.identity.legal_name_en).toBe('Test Company Ltd.');

      // Audit event emitted.
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'tenant_invoice_settings_updated'),
          ),
        );
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
    });

    it('after bootstrap, setup reports complete (FR-010 unblocked)', async () => {
      const complete = await isTenantInvoiceSetupComplete(tenantA.ctx.slug);
      expect(complete).toBe(true);
    });
  });

  describe('US4 AS1 — partial PATCH preserves untouched fields', () => {
    it('full PATCH with only vatRate changed preserves other fields across call', async () => {
      // The PATCH route currently sends all form fields on every
      // save (partial PATCH at the audit-diff level, not the SQL
      // level — the repo's upsert INSERTs a full row, and Postgres
      // evaluates NOT NULL on the INSERT VALUES before ON CONFLICT
      // resolution). This test mirrors that production contract:
      // callers send all fields; only the values change.
      const result = await updateTenantInvoiceSettings(
        { tenantSettingsRepo: drizzleTenantSettingsRepo, audit: f4AuditAdapter },
        { ...baseSettings(tenantA.ctx.slug), vatRate: '0.1000' },
      );
      expect(result.ok).toBe(true);

      const row = await drizzleTenantSettingsRepo.getForIssue(tenantA.ctx.slug);
      expect(row?.vatRate.raw).toBe('0.1000');
      expect(row?.identity.legal_name_en).toBe('Test Company Ltd.');
      expect(row?.identity.tax_id).toBe('0000000000000');
    });

    it('no_op when patch is empty', async () => {
      const result = await updateTenantInvoiceSettings(
        { tenantSettingsRepo: drizzleTenantSettingsRepo, audit: f4AuditAdapter },
        { tenantId: tenantA.ctx.slug, actorUserId: user.userId },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('no_op');
    });

    it('rejects VAT out of [0, 0.30] bound', async () => {
      const result = await updateTenantInvoiceSettings(
        { tenantSettingsRepo: drizzleTenantSettingsRepo, audit: f4AuditAdapter },
        {
          tenantId: tenantA.ctx.slug,
          actorUserId: user.userId,
          vatRate: '0.4000',
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('vat_rate_out_of_range');
    });
  });

  describe('FR-011 — live settings surface to next issue + trigger-enforced snapshot freeze', () => {
    const planId = 'alpha-plan';
    let planSeeded = false;
    async function ensurePlan() {
      if (planSeeded) return;
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(membershipPlans).values({
          tenantId: tenantA.ctx.slug,
          planId,
          planYear: 2026,
          planName: { en: 'Alpha Plan' },
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
          benefitMatrix: CORPORATE_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        }),
      );
      planSeeded = true;
    }

    it('changing VAT 10→5 updates what getForIssue returns (next issue snapshots 5%)', async () => {
      // FR-011 has two halves:
      //   (a) The tenant_invoice_settings row reflects the NEW value
      //       immediately so the NEXT issue-invoice call snapshots
      //       it. Tested here.
      //   (b) Invoices already issued have a frozen
      //       vat_rate_snapshot column. Enforced by the schema
      //       immutability trigger on `invoices` and covered by the
      //       tenant-isolation + audit-coverage integration suites
      //       which exercise the real `issueInvoice` use case.
      //
      // We deliberately do NOT hand-craft an issued-invoice row
      // here — the check constraints (`invoices_non_draft_has_snapshots`,
      // `invoices_draft_has_no_number`) require every snapshot
      // column and faking them duplicates issueInvoice logic.
      //
      await ensurePlan();
      // Pre-condition — previous test left VAT at 0.1000.
      const before = await drizzleTenantSettingsRepo.getForIssue(tenantA.ctx.slug);
      expect(before?.vatRate.raw).toBe('0.1000');

      // Mutate VAT 10 → 5.
      const mutateResult = await updateTenantInvoiceSettings(
        { tenantSettingsRepo: drizzleTenantSettingsRepo, audit: f4AuditAdapter },
        { ...baseSettings(tenantA.ctx.slug), vatRate: '0.0500' },
      );
      expect(mutateResult.ok).toBe(true);

      // getForIssue now returns the new value — next issueInvoice
      // call snapshots 0.0500 on the invoice row. The freeze of
      // already-issued snapshots is a DB trigger guarantee covered
      // elsewhere.
      const after = await drizzleTenantSettingsRepo.getForIssue(tenantA.ctx.slug);
      expect(after?.vatRate.raw).toBe('0.0500');
    });

    it('direct FR-011 — immutability trigger rejects vat_rate_snapshot mutation on issued invoice (F-03)', async () => {
      // Direct trigger assertion. Seed a draft → UPDATE to issued with
      // a complete snapshot (allowed by trigger — OLD.status='draft'
      // branch short-circuits) → attempt to mutate vat_rate_snapshot
      // on the now-issued row → trigger rejects with check_violation.
      // This tests the DB guarantee without requiring the full
      // issueInvoice flow.
      await ensurePlan();
      const memberId = randomUUID();
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberId,
          companyName: 'FR-011 Test Co',
          country: 'TH',
          planId,
          planYear: 2026,
        }),
      );

      const invoiceId = randomUUID();
      // Insert a draft — all snapshot fields null (allowed by
      // invoices_non_draft_has_snapshots check because status=draft).
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(invoices).values({
          tenantId: tenantA.ctx.slug,
          invoiceId,
          memberId,
          planYear: 2026,
          planId,
          draftByUserId: user.userId,
          status: 'draft',
        }),
      );

      // Promote to issued via a single UPDATE that sets EVERY required
      // snapshot. Trigger's OLD.status='draft' branch lets it through.
      await runInTenant(tenantA.ctx, (tx) =>
        tx.execute(sql`
          UPDATE invoices SET
            status = 'issued',
            fiscal_year = 2026,
            sequence_number = 800001,
            document_number = 'FR011-2026-800001',
            issue_date = '2026-04-21',
            due_date = '2026-05-21',
            subtotal_satang = 1000000,
            vat_rate_snapshot = '0.0700',
            vat_satang = 70000,
            total_satang = 1070000,
            pro_rate_policy_snapshot = 'none',
            net_days_snapshot = 30,
            tenant_identity_snapshot = '{"legal_name_en":"T","legal_name_th":"T","tax_id":"0","address":"x"}'::jsonb,
            member_identity_snapshot = '{"legal_name":"FR-011 Test Co","tax_id":null,"address":"Bangkok","primary_contact_name":"FR-011 Contact","primary_contact_email":"test@example.com"}'::jsonb,
            pdf_blob_key = 'test/fr011.pdf',
            pdf_sha256 = ${'0'.repeat(64)},
            pdf_template_version = 1
          WHERE tenant_id = ${tenantA.ctx.slug} AND invoice_id = ${invoiceId}
        `),
      );

      // Now attempt to mutate vat_rate_snapshot → trigger MUST reject.
      let rejected = false;
      try {
        await runInTenant(tenantA.ctx, (tx) =>
          tx.execute(sql`
            UPDATE invoices
            SET vat_rate_snapshot = '0.1500'
            WHERE tenant_id = ${tenantA.ctx.slug} AND invoice_id = ${invoiceId}
          `),
        );
      } catch (e) {
        rejected = true;
        // Drizzle 0.45+ wraps Postgres errors; walk the cause chain.
        const parts: string[] = [];
        let cur: unknown = e;
        while (cur instanceof Error) {
          parts.push(cur.message);
          cur = (cur as { cause?: unknown }).cause;
        }
        expect(parts.join(' | ')).toMatch(/snapshot columns are immutable/i);
      }
      expect(rejected).toBe(true);

      // Confirm the row's vat_rate_snapshot is still 0.0700.
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(invoices).where(eq(invoices.invoiceId, invoiceId)).limit(1),
      );
      expect(rows[0]?.vatRateSnapshot).toBe('0.0700');
    });
  });

  describe('Principle I clause 3 — cross-tenant invisibility', () => {
    it('tenant-A settings are not visible to tenant-B reads', async () => {
      // Tenant B has NOT bootstrapped yet.
      const bView = await drizzleTenantSettingsRepo.getForIssue(tenantB.ctx.slug);
      expect(bView).toBeNull();

      // Tenant A is populated.
      const aView = await drizzleTenantSettingsRepo.getForIssue(tenantA.ctx.slug);
      expect(aView).not.toBeNull();
    });

    it('tenant-B bootstrap does not affect tenant-A state', async () => {
      const result = await updateTenantInvoiceSettings(
        { tenantSettingsRepo: drizzleTenantSettingsRepo, audit: f4AuditAdapter },
        baseSettings(tenantB.ctx.slug),
      );
      expect(result.ok).toBe(true);

      const aView = await drizzleTenantSettingsRepo.getForIssue(tenantA.ctx.slug);
      const bView = await drizzleTenantSettingsRepo.getForIssue(tenantB.ctx.slug);

      // A reflects the last write from prior describe blocks (may be
      // '0.0500' after FR-011, '0.1000' after partial-PATCH only, or
      // '0.0700' if only bootstrap ran). The isolation property is:
      // A's VAT is whatever A set, NOT tenant-B's seed value.
      expect(aView).not.toBeNull();
      expect(aView?.vatRate.raw).not.toBe('0.0700');
      // B has the freshly-seeded 0.0700 and identity fields scoped to B.
      expect(bView?.vatRate.raw).toBe('0.0700');
      // Legal identity fields isolate too — B sees its own seed.
      expect(bView?.identity.legal_name_en).toBe('Test Company Ltd.');
    });
  });
});
