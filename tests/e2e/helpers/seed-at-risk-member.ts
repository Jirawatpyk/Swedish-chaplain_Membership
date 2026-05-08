/**
 * F8 Phase 6 T176 helper — seed one at-risk member (score=78,
 * band=at-risk) into the SweCham tenant for E2E. Returns a `cleanup`
 * closure that throws on failure so teardown problems are CI-visible
 * (writes go to the LIVE tenant — silent orphans would corrupt
 * production data).
 *
 * Pattern mirrors `renewals-seed.ts`: raw `postgres` client, runs
 * outside the Next.js request lifecycle.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SeededAtRiskMember {
  readonly memberId: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Seed one at-risk member with `risk_score=78`. Throws if
 * `DATABASE_URL` is missing or the seed transaction fails.
 *
 * @param planId    F2 plan_id (must already exist in tenant)
 * @param planYear  F2 plan_year matching the plan row
 */
export async function seedOneAtRiskMember(
  planId: string,
  planYear: number,
): Promise<SeededAtRiskMember> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      '[e2e seed at-risk] DATABASE_URL missing — cannot seed.',
    );
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  const memberId = randomUUID();
  const contactId = randomUUID();
  const cycleId = randomUUID();
  const now = new Date();
  const createdAt = new Date(now.getTime() - 200 * MS_PER_DAY);
  const lastActivityAt = new Date(now.getTime() - 400 * MS_PER_DAY);
  const expiresAt = new Date(now.getTime() + 30 * MS_PER_DAY);
  const periodFrom = new Date(now.getTime() - 335 * MS_PER_DAY);
  const registrationDate = createdAt.toISOString().slice(0, 10);
  const email = `e2e-at-risk-${memberId.slice(0, 6)}@acme.example`;

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`;

      // Empty factors JSONB — the AS3+AS4 specs assert only on score
      // and band, never on factor breakdown. Keeping a static factor
      // list would couple the fixture to FR-029 weights.
      await tx`
        INSERT INTO members (
          tenant_id, member_id, company_name, country,
          plan_id, plan_year, registration_date, registration_fee_paid,
          status, created_at, last_activity_at,
          risk_score, risk_score_band, risk_score_factors,
          risk_score_last_computed_at
        )
        VALUES (
          ${TENANT_ID}, ${memberId}::uuid,
          ${'E2E At-Risk ' + memberId.slice(0, 8)}, 'TH',
          ${planId}, ${planYear},
          ${registrationDate}::date, true,
          'active', ${createdAt.toISOString()}::timestamptz,
          ${lastActivityAt.toISOString()}::timestamptz,
          78, 'at-risk', '[]'::jsonb,
          ${now.toISOString()}::timestamptz
        )
      `;

      await tx`
        INSERT INTO contacts (
          tenant_id, contact_id, member_id,
          first_name, last_name, email, preferred_language, is_primary
        )
        VALUES (
          ${TENANT_ID}, ${contactId}::uuid, ${memberId}::uuid,
          'E2E', 'AtRisk', ${email}, 'en', true
        )
      `;

      // Upcoming cycle required by FR-007a "active for F8 cron purposes"
      await tx`
        INSERT INTO renewal_cycles (
          tenant_id, cycle_id, member_id, status,
          period_from, period_to, expires_at,
          cycle_length_months, tier_at_cycle_start,
          plan_id_at_cycle_start, frozen_plan_price_thb,
          frozen_plan_term_months, frozen_plan_currency
        )
        VALUES (
          ${TENANT_ID}, ${cycleId}::uuid, ${memberId}::uuid, 'upcoming',
          ${periodFrom.toISOString()}::timestamptz,
          ${expiresAt.toISOString()}::timestamptz,
          ${expiresAt.toISOString()}::timestamptz,
          12, 'regular',
          gen_random_uuid(), '50000.00',
          12, 'THB'
        )
      `;
    });
  } catch (e) {
    await sql.end({ timeout: 5 });
    throw e;
  }

  console.log(
    `[e2e seed at-risk] OK member=${memberId} cycle=${cycleId} score=78`,
  );

  return {
    memberId,
    cleanup: async () => {
      try {
        await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`;
          // FK-friendly order. AS4 outreach rows cascaded too.
          await tx`
            DELETE FROM at_risk_outreach
            WHERE tenant_id = ${TENANT_ID} AND member_id = ${memberId}::uuid
          `;
          await tx`
            DELETE FROM renewal_cycles
            WHERE tenant_id = ${TENANT_ID} AND cycle_id = ${cycleId}::uuid
          `;
          await tx`
            DELETE FROM contacts
            WHERE tenant_id = ${TENANT_ID} AND contact_id = ${contactId}::uuid
          `;
          await tx`
            DELETE FROM members
            WHERE tenant_id = ${TENANT_ID} AND member_id = ${memberId}::uuid
          `;
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  };
}
