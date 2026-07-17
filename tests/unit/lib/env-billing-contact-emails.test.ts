/**
 * env.ts — `BILLING_CONTACT_EMAILS` wiring.
 *
 * The invoice-detail "online payment unavailable" card (OnlinePaymentDisabledCard)
 * reads `env.billingContactEmails` for its `mailto:` recipients. This var is a
 * comma-separated, multi-recipient list, DECOUPLED from BOOTSTRAP_ADMIN_EMAIL
 * (an admin-account identity). Verifies:
 *   - a set list is split/trimmed/validated into a string[],
 *   - an unset var falls back to [SUPPORT_EMAIL] (always non-empty),
 *   - a malformed entry fails the boot (fail-fast contract).
 *
 * Pattern matches `env-blob-private-token.test.ts`: stub env, fresh module load.
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

describe('env.ts — BILLING_CONTACT_EMAILS', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('splits + trims a comma-separated list into a string[]', async () => {
    stubEnv({ BILLING_CONTACT_EMAILS: 'secretary@swecham.com, finance@swecham.com ' });
    const mod = await import('@/lib/env');
    expect(mod.env.billingContactEmails).toEqual([
      'secretary@swecham.com',
      'finance@swecham.com',
    ]);
  });

  it('accepts a single address', async () => {
    stubEnv({ BILLING_CONTACT_EMAILS: 'secretary@swecham.com' });
    const mod = await import('@/lib/env');
    expect(mod.env.billingContactEmails).toEqual(['secretary@swecham.com']);
  });

  it('falls back to [SUPPORT_EMAIL] when unset (always non-empty)', async () => {
    stubEnv({ BILLING_CONTACT_EMAILS: undefined, SUPPORT_EMAIL: 'help@swecham.se' });
    const mod = await import('@/lib/env');
    expect(mod.env.billingContactEmails).toEqual(['help@swecham.se']);
  });

  it('is DECOUPLED from BOOTSTRAP_ADMIN_EMAIL (bootstrap identity is not the contact)', async () => {
    stubEnv({
      BILLING_CONTACT_EMAILS: undefined,
      SUPPORT_EMAIL: 'help@swecham.se',
      BOOTSTRAP_ADMIN_EMAIL: 'admin-identity@swecham.com',
    });
    const mod = await import('@/lib/env');
    expect(mod.env.billingContactEmails).toEqual(['help@swecham.se']);
    expect(mod.env.billingContactEmails).not.toContain('admin-identity@swecham.com');
  });

  it('fails the boot when any entry is not a valid email', async () => {
    stubEnv({ BILLING_CONTACT_EMAILS: 'secretary@swecham.com, not-an-email' });
    await expect(import('@/lib/env')).rejects.toThrow();
  });
});
