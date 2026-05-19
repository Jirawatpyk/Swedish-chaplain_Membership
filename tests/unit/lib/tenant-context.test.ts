/**
 * Unit tests for `resolveTenantFromHeaders` helper (M3 round-2 fix).
 *
 * M1 round-3 verify-finding (2026-05-12): the helper was extracted in
 * round-2 but had zero direct test coverage. These tests pin the
 * 3 happy-path branches + the structural-types invariant.
 *
 * Note: `resolveTenantFromHeaders` flattens `ReadonlyHeaders` into a
 * plain Record then delegates to `resolveTenantFromRequest`. The
 * test-only `X-Tenant` override path is exercised via the existing
 * E2E throwaway-tenant fixtures; here we cover the helper's input-
 * normalisation behaviour and the default fall-through.
 */
import { describe, it, expect } from 'vitest';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';

/**
 * Build a minimal `ReadonlyHeaders`-like object (the structural shape
 * Next.js exposes from `await headers()`). Only `get`, `has`, and
 * `forEach` are needed by `resolveTenantFromHeaders`.
 */
function makeHeaders(
  entries: ReadonlyArray<readonly [string, string]>,
): {
  get(name: string): string | null;
  has(name: string): boolean;
  forEach(cb: (value: string, key: string) => void): void;
} {
  const map = new Map<string, string>(entries.map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (n: string) => map.get(n.toLowerCase()) ?? null,
    has: (n: string) => map.has(n.toLowerCase()),
    forEach: (cb) => {
      for (const [k, v] of map) cb(v, k);
    },
  };
}

describe('resolveTenantFromHeaders', () => {
  it('returns a valid TenantContext from the env default when no X-Tenant header', () => {
    const headers = makeHeaders([['host', 'swecham.zyncdata.app']]);
    const ctx = resolveTenantFromHeaders(headers);
    // Cannot assert specific slug (env.tenant.slug is test-set); only
    // that the return is a brand with a non-empty slug.
    expect(ctx.slug).toBeTruthy();
    expect(typeof ctx.slug).toBe('string');
  });

  it('handles empty headers (no host, no x-tenant)', () => {
    const headers = makeHeaders([]);
    expect(() => resolveTenantFromHeaders(headers)).not.toThrow();
    const ctx = resolveTenantFromHeaders(headers);
    expect(ctx.slug).toBeTruthy();
  });

  it('honours valid X-Tenant header when xHeaderEnabled is true (T115t test-tenant flow)', () => {
    // `.env.local` sets `E2E_X_TENANT_HEADER_ENABLED=1` for the
    // throwaway-tenant E2E flow. When that gate is open + a header
    // is present + the slug passes `asTenantContext` validation,
    // the helper MUST honour the override (Playwright fixtures
    // depend on this path).
    const headers = makeHeaders([
      ['x-tenant', 'test-throwaway-tenant'],
      ['host', 'localhost:3100'],
    ]);
    const ctx = resolveTenantFromHeaders(headers);
    expect(ctx.slug).toBe('test-throwaway-tenant');
  });

  it('throws on malformed X-Tenant header value (asTenantContext validates slug shape)', () => {
    const headers = makeHeaders([
      // Invalid slug: contains uppercase + special chars.
      ['x-tenant', 'INVALID!Tenant'],
    ]);
    expect(() => resolveTenantFromHeaders(headers)).toThrow();
  });

  it('post-ship R6 C2 — propagates `headers.forEach` exceptions instead of silently falling back to env.tenant.slug', () => {
    // Constitution v1.4.0 Principle I forbids tenant-isolation fallbacks.
    // Prior to 2026-05-19 a try/catch swallowed `forEach` throws and
    // returned `env.tenant.slug`; F10 multi-tenant rollout would have
    // silently routed cross-tenant probes to the deployed tenant. The
    // new contract: fail loud, let Next.js error boundaries surface
    // the 500 + ops dashboards alert.
    const throwingHeaders = {
      get: () => null,
      has: () => false,
      forEach: () => {
        throw new Error('synthetic Proxy wrapper failure');
      },
    };
    expect(() => resolveTenantFromHeaders(throwingHeaders)).toThrow(
      'synthetic Proxy wrapper failure',
    );
  });
});
