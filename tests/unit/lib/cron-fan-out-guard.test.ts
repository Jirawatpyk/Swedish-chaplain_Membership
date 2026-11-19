/**
 * #97 — a renewals coordinator fans out with
 * `fetch(\`${APP_BASE_URL}/api/cron/renewals/<x>/<tenant>\`)`. Relay R162
 * fired one on :3400 while `.env.local` pointed `APP_BASE_URL` at prod, and
 * the per-tenant runs executed on prod. Outside production the coordinator
 * must only fan out to its own origin.
 */
import { describe, expect, it } from 'vitest';
import { checkFanOutOrigin } from '@/lib/cron-fan-out-guard';

const REQ = 'http://localhost:3400/api/cron/renewals/dispatch-coordinator';

describe('checkFanOutOrigin', () => {
  it('allows any target in production (Vercel Cron calls the deployment host, APP_BASE_URL is the custom domain)', () => {
    expect(
      checkFanOutOrigin({ baseUrl: 'https://swecham.example', requestUrl: 'https://x.vercel.app/a', vercelEnv: 'production' }).ok,
    ).toBe(true);
  });

  it('allows the same origin outside production', () => {
    expect(checkFanOutOrigin({ baseUrl: 'http://localhost:3400', requestUrl: REQ, vercelEnv: undefined }).ok).toBe(true);
    expect(checkFanOutOrigin({ baseUrl: 'http://localhost:3400/', requestUrl: REQ, vercelEnv: 'preview' }).ok).toBe(true);
  });

  it('refuses another host outside production, naming both origins', () => {
    const r = checkFanOutOrigin({ baseUrl: 'https://swecham.example', requestUrl: REQ, vercelEnv: undefined });
    expect(r).toEqual({ ok: false, baseOrigin: 'https://swecham.example', requestOrigin: 'http://localhost:3400' });
  });

  it('refuses another port on the same host', () => {
    expect(checkFanOutOrigin({ baseUrl: 'http://localhost:3100', requestUrl: REQ, vercelEnv: 'development' }).ok).toBe(false);
  });

  it('refuses a malformed base URL', () => {
    expect(checkFanOutOrigin({ baseUrl: 'not a url', requestUrl: REQ, vercelEnv: undefined }).ok).toBe(false);
  });
});
