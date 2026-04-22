import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
try {
  const rows = await sql`
    SELECT status, attempts, last_error, next_retry_at, sent_message_id, notification_type, tenant_id, created_at, updated_at
    FROM notifications_outbox
    WHERE to_email = 'chotikarn.may@gmail.com'
    ORDER BY created_at DESC
    LIMIT 5
  `;
  console.log('=== Rows for chotikarn.may@gmail.com ===');
  console.log(JSON.stringify(rows, null, 2));
  const all = await sql`
    SELECT status, COUNT(*)::int AS n
    FROM notifications_outbox
    WHERE notification_type = 'member_invitation'
    GROUP BY status
  `;
  console.log('=== invitation status counts ===', JSON.stringify(all));
} finally {
  await sql.end();
}
