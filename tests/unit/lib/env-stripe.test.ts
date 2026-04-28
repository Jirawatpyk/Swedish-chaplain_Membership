/**
 * I4 fix — cross-field assertions in `src/lib/env.ts` for F5 Stripe +
 * T115t tenant-header test harness. These paths throw at boot, and a
 * PCI SAQ-A regression (live key rollout into staging) MUST fail loud.
 *
 * `src/lib/env.ts` runs zod + cross-field assertions at module load,
 * so each case uses `vi.stubEnv()` (auto-restored on `vi.unstubAllEnvs`
 * after each test — avoids the parallel-runner flake you get from
 * manual `process.env` mutation + savedEnv-at-describe-scope) then
 * `vi.resetModules()` to force a fresh parse.
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
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_xxx',
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
    vi.stubEnv(k, v ?? '');
  }
}

describe('env.ts — F5 cross-field assertions', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('happy path — sk_test_ + STRIPE_LIVE_MODE=false in dev does not throw', async () => {
    stubEnv({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_0000000000', STRIPE_LIVE_MODE: 'false' });
    await expect(import('@/lib/env')).resolves.toBeDefined();
  });

  it('throws when sk_test_ disagrees with STRIPE_LIVE_MODE=true', async () => {
    stubEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_0000000000', STRIPE_LIVE_MODE: 'true' });
    await expect(import('@/lib/env')).rejects.toThrow(/STRIPE_LIVE_MODE.*disagrees/i);
  });

  it('throws when sk_live_ disagrees with STRIPE_LIVE_MODE=false', async () => {
    stubEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_0000000000', STRIPE_LIVE_MODE: 'false' });
    await expect(import('@/lib/env')).rejects.toThrow(/STRIPE_LIVE_MODE.*disagrees/i);
  });

  it('throws when sk_live_ used in non-production', async () => {
    stubEnv({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_live_0000000000', STRIPE_LIVE_MODE: 'true' });
    await expect(import('@/lib/env')).rejects.toThrow(/STRIPE_LIVE_MODE=true.*only allowed when NODE_ENV=production/i);
  });

  it('throws when E2E_X_TENANT_HEADER_ENABLED=true in production', async () => {
    stubEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_0000000000', STRIPE_LIVE_MODE: 'true', E2E_X_TENANT_HEADER_ENABLED: 'true' });
    await expect(import('@/lib/env')).rejects.toThrow(/E2E_X_TENANT_HEADER_ENABLED.*false.*when NODE_ENV=production/i);
  });
});
