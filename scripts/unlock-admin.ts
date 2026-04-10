/**
 * Emergency unlock script for the bootstrap admin.
 *
 * Clears `locked_until` and `failed_signin_count` on an admin user
 * whose email matches `$BOOTSTRAP_ADMIN_EMAIL` (or a single CLI arg).
 * Used during E2E test runs where repeated failed sign-ins have
 * tripped the 5-per-15-min lockout.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/unlock-admin.ts
 *   node --env-file=.env.local --import tsx scripts/unlock-admin.ts admin@example.com
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

async function main(): Promise<void> {
  const email = process.argv[2] ?? process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email) {
    console.error(
      'usage: unlock-admin.ts <email>  (or set BOOTSTRAP_ADMIN_EMAIL)',
    );
    process.exit(1);
  }

  const result = await db.execute(
    sql`UPDATE users
        SET locked_until = NULL, failed_signin_count = 0
        WHERE email = ${email}
        RETURNING id, email, status, locked_until, failed_signin_count`,
  );

  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  console.log(`unlocked ${Array.isArray(rows) ? rows.length : 0} row(s):`);
  console.log(JSON.stringify(rows, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
