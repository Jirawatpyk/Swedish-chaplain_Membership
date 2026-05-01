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
const headersMock = vi.fn<() => Promise<Map<string, string>>>(
  async () => new Map(),
);

const unsubscribesCountMock = vi.fn();
const unsubscribePageTtfbMsMock = vi.fn();

const envMock = {
  broadcasts: {
    fromEmail: 'broadcasts@swecham.example',
  },
};

vi.mock('@/lib/env', () => ({ env: envMock }));
vi.mock('@/lib/metrics', () => ({
  broadcastsMetrics: {
    unsubscribesCount: (...a: unknown[]) => unsubscribesCountMock(...a),
    unsubscribePageTtfbMs: (...a: unknown[]) =>
      unsubscribePageTtfbMsMock(...a),
    auditEmitFailed: vi.fn(),
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
  tenantDefaultLocaleFor: (tenantId: string) =>
    tenantId === 'swecham' ? 'th' : 'en',
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
  getTranslations: vi.fn(async () => {
    const t = (key: string) => key;
    // Real-ish rich mock: invoke each tag callback so the resulting
    // React tree carries the rendered <a> elements. Returns an array
    // with the key string + each tag's rendered output so assertions
    // can inspect both the i18n lookup and the rich element output.
    t.rich = (key: string, tags?: Record<string, () => unknown>) => {
      const out: unknown[] = [key];
      if (tags) for (const fn of Object.values(tags)) out.push(fn());
      return out;
    };
    return t;
  }),
}));
vi.mock('next/headers', () => ({
  headers: () => headersMock(),
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
  headersMock.mockReset();
  unsubscribesCountMock.mockReset();
  unsubscribePageTtfbMsMock.mockReset();
  headersMock.mockResolvedValue(new Map());

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

  // F1 verify-fix: assert metrics emission on success
  it('success → unsubscribesCount{outcome:success} + ttfb histogram emitted', async () => {
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(unsubscribesCountMock).toHaveBeenCalledWith(VALID_TENANT, 'success');
    expect(unsubscribePageTtfbMsMock).toHaveBeenCalledTimes(1);
    expect(unsubscribePageTtfbMsMock.mock.calls[0]![0]).toBe(VALID_TENANT);
    expect(typeof unsubscribePageTtfbMsMock.mock.calls[0]![1]).toBe('number');
  });

  it('idempotent replay → unsubscribesCount{outcome:already}', async () => {
    unsubscribeRecipientMock.mockResolvedValueOnce(
      ok({
        wasNew: false,
        tenantDisplayName: 'Test Chamber',
        tenantSupportEmail: 'broadcasts@swecham.example',
        unsubscribedAt: new Date(),
      }),
    );
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(unsubscribesCountMock).toHaveBeenCalledWith(VALID_TENANT, 'already');
  });

  it('verify failure → unsubscribesCount{outcome:invalid}', async () => {
    verifyMock.mockReturnValueOnce({
      ok: false,
      error: { kind: 'token.bad_signature' },
    });
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(unsubscribesCountMock).toHaveBeenCalledWith(VALID_TENANT, 'invalid');
  });

  it('rate-limit exceeded → unsubscribesCount{outcome:rate_limited}', async () => {
    rateLimitCheckMock.mockResolvedValueOnce({
      ok: false as unknown as true,
      error: { kind: 'rate_limit_exceeded', retryAfterSeconds: 60, key: 'k' },
    } as unknown as { ok: true; value: true });
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(unsubscribesCountMock).toHaveBeenCalledWith(null, 'rate_limited');
  });

  // C2 verify-fix: repo_error renders error-state, not invalid
  it('use-case repo_error → unsubscribesCount{outcome:repo_error} + render distinct from invalid', async () => {
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
    expect(unsubscribesCountMock).toHaveBeenCalledWith(
      VALID_TENANT,
      'repo_error',
    );
    // MUST NOT also report 'invalid' for the same render.
    const calls = unsubscribesCountMock.mock.calls.map((c) => c[1]);
    expect(calls).not.toContain('invalid');
  });

  // C1 verify-fix: unhandled throw inside runInTenant collapses to error state
  it('runInTenant throw → unsubscribesCount{outcome:unhandled_error}, never throws', async () => {
    runInTenantMock.mockImplementationOnce(async () => {
      throw new Error('Neon connection refused');
    });
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(node).toBeDefined();
    expect(unsubscribesCountMock).toHaveBeenCalledWith(
      VALID_TENANT,
      'unhandled_error',
    );
  });

  // I3 verify-fix: locale resolution priority chain
  it('locale: token.lang wins over conflicting query.lang', async () => {
    // verifyMock default already returns lang: 'th'
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({ lang: 'en' }),
    });
    // lang attribute on <main> reflects resolved locale; we expect 'th'
    expect((node as unknown as { props: { lang: string } }).props.lang).toBe(
      'th',
    );
  });

  it('locale: query.lang used when token has no lang claim', async () => {
    verifyMock.mockReturnValueOnce(
      ok({
        tenantId: VALID_TENANT,
        broadcastId: VALID_BROADCAST,
        emailLower: VALID_EMAIL,
      }),
    );
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({ lang: 'sv' }),
    });
    expect((node as unknown as { props: { lang: string } }).props.lang).toBe(
      'sv',
    );
  });

  it('locale: Accept-Language used when neither token.lang nor query.lang present', async () => {
    verifyMock.mockReturnValueOnce(
      ok({
        tenantId: VALID_TENANT,
        broadcastId: VALID_BROADCAST,
        emailLower: VALID_EMAIL,
      }),
    );
    headersMock.mockResolvedValueOnce(
      new Map([['accept-language', 'sv-SE,sv;q=0.9,en;q=0.8']]),
    );
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect((node as unknown as { props: { lang: string } }).props.lang).toBe(
      'sv',
    );
  });

  it('locale: tenant default used when no token.lang, no query.lang, no Accept-Language', async () => {
    verifyMock.mockReturnValueOnce(
      ok({
        tenantId: 'swecham', // tenant default = 'th' per TENANT_DEFAULT_LOCALE
        broadcastId: VALID_BROADCAST,
        emailLower: VALID_EMAIL,
      }),
    );
    peekTokenTenantIdMock.mockReturnValueOnce('swecham');
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect((node as unknown as { props: { lang: string } }).props.lang).toBe(
      'th',
    );
  });

  // I4: rate-limit key shape contract
  it('rate-limit called with documented (key, max, window) contract', async () => {
    const { default: Page } = await importPage();
    await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    expect(rateLimitCheckMock).toHaveBeenCalledWith(
      expect.stringMatching(/^unsubscribe:/),
      20,
      300,
    );
  });

  // R3 verify-fix: assert the mailto anchor actually renders inside the
  // success contact line. The rich callback must produce an <a href="mailto:…">
  // element — a regression that strips the rich placeholder would silently
  // collapse to plain text and break the WCAG SC 2.5.8 touch-target affordance.
  it('success render: contact line emits <a href="mailto:..."> via t.rich callback', async () => {
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    const tree = JSON.stringify(node);
    expect(tree).toContain('mailto:broadcasts@swecham.example');
    // `getTranslations({namespace: 'public.unsubscribe'})` returns relative
    // keys, so the rendered string is `success.contact` not the full path.
    expect(tree).toContain('success.contact');
  });

  // R4 verify-fix: assert error-state JSX is distinct from invalid-state.
  // Both states currently use `state: 'error' | 'invalid'` discriminator;
  // a regression mapping repo_error → invalid template would lose the
  // "please try again" recovery affordance.
  it('repo_error render: error.* i18n keys (not invalid.*) reach the JSX', async () => {
    unsubscribeRecipientMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'unsubscribe.repo_error', cause: new Error('boom') },
    });
    const { default: Page } = await importPage();
    const node = await Page({
      params: Promise.resolve({ token: VALID_TOKEN }),
      searchParams: Promise.resolve({}),
    });
    const tree = JSON.stringify(node);
    expect(tree).toContain('error.heading');
    expect(tree).toContain('error.body');
    // MUST NOT bleed the invalid state into the error render.
    expect(tree).not.toContain('invalid.heading');
  });
});
