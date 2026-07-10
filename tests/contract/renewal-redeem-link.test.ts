/**
 * BUG-4 — renewal magic-link redeem contract (anti-prefetch interstitial).
 *
 * Route: /api/portal/renewal/redeem-link
 *   GET  — NON-consuming interstitial (renders a POST form). Email security
 *          scanners (SafeLinks/Proofpoint) that PREFETCH the link hit this and
 *          CANNOT burn the one-time token (no verify, no consume, no session).
 *   POST — verify + consume + session-mint (token from the form body).
 *
 * Pins the security-critical split so a regression that moves consume back
 * onto GET (re-opening the scanner-prefetch burn) fails CI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const TOK = 'v1.eyJ0aWQiOiJzd2VjaGFtIn0.abc123mac';
const MID = '00000000-0000-0000-0000-000000000abc';
const CID = '00000000-0000-0000-0000-000000000def';

const verifyMock = vi.fn();

// Barrel stubs — only the symbols the route uses. GET touches NONE of these
// (that is the whole point); POST drives verify + the members/auth deps.
vi.mock('@/modules/renewals', () => ({
  verifyRenewalLinkToken: (...args: unknown[]) => verifyMock(...args),
  makeRenewalsDeps: () => ({
    tokenVerifier: {},
    cyclesRepo: {},
    auditEmitter: {},
    tenant: { slug: 'swecham' },
    consumedLinkTokensRepo: {},
  }),
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    contactRepo: {
      listByMember: async () =>
        ok([{ isPrimary: true, removedAt: null, linkedUserId: 'u1' }]),
    },
  }),
}));

vi.mock('@/lib/auth-deps', () => ({
  defaultSignInDeps: {
    users: {
      findById: async () => ({
        status: 'active',
        emailVerified: true,
        requiresPasswordReset: false,
        lockedUntil: null,
      }),
    },
    sessions: { create: async () => ({ id: 'sess-1' }) },
  },
}));

vi.mock('@/modules/members', () => ({ asMemberId: (s: string) => s }));
vi.mock('@/modules/auth', () => ({ asUserId: (s: string) => s }));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (s: string) => ({ slug: s }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));
vi.mock('@/lib/auth-cookies', () => ({ setSessionCookie: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/request-id', () => ({ uuidv7: () => 'test-corr-id' }));
vi.mock('@/lib/client-ip', () => ({ getClientIp: () => '203.0.113.5' }));
vi.mock('@/lib/env', () => ({
  env: { features: { f8Renewals: true } },
}));

describe('contract: /api/portal/renewal/redeem-link (BUG-4 anti-prefetch)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET renders a non-consuming interstitial POST form and NEVER verifies/consumes the token', async () => {
    const { GET } = await import(
      '@/app/api/portal/renewal/redeem-link/route'
    );
    const res = await GET(
      new NextRequest(
        `http://localhost/api/portal/renewal/redeem-link?t=${TOK}`,
        { method: 'GET' },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // BUG-4 review (blocker fix): MUST be strict-origin, NOT no-referrer. A
    // `no-referrer` document makes the Continue POST send `Origin: null`, which
    // the proxy CSRF Origin allow-list rejects with 403 — breaking every
    // member. strict-origin keeps a valid same-origin Origin header (CSRF
    // passes) while still stripping the token from the Referer. This assertion
    // pins the requirement (the proxy CSRF layer isn't exercised in a
    // handler-level contract test, so this is the regression guard for it).
    expect(res.headers.get('referrer-policy')).toBe('strict-origin');
    const html = await res.text();
    expect(html).toContain('content="strict-origin"');
    expect(html).not.toContain('content="no-referrer"');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/portal/renewal/redeem-link"');
    expect(html).toContain('name="t"');
    expect(html).toContain(TOK);
    // THE regression assertion — GET must do ZERO verification/consume so an
    // email-scanner prefetch cannot burn the one-time token.
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('GET with no token redirects to the generic failure surface (no interstitial)', async () => {
    const { GET } = await import(
      '@/app/api/portal/renewal/redeem-link/route'
    );
    const res = await GET(
      new NextRequest('http://localhost/api/portal/renewal/redeem-link', {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/portal/sign-in');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('GET localizes the interstitial per the NEXT_LOCALE cookie (en/th/sv coverage)', async () => {
    // The interstitial copy is inline (not the next-intl catalog) so it
    // bypasses check:i18n — this asserts every locale renders its button +
    // lang, catching a missing/empty locale key.
    const { GET } = await import(
      '@/app/api/portal/renewal/redeem-link/route'
    );
    const cases: ReadonlyArray<{ locale: string; button: string }> = [
      { locale: 'en', button: 'Continue to renewal' },
      { locale: 'th', button: 'ดำเนินการต่อ' },
      { locale: 'sv', button: 'Fortsätt till förnyelse' },
    ];
    for (const { locale, button } of cases) {
      const res = await GET(
        new NextRequest(
          `http://localhost/api/portal/renewal/redeem-link?t=${TOK}`,
          { method: 'GET', headers: { cookie: `NEXT_LOCALE=${locale}` } },
        ),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(button);
      expect(html).toContain(`lang="${locale}"`);
    }
  });

  it('POST consumes the token (via verify), mints a session, and 302-redirects to the renewal page', async () => {
    // The real verify runs the preConsumeGate to capture the linked user +
    // consume the token; the mock mirrors that contract so the route's
    // resolvedUserId path is exercised.
    verifyMock.mockImplementation(
      async (
        _deps: unknown,
        _input: unknown,
        preConsumeGate: (a: {
          memberId: string;
          cycleId: string;
        }) => Promise<'allow' | 'block'>,
      ) => {
        await preConsumeGate({ memberId: MID, cycleId: CID });
        return ok({ kind: 'success', memberId: MID, cycleId: CID });
      },
    );

    const { POST } = await import(
      '@/app/api/portal/renewal/redeem-link/route'
    );
    const res = await POST(
      new NextRequest('http://localhost/api/portal/renewal/redeem-link', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `t=${TOK}`,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/portal/renewal/${MID}`);
    expect(res.cookies.get('swecham_session')?.value).toBe('sess-1');
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });
});
