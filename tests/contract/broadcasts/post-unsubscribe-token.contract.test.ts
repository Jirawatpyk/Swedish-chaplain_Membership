// @vitest-environment node
/**
 * Contract: POST /unsubscribe/[token] — RFC 8058 one-click unsubscribe
 * (served by `/api/unsubscribe/[token]` via the proxy rewrite).
 *
 * Mail clients send `List-Unsubscribe=One-Click` with no cookies and no
 * Origin. The handler runs the same verify → `unsubscribeRecipient` pipeline
 * as the page, tagged `one_click_post`, and answers with a status only:
 *   200 unsubscribed / already unsubscribed · 400 invalid token
 *   429 too many failed tokens from this IP · 503 temporary failure
 *
 * Mail providers POST from a handful of shared IPs, so a VALID token is
 * never throttled; only failed verifications count toward the IP limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const unsubscribeRecipientMock = vi.fn();
const peekTokenTenantIdMock = vi.fn();
const verifyMock = vi.fn();
const f7AuditEmitMock = vi.fn();
const unsubscribesCountMock = vi.fn();
const rateLimitCheckMock = vi.fn<
  (key: string, limit: number, windowSeconds: number) => Promise<unknown>
>(async () => ({ ok: true, value: true }));

vi.mock('@/lib/env', () => ({
  env: {
    broadcasts: {
      fromEmail: 'Chamber <broadcasts@swecham.example>',
      privacyContactEmail: 'privacy@swecham.example',
    },
  },
}));
vi.mock('@/lib/metrics', () => ({
  broadcastsMetrics: {
    unsubscribesCount: (...a: unknown[]) => unsubscribesCountMock(...a),
    unsubscribePageTtfbMs: vi.fn(),
    auditEmitFailed: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: { execute: vi.fn() },
  runInTenant: async (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/broadcasts-route-helpers', () => ({
  resolveTenantDisplayName: async () => 'Test Chamber',
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  unsubscribeRecipient: (...args: unknown[]) => unsubscribeRecipientMock(...args),
  makeUnsubscribeRecipientDeps: vi.fn(() => ({})),
  peekTokenTenantId: (...args: unknown[]) => peekTokenTenantIdMock(...args),
  tenantDefaultLocaleFor: () => 'en',
  unsubscribeTokenSigner: { sign: vi.fn(), verify: (...a: unknown[]) => verifyMock(...a) },
  broadcastsRateLimiter: {
    checkLimit: (key: string, limit: number, windowSeconds: number) =>
      rateLimitCheckMock(key, limit, windowSeconds),
  },
  f7AuditAdapter: { emit: (...args: unknown[]) => f7AuditEmitMock(...args) },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const TOKEN = 'v1.payload.macsig';
const IP = '203.0.113.9';

function oneClickPost(token = TOKEN): [NextRequest, { params: Promise<{ token: string }> }] {
  const req = new NextRequest(`https://members.swecham.example/api/unsubscribe/${token}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': IP,
    },
    body: 'List-Unsubscribe=One-Click',
  });
  return [req, { params: Promise.resolve({ token }) }];
}

async function importRoute() {
  return import('@/app/api/unsubscribe/[token]/route');
}

function useCaseResult(wasNew: boolean) {
  return ok({
    wasNew,
    tenantDisplayName: 'Test Chamber',
    tenantSupportEmail: 'privacy@swecham.example',
    unsubscribedAt: new Date(),
  });
}

beforeEach(() => {
  peekTokenTenantIdMock.mockReturnValue('test-tenant');
  verifyMock.mockReturnValue(
    ok({
      tenantId: 'test-tenant',
      broadcastId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      emailLower: 'alice@example.com',
      lang: 'en',
    }),
  );
  unsubscribeRecipientMock.mockResolvedValue(useCaseResult(true));
  f7AuditEmitMock.mockResolvedValue(undefined);
  rateLimitCheckMock.mockResolvedValue({ ok: true, value: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /unsubscribe/[token] (RFC 8058 one-click)', () => {
  it('unsubscribes through the shared use-case, tagged one_click_post → 200', async () => {
    const { POST } = await importRoute();
    const res = await POST(...oneClickPost());
    expect(res.status).toBe(200);
    expect(unsubscribeRecipientMock).toHaveBeenCalledTimes(1);
    const input = unsubscribeRecipientMock.mock.calls[0]![1];
    expect(input).toMatchObject({
      tenantId: 'test-tenant',
      emailLower: 'alice@example.com',
      tokenPlaintext: TOKEN,
      channel: 'one_click_post',
    });
  });

  it('is idempotent: a repeat POST (already unsubscribed) is still 200', async () => {
    const { POST } = await importRoute();
    unsubscribeRecipientMock.mockResolvedValueOnce(useCaseResult(true));
    unsubscribeRecipientMock.mockResolvedValueOnce(useCaseResult(false));
    expect((await POST(...oneClickPost())).status).toBe(200);
    expect((await POST(...oneClickPost())).status).toBe(200);
    expect(unsubscribesCountMock).toHaveBeenCalledWith('test-tenant', 'success');
    expect(unsubscribesCountMock).toHaveBeenCalledWith('test-tenant', 'already');
  });

  it('never throttles a valid token (provider IPs are shared)', async () => {
    const { POST } = await importRoute();
    await POST(...oneClickPost());
    expect(rateLimitCheckMock).not.toHaveBeenCalled();
  });

  it('invalid token → 400, audited, and counted against the failure bucket', async () => {
    verifyMock.mockReturnValueOnce({ ok: false, error: { kind: 'token.bad_signature' } });
    const { POST } = await importRoute();
    const res = await POST(...oneClickPost());
    expect(res.status).toBe(400);
    expect(unsubscribeRecipientMock).not.toHaveBeenCalled();
    expect(f7AuditEmitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitCheckMock).toHaveBeenCalledWith(`unsubscribe-post-fail:${IP}`, 20, 300);
  });

  it('too many failed tokens from one IP → 429 with Retry-After', async () => {
    verifyMock.mockReturnValueOnce({ ok: false, error: { kind: 'token.bad_signature' } });
    rateLimitCheckMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'rate_limit_exceeded', retryAfterSeconds: 120, key: 'k' },
    });
    const { POST } = await importRoute();
    const res = await POST(...oneClickPost());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(unsubscribesCountMock).toHaveBeenCalledWith(null, 'rate_limited');
  });

  it('temporary failure → 503 with Retry-After so the sender retries', async () => {
    unsubscribeRecipientMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'unsubscribe.repo_error', cause: new Error('boom') },
    });
    const { POST } = await importRoute();
    const res = await POST(...oneClickPost());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('GET on the API path is 405 — the page owns GET', async () => {
    const { GET } = await importRoute();
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
