/**
 * env.ts — `BLOB_PRIVATE_READ_WRITE_TOKEN` wiring (F9 T101a).
 *
 * A Vercel Blob store is public XOR private. F9 export artefacts need a
 * dedicated PRIVATE store (`private-blob-adapter.ts` does `put({access:'private'})`),
 * separate from the PUBLIC store that backs F4 invoice PDFs + F9 logos. This
 * verifies the env exposes `env.blob.privateReadWriteToken` which:
 *   - uses BLOB_PRIVATE_READ_WRITE_TOKEN when set (ship-day private store), and
 *   - falls back to BLOB_READ_WRITE_TOKEN when unset (dev/test/dark-launch),
 * while `env.blob.readWriteToken` (public store) is always the public token.
 *
 * Pattern matches `env-tenant-timezone.test.ts`: stub env, fresh module load.
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

describe('env.ts — BLOB_PRIVATE_READ_WRITE_TOKEN (F9 T101a)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the dedicated private token when BLOB_PRIVATE_READ_WRITE_TOKEN is set', async () => {
    stubEnv({ BLOB_PRIVATE_READ_WRITE_TOKEN: 'vercel_blob_rw_private_store' });
    const mod = await import('@/lib/env');
    expect(mod.env.blob.privateReadWriteToken).toBe('vercel_blob_rw_private_store');
    // The public store token is unchanged (F4 PDFs + F9 logos stay public).
    expect(mod.env.blob.readWriteToken).toBe('vercel_blob_rw_public_store');
  });

  it('falls back to the public token when BLOB_PRIVATE_READ_WRITE_TOKEN is unset (dark-launch)', async () => {
    stubEnv({});
    // Test isolation: tests/setup.ts loads .env.local before tests run, which on
    // a developer machine may set a real BLOB_PRIVATE_READ_WRITE_TOKEN. The
    // stubEnv helper above only stubs keys it knows about, so without this the
    // env.local value survives and `?? raw.BLOB_READ_WRITE_TOKEN` never engages.
    // Stub to `undefined` (NOT '') so vitest `delete`s the key — an empty string
    // would fail the `.min(10)` schema rule and throw at boot.
    vi.stubEnv('BLOB_PRIVATE_READ_WRITE_TOKEN', undefined);
    const mod = await import('@/lib/env');
    expect(mod.env.blob.privateReadWriteToken).toBe('vercel_blob_rw_public_store');
    expect(mod.env.blob.readWriteToken).toBe('vercel_blob_rw_public_store');
  });

  it('rejects a too-short private token (≥10 chars) at boot', async () => {
    stubEnv({ BLOB_PRIVATE_READ_WRITE_TOKEN: 'short' });
    await expect(import('@/lib/env')).rejects.toThrow();
  });

  it('F9 #8: production + F9 enabled + no private blob token → fail-loud at boot', async () => {
    stubEnv({
      NODE_ENV: 'production',
      FEATURE_F9_DASHBOARD: 'true',
      // Isolate from the unrelated F6-DPA prod guard.
      FEATURE_F6_EVENTCREATE: 'false',
      EXPORT_DOWNLOAD_TOKEN_SECRET: 'e'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
    });
    // No private store provisioned + ensure the other prod-only guards stay quiet.
    vi.stubEnv('BLOB_PRIVATE_READ_WRITE_TOKEN', undefined);
    vi.stubEnv('DEBUG_RLS_STATE', undefined);
    vi.stubEnv('E2E_X_TENANT_HEADER_ENABLED', undefined);
    await expect(import('@/lib/env')).rejects.toThrow(/BLOB_PRIVATE_READ_WRITE_TOKEN/);
  });

  it('F9 review: production + F9 enabled + private token EQUAL to the public token → fail-loud', async () => {
    const sameToken = 'vercel_blob_rw_shared_store';
    stubEnv({
      NODE_ENV: 'production',
      FEATURE_F9_DASHBOARD: 'true',
      FEATURE_F6_EVENTCREATE: 'false',
      EXPORT_DOWNLOAD_TOKEN_SECRET: 'e'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
      BLOB_READ_WRITE_TOKEN: sameToken,
      BLOB_PRIVATE_READ_WRITE_TOKEN: sameToken,
    });
    vi.stubEnv('DEBUG_RLS_STATE', undefined);
    vi.stubEnv('E2E_X_TENANT_HEADER_ENABLED', undefined);
    await expect(import('@/lib/env')).rejects.toThrow(/BLOB_PRIVATE_READ_WRITE_TOKEN/);
  });

  it('F9 #8: production + F9 enabled + a dedicated private store token → boots clean', async () => {
    stubEnv({
      NODE_ENV: 'production',
      FEATURE_F9_DASHBOARD: 'true',
      FEATURE_F6_EVENTCREATE: 'false',
      EXPORT_DOWNLOAD_TOKEN_SECRET: 'e'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
      BLOB_PRIVATE_READ_WRITE_TOKEN: 'vercel_blob_rw_private_store',
    });
    vi.stubEnv('DEBUG_RLS_STATE', undefined);
    vi.stubEnv('E2E_X_TENANT_HEADER_ENABLED', undefined);
    const mod = await import('@/lib/env');
    expect(mod.env.blob.privateReadWriteToken).toBe('vercel_blob_rw_private_store');
  });
});

describe('env.ts — EXPORT_DOWNLOAD_TOKEN_SECRET distinctness (F9 #13)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects EXPORT_DOWNLOAD_TOKEN_SECRET that collides with AUTH_COOKIE_SIGNING_SECRET', async () => {
    const shared = 'z'.repeat(48);
    stubEnv({
      FEATURE_F9_DASHBOARD: 'true',
      AUTH_COOKIE_SIGNING_SECRET: shared,
      EXPORT_DOWNLOAD_TOKEN_SECRET: shared,
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
    });
    await expect(import('@/lib/env')).rejects.toThrow(/DISTINCT/);
  });

  it('rejects EXPORT_DOWNLOAD_TOKEN_SECRET that collides with UNSUBSCRIBE_TOKEN_SECRET', async () => {
    const shared = 'q'.repeat(48);
    stubEnv({
      FEATURE_F9_DASHBOARD: 'true',
      AUTH_COOKIE_SIGNING_SECRET: 'a'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: shared,
      EXPORT_DOWNLOAD_TOKEN_SECRET: shared,
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
    });
    await expect(import('@/lib/env')).rejects.toThrow(/DISTINCT/);
  });

  it('rejects EXPORT_DOWNLOAD_TOKEN_SECRET that collides with RENEWAL_LINK_TOKEN_SECRET_PRIMARY', async () => {
    const shared = 'p'.repeat(48);
    stubEnv({
      FEATURE_F9_DASHBOARD: 'true',
      AUTH_COOKIE_SIGNING_SECRET: 'a'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: shared,
      EXPORT_DOWNLOAD_TOKEN_SECRET: shared,
    });
    await expect(import('@/lib/env')).rejects.toThrow(/DISTINCT/);
  });

  it('rejects EXPORT_DOWNLOAD_TOKEN_SECRET that collides with RENEWAL_LINK_TOKEN_SECRET_FALLBACK', async () => {
    const shared = 'f'.repeat(48);
    stubEnv({
      FEATURE_F9_DASHBOARD: 'true',
      AUTH_COOKIE_SIGNING_SECRET: 'a'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_FALLBACK: shared,
      EXPORT_DOWNLOAD_TOKEN_SECRET: shared,
    });
    await expect(import('@/lib/env')).rejects.toThrow(/DISTINCT/);
  });

  it('accepts a distinct EXPORT_DOWNLOAD_TOKEN_SECRET (all secrets unique)', async () => {
    stubEnv({
      FEATURE_F9_DASHBOARD: 'true',
      AUTH_COOKIE_SIGNING_SECRET: 'a'.repeat(48),
      UNSUBSCRIBE_TOKEN_SECRET: 'u'.repeat(48),
      RENEWAL_LINK_TOKEN_SECRET_PRIMARY: 'r'.repeat(48),
      EXPORT_DOWNLOAD_TOKEN_SECRET: 'e'.repeat(48),
      BLOB_PRIVATE_READ_WRITE_TOKEN: 'vercel_blob_rw_private_store',
    });
    await expect(import('@/lib/env')).resolves.toBeDefined();
  });
});
