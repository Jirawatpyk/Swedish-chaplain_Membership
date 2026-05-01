/**
 * env.ts — `TENANT_TIMEZONE` IANA-validation regression test.
 *
 * Boot-time guard: a typo / unknown IANA id MUST refuse to start the
 * app rather than silently render quota dates in UTC. The validator
 * uses `Intl.DateTimeFormat({ timeZone })` which throws RangeError on
 * unknown ids; zod surfaces it as a parse error.
 *
 * Pattern matches `env-stripe.test.ts`: stub the env, force a fresh
 * module load via `vi.resetModules`, then assert the import resolves
 * (happy path) or rejects (invalid id).
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

describe('env.ts — TENANT_TIMEZONE IANA validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['Asia/Bangkok', 'Europe/Stockholm', 'UTC', 'America/New_York'])(
    'valid IANA id %s loads the module',
    async (tz) => {
      stubEnv({ TENANT_TIMEZONE: tz });
      const mod = await import('@/lib/env');
      expect(mod.env.tenant.timezone).toBe(tz);
    },
  );

  it.each(['Foo/Bar', 'Asia/Bankgok', 'NotAZone', 'random-string'])(
    'invalid IANA id %s refuses to load (boot-fail-fast)',
    async (tz) => {
      stubEnv({ TENANT_TIMEZONE: tz });
      await expect(import('@/lib/env')).rejects.toThrow(/IANA/);
    },
  );
});
