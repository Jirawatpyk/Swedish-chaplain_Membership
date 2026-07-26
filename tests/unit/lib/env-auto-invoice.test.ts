/**
 * env.ts — `FEATURE_AUTO_INVOICE` wiring (auto-invoice #2, Task 3).
 *
 * Kill-switch for the auto-invoice feature (dark-ship key #1 of 3).
 * Default FALSE — independent of `FEATURE_F8_RENEWALS`; no cross-field
 * guard (it gates no secret). Verifies `env.features.autoInvoice`:
 *   - defaults to false when unset,
 *   - coerces the string 'true' / '1' to true via `booleanFromString`.
 *
 * Pattern matches `env-blob-private-token.test.ts`: stub env, fresh
 * module load via `vi.resetModules` + dynamic `import('@/lib/env')`.
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

describe('env.ts — FEATURE_AUTO_INVOICE', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to false when unset', async () => {
    stubEnv({ FEATURE_AUTO_INVOICE: undefined });
    const mod = await import('@/lib/env');
    expect(mod.env.features.autoInvoice).toBe(false);
  });

  it("coerces the string 'true' to true", async () => {
    stubEnv({ FEATURE_AUTO_INVOICE: 'true' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.autoInvoice).toBe(true);
  });

  it("coerces the string '1' to true", async () => {
    stubEnv({ FEATURE_AUTO_INVOICE: '1' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.autoInvoice).toBe(true);
  });

  it("coerces the string 'false' to false", async () => {
    stubEnv({ FEATURE_AUTO_INVOICE: 'false' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.autoInvoice).toBe(false);
  });

  it('is independent of FEATURE_F8_RENEWALS (no cross-field coupling)', async () => {
    stubEnv({ FEATURE_AUTO_INVOICE: 'true', FEATURE_F8_RENEWALS: 'false' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.autoInvoice).toBe(true);
    expect(mod.env.features.f8Renewals).toBe(false);
  });
});
