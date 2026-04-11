/**
 * One-off sanity check after bootstrap: verify the admin row exists +
 * the audit event was emitted. Handy to run once, not part of the
 * normal workflow.
 */
process.loadEnvFile?.('.env.local');

import postgres from 'postgres';

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL;
  if (!url) {
    console.error('verify-admin: DATABASE_URL is required');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, ssl: 'require' });

  try {
    const admins = await sql<
      { id: string; email: string; role: string; status: string; created_at: Date }[]
    >`
      SELECT id, email, role, status, created_at
      FROM users
      WHERE role = 'admin'
      ORDER BY created_at
    `;
    console.log('Admins:');
    for (const row of admins) {
      console.log(
        `  ${row.id.slice(0, 8)}…  ${row.email}  role=${row.role}  status=${row.status}  created=${row.created_at.toISOString()}`,
      );
    }

    const bootstrapEvents = await sql<
      { id: string; event_type: string; actor_user_id: string; summary: string; timestamp: Date }[]
    >`
      SELECT id, event_type, actor_user_id, summary, timestamp
      FROM audit_log
      WHERE actor_user_id = 'system:bootstrap'
      ORDER BY timestamp
    `;
    console.log('\nBootstrap audit events:');
    for (const row of bootstrapEvents) {
      console.log(
        `  ${row.timestamp.toISOString()}  ${row.event_type}  ${row.summary}`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('verify-admin: crashed:', error);
  process.exit(1);
});
