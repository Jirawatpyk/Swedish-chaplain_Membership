/**
 * 059-membership-suspension Task 10 — E2E seed for the TERMINATED-member
 * journey (`lapsed-portal-scope.spec.ts` DENY-side rewrite).
 *
 * Mints `e2e-member`'s ONLY renewal cycle as `lapsed`, with `expires_at`
 * well in the past. Verified against `deriveMembershipAccess`
 * (`src/modules/renewals/domain/renewal-cycle.ts`):
 *
 *   if (cycle.status === 'lapsed' || cycle.status === 'cancelled') {
 *     return expired
 *       ? { access: 'terminated', reason: 'grace_expired' }
 *       : { access: 'full', reason: 'in_good_standing' };
 *   }
 *
 * — `lapsed` + past `expires_at` → `{ access: 'terminated', reason:
 * 'grace_expired' }` deterministically. `findLatestCycleForMember` orders
 * by `created_at DESC, cycle_id DESC` across ALL statuses (no filter), so
 * this fresh single row is unambiguously the member's "latest" cycle
 * regardless of what an earlier spec (`seedF8Renewals`, `seedSuspendedMember`)
 * left behind — those rows are deleted first.
 *
 * `closed_at`/`closed_reason` are set (`renewal_cycles_closed_at_iff_
 * terminal_check` requires `closed_at NOT NULL` for a `lapsed` row).
 *
 * Reuses `e2e-member` (not a fresh dummy member) for the same reason
 * `suspended-member-seed.ts` does — a real portal sign-in needs known
 * credentials, and only `E2E_MEMBER_EMAIL`/`E2E_MEMBER_PASSWORD` are
 * provisioned for that. Mirrors `pending-reactivation-seed.ts`'s
 * delete-then-insert idempotency (clears the member's active cycle only —
 * `renewal_cycles_active_member_uniq` excludes lapsed/cancelled/completed
 * — then inserts fresh).
 *
 * No-op (returns null) when `DATABASE_URL` / `E2E_MEMBER_EMAIL` is missing,
 * or `e2e-member` can't be resolved in the tenant.
 */
import { randomUUID } from 'node:crypto';
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEED_LABEL = 'e2e seed terminated-member';

export interface TerminatedMemberSeed {
  readonly cycleId: string;
  readonly memberId: string;
}

export async function seedTerminatedMember(): Promise<TerminatedMemberSeed | null> {
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  if (!memberEmail) {
    console.warn(`[${SEED_LABEL}] skipped — E2E_MEMBER_EMAIL missing`);
    return null;
  }
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const memberRows = await sql<Array<{ member_id: string }>>`
      SELECT m.member_id::text AS member_id
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
        `[${SEED_LABEL}] e2e-member not found in tenant ${TENANT_ID}; skipping`,
      );
      return null;
    }

    // Clear the member's active cycle (unique-active-cycle invariant).
    // Prior terminal rows (e.g. a stray `lapsed` row from a previous run)
    // are left in place — the freshly-inserted row's `created_at = now()`
    // always wins the `findLatestCycleForMember` ordering regardless.
    await sql`
      DELETE FROM renewal_reminder_events
      WHERE tenant_id = ${TENANT_ID}
        AND cycle_id IN (
          SELECT cycle_id FROM renewal_cycles
          WHERE tenant_id = ${TENANT_ID}
            AND member_id = ${member.member_id}::uuid
            AND status NOT IN ('lapsed', 'cancelled', 'completed')
        )
    `;
    await sql`
      DELETE FROM renewal_cycles
      WHERE tenant_id = ${TENANT_ID}
        AND member_id = ${member.member_id}::uuid
        AND status NOT IN ('lapsed', 'cancelled', 'completed')
    `;

    const cycleId = randomUUID();
    const now = new Date();
    // Well past any grace period (90 days per Slice 2's ops step, or the
    // 14-day code default) — unambiguously terminated either way.
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
        ${TENANT_ID}, ${cycleId}::uuid, ${member.member_id}::uuid, 'lapsed',
        ${periodFrom.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz,
        12, 'regular',
        'regular', '50000.00',
        12, 'THB',
        ${expiresAt.toISOString()}::timestamptz, 'lapsed'
      )
    `;

    console.log(
      `[${SEED_LABEL}] OK lapsed cycle=${cycleId} member=${member.member_id} expires=${expiresAt.toISOString()}`,
    );
    return { cycleId, memberId: member.member_id };
  } finally {
    await end();
  }
}
