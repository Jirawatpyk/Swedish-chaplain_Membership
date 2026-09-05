/**
 * 108 PR-D T061 (US6 — FR-030b, FR-032, FR-033, FR-053a) — contract:
 * `PATCH /api/portal/profile/marketing` + the `marketing` block on
 * `GET /api/portal/profile`.
 *
 * The portal self-toggle acts on the SESSION's own contact and nothing else:
 * the body is `{ optOut: boolean }` (strict — no contact id can be smuggled
 * in), the use case is called with `ctx.ownContactId` and `source: 'self'`,
 * the same `Idempotency-Key` + 60/min rules as the staff toggle apply, and
 * a suppressed address is refused with 409 (the portal hides the control in
 * that state). `GET /api/portal/profile` carries `marketing: { state }` for
 * the own contact only — other contacts' marketing states are never shown to
 * a portal user (FR-032).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const setContactMarketingOptOutMock = vi.fn();
const getMemberMock = vi.fn();
const isSuppressedMock = vi.fn(async () => false);
const rateLimitCheckMock = vi.fn();
type Classification = {
  readonly kind: 'first' | 'replay' | 'conflict';
  readonly previousResponse?: { readonly status: number; readonly body: unknown };
};
const classifyMock = vi.fn(async (): Promise<Classification> => ({ kind: 'first' }));
const reserveMock = vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } }));
const rememberMock = vi.fn(async () => undefined);

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/contact-marketing-deps', () => ({
  buildContactMarketingDeps: vi.fn(() => ({ tenant: { slug: 'test', __brand: true } })),
  makeMarketingSuppressionLookup: vi.fn(() => ({
    isSuppressed: (...args: unknown[]) => isSuppressedMock(...(args as [])),
  })),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({ memberRepo: {}, contactRepo: {}, audit: {} })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>('@/modules/members');
  return {
    ...actual,
    setContactMarketingOptOut: (...args: unknown[]) => setContactMarketingOptOutMock(...args),
    getMember: (...args: unknown[]) => getMemberMock(...args),
  };
});
vi.mock('@/modules/auth', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth')>('@/modules/auth');
  return {
    ...actual,
    rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
  };
});
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: (...args: unknown[]) => classifyMock(...(args as [])),
  reserveIdempotencyRecord: (...args: unknown[]) => reserveMock(...(args as [])),
  rememberIdempotentResponse: (...args: unknown[]) => rememberMock(...(args as [])),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const OWN = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-222222222222';
const MEMBER = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-09-06T10:00:00Z');

function contact(id: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test',
    contactId: id,
    memberId: MEMBER,
    firstName: id === OWN ? 'Own' : 'Other',
    lastName: 'Contact',
    email: `${id === OWN ? 'own' : 'other'}@example.com`,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: id === OWN ? 'user-1' : null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing: { optedOutAt: null, source: null, byUserId: null },
    isPrimary: id === OWN,
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const memberContext = {
  current: {
    user: { id: 'user-1', email: 'own@example.com', role: 'member', status: 'active' },
    session: { id: 's-1' },
  },
  tenant: { slug: 'test', __brand: true },
  member: {
    memberId: MEMBER,
    companyName: 'Test Corp',
    legalEntityType: null,
    country: 'TH',
    website: null,
    description: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: NOW,
    registrationFeePaid: false,
    status: 'active',
    archivedAt: null,
    lastActivityAt: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  memberId: MEMBER,
  ownContact: contact(OWN),
  ownContactId: OWN,
  sourceIp: '203.0.113.9',
  requestId: 'req-portal',
};

function patchRequest(body: unknown, opts: { key?: string | null } = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.key !== null) headers.set('idempotency-key', opts.key ?? 'key-1');
  return new NextRequest('http://localhost/api/portal/profile/marketing', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

async function loadMarketingRoute() {
  return import('@/app/api/portal/profile/marketing/route');
}

describe('contract: PATCH /api/portal/profile/marketing (108 PR-D T061)', () => {
  beforeEach(() => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    rateLimitCheckMock.mockResolvedValue({ success: true, remaining: 59, reset: Date.now() + 60_000, fellBack: false });
    classifyMock.mockResolvedValue({ kind: 'first' });
    isSuppressedMock.mockResolvedValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  it('no session → the member-context rejection is returned untouched', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: true }));
    expect(res.status).toBe(401);
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('optOut: true → the use case runs on the OWN contact with source self and the session role', async () => {
    setContactMarketingOptOutMock.mockResolvedValueOnce(
      ok({
        outcome: 'changed',
        contact: contact(OWN, { marketing: { optedOutAt: NOW, source: 'self', byUserId: 'user-1' } }),
        event: 'contact_marketing_opted_out',
      }),
    );
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'changed', marketing: { state: 'off_by_contact' } });
    expect(setContactMarketingOptOutMock).toHaveBeenCalledWith(
      {
        contactId: OWN,
        state: 'off',
        actor: { userId: 'user-1', role: 'member', source: 'self' },
        requestId: 'req-portal',
      },
      expect.anything(),
    );
    expect(rememberMock).toHaveBeenCalledWith(expect.anything(), 'key-1', 'hash', expect.objectContaining({ status: 200 }));
  });

  it('optOut: false → state on; the body cannot address another contact (strict schema → 400)', async () => {
    setContactMarketingOptOutMock.mockResolvedValueOnce(
      ok({ outcome: 'changed', contact: contact(OWN), event: 'contact_marketing_opted_in' }),
    );
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'changed', marketing: { state: 'on' } });
    expect(setContactMarketingOptOutMock.mock.calls[0]![0]).toMatchObject({ contactId: OWN, state: 'on' });

    const smuggled = await PATCH(patchRequest({ optOut: false, contactId: OTHER }, { key: 'key-2' }));
    expect(smuggled.status).toBe(400);
    expect((await smuggled.json()).error.code).toBe('invalid_body');
    expect(setContactMarketingOptOutMock).toHaveBeenCalledTimes(1);
  });

  it('same state → 200 { outcome: unchanged } with the current state', async () => {
    setContactMarketingOptOutMock.mockResolvedValueOnce(ok({ outcome: 'unchanged', contact: contact(OWN) }));
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'unchanged', marketing: { state: 'on' } });
  });

  it('missing Idempotency-Key → 400 missing_idempotency_key, nothing consumed', async () => {
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: true }, { key: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('missing_idempotency_key');
    expect(rateLimitCheckMock).not.toHaveBeenCalled();
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('replayed key → the stored outcome, no second use-case call (no second audit row)', async () => {
    classifyMock.mockResolvedValueOnce({
      kind: 'replay',
      previousResponse: { status: 200, body: { outcome: 'changed', marketing: { state: 'off_by_contact' } } },
    });
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).marketing.state).toBe('off_by_contact');
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('60/min per tenant + user, consumed before the write (the SAME bucket as the staff toggle)', async () => {
    rateLimitCheckMock.mockResolvedValueOnce({ success: false, remaining: 0, reset: Date.now() + 20_000, fellBack: false });
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: true }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(rateLimitCheckMock).toHaveBeenCalledWith('contacts:marketing:test:user-1', 60, 60);
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('suppressed address → 409 suppressed (the portal hides the control in that state)', async () => {
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'suppressed' }));
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: false }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('suppressed');
  });

  it('invalid body (non-boolean) → 400 invalid_body', async () => {
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: 'yes' }));
    expect(res.status).toBe(400);
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('server_error → 500 without the message', async () => {
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'server_error', message: 'pool exhausted' }));
    const { PATCH } = await loadMarketingRoute();
    const res = await PATCH(patchRequest({ optOut: true }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('pool exhausted');
  });
});

describe('contract: GET /api/portal/profile carries marketing.state for the OWN contact only (FR-032)', () => {
  beforeEach(() => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    isSuppressedMock.mockResolvedValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  async function loadProfileRoute() {
    return import('@/app/api/portal/profile/route');
  }

  it('own contact → marketing.state derived (opt-out by self → off_by_contact); other contacts carry no marketing block', async () => {
    getMemberMock.mockResolvedValueOnce(
      ok({
        member: memberContext.member,
        contacts: [
          contact(OWN, { marketing: { optedOutAt: NOW, source: 'self', byUserId: 'user-1' } }),
          contact(OTHER, { marketing: { optedOutAt: NOW, source: 'staff', byUserId: 'staff-1' } }),
        ],
      }),
    );
    const { GET } = await loadProfileRoute();
    const res = await GET(new NextRequest('http://localhost/api/portal/profile'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const own = body.contacts.find((c: { contact_id: string }) => c.contact_id === OWN);
    const other = body.contacts.find((c: { contact_id: string }) => c.contact_id === OTHER);
    expect(own.marketing).toEqual({ state: 'off_by_contact' });
    expect(other.marketing).toBeUndefined();
    // Never the opt-out columns themselves (who/when is a staff-side detail).
    expect(own.marketing_opt_out_by_user_id).toBeUndefined();
  });

  it('own contact suppressed → unsubscribed; suppression lookup outage → unavailable', async () => {
    getMemberMock.mockResolvedValue(ok({ member: memberContext.member, contacts: [contact(OWN)] }));
    const { GET } = await loadProfileRoute();

    isSuppressedMock.mockResolvedValueOnce(true);
    const suppressed = await (await GET(new NextRequest('http://localhost/api/portal/profile'))).json();
    expect(suppressed.contacts[0].marketing).toEqual({ state: 'unsubscribed' });

    isSuppressedMock.mockRejectedValueOnce(new Error('down'));
    const degraded = await (await GET(new NextRequest('http://localhost/api/portal/profile'))).json();
    expect(degraded.contacts[0].marketing).toEqual({ state: 'unavailable' });
  });
});
