import postgres from 'postgres';
process.loadEnvFile?.('.env.local');
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!;
const sql = postgres(url, { max: 1, ssl: 'require' });
async function main() {
  const email = 'smoketest-20260418@swecham.test';
  const users = await sql`
    SELECT id, email, role, status, email_verified, display_name, password_hash IS NOT NULL AS has_password, last_sign_in_at
    FROM users WHERE email = ${email} LIMIT 1`;
  console.log('=== USER (post-redeem) ===');
  console.log(JSON.stringify(users[0], null, 2));

  const invitations = await sql`
    SELECT id, consumed_at, intended_role
    FROM invitations
    WHERE user_id = ${(users[0] as { id: string }).id}
    ORDER BY created_at DESC LIMIT 1`;
  console.log('\n=== INVITATION ===');
  console.log(JSON.stringify(invitations[0], null, 2));

  const sessions = await sql`
    SELECT id, user_id, created_at, expires_at
    FROM sessions
    WHERE user_id = ${(users[0] as { id: string }).id}
    ORDER BY created_at DESC LIMIT 1`;
  console.log('\n=== SESSION (after redeem) ===');
  console.log(JSON.stringify(sessions[0] ?? null, null, 2));

  const audit = await sql`
    SELECT event_type, summary, request_id, created_at
    FROM audit_log
    WHERE target_user_id = ${(users[0] as { id: string }).id}
    ORDER BY created_at DESC LIMIT 5`;
  console.log('\n=== AUDIT TRAIL ===');
  for (const r of audit) console.log('  ', (r as { event_type: string }).event_type, '—', (r as { summary: string }).summary);

  await sql.end();
}
main().catch(console.error);
