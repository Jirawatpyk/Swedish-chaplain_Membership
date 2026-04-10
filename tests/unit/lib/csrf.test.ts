/**
 * CSRF guard unit tests (T041 + Phase 9 QA bugfix).
 *
 * Regression guard for the Phase 9 `/api/webhooks/*` + `/api/cron/*`
 * CSRF exemption — these paths MUST be allowed through without an
 * Origin header because:
 *   - Webhook callers (Resend / Svix) never send Origin.
 *   - Vercel Cron jobs never send Origin.
 *   - Both are authenticated by their own signature / bearer token
 *     mechanisms inside the route handler itself.
 *
 * Without the exemption, every webhook delivery and every cron tick
 * would 403 `csrf-rejected` in production. That was the finding in
 * the Phase 9 QA run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env so APP_ALLOWED_ORIGINS is deterministic
vi.mock('@/lib/env', () => ({
  env: {
    nodeEnv: 'production',
    isProduction: true,
    isDevelopment: false,
    isTest: false,
    database: { url: 'postgres://stub', unpooledUrl: 'postgres://stub' },
    upstash: { url: 'https://stub', token: 'stub' },
    resend: { apiKey: 're_stub', webhookSigningSecret: 'whsec_stub' },
    auth: { cookieSigningSecret: 'a'.repeat(48) },
    app: {
      baseUrl: 'https://swecham.example',
      allowedOrigins: ['https://swecham.example'],
    },
    flags: { readOnlyMode: false },
    bootstrap: { adminEmail: undefined },
    log: { level: 'silent' },
  },
}));

// Dynamic import after mock so the env override takes effect
let checkCsrf: typeof import('@/lib/csrf').checkCsrf;

beforeEach(async () => {
  const mod = await import('@/lib/csrf');
  checkCsrf = mod.checkCsrf;
});

describe('checkCsrf — safe methods and non-API paths pass through', () => {
  it('passes GET regardless of origin', () => {
    expect(checkCsrf('GET', '/api/auth/sign-in', null)).toEqual({
      action: 'pass',
      reason: 'method-safe',
    });
  });

  it('passes HEAD / OPTIONS', () => {
    expect(checkCsrf('HEAD', '/api/auth/sign-in', null).action).toBe('pass');
    expect(checkCsrf('OPTIONS', '/api/auth/sign-in', null).action).toBe('pass');
  });

  it('passes POST on non-API paths', () => {
    expect(checkCsrf('POST', '/admin/sign-in', null)).toEqual({
      action: 'pass',
      reason: 'unprotected-path',
    });
  });
});

describe('checkCsrf — state-changing API paths enforce Origin', () => {
  it('rejects POST /api/auth/* with missing Origin', () => {
    expect(checkCsrf('POST', '/api/auth/sign-in', null)).toEqual({
      action: 'reject',
      reason: 'missing-origin',
    });
  });

  it('rejects POST /api/auth/* with wrong Origin', () => {
    expect(
      checkCsrf('POST', '/api/auth/sign-in', 'https://evil.example'),
    ).toEqual({
      action: 'reject',
      reason: 'origin-not-allowed',
    });
  });

  it('accepts POST /api/auth/* with allowed Origin', () => {
    expect(
      checkCsrf('POST', '/api/auth/sign-in', 'https://swecham.example'),
    ).toEqual({
      action: 'pass',
      reason: 'origin-allowed',
    });
  });
});

describe('checkCsrf — webhook + cron exemption (Phase 9 QA bugfix)', () => {
  it('passes POST /api/webhooks/resend WITHOUT an Origin header', () => {
    // Webhooks authenticate via Svix signature, not Origin
    expect(checkCsrf('POST', '/api/webhooks/resend', null)).toEqual({
      action: 'pass',
      reason: 'exempt-path',
    });
  });

  it('passes POST /api/cron/lockout-cleanup WITHOUT an Origin header', () => {
    // Cron jobs authenticate via Bearer CRON_SECRET, not Origin
    expect(checkCsrf('POST', '/api/cron/lockout-cleanup', null)).toEqual({
      action: 'pass',
      reason: 'exempt-path',
    });
  });

  it('passes POST /api/webhooks/resend even with a hostile Origin', () => {
    // The signature check inside the route handler is the real
    // defence; Origin is not a meaningful signal for server-to-server.
    expect(
      checkCsrf('POST', '/api/webhooks/resend', 'https://evil.example'),
    ).toEqual({
      action: 'pass',
      reason: 'exempt-path',
    });
  });

  it('passes POST on any /api/webhooks/<subpath>', () => {
    // Future webhooks (e.g. /api/webhooks/stripe for F5) also benefit
    expect(checkCsrf('POST', '/api/webhooks/stripe', null).action).toBe('pass');
  });

  it('rejects POST on look-alike path that is NOT under the exempt prefix', () => {
    // e.g. /api/authwebhook would not be protected by prefix match
    // alone — explicit prefix requires the trailing slash
    expect(
      checkCsrf('POST', '/api/authwebhooks/foo', null),
    ).toEqual({
      action: 'reject',
      reason: 'missing-origin',
    });
  });
});
