/**
 * 059-membership-suspension Task 10 — E2E seed for the SUSPENDED-member
 * journey.
 *
 * Why this fixture exists (and why `seedF8Renewals()` is NOT reused): that
 * F8 helper mints the `e2e-member` a member with BOTH an `upcoming`
 * (future-expiry) cycle AND a `lapsed` cycle. Under `deriveMembershipAccess`
 * + `findLatestCycleForMember` (which returns the member's LATEST cycle —
 * `created_at DESC, cycle_id DESC`, no status filter), the `upcoming`
 * cycle is inserted AFTER the `lapsed` one in that helper, so it is always
 * the "latest" → `deriveMembershipAccess` resolves that member to `full`,
 * not `suspended`. Reusing it here would silently produce a false-negative
 * fixture (every assertion in `membership-suspension.spec.ts` would pass
 * vacuously because the member was never actually suspended).
 *
 * This helper instead mints exactly ONE cycle for `e2e-member`, in
 * `awaiting_payment`, with `expires_at` in the past. Verified against
 * `deriveMembershipAccess` (`src/modules/renewals/domain/renewal-cycle.ts`):
 *
 *   if (cycle.status === 'awaiting_payment') {
 *     return { access: 'suspended', reason: 'unpaid' };
 *   }
 *
 * — this branch fires UNCONDITIONALLY for `awaiting_payment` (before the
 * expiry comparison even runs), so the member resolves to
 * `{ access: 'suspended', reason: 'unpaid' }` regardless of `expires_at`.
 * `expires_at` is still backdated here for narrative realism (the member's
 * renewal period ended and the invoice was never paid) and so the
 * dashboard's "Invoice due {date}" copy reads sensibly.
 *
 * Deliberately targets the SAME `e2e-member` account `seedF8Renewals` uses
 * (not a fresh dummy member) — a real browser sign-in requires a known
 * password, and the only member account whose credentials are provisioned
 * in `.env.local` is `E2E_MEMBER_EMAIL`/`E2E_MEMBER_PASSWORD`. This member
 * already carries a real ISSUED membership invoice from
 * `scripts/seed-e2e-portal-invoices.ts` (`E2E_ISSUED_INVOICE_ID`,
 * `invoice_subject='membership'`, `status='issued'`) — the portal
 * dashboard's smart-CTA (`findUnpaidMembershipInvoiceId`) resolves straight
 * to it, so this fixture doubles as the "reachable invoice detail page"
 * fixture with no extra invoice seeding required.
 *
 * Mirrors `pending-reactivation-seed.ts`'s delete-then-insert idempotency:
 * only the member's non-terminal/active cycle is cleared before inserting
 * (matches the `renewal_cycles_active_member_uniq` partial-unique-index
 * invariant — a member can have at most one cycle whose status is NOT in
 * `lapsed`/`cancelled`/`completed`). Terminal cycles from a prior run/spec
 * are left alone; the freshly-inserted row's `created_at = now()` always
 * wins the `findLatestCycleForMember` ordering regardless.
 *
 * No-op (returns null) when `DATABASE_URL` / `E2E_MEMBER_EMAIL` is missing,
 * or `e2e-member` can't be resolved in the tenant.
 */
import { randomUUID } from 'node:crypto';
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEED_LABEL = 'e2e seed suspended-member';

export interface SuspendedMemberSeed {
  readonly cycleId: string;
  readonly memberId: string;
}

export async function seedSuspendedMember(): Promise<SuspendedMemberSeed | null> {
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

    // Clear the member's active cycle (unique-active-cycle invariant —
    // `renewal_cycles_active_member_uniq` excludes lapsed/cancelled/
    // completed). Reminder events FK-reference the cycle so must go first.
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
    // Period ended 30 days ago; opened ~11 months before that — a plausible
    // "renewed, then stopped paying" history. No `linked_invoice_id` — the
    // dashboard smart-CTA discovers the unpaid invoice independently (by
    // `invoice_subject`/`status` scan over the member's invoices), not via
    // this column, so leaving it NULL matches how a real awaiting_payment
    // cycle looks before an admin/F4 hook links one.
    const expiresAt = new Date(now.getTime() - 30 * MS_PER_DAY);
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
        ${TENANT_ID}, ${cycleId}::uuid, ${member.member_id}::uuid, 'awaiting_payment',
        ${periodFrom.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz,
        12, 'regular',
        'regular', '50000.00',
        12, 'THB'
      )
    `;

    console.log(
      `[${SEED_LABEL}] OK awaiting_payment cycle=${cycleId} member=${member.member_id} expires=${expiresAt.toISOString()}`,
    );
    return { cycleId, memberId: member.member_id };
  } finally {
    await end();
  }
}
