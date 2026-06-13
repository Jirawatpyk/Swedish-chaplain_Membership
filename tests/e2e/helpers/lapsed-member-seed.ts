/**
 * F8-completion Slice 3 · Task 3.2 — E2E seed for the admin lapsed-comeback
 * journey.
 *
 * Provisions a DUMMY (simulated, NOT real-PII) member in the `swecham`
 * tenant whose ONLY renewal cycle is `lapsed` — i.e. the member has NO
 * active cycle, so the admin "Renew member" action is surfaced on the
 * member-detail Renewal & Health card. Deterministic ids → idempotent
 * across runs (re-seed deletes the dummy's prior cycle + re-inserts).
 *
 * Never references a real member row (per the project "no real members in
 * seed scripts" rule). The dummy company name + contact email are
 * obviously synthetic.
 *
 * No-op (returns null) when DATABASE_URL is missing or the tenant has no
 * membership plan to anchor the member on.
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';

// Deterministic dummy member id so the seed is idempotent + the spec can
// navigate straight to /admin/members/<id> without a directory search.
const DUMMY_MEMBER_ID = '00000000-0000-4000-8000-0000f8c0de03';
const DUMMY_CONTACT_ID = '00000000-0000-4000-8000-0000f8c0de13';
const DUMMY_COMPANY = 'Lapsed Comeback Co (E2E)';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LapsedMemberSeed {
  readonly memberId: string;
  readonly companyName: string;
}

export async function seedLapsedMemberForComeback(): Promise<LapsedMemberSeed | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[e2e seed lapsed-member] skipped — DATABASE_URL missing');
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    // Anchor the member on a plan that the F8 renewal plan-lookup
    // (`loadPlanFrozenFields`) will resolve as ACTIVE. That lookup keys on
    // `plan_id` only and returns the MOST-RECENT-plan_year row
    // (`ORDER BY plan_year DESC`), so a plan_id whose newest-year row is
    // INACTIVE would make the renew use-case fail with plan_not_found.
    // We therefore pick a plan_id whose latest-year row is active +
    // non-deleted, and anchor the member on THAT latest year (the members
    // FK `members_plan_tenant_year_fk` is on (plan_id, tenant_id,
    // plan_year), so the member's plan_year must match the plan row).
    // The F8 renewal plan-lookup (`loadPlanFrozenFields`) keys on `plan_id`
    // ONLY and resolves the row with the HIGHEST `plan_year`
    // (`ORDER BY plan_year DESC`), then rejects it if `is_active = false`.
    // The real `swecham` catalogue carries stray inactive future-year rows
    // (e.g. clone-to-year test artifacts), so anchoring on a real plan_id
    // makes the lookup resolve to an inactive future row → plan_not_found.
    //
    // To keep the E2E self-contained + deterministic, seed a DEDICATED
    // dummy plan row (cloned from a real active plan to satisfy every NOT
    // NULL column) under a unique `plan_id` so its single row IS the
    // highest-year active row the lookup resolves. Idempotent.
    const DUMMY_PLAN_ID = 'e2e-lapsed-comeback-plan';
    // Use the CURRENT calendar year so it matches the `plan_year` the UI
    // posts for the renewal invoice (`new Date().getUTCFullYear()`); the
    // F4 createInvoiceDraft looks up the plan fee by (plan_id, plan_year)
    // and would 404 on a mismatch. Because `DUMMY_PLAN_ID` is unique, this
    // single row is also the newest-year active row the F8 plan-lookup
    // resolves — sidestepping the real catalogue's inactive future-year
    // pollution.
    const DUMMY_PLAN_YEAR = new Date().getUTCFullYear();
    const sourceRows = await sql<Array<{ plan_id: string; plan_year: number }>>`
      SELECT plan_id, plan_year FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL AND is_active = true
      ORDER BY plan_year DESC, created_at ASC
      LIMIT 1
    `;
    const source = sourceRows[0];
    if (!source) {
      console.warn(
        `[e2e seed lapsed-member] no active plan to clone in tenant ${TENANT_ID}; skipping`,
      );
      return null;
    }
    await sql`
      DELETE FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${DUMMY_PLAN_ID}
    `;
    await sql`
      INSERT INTO membership_plans (
        tenant_id, plan_id, plan_year, plan_name, description,
        sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, is_active, created_by, updated_by
      )
      SELECT
        tenant_id, ${DUMMY_PLAN_ID}, ${DUMMY_PLAN_YEAR}, plan_name, description,
        sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, true, created_by, created_by
      FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${source.plan_id}
        AND plan_year = ${source.plan_year}
    `;
    const planId = DUMMY_PLAN_ID;
    const planYear = DUMMY_PLAN_YEAR;

    // Idempotency: clear any prior cycles + the dummy rows, then re-insert.
    await sql`
      DELETE FROM renewal_cycles
      WHERE tenant_id = ${TENANT_ID} AND member_id = ${DUMMY_MEMBER_ID}::uuid
    `;
    await sql`
      DELETE FROM contacts
      WHERE tenant_id = ${TENANT_ID} AND member_id = ${DUMMY_MEMBER_ID}::uuid
    `;
    await sql`
      DELETE FROM members
      WHERE tenant_id = ${TENANT_ID} AND member_id = ${DUMMY_MEMBER_ID}::uuid
    `;

    const now = new Date();
    // `members.member_number` is a per-tenant-UNIQUE positive INTEGER (the
    // `SCCM-NNNN` form is display-only). Use a high value that won't collide
    // with the allocator's low 1..N output in the shared `swecham` tenant.
    const memberNumber = 990_000 + Math.floor(Math.random() * 9_000);
    await sql`
      INSERT INTO members (
        tenant_id, member_id, member_number, company_name, country,
        plan_id, plan_year, registration_fee_paid, registration_date,
        status
      )
      VALUES (
        ${TENANT_ID}, ${DUMMY_MEMBER_ID}::uuid, ${memberNumber}, ${DUMMY_COMPANY}, 'TH',
        ${planId}, ${planYear}, true, '2020-01-01',
        'active'
      )
    `;
    await sql`
      INSERT INTO contacts (
        tenant_id, contact_id, member_id, first_name, last_name, email, is_primary
      )
      VALUES (
        ${TENANT_ID}, ${DUMMY_CONTACT_ID}::uuid, ${DUMMY_MEMBER_ID}::uuid,
        'Lapsed', 'Comeback', 'lapsed-comeback-e2e@example.com', true
      )
    `;

    // The member's ONLY cycle is lapsed (no active cycle) — drives the
    // "Renew member" affordance.
    const lapsedExpiresAt = new Date(now.getTime() - 90 * MS_PER_DAY);
    const lapsedPeriodFrom = new Date(now.getTime() - 455 * MS_PER_DAY);
    await sql`
      INSERT INTO renewal_cycles (
        tenant_id, cycle_id, member_id, status,
        period_from, period_to, expires_at,
        cycle_length_months, tier_at_cycle_start,
        plan_id_at_cycle_start, frozen_plan_price_thb,
        frozen_plan_term_months, frozen_plan_currency,
        closed_at, closed_reason
      )
      VALUES (
        ${TENANT_ID}, ${randomUUID()}::uuid, ${DUMMY_MEMBER_ID}::uuid, 'lapsed',
        ${lapsedPeriodFrom.toISOString()}::timestamptz, ${lapsedExpiresAt.toISOString()}::timestamptz, ${lapsedExpiresAt.toISOString()}::timestamptz,
        12, 'regular',
        ${planId}, '50000.00',
        12, 'THB',
        ${lapsedExpiresAt.toISOString()}::timestamptz, 'lapsed'
      )
    `;

    console.log(
      `[e2e seed lapsed-member] OK member=${DUMMY_MEMBER_ID} (${DUMMY_COMPANY}) lapsed-only in tenant ${TENANT_ID}`,
    );
    return { memberId: DUMMY_MEMBER_ID, companyName: DUMMY_COMPANY };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
