/**
 * T020 — F4 feature-flag kill-switch test.
 *
 * Verifies `FEATURE_F4_INVOICING=false` causes every invoicing route
 * to return 503 `read_only_mode` via the `src/proxy.ts` guard.
 *
 * Unit-level test against `proxy()` directly (not a full HTTP round-trip)
 * because proxy.ts is pure-ish: given a NextRequest, it returns a
 * NextResponse. The env module is re-imported under vi.resetModules()
 * so the `env.features.f4Invoicing` value picks up the override.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const F4_PATHS = [
  '/api/invoices',
  '/api/invoices/abc-123',
  '/api/credit-notes',
  '/api/tenant-invoice-settings',
  '/api/portal/invoices',
];

// R7-B4 — the outbox dispatcher is a shared cron route that serves
// BOTH F1 and F4 rows. The kill-switch must NOT blanket-block this
// path (that would stop F1 emails too). Instead F4 rows are filtered
// at the query layer inside the route handler when F4 is disabled;
// see `src/app/api/cron/outbox-dispatch/route.ts` and the companion
// integration test `dispatcher-f4-gated.test.ts`. The proxy path is
// asserted as NON-gated here to lock in that contract.
const NON_F4_PATHS = [
  '/api/members',
  '/api/auth/sign-in',
  '/admin',
  '/api/cron/outbox-dispatch',
];

describe('F4 feature-flag kill-switch (T020)', () => {
  const originalFlag = process.env.FEATURE_F4_INVOICING;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.FEATURE_F4_INVOICING = originalFlag;
    vi.resetModules();
  });

  it.each(F4_PATHS)('returns 503 read_only_mode on %s when flag=false', async (path) => {
    process.env.FEATURE_F4_INVOICING = 'false';
    const { proxy } = await import('@/proxy');
    const req = new NextRequest(new URL(`http://localhost:3100${path}`), { method: 'GET' });
    const res = proxy(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('read_only_mode');
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it.each(NON_F4_PATHS)('does NOT gate %s even when flag=false', async (path) => {
    process.env.FEATURE_F4_INVOICING = 'false';
    const { proxy } = await import('@/proxy');
    const req = new NextRequest(new URL(`http://localhost:3100${path}`), { method: 'GET' });
    const res = proxy(req);
    // Non-F4 paths either pass through (200/next) or hit some other
    // guard (csrf / f3 kill-switch) — they MUST NOT return the F4
    // kill-switch 503. The marker is the exact response body.
    if (res.status === 503) {
      const body = await res.json();
      expect(body.message).not.toBe('Invoicing is temporarily unavailable.');
    }
  });

  it.each(F4_PATHS)('allows %s when flag=true', async (path) => {
    process.env.FEATURE_F4_INVOICING = 'true';
    const { proxy } = await import('@/proxy');
    const req = new NextRequest(new URL(`http://localhost:3100${path}`), { method: 'GET' });
    const res = proxy(req);
    // Could be anything EXCEPT the F4 kill-switch 503.
    if (res.status === 503) {
      const body = await res.json();
      expect(body.message).not.toBe('Invoicing is temporarily unavailable.');
    }
  });
});
