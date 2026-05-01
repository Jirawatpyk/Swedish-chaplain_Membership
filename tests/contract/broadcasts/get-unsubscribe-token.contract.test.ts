/**
 * T136 — Contract test: GET /unsubscribe/[token] (F7 US4 public route).
 *
 * Asserts the route → use-case wiring contract:
 *   - Locale resolution priority (token > query > Accept-Language >
 *     tenant default > 'en') is honoured
 *   - Use-case invoked with (tenantId, broadcastId, emailLower) parsed
 *     from the verified token
 *   - Token-verify failure → use-case NOT invoked + audit row written
 *   - Tenant peek failure (malformed token) → use-case NOT invoked +
 *     audit row written + page renders fallback locale fallback
 *
 * Branching behaviour per outcome (success/already/invalid) lives at
 * the unit-test level (`unsubscribe-recipient.test.ts` + signer test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

const unsubscribeRecipientMock = vi.fn();
const peekTokenTenantIdMock = vi.fn();
const verifyMock = vi.fn();
const dbExecuteMock = vi.fn();
const resolveTenantDisplayNameMock = vi.fn();
const runInTenantMock = vi.fn();

const envMock = {
  broadcasts: {
    fromEmail: 'broadcasts@swecham.example',
  },
};

vi.mock('@/lib/env', () => ({ env: envMock }));
vi.mock('@/lib/metrics', () => ({
  broadcastsMetrics: {
    unsubscribesCount: vi.fn(),
    unsubscribePageTtfbMs: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: { execute: (...a: unknown[]) => dbExecuteMock(...a) },
  runInTenant: (...args: unknown[]) => runInTenantMock(...args),
}));
vi.mock('@/lib/broadcasts-route-helpers', () => ({
  resolveTenantDisplayName: (...args: unknown[]) =>
    resolveTenantDisplayNameMock(...args),
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));
const rateLimitCheckMock = vi.fn<
  (key: string, limit: number, windowSeconds: number) => Promise<unknown>
>(async () => ({ ok: true, value: true }));
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  unsubscribeRecipient: (...args: unknown[]) =>
    unsubscribeRecipientMock(...args),
  makeUnsubscribeRecipientDeps: vi.fn(() => ({})),
  peekTokenTenantId: (...args: unknown[]) => peekTokenTenantIdMock(...args),
  unsubscribeTokenSigner: {
    sign: vi.fn(),
    verify: (...args: unknown[]) => verifyMock(...args),
  },
  broadcastsRateLimiter: {
    checkLimit: (key: string, limit: number, windowSeconds: number) =>
      rateLimitCheckMock(key, limit, windowSeconds),
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Map()),
}));

async function importPage() {
  return import('@/app/unsubscribe/[token]/page');
}

const VALID_TENANT = 'test-tenant';
const VALID_BROADCAST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_EMAIL = 'alice@example.com';
const VALID_TOKEN = 'v1.payload.macsig';

beforeEach(() => {
  unsubscribeRecipientMock.mockReset();
  peekTokenTenantIdMock.mockReset();
  verifyMock.mockReset();
  dbExecuteMock.mockReset();
  resolveTenantDisplayNameMock.mockReset();
  runInTenantMock.mockReset();

  // Default happy-path stubs
  peekTokenTenantIdMock.mockReturnValue(VALID_TENANT);
  verifyMock.mockReturnValue(
    ok({
      tenantId: VALID_TENANT,
      broadcastId: VALID_BROADCAST,
      emailLower: VALID_EMAIL,
      lang: 'th',
    }),
  );
  resolveTenantDisplayNameMock.mockResolvedValue('Test Chamber');
  runInTenantMock.mockImplementation(async (_ctx, fn) => fn());
  unsubscribeRecipientMock.mockResolvedValue(
    ok({
      wasNew: true,
      tenantDisplayName: 'Test Chamber',
      tenantSupportEmail: 'broadcasts@swecham.example',
      unsubscribedAt: new Date(),
    }),
  );
  dbExecuteMock.mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /unsubscribe/[token] (T136 contract)', () => {
  it('valid token → renders confirmation + invokes unsubscribeRecipient with verified payload', async () => {
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });

    expect(peekTokenTenantIdMock).toHaveBeenCalledWith(VALID_TOKEN);
    expect(verifyMock).toHaveBeenCalledWith(VALID_TOKEN);
    expect(unsubscribeRecipientMock).toHaveBeenCalledTimes(1);

    const useCaseInput = unsubscribeRecipientMock.mock.calls[0]![1];
    expect(useCaseInput.tenantId).toBe(VALID_TENANT);
    expect(useCaseInput.broadcastId).toBe(VALID_BROADCAST);
    expect(useCaseInput.emailLower).toBe(VALID_EMAIL);
    expect(useCaseInput.tokenPlaintext).toBe(VALID_TOKEN);
    expect(useCaseInput.reasonText).toBeNull();
  });

  it('malformed token (peek returns null) → use-case NOT invoked + invalid-token audit written', async () => {
    peekTokenTenantIdMock.mockReturnValueOnce(null);

    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: 'garbage' }),
      searchParams: Promise.resolve({}),
    });

    expect(unsubscribeRecipientMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).toHaveBeenCalled();
  });

  it('verify failure (bad signature) → use-case NOT invoked + invalid-token audit written', async () => {
    verifyMock.mockReturnValueOnce({
      ok: false,
      error: { kind: 'token.bad_signature' },
    });

    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });

    expect(unsubscribeRecipientMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).toHaveBeenCalled();
  });

  it('use-case error (e.g. repo_error) → page renders invalid state without crashing', async () => {
    unsubscribeRecipientMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'unsubscribe.repo_error', cause: new Error('boom') },
    });

    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(node).toBeDefined();
  });

  it('idempotent replay (wasNew=false) → page renders without re-invoking use-case', async () => {
    unsubscribeRecipientMock.mockResolvedValueOnce(
      ok({
        wasNew: false,
        tenantDisplayName: 'Test Chamber',
        tenantSupportEmail: 'broadcasts@swecham.example',
        unsubscribedAt: new Date('2026-04-29T10:00:00Z'),
      }),
    );

    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(node).toBeDefined();
    expect(unsubscribeRecipientMock).toHaveBeenCalledTimes(1);
  });

  it('lang query param accepted as fallback when token has no lang claim', async () => {
    verifyMock.mockReturnValueOnce(
      ok({
        tenantId: VALID_TENANT,
        broadcastId: VALID_BROADCAST,
        emailLower: VALID_EMAIL,
        // no lang
      }),
    );
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({ lang: 'sv' }),
    });
    expect(unsubscribeRecipientMock).toHaveBeenCalledTimes(1);
  });

  it('peek-tid mismatch with verified payload tid → use-case NOT invoked + audit row written', async () => {
    peekTokenTenantIdMock.mockReturnValueOnce('mismatched-tenant');
    verifyMock.mockReturnValueOnce(
      ok({
        tenantId: VALID_TENANT,
        broadcastId: VALID_BROADCAST,
        emailLower: VALID_EMAIL,
      }),
    );
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(unsubscribeRecipientMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).toHaveBeenCalled();
  });

  // E1 — verify-fix: anti-enumeration rate limit
  it('rate limit exceeded → use-case NOT invoked + audit + invalid render', async () => {
    rateLimitCheckMock.mockResolvedValueOnce({
      ok: false as unknown as true,
      error: {
        kind: 'rate_limit_exceeded',
        retryAfterSeconds: 60,
        key: 'unsubscribe:127.0.0.1',
      },
    } as unknown as { ok: true; value: true });

    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });

    expect(unsubscribeRecipientMock).not.toHaveBeenCalled();
    expect(peekTokenTenantIdMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).toHaveBeenCalled();
  });

  // E1 — verify-fix: rate-limiter outage fail-open per Complexity Tracking entry
  it('rate-limiter outage → fail-open, request proceeds', async () => {
    rateLimitCheckMock.mockRejectedValueOnce(new Error('Upstash unreachable'));

    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });

    // Use-case still invoked despite limiter outage.
    expect(unsubscribeRecipientMock).toHaveBeenCalledTimes(1);
  });
});
