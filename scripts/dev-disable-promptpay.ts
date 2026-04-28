/**
 * DEV-ONLY — temporarily remove `promptpay` from enabled_methods so the
 * PromptPay tab disappears in the UI. Use when the Stripe test account
 * has not yet activated PromptPay (Stripe rejects createPaymentIntent
 * with `parameter_missing`) and the broken tab is triggering
 * cross-method cancel cycles on every click.
 *
 * Reversal: re-enable PromptPay in Stripe Dashboard, then run
 *   pnpm tsx --env-file=.env.local scripts/dev-disable-promptpay.ts --enable
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const enable = process.argv.includes('--enable');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const lower = url.toLowerCase();
  if (
    process.env.NODE_ENV === 'production' ||
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.') ||
    lower.includes('-live') ||
    lower.includes('.live.')
  ) {
    throw new Error('REFUSED: production-looking DATABASE_URL.');
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  // `enabled_methods` is a PostgreSQL `text[]` (NOT jsonb) — use array
  // literal syntax. Safe constant string, no user input.
  const next = enable ? `ARRAY['card','promptpay']::text[]` : `ARRAY['card']::text[]`;
  const result = await db.execute(sql.raw(`
    UPDATE tenant_payment_settings
    SET enabled_methods = ${next}
    WHERE tenant_id = 'swecham'
    RETURNING tenant_id, enabled_methods
  `));
  console.log(
    `✓ ${enable ? 'enabled' : 'disabled'} promptpay for swecham:`,
    JSON.stringify(result, null, 2),
  );
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
