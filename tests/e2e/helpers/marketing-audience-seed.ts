/**
 * 108 PR-D T047 — fixture for the Marketing audience / member-page toggle
 * walks: one active member with a primary contact and two secondaries — one
 * receiving, one switched off by staff — in the e2e tenant.
 *
 * Fixed UUIDs (the `…108d…` range is disjoint from the other e2e seeds) so a
 * crashed run is cleaned up by the next one. Same clone-a-plan technique and
 * BYPASSRLS seed client as `long-content-member-seed.ts`. Simulated
 * `@e2e.invalid` addresses only — no real PII.
 */
import { openSeedClient, type SeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const SEED_LABEL = 'e2e seed marketing-audience';

export const MARKETING_AUDIENCE_FIXTURE = {
  memberId: '00000000-0000-4000-8000-00000108d001',
  planId: 'e2e-marketing-audience-plan',
  companyName: 'Audience Fixture Trading Co (E2E)',
  primary: {
    contactId: '00000000-0000-4000-8000-00000108d011',
    firstName: 'Prim',
    lastName: 'Audiencefixture',
    email: 'prim.audiencefixture@e2e.invalid',
  },
  secondaryOn: {
    contactId: '00000000-0000-4000-8000-00000108d012',
    firstName: 'Secon',
    lastName: 'Receiving',
    email: 'secon.receiving@e2e.invalid',
  },
  secondaryStaffOff: {
    contactId: '00000000-0000-4000-8000-00000108d013',
    firstName: 'Secoff',
    lastName: 'Staffswitched',
    email: 'secoff.staffswitched@e2e.invalid',
  },
  /** A stand-in staff actor id for the pre-seeded opt-out (no FK on the column). */
  staffActorId: '00000000-0000-4000-8000-00000108d0aa',
} as const;

const F = MARKETING_AUDIENCE_FIXTURE;

async function deleteFixtureRows(sql: SeedClient['sql']): Promise<void> {
  // NOTE: audit_log is append-only (security.md T-13) — the toggle audit rows
  // this walk writes stay behind, which is why `readMarketingAuditTrail`
  // filters by the seed timestamp instead of expecting a clean table.
  await sql`
    DELETE FROM contacts
    WHERE tenant_id = ${TENANT_ID} AND member_id = ${F.memberId}::uuid
  `;
  await sql`
    DELETE FROM members
    WHERE tenant_id = ${TENANT_ID} AND member_id = ${F.memberId}::uuid
  `;
  await sql`
    DELETE FROM membership_plans
    WHERE tenant_id = ${TENANT_ID} AND plan_id = ${F.planId}
  `;
}

/** Resolves to the seed instant (for the audit-trail read), or null when skipped. */
export async function seedMarketingAudienceFixture(): Promise<Date | null> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const seededAt = new Date();
    const planYear = seededAt.getUTCFullYear();
    const sourceRows = await sql<Array<{ plan_id: string; plan_year: number }>>`
      SELECT plan_id, plan_year FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL AND is_active = true
      ORDER BY plan_year DESC, created_at ASC
      LIMIT 1
    `;
    const source = sourceRows[0];
    if (!source) {
      console.warn(`[${SEED_LABEL}] no active plan to clone in tenant ${TENANT_ID}; skipping`);
      return null;
    }

    await deleteFixtureRows(sql);

    await sql`
      INSERT INTO membership_plans (
        tenant_id, plan_id, plan_year, plan_name, description,
        sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, is_active, created_by, updated_by
      )
      SELECT
        tenant_id, ${F.planId}, ${planYear},
        jsonb_build_object('en', 'E2E Marketing Audience Plan'::text),
        description, sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, true, created_by, created_by
      FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${source.plan_id}
        AND plan_year = ${source.plan_year}
    `;

    // Disjoint from the other e2e dummy-member ranges (970k / 980k / 990k).
    const memberNumber = 960_000 + Math.floor(Math.random() * 9_000);
    await sql`
      INSERT INTO members (
        tenant_id, member_id, member_number, company_name, country,
        plan_id, plan_year, status
      )
      VALUES (
        ${TENANT_ID}, ${F.memberId}::uuid, ${memberNumber}, ${F.companyName}, 'TH',
        ${F.planId}, ${planYear}, 'active'
      )
    `;

    await sql`
      INSERT INTO contacts (
        tenant_id, contact_id, member_id, first_name, last_name, email, is_primary
      )
      VALUES
        (${TENANT_ID}, ${F.primary.contactId}::uuid, ${F.memberId}::uuid,
         ${F.primary.firstName}, ${F.primary.lastName}, ${F.primary.email}, true),
        (${TENANT_ID}, ${F.secondaryOn.contactId}::uuid, ${F.memberId}::uuid,
         ${F.secondaryOn.firstName}, ${F.secondaryOn.lastName}, ${F.secondaryOn.email}, false)
    `;
    await sql`
      INSERT INTO contacts (
        tenant_id, contact_id, member_id, first_name, last_name, email, is_primary,
        marketing_opt_out_at, marketing_opt_out_source, marketing_opt_out_by_user_id
      )
      VALUES (
        ${TENANT_ID}, ${F.secondaryStaffOff.contactId}::uuid, ${F.memberId}::uuid,
        ${F.secondaryStaffOff.firstName}, ${F.secondaryStaffOff.lastName},
        ${F.secondaryStaffOff.email}, false,
        now() - interval '2 days', 'staff', ${F.staffActorId}::uuid
      )
    `;
    return seededAt;
  } finally {
    await end();
  }
}

export async function cleanupMarketingAudienceFixture(): Promise<void> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return;
  try {
    await deleteFixtureRows(client.sql);
  } finally {
    await client.end();
  }
}

/**
 * The toggle audit trail for one contact SINCE the seed instant, oldest first
 * (proves Undo used a fresh key). audit_log is append-only, so earlier runs'
 * rows are excluded by time rather than deleted.
 */
export async function readMarketingAuditTrail(contactId: string, since: Date): Promise<string[]> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return [];
  try {
    const rows = await client.sql<Array<{ event_type: string }>>`
      SELECT event_type FROM audit_log
      WHERE tenant_id = ${TENANT_ID}
        AND payload->>'contact_id' = ${contactId}
        AND event_type IN ('contact_marketing_opted_out', 'contact_marketing_opted_in')
        AND "timestamp" >= ${since.toISOString()}::timestamptz
      ORDER BY "timestamp" ASC
    `;
    return rows.map((r) => r.event_type);
  } finally {
    await client.end();
  }
}
