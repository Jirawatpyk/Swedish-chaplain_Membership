/**
 * Idempotent re-seed of the reserved SYSTEM-ACTOR users.
 *
 * These are the non-human `actor_user_id` rows that webhook + cron writes
 * point at. They live in the reserved `00000000-0000-0000-0000-0000000f50xx`
 * UUID namespace and are seeded by migrations 0041 (Stripe) + 0181 (Resend).
 *
 * WHY THIS SCRIPT EXISTS — run it after ANY prod data wipe:
 *   `payments.actor_user_id`, `refunds.initiator_user_id`,
 *   `audit_log.actor_user_id`, ... are `uuid REFERENCES users(id)`. A wipe
 *   that deletes users (keeping only human admins) removes these system
 *   rows. Then EVERY Stripe/Resend webhook insert hits an FK violation →
 *   PostgresError → the webhook dispatch throws → 500 → online payments
 *   silently fail (customer charged, invoice never marked paid, no receipt).
 *   This actually happened after the 2026-06-24 prod wipe (2026-07-06
 *   incident: pi_3Tq5… charged but stuck pending). Migrations 0041/0181 run
 *   ONCE, so a post-wipe redeploy does NOT restore them — this script does.
 *
 * Safe to run repeatedly (ON CONFLICT DO NOTHING). Exits non-zero if, after
 * seeding, any actor is still missing (so it can gate a post-wipe checklist).
 *
 * Run: node --env-file=.env.production --import tsx scripts/seed-system-actors.ts
 *      (or --env-file=.env.local for the dev branch)
 */
import postgres from 'postgres';

// Mirror of migrations 0041 + 0181. Keep in sync with
// `src/modules/payments/domain/system-actors.ts` (SYSTEM_ACTOR_STRIPE_WEBHOOK).
const SYSTEM_ACTORS = [
  {
    id: '00000000-0000-0000-0000-0000000f5001',
    email: 'system-stripe-webhook@chamber-os.internal',
    displayName: 'System (Stripe Webhook)',
  },
  {
    id: '00000000-0000-0000-0000-0000000f5002',
    email: 'system-resend-webhook@chamber-os.internal',
    displayName: 'System (Resend Webhook)',
  },
] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('DATABASE_URL required (use --env-file=.env.production).');
    process.exit(1);
  }
  console.log(`DB host: ${url.match(/@([^/:?]+)/)?.[1] ?? 'UNKNOWN'}`);
  const sql = postgres(url, { max: 1, prepare: false });
  let missing = 0;
  try {
    for (const a of SYSTEM_ACTORS) {
      const r = await sql`
        INSERT INTO users
          (id, email, role, status, password_hash, display_name, created_at, failed_signin_count)
        VALUES
          (${a.id}, ${a.email}, 'admin', 'disabled', NULL, ${a.displayName}, now(), 0)
        ON CONFLICT (id) DO NOTHING`;
      console.log(`  ${a.email}: ${r.count === 1 ? '⚠ INSERTED (was MISSING)' : '✓ already present'}`);
    }
    const present = await sql`
      SELECT id FROM users WHERE id = ANY(${SYSTEM_ACTORS.map((a) => a.id)})`;
    missing = SYSTEM_ACTORS.length - present.length;
    console.log(
      missing === 0
        ? `✓ all ${SYSTEM_ACTORS.length} system actors present — webhooks can write actor_user_id`
        : `✗ ${missing} still MISSING after seed — investigate`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(missing === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
