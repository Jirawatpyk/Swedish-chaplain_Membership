/**
 * 070 F8 item #18 — E2E seed for a `pending_admin_reactivation` cycle.
 *
 * Provisions, for the existing `e2e-member`, ONE cycle in
 * `pending_admin_reactivation` linked to a draft membership invoice so the
 * cycle-detail admin actions (approve / reject-with-refund) have a real
 * target. The reject path's F5 refund returns `no_payment_found` (the draft
 * invoice has no succeeded payment) so the reject still transitions the
 * cycle to `cancelled` and renders the "no payment to refund" toast — no
 * Stripe call is made.
 *
 * The unique-active-cycle invariant (one active cycle per member) means we
 * first delete any active cycle the e2e-member owns, then insert the
 * pending one. Re-seeding is idempotent (delete-then-insert).
 *
 * No-op (returns null) when DATABASE_URL / E2E_MEMBER_EMAIL / E2E_ADMIN_EMAIL
 * is missing, or the e2e-member / admin user can't be resolved — the caller
 * gates the suite on a null result.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PendingSeedResult {
  readonly cycleId: string;
  readonly memberId: string;
  readonly invoiceId: string;
}

export async function seedPendingReactivationCycle(): Promise<PendingSeedResult | null> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  const adminEmail = process.env.E2E_ADMIN_EMAIL;
  if (!dbUrl || !memberEmail || !adminEmail) {
    console.warn(
      '[e2e seed pending-reactivation] skipped — DATABASE_URL / E2E_MEMBER_EMAIL / E2E_ADMIN_EMAIL missing',
    );
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
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
        `[e2e seed pending-reactivation] e2e-member not found in tenant ${TENANT_ID}; skipping`,
      );
      return null;
    }

    const adminRows = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM users WHERE email = ${adminEmail} LIMIT 1
    `;
    const adminUserId = adminRows[0]?.id;
    if (!adminUserId) {
      console.warn(
        '[e2e seed pending-reactivation] e2e-admin user not found; skipping',
      );
      return null;
    }

    // The member's plan_id (slug) — used for the draft invoice subject CHECK.
    const planId = member.plan_uuid ?? 'regular';
    const planYear = new Date().getUTCFullYear();

    // Clear the member's active cycle (unique-active-cycle invariant) +
    // any prior pending-seed invoice so re-runs are clean. Reminder events
    // FK-cascade off the cycle.
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

    // Draft membership invoice (no payment → reject yields no_payment_found,
    // no Stripe call). Satisfies the linked-invoice FK + completed CHECK.
    const invoiceId = randomUUID();
    await sql`
      INSERT INTO invoices (
        tenant_id, invoice_id, member_id, plan_id, plan_year,
        invoice_subject, status, draft_by_user_id, currency, vat_inclusive
      )
      VALUES (
        ${TENANT_ID}, ${invoiceId}::uuid, ${member.member_id}::uuid,
        ${planId}, ${planYear},
        'membership', 'draft', ${adminUserId}::uuid, 'THB', false
      )
    `;

    const cycleId = randomUUID();
    const now = new Date();
    // Pending for 5 days — comfortably under the 30-day auto-timeout so the
    // reconcile cron never lapses it out from under the test.
    const enteredPendingAt = new Date(now.getTime() - 5 * MS_PER_DAY);
    const periodFrom = new Date(now.getTime() - 365 * MS_PER_DAY);
    const expiresAt = new Date(now.getTime() - 10 * MS_PER_DAY);
    await sql`
      INSERT INTO renewal_cycles (
        tenant_id, cycle_id, member_id, status,
        period_from, period_to, expires_at,
        cycle_length_months, tier_at_cycle_start,
        plan_id_at_cycle_start, frozen_plan_price_thb,
        frozen_plan_term_months, frozen_plan_currency,
        entered_pending_at, linked_invoice_id
      )
      VALUES (
        ${TENANT_ID}, ${cycleId}::uuid, ${member.member_id}::uuid, 'pending_admin_reactivation',
        ${periodFrom.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz, ${expiresAt.toISOString()}::timestamptz,
        12, 'regular',
        'regular', '50000.00',
        12, 'THB',
        ${enteredPendingAt.toISOString()}::timestamptz, ${invoiceId}::uuid
      )
    `;

    console.log(
      `[e2e seed pending-reactivation] OK cycle=${cycleId} invoice=${invoiceId} member=${member.member_id}`,
    );
    return { cycleId, memberId: member.member_id, invoiceId };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Teardown for the rows {@link seedPendingReactivationCycle} leaves behind.
 *
 * Each seed run inserts ONE draft invoice + ONE renewal cycle for the shared
 * live-Neon `e2e-member`. The approve/reject tests transition the cycle to a
 * TERMINAL state (`completed`/`cancelled`) but never delete it, and the draft
 * invoice is always orphaned — so a suite with no teardown accretes stale rows
 * on the shared member every run. This deletes the EXACT cycleId/invoiceId
 * pairs the suite seeded (FK order: reminder events → cycle → invoice), so it
 * touches nothing else the member owns.
 *
 * No-op when DATABASE_URL is missing (the suite was gated off + nothing
 * seeded). Best-effort: a failure here only logs — it must never fail the run.
 */
export async function cleanupPendingReactivationSeeds(
  seeds: readonly PendingSeedResult[],
): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || seeds.length === 0) return;
  const cycleIds = seeds.map((s) => s.cycleId);
  const invoiceIds = seeds.map((s) => s.invoiceId);
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    // Reminder events FK-cascade off the cycle, but delete explicitly first
    // in case the FK is not ON DELETE CASCADE for every seeded row.
    await sql`
      DELETE FROM renewal_reminder_events
      WHERE tenant_id = ${TENANT_ID}
        AND cycle_id = ANY(${cycleIds}::uuid[])
    `;
    await sql`
      DELETE FROM renewal_cycles
      WHERE tenant_id = ${TENANT_ID}
        AND cycle_id = ANY(${cycleIds}::uuid[])
    `;
    await sql`
      DELETE FROM invoices
      WHERE tenant_id = ${TENANT_ID}
        AND invoice_id = ANY(${invoiceIds}::uuid[])
    `;
    console.log(
      `[e2e seed pending-reactivation] cleaned up ${cycleIds.length} seeded cycle/invoice pair(s)`,
    );
  } catch (e) {
    console.warn(
      '[e2e seed pending-reactivation] cleanup failed (non-fatal):',
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
