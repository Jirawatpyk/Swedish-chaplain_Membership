/**
 * T082 — Idempotent seeder for the F5 `tenant_payment_settings` row
 * required by the 74 fixme'd pay-sheet E2E tests.
 *
 * The Pay-now flow refuses to initiate unless the tenant has:
 *   - `online_payment_enabled = true`
 *   - at least one enabled method
 *   - a publishable key (surfaced to the browser via initiateResponse)
 *
 * This script UPSERTs a FIXTURE row for the E2E tenant (`swecham`)
 * with Stripe test-mode stub keys. Real Stripe calls are `page.route()`-
 * stubbed inside the pay-sheet specs themselves — the keys here only
 * have to satisfy `src/lib/env.ts` + the Domain validator; they are
 * never sent to Stripe.
 *
 * The script runs with the `neondb_owner` pooled connection (same
 * pattern as every other `scripts/seed-*.ts`), which bypasses RLS for
 * table-setup writes. This is consistent with:
 *   - scripts/seed-f4-invoice-settings.ts (F4 tenant_invoice_settings)
 *   - scripts/seed-swecham-2026-plans.ts (plans seed)
 * both of which use `db` directly without `runInTenant`.
 *
 * Usage:
 *   pnpm seed:f5-e2e
 *   # or:
 *   node --env-file=.env.local --import tsx scripts/seed-f5-e2e-payment-settings.ts
 *
 * Guard: refuses to run against any tenant slug other than `swecham`.
 * Guard: refuses to run with a live-mode Stripe secret key in the
 *        environment — this script is test-fixture-only.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tenantPaymentSettings } from '@/modules/payments/infrastructure/schema';

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';

// Read from env so the seeded row matches what the runtime (env.ts +
// stripe client) will actually present to Stripe. This keeps the
// webhook tenant-resolver (`findByProcessorAccountId`) aligned with
// the `stripeAccount` option the app sends on every SDK call.
//
// Defaults are stub fixtures for the case where the operator has no
// real Stripe account linked yet — the pay-sheet E2E specs stub
// `/api/payments/initiate` via page.route() so real Stripe calls are
// never made in those tests, making fixture keys acceptable there.
const FIXTURE_ACCOUNT_ID =
  process.env.STRIPE_ACCOUNT_ID_SWECHAM ?? 'acct_test_e2e_fixture';
const FIXTURE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? 'pk_test_e2e_fixture';

function requireSwecham(): void {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-f5-e2e-payment-settings: refusing to run against TENANT_SLUG="${TENANT_SLUG}". ` +
        `Only 'swecham' is allowed (tenant-scoped fixture).`,
    );
  }
}

function refuseLiveMode(): void {
  if (process.env.STRIPE_LIVE_MODE === 'true') {
    throw new Error(
      'seed-f5-e2e-payment-settings: refusing to run with STRIPE_LIVE_MODE=true. ' +
        'This seeder writes fixture stub keys and must never collide with a live-mode deploy.',
    );
  }
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (key.startsWith('sk_live_')) {
    throw new Error(
      'seed-f5-e2e-payment-settings: STRIPE_SECRET_KEY is a live-mode key. ' +
        'This script is for E2E fixtures only — switch to an sk_test_ key before running.',
    );
  }
}

async function main(): Promise<void> {
  requireSwecham();
  refuseLiveMode();

  console.log(`seeding F5 tenant_payment_settings for tenant=${TENANT_SLUG}…`);

  // UPSERT — idempotent across re-runs. Tenant PK, so ON CONFLICT
  // targets the tenant_id. Bypasses RLS (neondb_owner connection);
  // consistent with other seed-*.ts scripts.
  await db
    .insert(tenantPaymentSettings)
    .values({
      tenantId: TENANT_SLUG,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: FIXTURE_ACCOUNT_ID,
      processorPublishableKey: FIXTURE_PUBLISHABLE_KEY,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    })
    .onConflictDoUpdate({
      target: tenantPaymentSettings.tenantId,
      set: {
        processor: 'stripe',
        processorEnvironment: 'test',
        processorAccountId: FIXTURE_ACCOUNT_ID,
        processorPublishableKey: FIXTURE_PUBLISHABLE_KEY,
        enabledMethods: ['card', 'promptpay'],
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
        updatedAt: sql`now()`,
      },
    });

  console.log('  upserted tenant_payment_settings row:');
  console.log(`    processor=stripe env=test account=${FIXTURE_ACCOUNT_ID}`);
  console.log(`    enabled_methods=['card','promptpay'] online=true auto_email=true`);
  console.log('\n----------------------------------------');
  console.log('Ensure in .env.local:');
  console.log(`  FEATURE_F5_ONLINE_PAYMENT=true`);
  console.log(`  STRIPE_SECRET_KEY=sk_test_e2e_fixture`);
  console.log(`  STRIPE_PUBLISHABLE_KEY=pk_test_e2e_fixture`);
  console.log(`  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_e2e_fixture`);
  console.log(`  STRIPE_WEBHOOK_SECRET=whsec_e2e_fixture`);
  console.log(`  STRIPE_API_VERSION=2024-06-20`);
  console.log(`  STRIPE_ACCOUNT_ID_SWECHAM=${FIXTURE_ACCOUNT_ID}`);
  console.log(`  STRIPE_LIVE_MODE=false`);
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
