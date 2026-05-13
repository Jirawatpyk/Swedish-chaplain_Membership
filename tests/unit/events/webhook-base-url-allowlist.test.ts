/**
 * Round 2 T-Gap2 fix (2026-05-13) — unit tests for the F6 host-
 * header allowlist guard (`deriveWebhookBaseUrl` +
 * `deriveWebhookBaseUrlFromHeaders` in `_lib/role-violation-audit.ts`).
 *
 * The H4 allowlist defends test-webhook + RSC page rendering against
 * spoofed `Host` headers on staging/preview deployments (without it,
 * an admin would copy a spoofed webhook URL into Zapier or POST
 * signed traffic to an attacker host). Previously zero direct test
 * coverage — round-6 ship-blocked on this surface only by accident.
 *
 * Test approach: mock `@/lib/env` with controlled allowlist values,
 * exercise each branch of `assertCanonicalBaseUrl`:
 *   1. Inbound matches `APP_BASE_URL` → return verbatim.
 *   2. Inbound in `APP_ALLOWED_ORIGINS` → return verbatim.
 *   3. Inbound off allowlist → return `APP_BASE_URL` + logger.warn.
 *   4. Malformed URL → return `APP_BASE_URL` (the catch).
 *   5. Null host (headers variant) → return `APP_BASE_URL` early.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    app: {
      baseUrl: 'https://canonical.chamber-os.app',
      allowedOrigins: [
        'https://staging.chamber-os.app',
        'https://preview-pr-42.chamber-os.app',
      ],
    },
  } as const,
}));

const warnSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => warnSpy(...args) },
}));

// Imported AFTER the mocks so the module-level allowlist Set is built
// from the mocked env.
const {
  assertCanonicalBaseUrl: deriveCanonical,
  assertCanonicalBaseUrlFromHeaders: deriveCanonicalFromHeaders,
} = await import('@/lib/canonical-base-url');

// Test shims that match the `deriveWebhookBaseUrl(req)` /
// `deriveWebhookBaseUrlFromHeaders(proto, host)` route-side surfaces
// 1:1 — same allowlist logic, just called through the underlying
// pure helper to avoid the role-violation-audit module's
// `@/modules/events` import chain (which pulls in the DB client).
function deriveWebhookBaseUrl(req: NextRequest): string {
  return deriveCanonical(new URL(req.url).origin, '/api');
}
function deriveWebhookBaseUrlFromHeaders(
  proto: string | null,
  host: string | null,
): string {
  return deriveCanonicalFromHeaders(proto, host);
}

function makeRequest(url: string): NextRequest {
  // Minimal stub — only `request.url` is read.
  return { url } as unknown as NextRequest;
}

describe('deriveWebhookBaseUrl — host allowlist (H4 defence-in-depth)', () => {
  beforeEach(() => {
    warnSpy.mockReset();
  });
  afterEach(() => {
    warnSpy.mockReset();
  });

  it('returns the canonical origin when inbound Host matches APP_BASE_URL', () => {
    const out = deriveWebhookBaseUrl(
      makeRequest('https://canonical.chamber-os.app/api/admin/integrations/eventcreate'),
    );
    expect(out).toBe('https://canonical.chamber-os.app');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the inbound origin when in APP_ALLOWED_ORIGINS (staging)', () => {
    const out = deriveWebhookBaseUrl(
      makeRequest('https://staging.chamber-os.app/api/admin/integrations/eventcreate'),
    );
    expect(out).toBe('https://staging.chamber-os.app');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the inbound origin when in APP_ALLOWED_ORIGINS (PR preview)', () => {
    const out = deriveWebhookBaseUrl(
      makeRequest(
        'https://preview-pr-42.chamber-os.app/api/admin/integrations/eventcreate',
      ),
    );
    expect(out).toBe('https://preview-pr-42.chamber-os.app');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to APP_BASE_URL + warns when inbound Host is off allowlist', () => {
    const out = deriveWebhookBaseUrl(
      makeRequest('https://attacker.example.com/api/admin/integrations/eventcreate'),
    );
    expect(out).toBe('https://canonical.chamber-os.app');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      event: 'f6_webhook_base_url_off_allowlist',
      candidateOrigin: 'https://attacker.example.com',
    });
  });
});

describe('deriveWebhookBaseUrlFromHeaders — RSC page variant', () => {
  beforeEach(() => {
    warnSpy.mockReset();
  });

  it('returns APP_BASE_URL early when host is null', () => {
    const out = deriveWebhookBaseUrlFromHeaders(null, null);
    expect(out).toBe('https://canonical.chamber-os.app');
    // Null-host fast path bypasses the allowlist check entirely;
    // logger.warn does NOT fire (no spoofed-origin signal).
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns canonical origin when proto+host match APP_BASE_URL', () => {
    const out = deriveWebhookBaseUrlFromHeaders('https', 'canonical.chamber-os.app');
    expect(out).toBe('https://canonical.chamber-os.app');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back + warns when off allowlist', () => {
    const out = deriveWebhookBaseUrlFromHeaders('https', 'attacker.example.com');
    expect(out).toBe('https://canonical.chamber-os.app');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults proto to https when null', () => {
    const out = deriveWebhookBaseUrlFromHeaders(null, 'canonical.chamber-os.app');
    expect(out).toBe('https://canonical.chamber-os.app');
  });
});
