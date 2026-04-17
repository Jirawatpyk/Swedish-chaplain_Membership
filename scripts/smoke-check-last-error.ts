import postgres from 'postgres';
process.loadEnvFile?.('.env.local');
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!;
const sql = postgres(url, { max: 1, ssl: 'require' });
async function main() {
  const rows = await sql`SELECT last_error, attempts, next_retry_at FROM notifications_outbox WHERE to_email = 'smoketest-20260418@swecham.test' ORDER BY created_at DESC LIMIT 1`;
  console.log(JSON.stringify(rows[0], null, 2));
  await sql.end();
}
main();
