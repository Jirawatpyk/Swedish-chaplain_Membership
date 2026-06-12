/**
 * T115t — Throwaway-tenant fixture helper for Playwright E2E.
 *
 * Mutating E2E tests (AS1 VAT change, AS2 logo upload, AS5 bootstrap
 * empty-state) cannot run against the shared SweCham tenant because
 * each run would permanently alter `tenant_invoice_settings` +
 * cross-contaminate every later test. This helper provisions a
 * uniquely-slugged tenant row per test, seeds whatever the test
 * requires, and tears it down on completion.
 *
 * Architecture:
 *   1. Generate a unique slug (`test-e2e-{uuid-first-8}`).
 *   2. Seed plan + member (+ optional settings) via direct DB writes
 *      under `runInTenant(throwawaySlug, ...)` so RLS respects the
 *      new slug.
 *   3. Caller sets the `X-Tenant` header on the Playwright page:
 *        await page.setExtraHTTPHeaders({ 'X-Tenant': ctx.slug })
 *      The app-layer resolver (`src/lib/tenant-context.ts`) honours
 *      the header ONLY when `env.tenant.xHeaderEnabled` is TRUE,
 *      which requires `E2E_X_TENANT_HEADER_ENABLED=1` in .env.local
 *      AND NODE_ENV != 'production' (boot validator refuses prod).
 *   4. Caller runs the test against `/admin/...` routes — the
 *      resolver returns the throwaway slug for every request.
 *   5. `cleanup()` deletes all rows created under the slug (audit
 *      log entries are retained — append-only per Principle I).
 *
 * Admin session: reuses the shared `e2e-admin` seeded user. F1
 * sessions are cross-tenant by design (no `tenant_id` on the users
 * row), so a signed-in admin session carries over when the X-Tenant
 * header swaps the resolved tenant mid-suite.
 */

// Env vars loaded by Playwright's config (`playwright.config.ts`
// § `loadEnvLocal()`) — no `process.loadEnvFile` here; ESM hoists
// the imports below ABOVE any top-level statement, so calling
// `loadEnvFile` at this line position would run AFTER `@/lib/db`
// has already read process.env via its zod validator.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { nextSeedMemberNumber } from '../../integration/helpers/seed-member-number';

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

export interface ThrowawayTenantSeedOptions {
  /**
   * Seed a `tenant_invoice_settings` row so the tenant is ready to
   * issue invoices. When FALSE (default), the tenant has NO settings
   * row — lets AS5 "bootstrap empty state" E2E run the first-time
   * setup flow.
   */
  readonly seedSettings?: boolean;
  /**
   * Seed a `membership_plans` row (planId='regular', planYear=2026).
   * Default TRUE — required by most test surfaces.
   */
  readonly seedPlan?: boolean;
  /**
   * Seed 1 active member under the plan. Default TRUE.
   */
  readonly seedMember?: boolean;
  /**
   * Override the actor user id passed to membership_plans.createdBy /
   * updatedBy. Default 'system:throwaway-tenant'.
   */
  readonly actorUserId?: string;
}

export interface ThrowawayTenant {
  readonly slug: string;
  readonly ctx: TenantContext;
  readonly memberId: string | null;
  readonly cleanup: () => Promise<void>;
}

async function resolveAdminActorUserId(): Promise<string> {
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (row.length === 0) {
    throw new Error(
      'throwaway-tenant: no admin user seeded — run scripts/seed-e2e-user.ts first.',
    );
  }
  return row[0]!.id;
}

export async function createThrowawayTenant(
  opts: ThrowawayTenantSeedOptions = {},
): Promise<ThrowawayTenant> {
  const slug = `test-e2e-${randomUUID().slice(0, 8)}`;
  const ctx = asTenantContext(slug);
  const seedPlan = opts.seedPlan ?? true;
  const seedMember = opts.seedMember ?? true;
  const seedSettings = opts.seedSettings ?? false;
  const actorUserId = opts.actorUserId ?? (await resolveAdminActorUserId());

  let memberId: string | null = null;

  await runInTenant(ctx, async (tx) => {
    if (seedPlan) {
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'regular',
        planYear: 2026,
        planName: { en: 'E2E Throwaway Plan' },
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
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    }

    if (seedSettings) {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'E2E',
        creditNoteNumberPrefix: 'E2EC',
      });
    }

    if (seedMember && seedPlan) {
      memberId = randomUUID();
      await tx.insert(members).values({
        tenantId: slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'E2E Throwaway Co',
        country: 'TH',
        // Seed a valid Thai TIN so this throwaway member is a TIN-bearing
        // (input-VAT-claimable) §86/4 case in the invoice-draft-issue /
        // invoice-pay / payment-card-happy-path specs. (066 removed the
        // membership no-TIN block — a TIN is no longer required to reach
        // `issued` — but keeping one exercises the TIN-present render path.)
        taxId: '0105536000020',
        planId: 'regular',
        planYear: 2026,
      });
    }
  });

  const cleanup = async (): Promise<void> => {
    // Delete in dependency order. Audit log rows are append-only by
    // trigger — let them accumulate with the throwaway slug; a
    // future F13 super-admin scan sweeps them.
    await db.delete(invoiceLines).where(eq(invoiceLines.tenantId, slug));
    await db.delete(creditNotes).where(eq(creditNotes.tenantId, slug));
    await db.delete(invoices).where(eq(invoices.tenantId, slug));
    await db.delete(tenantDocumentSequences).where(eq(tenantDocumentSequences.tenantId, slug));
    await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug));
    await db.delete(members).where(eq(members.tenantId, slug));
    await db
      .delete(membershipPlans)
      .where(
        and(
          eq(membershipPlans.tenantId, slug),
          sql`true`, // composite-key catch-all; slug filter is the real guard
        ),
      );
  };

  return { slug, ctx, memberId, cleanup };
}
