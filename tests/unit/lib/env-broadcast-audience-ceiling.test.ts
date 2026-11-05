/**
 * env.ts — `BROADCAST_AUDIENCE_CEILING` bounds (spec 140 s4, DR3).
 *
 * The one E-Blast audience ceiling, compared at count, submit and dispatch.
 * Default 900; the zod bound is 1..50,000 (the DB CHECK
 * `broadcasts_estimated_recipient_cap` is the outer bound). A value the schema
 * refuses must refuse boot, never fall back to the default: a typo that
 * silently became 900 would be read as "the ceiling I set".
 *
 * Pattern matches `env-contact-marketing-recipients.test.ts`: stub env, fresh
 * module load.
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

function stubCeiling(value: string | undefined): void {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  // `undefined` makes vitest DELETE the key, so a `.env.local` value (loaded
  // by tests/setup.ts) cannot leak into the "unset" case.
  vi.stubEnv('BROADCAST_AUDIENCE_CEILING', value);
}

describe('env.ts — BROADCAST_AUDIENCE_CEILING (spec 140 s4, DR3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 900 when the var is unset', async () => {
    stubCeiling(undefined);
    const mod = await import('@/lib/env');
    expect(mod.env.broadcasts.audienceCeiling).toBe(900);
  });

  it.each([
    ['1', 1],
    ['50000', 50_000],
  ])('accepts the bound %s', async (raw, expected) => {
    stubCeiling(raw);
    const mod = await import('@/lib/env');
    expect(mod.env.broadcasts.audienceCeiling).toBe(expected);
  });

  // `""` coerces to 0, so it refuses by the lower bound rather than reading
  // as "unset": an empty Vercel value is a mistake, not a request for 900.
  it.each(['0', '50001', ''])('refuses %j at boot', async (raw) => {
    stubCeiling(raw);
    await expect(import('@/lib/env')).rejects.toThrow(/BROADCAST_AUDIENCE_CEILING/);
  });
});
