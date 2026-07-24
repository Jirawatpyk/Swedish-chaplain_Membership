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

/**
 * Optional overrides for the seeded UPCOMING cycle. Defaults reproduce the
 * historical fixture verbatim (the e2e-member on the `regular` slug at a frozen
 * 50,000.00 THB), so every existing `seedF8Renewals()` caller — including
 * `global-setup.ts` — is unaffected.
 *
 * The plan-change-UX downgrade E2E (`portal-renewal-downgrade.spec.ts`) passes
 * a HIGHER-priced current plan (`premium`) with the frozen price set to that
 * plan's real catalogue fee (36,000.00 THB), so the renewal picker offers
 * genuinely cheaper plans that trip the two-step downgrade acknowledgement gate.
 * The lapsed cycle + tier-upgrade suggestion below are left on their historical
 * values — they are read by unrelated surfaces and do not affect the portal
 * picker (which reads only the active `upcoming`/`awaiting_payment` cycle).
 */
export interface SeedF8RenewalsOptions {
  /** `plan_id_at_cycle_start` for the upcoming cycle (default `'regular'`). */
  readonly planId?: string;
  /** `tier_at_cycle_start` for the upcoming cycle (default `'regular'`). */
  readonly tier?: string;
  /** `frozen_plan_price_thb` decimal string (default `'50000.00'`). */
  readonly frozenPlanPriceThb?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function seedF8Renewals(
  options: SeedF8RenewalsOptions = {},
): Promise<SeedResult | null> {
  const planIdAtCycleStart = options.planId ?? 'regular';
  const tierAtCycleStart = options.tier ?? 'regular';
  const frozenPlanPriceThb = options.frozenPlanPriceThb ?? '50000.00';
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

    // 070 e2e fix — the member-self-service renewal page scopes its
    // plan-change selector to `listPlans(deriveFiscalYear(cycle.period_from),
    // activeOnly: true)` — the cycle's OWN fiscal year (the 070 L2 §86/4 fix
    // that replaced the period-END year). This seed mints a realistic
    // ~12-month cycle whose `period_from` lands in the PRIOR calendar year,
    // but the swecham dev catalogue is seeded only for the current year — so
    // that year would have 0 active plans and the picker renders nothing
    // (`hasAlternatives = availablePlans.length > 1`). Make the seed
    // self-sufficient: ensure the catalogue covers the cycle's fiscal year by
    // cloning the most-recent active year's active plans into it (idempotent
    // via ON CONFLICT — mirrors what a real catalogue spanning members' cycle
    // years would carry). SweCham fiscal-year start month = 1, so FY = the
    // Bangkok-wall (UTC+7) calendar year of `period_from`.
    const cycleFiscalYear = new Date(
      periodFrom.getTime() + 7 * 60 * 60 * 1000,
    ).getUTCFullYear();
    await sql`
      INSERT INTO membership_plans (
        tenant_id, plan_id, plan_year, plan_name, description, sort_order,
        plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, min_turnover_minor_units,
        max_turnover_minor_units, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, is_active, deleted_at,
        created_at, updated_at, created_by, updated_by
      )
      SELECT
        tenant_id, plan_id, ${cycleFiscalYear}, plan_name, description, sort_order,
        plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, min_turnover_minor_units,
        max_turnover_minor_units, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, true, NULL,
        now(), now(), created_by, updated_by
      FROM membership_plans
      WHERE tenant_id = ${TENANT_ID}
        AND is_active = true
        AND deleted_at IS NULL
        AND plan_year = (
          SELECT max(plan_year) FROM membership_plans
          WHERE tenant_id = ${TENANT_ID}
            AND is_active = true
            AND deleted_at IS NULL
        )
      ON CONFLICT (tenant_id, plan_id, plan_year) DO NOTHING
    `;

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
        12, ${tierAtCycleStart},
        ${planIdAtCycleStart}, ${frozenPlanPriceThb},
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
    // Round 6 W-015 — seed an OPEN tier_upgrade_suggestion for the same
    // e2e-member so `auto-tier-upgrade.spec.ts` AlertDialog focus test
    // actually runs (was vacuous-skip per FR-058 §4 Cancel-default
    // assertion). Idempotency: drop any existing open/pending
    // suggestion for this member first (other terminal-status rows
    // stay so audit history is preserved).
    await sql`
      DELETE FROM tier_upgrade_suggestions
      WHERE tenant_id = ${TENANT_ID}
        AND member_id = ${member.member_id}::uuid
        AND status IN ('open', 'accepted_pending_apply')
    `;
    const suggestionId = randomUUID();
    await sql`
      INSERT INTO tier_upgrade_suggestions (
        tenant_id, suggestion_id, member_id,
        from_plan_id, to_plan_id,
        reason_code, evidence_jsonb, status
      )
      VALUES (
        ${TENANT_ID}, ${suggestionId}::uuid, ${member.member_id}::uuid,
        'regular', 'premium',
        'declared_turnover_above_threshold',
        ${JSON.stringify({
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 120_000_000,
          thresholdMetAt: new Date().toISOString(),
        })}::jsonb,
        'open'
      )
    `;
    console.log(
      `[e2e seed renewals] OK upcoming=${cycleId} lapsed=${lapsedCycleId} suggestion=${suggestionId} member=${member.member_id} expires=${expiresAt.toISOString()}`,
    );
    return { cycleId, memberId: member.member_id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
