/**
 * F8 Phase 6 T176 helper — seed one at-risk member into the SweCham
 * tenant for E2E so the AS3 + AS4 dialog flows always have an
 * actionable row to click. Returns a teardown closure.
 *
 * Writes directly to F3 `members.risk_score_*` columns (bypassing the
 * cron path) — the E2E only needs the widget query to return a row;
 * the recompute logic is covered by unit + integration tests
 * (T172 property-based × 512 cases · T173 F6-fallback · T175
 * snooze+outreach · T174 perf).
 *
 * Pattern mirrors `renewals-seed.ts`: raw `postgres` client (no
 * application-code import surface) so the helper runs independently
 * of the Next.js request lifecycle.
 *
 * No-op when DATABASE_URL is missing.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SeededAtRiskMember {
  readonly memberId: string;
  readonly cycleId: string;
  readonly contactId: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Seed one at-risk member with `risk_score=78` (at-risk band) so the
 * widget query returns ≥1 actionable row.
 *
 * @param planId      F2 plan_id to bind the member to (must already exist
 *                    in the tenant — e.g. 'regular' from the SweCham 2026
 *                    fixtures).
 * @param planYear    F2 plan_year matching the plan row.
 */
export async function seedOneAtRiskMember(
  planId: string,
  planYear: number,
): Promise<SeededAtRiskMember | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[e2e seed at-risk] skipped — DATABASE_URL missing');
    return null;
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
    // RLS scope — the helper runs OUTSIDE runInTenant; SET LOCAL on a
    // dedicated transaction restricts every INSERT below to TENANT_ID.
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`;

      // 1. members row — pre-populate risk_score_* so the widget query
      //    immediately returns this row at the 'at-risk' band.
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
          78, 'at-risk',
          ${JSON.stringify([
            { factor: 'invoices_overdue_count_gt_zero', points: 25 },
            { factor: 'days_since_last_payment_gt_180', points: 10 },
            { factor: 'days_since_contact_update_gt_365', points: 5 },
            { factor: 'tier_downgraded_last_12mo', points: 15 },
            { factor: 'e_blast_quota_under_30pct', points: 15 },
            { factor: 'cultural_ticket_quota_under_50pct', points: 10 },
          ])}::jsonb,
          ${now.toISOString()}::timestamptz
        )
      `;

      // 2. primary contact (FR-003 — one primary per member).
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

      // 3. upcoming renewal cycle — required by FR-007a "active for F8
      //    cron purposes" + ensures the at-risk widget query joins.
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

    console.log(
      `[e2e seed at-risk] OK member=${memberId} cycle=${cycleId} score=78`,
    );

    return {
      memberId,
      cycleId,
      contactId,
      cleanup: async () => {
        const cleanupSql = postgres(dbUrl, { ssl: 'require', max: 1 });
        try {
          await cleanupSql.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant', ${TENANT_ID}, true)`;
            // FK-friendly order. Snooze + outreach rows that the E2E
            // may have created during AS3 + AS4 are also cascaded here.
            await tx`
              DELETE FROM at_risk_outreach
              WHERE tenant_id = ${TENANT_ID}
                AND member_id = ${memberId}::uuid
            `;
            await tx`
              DELETE FROM renewal_cycles
              WHERE tenant_id = ${TENANT_ID}
                AND cycle_id = ${cycleId}::uuid
            `;
            await tx`
              DELETE FROM contacts
              WHERE tenant_id = ${TENANT_ID}
                AND contact_id = ${contactId}::uuid
            `;
            await tx`
              DELETE FROM members
              WHERE tenant_id = ${TENANT_ID}
                AND member_id = ${memberId}::uuid
            `;
          });
        } catch (e) {
          // Cleanup is best-effort — log but never throw from teardown.
          console.warn(
            `[e2e seed at-risk] cleanup failed for member=${memberId}:`,
            e,
          );
        } finally {
          await cleanupSql.end({ timeout: 5 });
        }
      },
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
