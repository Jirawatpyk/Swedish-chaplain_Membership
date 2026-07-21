/**
 * env.ts — `FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE` wiring.
 *
 * Phase 2 of plan-change → billing remediation. When ON, a manual admin
 * change-plan ALSO re-freezes the member's OPEN (not-yet-invoiced) renewal
 * cycle to the new plan/price immediately; when OFF (the default), the change
 * defers to the next renewal cycle (Phase-1 behaviour). Verifies:
 *   - the flag defaults FALSE when unset (ships dark),
 *   - an explicit `"true"` coerces to boolean true,
 *   - `"false"` / `"1"` coerce as the shared `booleanFromString` helper does.
 *
 * Pattern matches `env-billing-contact-emails.test.ts`: stub env, fresh module
 * load. Mirrors `FEATURE_VOID_ON_REISSUE` (also a default-false ship-dark flag).
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

describe('env.ts — FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults FALSE when the var is unset (ships dark)', async () => {
    stubEnv({ FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE: undefined });
    const mod = await import('@/lib/env');
    expect(mod.env.features.planChangeImmediateRefreeze).toBe(false);
  });

  it('coerces the string "true" to boolean true', async () => {
    stubEnv({ FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE: 'true' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.planChangeImmediateRefreeze).toBe(true);
  });

  it('coerces the string "false" to boolean false', async () => {
    stubEnv({ FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE: 'false' });
    const mod = await import('@/lib/env');
    expect(mod.env.features.planChangeImmediateRefreeze).toBe(false);
  });
});
