/**
 * Smoke test DB verification for post-merge F3 smoke test.
 * Queries the just-created user + invitation + outbox row.
 */
import postgres from 'postgres';

process.loadEnvFile?.('.env.local');
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!;
const sql = postgres(url, { max: 1, ssl: 'require' });

const email = process.argv[2] ?? 'smoketest-20260418@swecham.test';

async function main() {
  try {
    const users = await sql<Array<{ id: string; email: string; role: string; status: string; created_at: Date }>>`
      SELECT id, email, role, status, created_at
      FROM users
      WHERE lower(email) = lower(${email})
      ORDER BY created_at DESC
      LIMIT 1
    `;
    console.log('=== USER ===');
    if (users.length === 0) {
      console.log('  ❌ No user row found for', email);
      process.exit(1);
    }
    console.log('  ✓', JSON.stringify(users[0], null, 2));
    const userId = users[0]!.id;

    const invitations = await sql<Array<{ id: string; user_id: string; intended_role: string; created_at: Date; expires_at: Date; consumed_at: Date | null }>>`
      SELECT id, user_id, intended_role, created_at, expires_at, consumed_at
      FROM invitations
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    console.log('\n=== INVITATION ===');
    if (invitations.length === 0) {
      console.log('  ❌ No invitation row');
      process.exit(1);
    }
    console.log('  ✓ id=' + invitations[0]!.id.slice(0, 16) + '...');
    console.log('  ✓ intended_role=' + invitations[0]!.intended_role);
    console.log('  ✓ consumed_at=' + invitations[0]!.consumed_at);

    const outbox = await sql<Array<{ id: string; notification_type: string; to_email: string; status: string; attempts: number; context_data: unknown; created_at: Date; sent_message_id: string | null }>>`
      SELECT id, notification_type, to_email, status, attempts, context_data, created_at, sent_message_id
      FROM notifications_outbox
      WHERE to_email = lower(${email})
      ORDER BY created_at DESC
      LIMIT 1
    `;
    console.log('\n=== OUTBOX ===');
    if (outbox.length === 0) {
      console.log('  ❌ No outbox row');
      process.exit(1);
    }
    const row = outbox[0]!;
    console.log('  ✓ notification_type=' + row.notification_type);
    console.log('  ✓ to_email=' + row.to_email);
    console.log('  ✓ status=' + row.status);
    console.log('  ✓ attempts=' + row.attempts);
    console.log('  ✓ sent_message_id=' + row.sent_message_id);
    console.log('  ✓ context_data=' + JSON.stringify(row.context_data));

    const tokenFromOutbox = (row.context_data as { token?: string }).token;
    const invitationId = invitations[0]!.id;
    console.log('\n=== ATOMICITY CHECK ===');
    if (tokenFromOutbox === invitationId) {
      console.log('  ✓ outbox.context_data.token === invitations.id (Path C atomic commit confirmed)');
    } else {
      console.log('  ❌ Token mismatch!', tokenFromOutbox, '!==', invitationId);
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
