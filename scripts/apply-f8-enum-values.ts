/**
 * One-off helper: add 21 F8 Phase 5 audit_event_type pgEnum values
 * directly via SQL. Workaround for drizzle-kit silently skipping
 * migration 0109 (journal timestamp ordering bug).
 *
 * Idempotent — `ADD VALUE IF NOT EXISTS` is safe to re-run.
 *
 * Usage: `node --env-file=.env.local --import tsx scripts/apply-f8-enum-values.ts`
 */
process.loadEnvFile?.('.env.local');

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

const VALUES = [
  'renewal_cycle_created',
  'renewal_cycle_price_frozen',
  'renewal_self_service_initiated',
  'renewal_invoice_created',
  'renewal_with_plan_change',
  'renewal_payment_failed',
  'renewal_completed',
  'renewal_completed_post_lapse',
  'renewal_token_invalid',
  'renewal_kill_switch_blocked',
  'renewal_cross_member_probe',
  'lapsed_member_action_blocked',
  'lapsed_member_admin_reactivated',
  'lapsed_member_admin_reactivation_rejected',
  'lapsed_member_admin_reactivation_timed_out',
  'member_auto_reactivation_blocked',
  'member_auto_reactivation_unblocked',
  'renewal_token_clicked_on_completed_cycle',
  'lapsed_member_admin_reactivation_reminder_t-7',
  'lapsed_member_admin_reactivation_reminder_t-3',
  'lapsed_member_admin_reactivation_reminder_t-1',
];

async function main() {
  for (const v of VALUES) {
    // ALTER TYPE … ADD VALUE cannot run inside a transaction in
    // Postgres (the SQL spec requires it as a top-level statement).
    // postgres-js wraps each `db.execute(sql)` in its own
    // single-statement frame so this works.
    await db.execute(
      sql.raw(`ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS '${v}'`),
    );
    console.log(`✓ ${v}`);
  }
  console.log('\nAll 21 enum values applied.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
