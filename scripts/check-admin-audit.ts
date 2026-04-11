import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'jirawat.p@eqho.com';
  const result = await db.execute(
    sql`SELECT al.timestamp, al.event_type, al.summary, al.source_ip, al.request_id
        FROM audit_log al
        JOIN users u ON u.id::text = al.actor_user_id
        WHERE lower(u.email) = lower(${email})
          AND al.event_type IN ('password_changed', 'password_reset_completed', 'sign_in_success', 'sign_in_failure')
        ORDER BY al.timestamp DESC
        LIMIT 20`,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  console.log(`audit trail for ${email} (latest 15):`);
  console.log(JSON.stringify(rows, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
