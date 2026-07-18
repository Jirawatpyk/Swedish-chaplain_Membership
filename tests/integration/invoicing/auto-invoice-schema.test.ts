/**
 * 107-auto-invoice (Task 1) — schema foundation integration test (live Neon).
 *
 * Pins migration 0259 against the database: the `invoice_origin` enum +
 * `invoices.origin` default, the 4 `tenant_invoice_settings` cadence/toggle
 * columns' defaults, and the lead-days CHECK constraint. Unit-test mocks
 * cannot exercise DB-level defaults/CHECKs — they only show up against live
 * Postgres (F4-R8 discipline, see CLAUDE.md § Gotchas).
 *
 * `members.auto_invoice_enrolled_at` and `renewal_cycles.auto_draft_
 * invoice_id` are plain nullable columns with no default/CHECK to pin at the
 * DB layer this round — they are exercised by the later tasks that read/
 * write them (the cron + review-queue use-cases). Confirming they exist with
 * the right TS type is left to `pnpm typecheck` on this file's imports.
 *
 * Scenarios:
 *   (1) A fresh draft membership invoice (origin NOT specified on insert)
 *       persists with `origin='manual'` — the DB-level DEFAULT, not an
 *       application-layer default (this test never sets the field).
 *   (2) `tenant_invoice_settings` defaults: auto_invoice_enabled=false,
 *       auto_invoice_lead_days_rolling=30, auto_invoice_lead_days_calendar=31,
 *       auto_invoice_page_size=200.
 *   (3) `tenant_invoice_settings_auto_lead_days_ck` rejects an out-of-range
 *       (>120) lead-days value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
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

describe('auto-invoice schema foundation — 107-auto-invoice Task 1 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'auto-inv-schema-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Auto-Invoice Schema Test Plan' },
        description: { en: 'Task 1 schema pin' },
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
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('(1) new draft invoice defaults origin=manual at the DB layer', async () => {
    const memberId = randomUUID();
    const invoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Auto-Invoice Schema Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      // `origin` is deliberately OMITTED — this is the exact point of the
      // test: the column's DB-level DEFAULT 'manual' must fire, not an
      // application-layer default this insert never supplies.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
      });
    });

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ origin: invoices.origin })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.origin).toBe('manual');
  }, 60_000);

  it('(2) tenant_invoice_settings auto-invoice columns default correctly', async () => {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          enabled: tenantInvoiceSettings.autoInvoiceEnabled,
          rolling: tenantInvoiceSettings.autoInvoiceLeadDaysRolling,
          calendar: tenantInvoiceSettings.autoInvoiceLeadDaysCalendar,
          page: tenantInvoiceSettings.autoInvoicePageSize,
        })
        .from(tenantInvoiceSettings)
        .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)),
    );
    expect(row).toMatchObject({ enabled: false, rolling: 30, calendar: 31, page: 200 });
  }, 60_000);

  it('(3) CHECK rejects an out-of-range auto-invoice lead-days value', async () => {
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(tenantInvoiceSettings)
          .set({ autoInvoiceLeadDaysCalendar: 200 })
          .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)),
      ),
    ).rejects.toThrow();
  }, 60_000);
});
