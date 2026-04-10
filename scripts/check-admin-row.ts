import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'jirawat.p@eqho.com';
  const result = await db.execute(
    sql`SELECT
      id,
      email,
      role,
      status,
      (password_hash IS NOT NULL) AS has_password_hash,
      length(password_hash) AS hash_length,
      substring(password_hash, 1, 12) AS hash_prefix,
      created_at,
      last_sign_in_at,
      last_password_changed_at,
      failed_signin_count,
      locked_until
    FROM users
    WHERE lower(email) = lower(${email})`,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  console.log(`query: ${email}`);
  console.log(JSON.stringify(rows, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
