/**
 * E2E seed helper for F8 renewal pipeline (US1 + US2).
 *
 * Provisions:
 *   1. Default 5-bucket schedule policy for the `swecham` tenant if
 *      missing (idempotent — no-op when migration 0089 already seeded).
 *   2. A renewal cycle in `upcoming` status whose `expires_at` is 30
 *      days from real-now → falls into the T-30 urgency bucket so the
 *      pipeline UI has at least one row to render.
 *
 * Targeted at the existing `e2e-member` account so it shares the
 * F7 broadcasts seed and doesn't introduce a new dependency on a
 * dedicated F8 fixture user. Idempotent across runs — re-seeding
 * deletes any prior cycle for the same member then re-inserts.
 *
 * No-op when DATABASE_URL or E2E_MEMBER_EMAIL is missing.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';

export interface SeedResult {
  readonly cycleId: string;
  readonly memberId: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function seedF8Renewals(): Promise<SeedResult | null> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  if (!dbUrl || !memberEmail) {
    console.warn(
      '[e2e seed renewals] skipped — DATABASE_URL or E2E_MEMBER_EMAIL missing',
    );
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    // Resolve member from existing e2e seed.
    const memberRows = await sql<
      Array<{ member_id: string; plan_uuid: string }>
    >`
      SELECT m.member_id::text AS member_id, m.plan_id AS plan_uuid
      FROM users u
      JOIN contacts c
        ON c.linked_user_id = u.id AND c.tenant_id = ${TENANT_ID}
      JOIN members m
        ON m.member_id = c.member_id AND m.tenant_id = ${TENANT_ID}
      WHERE u.email = ${memberEmail}
      LIMIT 1
    `;
    const member = memberRows[0];
    if (!member) {
      console.warn(
        `[e2e seed renewals] e2e-member not found in tenant ${TENANT_ID}; skipping seed`,
      );
      return null;
    }

    // Idempotency: drop any prior cycle for this member that the seed
    // owns (open cycles + lapsed cycles created by previous E2E runs).
    // Other cycles (paid/completed/cancelled by real flows) stay so
    // audit history is preserved.
    await sql`
      DELETE FROM renewal_reminder_events
      WHERE tenant_id = ${TENANT_ID}
        AND cycle_id IN (
          SELECT cycle_id FROM renewal_cycles
          WHERE tenant_id = ${TENANT_ID}
            AND member_id = ${member.member_id}::uuid
            AND status IN ('upcoming', 'reminded', 'awaiting_payment', 'lapsed')
        )
    `;
    await sql`
      DELETE FROM renewal_cycles
      WHERE tenant_id = ${TENANT_ID}
        AND member_id = ${member.member_id}::uuid
        AND status IN ('upcoming', 'reminded', 'awaiting_payment', 'lapsed')
    `;

    // Mint a fresh upcoming cycle 30 days from now (drives AS1/AS2 +
    // T113 row-action tests).
    const cycleId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * MS_PER_DAY);
    const periodFrom = new Date(now.getTime() - 335 * MS_PER_DAY);
    await sql`
      INSERT INTO renewal_cycles (
        tenant_id, cycle_id, member_id, status,
        period_from, period_to, expires_at,
        cycle_length_months, tier_at_cycle_start,
        plan_id_at_cycle_start, frozen_plan_price_thb,
        frozen_plan_term_months, frozen_plan_currency
      )
      VALUES (
        ${TENANT_ID}, ${cycleId}::uuid, ${member.member_id}::uuid, 'upcoming',
        ${periodFrom.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz,
        12, 'regular',
        'regular', '50000.00',
        12, 'THB'
      )
    `;

    // Mint a lapsed cycle for the SAME member but with a closed_at +
    // closed_reason that drives the lapsed-tab banner (drives AS3).
    // The page filters lapsed cycles by status='lapsed' only — both
    // upcoming + lapsed coexist in the seed so the dashboard can
    // exercise both tabs without race-conditional fixtures.
    const lapsedCycleId = randomUUID();
    const lapsedExpiresAt = new Date(now.getTime() - 60 * MS_PER_DAY);
    const lapsedPeriodFrom = new Date(now.getTime() - 425 * MS_PER_DAY);
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
        ${TENANT_ID}, ${lapsedCycleId}::uuid, ${member.member_id}::uuid, 'lapsed',
        ${lapsedPeriodFrom.toISOString()}::timestamptz, ${lapsedExpiresAt.toISOString()}::timestamptz, ${lapsedExpiresAt.toISOString()}::timestamptz,
        12, 'regular',
        'regular', '50000.00',
        12, 'THB',
        ${lapsedExpiresAt.toISOString()}::timestamptz, 'lapsed'
      )
    `;
    console.log(
      `[e2e seed renewals] OK upcoming=${cycleId} lapsed=${lapsedCycleId} member=${member.member_id} expires=${expiresAt.toISOString()}`,
    );
    return { cycleId, memberId: member.member_id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
