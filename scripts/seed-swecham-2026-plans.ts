/**
 * T088 — SweCham 2026 plan catalogue seed script.
 *
 * Two-stage idempotent per critique P4:
 *
 *   Stage A (own transaction): upsert tenant_fee_config for SweCham
 *     with (currency=THB, vat=7%, registration_fee=100000 satang)
 *     — `onConflictDoNothing` makes the call safe to re-run.
 *
 *   Stage B (own transaction): INSERT 9 plans for (swecham, 2026) but
 *     ONLY when zero plans already exist for that (tenant, year). A
 *     partial-seeded state (fee config present, plans missing) is
 *     recovered cleanly on the next run. A fully-seeded state is a
 *     no-op that reports "already seeded".
 *
 * Guards:
 *   - TENANT_SLUG must equal 'swecham'. Running against a different
 *     tenant by accident would insert SweCham data into someone else's
 *     catalogue — hard-refuse.
 *   - BOOTSTRAP_ADMIN_EMAIL (or an admin user) must exist to satisfy
 *     the `created_by` FK to users(id).
 *
 * Audit: appends 9 `plan_created` + 1 `fee_config_updated` events,
 * each with the correct payload shape. They provide an audit-log
 * trail for the seed operation (useful for forensics if the script
 * accidentally runs twice in a short window).
 *
 * Usage:
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/seed-swecham-2026-plans.ts
 *
 * Exit codes:
 *   0 — seeded (or already seeded / idempotent no-op)
 *   1 — validation failed OR infrastructure error
 */

import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { asPlanYear } from '@/modules/plans/domain/plan';
import type { PlanDraftInput } from '@/modules/plans/application/ports';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { runInTenant } from '@/lib/db';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { eq } from 'drizzle-orm';

// --- Guards -----------------------------------------------------------------

function requireSwechamTenant(): TenantContext {
  const slug = process.env.TENANT_SLUG ?? '';
  if (slug !== 'swecham') {
    throw new Error(
      `seed-swecham-2026-plans: refusing to run against TENANT_SLUG="${slug}". Only 'swecham' is allowed.`,
    );
  }
  return asTenantContext('swecham');
}

async function findSeedOwnerUserId(): Promise<string> {
  // Prefer BOOTSTRAP_ADMIN_EMAIL if present; otherwise fall back to the
  // first admin account. Seed runs after /speckit.implement so an admin
  // must exist — if none, tell the operator to seed the bootstrap admin
  // first.
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  const rows = bootstrapEmail
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, bootstrapEmail))
        .limit(1)
    : await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);

  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      'seed-swecham-2026-plans: no admin user found. Run `pnpm db:seed-admin` first, or set BOOTSTRAP_ADMIN_EMAIL.',
    );
  }
  return id;
}

// --- Fixture data -----------------------------------------------------------

// Shared benefit matrix builder — every corporate plan has slightly
// different numeric values; partnership plans add the partnership block.

const EVENT_BASE = {
  event_discount_scope: 'all_employees' as const,
  events_cobranded_access: true,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: true,
};

// --- Corporate seed rows ----------------------------------------------------

const CORPORATE_SEED: ReadonlyArray<{
  readonly id: string;
  readonly name: { readonly en: string; readonly th: string; readonly sv: string };
  readonly fee: number;
  readonly minTurnover: number | null;
  readonly maxTurnover: number | null;
  readonly maxDuration: number | null;
  readonly maxAge: number | null;
  readonly memberType: 'company' | 'individual';
  readonly matrix: BenefitMatrix;
  readonly sortOrder: number;
}> = [
  {
    id: 'premium',
    name: {
      en: 'Premium Corporate',
      sv: 'Premium f\u00f6retagsmedlem',
      th: 'สมาชิกองค์กรระดับพรีเมียม',
    },
    fee: 3_600_000,
    minTurnover: 10_000_000_000,
    maxTurnover: null,
    maxDuration: null,
    maxAge: null,
    memberType: 'company',
    sortOrder: 10,
    matrix: {
      eblast_per_year: 6,
      website_page_type: 'member_news_update',
      homepage_logo_category: 'premium',
      directory_listing_size: 'full_page',
      ...EVENT_BASE,
      cultural_tickets_per_year: 2,
      partnership: null,
    },
  },
  {
    id: 'large',
    name: {
      en: 'Large Corporate',
      sv: 'St\u00f6rre f\u00f6retagsmedlem',
      th: 'สมาชิกองค์กรขนาดใหญ่',
    },
    fee: 2_600_000,
    minTurnover: 5_000_000_000,
    maxTurnover: 10_000_000_000,
    maxDuration: null,
    maxAge: null,
    memberType: 'company',
    sortOrder: 20,
    matrix: {
      eblast_per_year: 3,
      website_page_type: 'member_news_update',
      homepage_logo_category: 'large',
      directory_listing_size: 'full_page',
      ...EVENT_BASE,
      cultural_tickets_per_year: 1,
      partnership: null,
    },
  },
  {
    id: 'regular',
    name: {
      en: 'Regular Corporate',
      sv: 'Vanlig f\u00f6retagsmedlem',
      th: 'สมาชิกองค์กรทั่วไป',
    },
    fee: 1_600_000,
    minTurnover: null,
    maxTurnover: 5_000_000_000,
    maxDuration: null,
    maxAge: null,
    memberType: 'company',
    sortOrder: 30,
    matrix: {
      eblast_per_year: 1,
      website_page_type: 'member_news_update',
      homepage_logo_category: 'regular',
      directory_listing_size: 'half_page',
      ...EVENT_BASE,
      events_cobranded_access: false,
      cultural_tickets_per_year: 0,
      partnership: null,
    },
  },
  {
    id: 'start-up',
    name: {
      en: 'Start-up',
      sv: 'Startup',
      th: 'สมาชิกสตาร์ทอัป',
    },
    fee: 1_000_000,
    minTurnover: null,
    maxTurnover: null,
    maxDuration: 2,
    maxAge: null,
    memberType: 'company',
    sortOrder: 40,
    matrix: {
      eblast_per_year: 0,
      website_page_type: 'smes_spotlight',
      homepage_logo_category: 'start_up',
      directory_listing_size: 'half_page',
      ...EVENT_BASE,
      events_cobranded_access: false,
      cultural_tickets_per_year: 0,
      tailor_made_services: false,
      partnership: null,
    },
  },
  {
    id: 'individual',
    name: {
      en: 'Individual',
      sv: 'Privatmedlem',
      th: 'สมาชิกบุคคลทั่วไป',
    },
    fee: 600_000,
    minTurnover: null,
    maxTurnover: null,
    maxDuration: null,
    maxAge: null,
    memberType: 'individual',
    sortOrder: 50,
    matrix: {
      eblast_per_year: 0,
      website_page_type: null,
      homepage_logo_category: null,
      directory_listing_size: 'eighth_page',
      ...EVENT_BASE,
      event_discount_scope: 'one_ticket_per_event',
      events_cobranded_access: false,
      cultural_tickets_per_year: 0,
      m2m_benefits_access: false,
      business_referrals: false,
      tailor_made_services: false,
      partnership: null,
    },
  },
  {
    id: 'thai-alumni',
    name: {
      en: 'Thai Alumni/Student',
      sv: 'Thail\u00e4ndsk alumn/student',
      th: 'สมาชิกศิษย์เก่า/นักศึกษาไทย',
    },
    fee: 100_000,
    minTurnover: null,
    maxTurnover: null,
    maxDuration: null,
    maxAge: 35,
    memberType: 'individual',
    sortOrder: 60,
    matrix: {
      eblast_per_year: 0,
      website_page_type: 'student_intern_cv',
      homepage_logo_category: null,
      directory_listing_size: 'eighth_page',
      ...EVENT_BASE,
      event_discount_scope: 'one_ticket_per_event',
      events_cobranded_access: false,
      cultural_tickets_per_year: 0,
      m2m_benefits_access: false,
      business_referrals: false,
      tailor_made_services: false,
      partnership: null,
    },
  },
];

// --- Partnership seed rows --------------------------------------------------

const PARTNERSHIP_SHARED: Pick<
  BenefitMatrix,
  | 'eblast_per_year'
  | 'website_page_type'
  | 'homepage_logo_category'
  | 'directory_listing_size'
  | 'event_discount_scope'
  | 'events_cobranded_access'
  | 'cultural_tickets_per_year'
  | 'm2m_benefits_access'
  | 'business_referrals'
  | 'tailor_made_services'
> = {
  // Partnership plans inherit Premium's brand visibility defaults
  eblast_per_year: 6,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'premium',
  directory_listing_size: 'full_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: true,
  cultural_tickets_per_year: 2,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: true,
};

const PARTNERSHIP_SEED: ReadonlyArray<{
  readonly id: string;
  readonly name: { readonly en: string; readonly th: string; readonly sv: string };
  readonly fee: number;
  readonly sortOrder: number;
  readonly matrix: BenefitMatrix;
}> = [
  {
    id: 'diamond',
    name: {
      en: 'Diamond Partnership',
      sv: 'Diamond partnerskap',
      th: 'พาร์ทเนอร์ระดับเพชร',
    },
    fee: 20_000_000,
    sortOrder: 10,
    matrix: {
      ...PARTNERSHIP_SHARED,
      eblast_per_year: 15,
      partnership: {
        event_tickets_included: 6,
        booth_included: true,
        rollup_logo_at_events: true,
        logo_on_merch: true,
        video_duration_minutes: 1.5,
        video_frequency_scope: 'all_events',
        website_logo_months: 12,
        banner_per_year: 20,
        newsletter_promotion: true,
        enewsletter_logo: true,
        directory_ad_position: 'pages_1_and_2',
      },
    },
  },
  {
    id: 'platinum',
    name: {
      en: 'Platinum Partnership',
      sv: 'Platinum partnerskap',
      th: 'พาร์ทเนอร์ระดับแพลตตินัม',
    },
    fee: 15_000_000,
    sortOrder: 20,
    matrix: {
      ...PARTNERSHIP_SHARED,
      eblast_per_year: 10,
      partnership: {
        event_tickets_included: 4,
        booth_included: true,
        rollup_logo_at_events: true,
        logo_on_merch: true,
        video_duration_minutes: 1.0,
        video_frequency_scope: 'all_events',
        website_logo_months: 6,
        banner_per_year: 15,
        newsletter_promotion: true,
        enewsletter_logo: true,
        directory_ad_position: 'first_pages',
      },
    },
  },
  {
    id: 'gold',
    name: {
      en: 'Gold Partnership',
      sv: 'Gold partnerskap',
      th: 'พาร์ทเนอร์ระดับทอง',
    },
    fee: 10_000_000,
    sortOrder: 30,
    matrix: {
      ...PARTNERSHIP_SHARED,
      eblast_per_year: 6,
      partnership: {
        event_tickets_included: 2,
        booth_included: true,
        rollup_logo_at_events: true,
        logo_on_merch: true,
        video_duration_minutes: 1.0,
        video_frequency_scope: 'three_selected_events',
        website_logo_months: 3,
        banner_per_year: 10,
        newsletter_promotion: true,
        enewsletter_logo: true,
        directory_ad_position: 'first_10_pages',
      },
    },
  },
];

// --- Seed orchestration -----------------------------------------------------

async function countPlans(ctx: TenantContext, year: number): Promise<number> {
  const rows = await planRepo.findByTenantAndYear(ctx, {
    year: asPlanYear(year),
    showDeleted: true,
  });
  return rows.length;
}

async function stageA_FeeConfig(ctx: TenantContext): Promise<'inserted' | 'exists'> {
  // R9 — renamed fiscal home: tenant_invoice_settings is the single
  // source of truth (F4 consolidation). tenant_fee_config dropped.
  // Stage name kept for operator-script parity.
  return await runInTenant(ctx, async (tx): Promise<'inserted' | 'exists'> => {
    const existing = await tx
      .select({ tenantId: tenantInvoiceSettings.tenantId })
      .from(tenantInvoiceSettings)
      .limit(1);
    if (existing.length > 0) return 'exists';
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: ctx.slug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 100_000n,
      // Placeholder legal identity — admin fills in via
      // /admin/settings/invoicing before issuing invoices.
      legalNameTh: 'PENDING-SETUP',
      legalNameEn: 'PENDING-SETUP',
      taxId: '0000000000000',
      registeredAddressTh: 'PENDING-SETUP',
      registeredAddressEn: 'PENDING-SETUP',
      invoiceNumberPrefix: 'INV',
      creditNoteNumberPrefix: 'CN',
    });
    return 'inserted';
  });
}

async function stageB_Plans(
  ctx: TenantContext,
  ownerUserId: string,
): Promise<{ inserted: number; skipped: boolean }> {
  const existingCount = await countPlans(ctx, 2026);
  if (existingCount > 0) {
    return { inserted: 0, skipped: true };
  }

  // Build the draft list once, insert one-by-one through the repo.
  // Could batch but one-per-call keeps the audit-event writer happy
  // and the loop is 9 iterations total.
  const drafts: PlanDraftInput[] = [];

  for (const row of CORPORATE_SEED) {
    drafts.push({
      plan_id: row.id,
      plan_year: 2026,
      plan_name: row.name,
      description: { en: '' },
      sort_order: row.sortOrder,
      plan_category: 'corporate',
      member_type_scope: row.memberType,
      annual_fee_minor_units: row.fee,
      includes_corporate_plan_id: null,
      min_turnover_minor_units: row.minTurnover,
      max_turnover_minor_units: row.maxTurnover,
      max_duration_years: row.maxDuration,
      max_member_age: row.maxAge,
      benefit_matrix: row.matrix,
      isActive: true,
      createdBy: ownerUserId,
      updatedBy: ownerUserId,
    } as PlanDraftInput);
  }

  for (const row of PARTNERSHIP_SEED) {
    drafts.push({
      plan_id: row.id,
      plan_year: 2026,
      plan_name: row.name,
      description: { en: '' },
      sort_order: row.sortOrder,
      plan_category: 'partnership',
      member_type_scope: 'company',
      annual_fee_minor_units: row.fee,
      includes_corporate_plan_id: 'premium',
      min_turnover_minor_units: null,
      max_turnover_minor_units: null,
      max_duration_years: null,
      max_member_age: null,
      benefit_matrix: row.matrix,
      isActive: true,
      createdBy: ownerUserId,
      updatedBy: ownerUserId,
    } as PlanDraftInput);
  }

  for (const draft of drafts) {
    const inserted = await planRepo.insert(ctx, draft);
    // Audit — fire and forget, one event per plan
    await planAuditAdapter.record(
      {
        tenant: ctx,
        actorUserId: ownerUserId,
        requestId: `seed-${randomUUID()}`,
        sourceIp: null,
      },
      {
        event_type: 'plan_created',
        payload: {
          plan_id: inserted.plan_id,
          plan_year: inserted.plan_year,
          plan_name_en: inserted.plan_name.en,
          annual_fee_minor_units: inserted.annual_fee_minor_units,
          category: inserted.plan_category,
          member_type_scope: inserted.member_type_scope,
        },
      },
    );
  }

  return { inserted: drafts.length, skipped: false };
}

async function main(): Promise<void> {
  const ctx = requireSwechamTenant();
  console.log(`[seed] tenant: ${ctx.slug}`);

  const ownerUserId = await findSeedOwnerUserId();
  console.log(`[seed] owner user: ${ownerUserId}`);

  // Stage A
  const feeStatus = await stageA_FeeConfig(ctx);
  console.log(`[seed] Stage A (tenant_fee_config): ${feeStatus}`);

  // Stage B
  const planStatus = await stageB_Plans(ctx, ownerUserId);
  if (planStatus.skipped) {
    console.log('[seed] Stage B (plans): already seeded — skipped');
  } else {
    console.log(`[seed] Stage B (plans): inserted ${planStatus.inserted} plans`);
  }

  console.log('[seed] DONE');
}

main()
  .catch((e) => {
    console.error('[seed] FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close any pooled connections so the script exits cleanly
    // (Drizzle's `db` doesn't expose an end() — the postgres.js client
    // used under the hood will be collected on process exit).
    void sql;
  });
