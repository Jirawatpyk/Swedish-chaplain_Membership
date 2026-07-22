/**
 * E2E seed — a DUMMY member whose plan name and renewal state are long/wide
 * enough to overflow the `/admin/members` directory's fixed column widths
 * (Plan 150px, Status 130px — see `members-table.tsx`'s `columnHelper`
 * `size` values).
 *
 * Modeled on `tests/e2e/helpers/lapsed-member-seed.ts` (same owner-role
 * postgres client via `openSeedClient`, same "no real PII" rule, same
 * idempotent deterministic ids, same clone-a-real-plan-row technique so
 * every NOT NULL column on `membership_plans` is satisfied without having
 * to enumerate them all here).
 *
 * The member also gets a single `lapsed` renewal cycle so the Status cell
 * renders its WIDEST possible content — the inline status control + pencil
 * icon + the "Lapsed" badge (icon + label). Without it, "Active" + a pencil
 * icon alone comfortably fits inside 130px and the Status-column half of
 * this fixture would guard nothing. `lapsed` resolves to `access:
 * 'terminated'` in `deriveMembershipAccess` UNCONDITIONALLY (065 §5.2⇄§5.3
 * — see `src/modules/renewals/domain/renewal-cycle.ts`), regardless of
 * `expires_at`, so a single lapsed cycle is sufficient.
 *
 * No-op (returns null) when `DATABASE_URL` is missing or the tenant has no
 * active membership plan to clone.
 */
import { randomUUID } from 'node:crypto';
import { openSeedClient, type SeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const SEED_LABEL = 'e2e seed long-content-member';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DUMMY_MEMBER_ID = '00000000-0000-4000-8000-0000010ec001';
const DUMMY_CONTACT_ID = '00000000-0000-4000-8000-0000010ec011';
const DUMMY_PLAN_ID = 'e2e-long-name-plan';
// 46 chars -- comfortably wider than the 150px Plan column once rendered
// with " · <year>" appended.
const DUMMY_PLAN_NAME = 'Corporate Platinum Plus Membership Package 2026';
const DUMMY_COMPANY = 'Overflow Fixture Trading Company Limited (E2E)';
const DUMMY_CONTACT_FIRST = 'Bartholomew';
const DUMMY_CONTACT_LAST = 'Featherstonehaugh-Wickersham';

export interface LongContentMemberSeed {
  readonly memberId: string;
  readonly companyName: string;
  readonly planName: string;
}

/**
 * Idempotent teardown of any leftover dummy data from a prior run that
 * didn't reach its `afterAll` (e.g. an interrupted run), in FK order.
 * Shared by both the seed's own pre-insert cleanup and the exported
 * `cleanupLongContentMember`.
 */
async function deleteLongContentMemberRows(sql: SeedClient['sql']): Promise<void> {
  await sql`
    DELETE FROM renewal_reminder_events
    WHERE tenant_id = ${TENANT_ID}
      AND cycle_id IN (
        SELECT cycle_id FROM renewal_cycles
        WHERE tenant_id = ${TENANT_ID} AND member_id = ${DUMMY_MEMBER_ID}::uuid
      )
  `;
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
  await sql`
    DELETE FROM membership_plans
    WHERE tenant_id = ${TENANT_ID} AND plan_id = ${DUMMY_PLAN_ID}
  `;
}

export async function seedLongContentMember(): Promise<LongContentMemberSeed | null> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const planYear = new Date().getUTCFullYear();

    // Clone a real active plan row so every NOT NULL column on
    // `membership_plans` is satisfied, then override plan_id/plan_year/
    // plan_name. Same technique as lapsed-member-seed.ts.
    const sourceRows = await sql<Array<{ plan_id: string; plan_year: number }>>`
      SELECT plan_id, plan_year FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL AND is_active = true
      ORDER BY plan_year DESC, created_at ASC
      LIMIT 1
    `;
    const source = sourceRows[0];
    if (!source) {
      console.warn(
        `[${SEED_LABEL}] no active plan to clone in tenant ${TENANT_ID}; skipping`,
      );
      return null;
    }

    await deleteLongContentMemberRows(sql);

    await sql`
      INSERT INTO membership_plans (
        tenant_id, plan_id, plan_year, plan_name, description,
        sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, is_active, created_by, updated_by
      )
      SELECT
        tenant_id, ${DUMMY_PLAN_ID}, ${planYear},
        jsonb_build_object('en', ${DUMMY_PLAN_NAME}::text),
        description, sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, true, created_by, created_by
      FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${source.plan_id}
        AND plan_year = ${source.plan_year}
    `;

    // `members.member_number` is a per-tenant-UNIQUE positive INTEGER (the
    // `SCCM-NNNN` form is display-only). A high value avoids colliding with
    // the allocator's low sequential output in the shared `swecham` tenant;
    // the range is disjoint from the other e2e dummy-member seeds
    // (`erasure-evidence-seed.ts` 980_000+, `lapsed-member-seed.ts` 990_000+).
    const memberNumber = 970_000 + Math.floor(Math.random() * 9_000);
    await sql`
      INSERT INTO members (
        tenant_id, member_id, member_number, company_name, country,
        plan_id, plan_year, status
      )
      VALUES (
        ${TENANT_ID}, ${DUMMY_MEMBER_ID}::uuid, ${memberNumber}, ${DUMMY_COMPANY}, 'TH',
        ${DUMMY_PLAN_ID}, ${planYear}, 'active'
      )
    `;
    await sql`
      INSERT INTO contacts (
        tenant_id, contact_id, member_id, first_name, last_name, email, is_primary
      )
      VALUES (
        ${TENANT_ID}, ${DUMMY_CONTACT_ID}::uuid, ${DUMMY_MEMBER_ID}::uuid,
        ${DUMMY_CONTACT_FIRST}, ${DUMMY_CONTACT_LAST},
        'overflow.fixture@e2e.invalid', true
      )
    `;

    // The member's ONLY cycle is `lapsed` — drives the Status-cell "Lapsed"
    // badge (see the module doc comment for why this is required for the
    // Status half of the overflow assertion).
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 120 * MS_PER_DAY);
    const periodFrom = new Date(now.getTime() - 485 * MS_PER_DAY);
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
        ${periodFrom.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz,
        12, 'regular',
        ${DUMMY_PLAN_ID}, '50000.00',
        12, 'THB',
        ${expiresAt.toISOString()}::timestamptz, 'lapsed'
      )
    `;

    console.log(
      `[${SEED_LABEL}] OK member=${DUMMY_MEMBER_ID} (${DUMMY_COMPANY}) plan="${DUMMY_PLAN_NAME}" in tenant ${TENANT_ID}`,
    );
    return {
      memberId: DUMMY_MEMBER_ID,
      companyName: DUMMY_COMPANY,
      planName: DUMMY_PLAN_NAME,
    };
  } finally {
    await end();
  }
}

/**
 * Tear down everything this seed left in the shared `swecham` tenant — the
 * dummy member (high `member_number`), its contact, its renewal cycle, and
 * the dummy plan row. MUST run in the spec's `afterAll`: a stray high
 * `member_number` left behind would inflate `MAX(member_number)` for the
 * tenant past `tenant_member_sequences.last_number`, breaking the
 * `migration-0209-post-apply` invariant that the sequence's high-water mark
 * covers every row (see that integration test's last assertion).
 */
export async function cleanupLongContentMember(): Promise<void> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return;
  const { sql, end } = client;
  try {
    await deleteLongContentMemberRows(sql);
  } finally {
    await end();
  }
}
