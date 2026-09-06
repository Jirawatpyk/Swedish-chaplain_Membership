/**
 * env.ts — `FEATURE_CONTACT_MARKETING_RECIPIENTS` wiring (108 PR-C, T072).
 *
 * Temporary cutover flag for the 1:N marketing audience (research R10, plan
 * § Complexity Tracking #2). When ON, the broadcasts composition root maps it
 * to `ResolveSegmentDeps.audienceMode = 'all_contacts'`; when OFF (the
 * default) the resolver keeps the `primary_only` leg, so a flag-off is the
 * rollback for the audience WIDENING (FR-045; quickstart § Rollback matrix).
 * Read in exactly one place (`broadcasts-deps.ts`), never in Domain or
 * Application. Deleted together with that leg after one clean week of sends
 * (T099). Verifies:
 *   - the flag defaults FALSE when unset (ships dark),
 *   - `"true"` / `"false"` coerce as the shared `booleanFromString` helper does.
 *
 * Pattern matches `env-plan-change-immediate-refreeze.test.ts`: stub env,
 * fresh module load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  KV_REST_API_URL: 'https://kv.example.com',
  KV_REST_API_TOKEN: 'kv-token-with-enough-length',
  RESEND_API_KEY: 're_0000000000',
  RESEND_WEBHOOK_SIGNING_SECRET: 'whsigningsecret',
  AUTH_COOKIE_SIGNING_SECRET: 'a'.repeat(48),
  APP_BASE_URL: 'http://localhost:3100',
  APP_ALLOWED_ORIGINS: 'http://localhost:3100',
  TENANT_SLUG: 'swecham',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_public_store',
  CRON_SECRET: 'cron-secret-with-enough-length',
  STRIPE_SECRET_KEY: 'sk_test_0000000000',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_0000000000',
  STRIPE_WEBHOOK_SECRET: 'whsec_0000000000',
  STRIPE_API_VERSION: '2025-09-30.clover',
  STRIPE_ACCOUNT_ID_SWECHAM: 'acct_TEST0000',
  STRIPE_LIVE_MODE: 'false',
  FEATURE_F5_ONLINE_PAYMENT: 'false',
};

function stubEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      // Stub to `undefined` so vitest deletes the key — leaving a real
      // .env.local value (loaded by tests/setup.ts) would defeat the test.
      vi.stubEnv(k, undefined);
      continue;
    }
    vi.stubEnv(k, v);
  }
}

describe('env.ts — FEATURE_CONTACT_MARKETING_RECIPIENTS (108 PR-C)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults FALSE when the var is unset (ships dark — the primary_only leg)', async () => {
    stubEnv({ FEATURE_CONTACT_MARKETING_RECIPIENTS: undefined });
    const mod = await import('@/lib/env');
    expect(mod.env.features.contactMarketingRecipients).toBe(false);
  });

  it('coerces the string "true" to boolean true (the all_contacts leg)', async () => {
    stubEnv({ FEATURE_CONTACT_MARKETING_RECIPIENTS: 'true' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.contactMarketingRecipients).toBe(true);
  });

  it('coerces the string "false" to boolean false', async () => {
    stubEnv({ FEATURE_CONTACT_MARKETING_RECIPIENTS: 'false' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.contactMarketingRecipients).toBe(false);
  });
});
