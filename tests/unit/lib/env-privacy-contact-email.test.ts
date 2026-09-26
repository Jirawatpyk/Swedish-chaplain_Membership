/**
 * env.ts — `TENANT_PRIVACY_CONTACT_EMAIL` (E-Blast PDPA/GDPR condition).
 *
 * The public unsubscribe page names this inbox as the free manual-removal
 * route, so it must be a person-read inbox, rendered as a bare `mailto:`
 * address — never the display-name sending address `BROADCASTS_FROM_EMAIL`.
 * Pattern matches `env-blob-private-token.test.ts`: stub env, fresh load.
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
    if (v === undefined) continue; // leave unset (do not stub to '')
    vi.stubEnv(k, v);
  }
}

describe('env.ts — TENANT_PRIVACY_CONTACT_EMAIL', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes the configured bare address', async () => {
    stubEnv({ TENANT_PRIVACY_CONTACT_EMAIL: 'privacy@swecham.com' });
    const mod = await import('@/lib/env');
    expect(mod.env.broadcasts.privacyContactEmail).toBe('privacy@swecham.com');
  });

  it('rejects the display-name form (it is rendered as mailto: text)', async () => {
    stubEnv({ TENANT_PRIVACY_CONTACT_EMAIL: 'Chamber <privacy@swecham.com>' });
    await expect(import('@/lib/env')).rejects.toThrow(/TENANT_PRIVACY_CONTACT_EMAIL/);
  });

  it('rejects reserved TLDs', async () => {
    stubEnv({ TENANT_PRIVACY_CONTACT_EMAIL: 'privacy@chamber.example' });
    await expect(import('@/lib/env')).rejects.toThrow(/TENANT_PRIVACY_CONTACT_EMAIL/);
  });

  it('outside production, falls back to the BARE part of the sending address', async () => {
    stubEnv({ BROADCASTS_FROM_EMAIL: 'Chamber <broadcasts@swecham.com>' });
    vi.stubEnv('TENANT_PRIVACY_CONTACT_EMAIL', undefined);
    const mod = await import('@/lib/env');
    expect(mod.env.broadcasts.privacyContactEmail).toBe('broadcasts@swecham.com');
  });

  it('production with F7 on refuses to boot without it', async () => {
    stubEnv({ NODE_ENV: 'production', FEATURE_F7_BROADCASTS: 'true', FEATURE_F6_EVENTCREATE: 'false' });
    vi.stubEnv('TENANT_PRIVACY_CONTACT_EMAIL', undefined);
    await expect(import('@/lib/env')).rejects.toThrow(/TENANT_PRIVACY_CONTACT_EMAIL must be set/);
  });

  // Every unsubscribe state and the E-Blast banner link the privacy notice
  // (GDPR Art. 13/14). In production with F7 on it must exist, over https.
  it('production with F7 on refuses to boot without TENANT_PRIVACY_POLICY_URL', async () => {
    stubEnv({
      NODE_ENV: 'production',
      FEATURE_F7_BROADCASTS: 'true',
      FEATURE_F6_EVENTCREATE: 'false',
      TENANT_PRIVACY_CONTACT_EMAIL: 'privacy@swecham.com',
    });
    vi.stubEnv('TENANT_PRIVACY_POLICY_URL', undefined);
    await expect(import('@/lib/env')).rejects.toThrow(/TENANT_PRIVACY_POLICY_URL must be set/);
  });

  it('production with F7 on refuses a non-https privacy policy URL', async () => {
    stubEnv({
      NODE_ENV: 'production',
      FEATURE_F7_BROADCASTS: 'true',
      FEATURE_F6_EVENTCREATE: 'false',
      TENANT_PRIVACY_CONTACT_EMAIL: 'privacy@swecham.com',
      TENANT_PRIVACY_POLICY_URL: 'http://swecham.com/privacy',
    });
    await expect(import('@/lib/env')).rejects.toThrow(/TENANT_PRIVACY_POLICY_URL must be set to an https:\/\/ URL/);
  });
});

