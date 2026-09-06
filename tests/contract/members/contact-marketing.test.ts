/**
 * 108 PR-D T043 (US4 — FR-030, FR-030a, FR-030b, FR-053a) — contract:
 * `POST /api/admin/contacts/[contactId]/marketing`.
 *
 * The staff toggle. Mocks the use case, the composition and the
 * idempotency / rate-limit adapters; verifies the wire contract
 * (contracts/contact-marketing-api.md § 1): gate key, body shape, the
 * `Idempotency-Key` rule (400 / replay returns the stored outcome with no
 * second use-case call), the 60/min limit consumed BEFORE the write, and the
 * RFC 7807 problem bodies for 404 / 409 / 503.
 *
 * The RBAC denial itself (manager → 403 + `permission_denied` audited with
 * the REAL role) is the gate's behaviour, proven in
 * tests/contract/rbac/permission-denied-audit.test.ts; this file pins that the
 * route hands the gate the literal key `contacts.marketing`, and
 * `check:api-route-guard` pins that literal against the frozen baseline row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const setContactMarketingOptOutMock = vi.fn();
const auditRecordMock = vi.fn(async () => ok(undefined));
const rateLimitCheckMock = vi.fn();
type Classification = {
  readonly kind: 'first' | 'replay' | 'conflict';
  readonly previousResponse?: { readonly status: number; readonly body: unknown };
};
const classifyMock = vi.fn(async (): Promise<Classification> => ({ kind: 'first' }));
const reserveMock = vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } }));
const rememberMock = vi.fn(async () => undefined);

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/contact-marketing-deps', () => ({
  buildContactMarketingDeps: vi.fn(() => ({
    tenant: { slug: 'test', __brand: true },
    audit: { record: (...args: unknown[]) => auditRecordMock(...(args as [])) },
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>('@/modules/members');
  return {
    ...actual,
    setContactMarketingOptOut: (...args: unknown[]) => setContactMarketingOptOutMock(...args),
  };
});
vi.mock('@/modules/auth', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth')>('@/modules/auth');
  return {
    ...actual,
    rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
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

const CONTACT = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
const MEMBER = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-09-06T10:00:00Z');

function contextFor(role: string, id = `${role}-1`) {
  return {
    current: {
      user: { id, email: 'a@b.co', role, status: 'active' },
      session: { id: 's1' },
    },
    sourceIp: '203.0.113.5',
    requestId: `req-${role}`,
  };
}

const changedContact = {
  tenantId: 'test',
  contactId: CONTACT,
  memberId: MEMBER,
  firstName: 'Sec',
  lastName: 'Ondary',
  email: 'sec@example.com',
  phone: null,
  roleTitle: null,
  preferredLanguage: 'en' as const,
  dateOfBirth: null,
  linkedUserId: null,
  inviteBouncedAt: null,
  art14AttestedAt: null,
  marketing: { optedOutAt: NOW, source: 'staff' as const, byUserId: 'super_admin-1' },
  isPrimary: false,
  removedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeRequest(
  body: unknown,
  opts: { key?: string | null; contactId?: string } = {},
): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.key !== null) headers.set('idempotency-key', opts.key ?? 'key-1');
  return new NextRequest(
    `http://localhost/api/admin/contacts/${opts.contactId ?? CONTACT}/marketing`,
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
  );
}

const routeParams = (contactId = CONTACT) => Promise.resolve({ contactId });

async function loadRoute() {
  return import('@/app/api/admin/contacts/[contactId]/marketing/route');
}

describe('contract: POST /api/admin/contacts/[contactId]/marketing (108 PR-D T043)', () => {
  beforeEach(() => {
    rateLimitCheckMock.mockResolvedValue({ success: true, remaining: 59, reset: Date.now() + 60_000, fellBack: false });
    classifyMock.mockResolvedValue({ kind: 'first' });
  });
  afterEach(() => vi.clearAllMocks());

  it('gates on the literal key contacts.marketing (the real gate audits a denial with the real role)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new Response(null, { status: 403 }),
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(403);
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'contacts.marketing');
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('super_admin off → 200 { outcome: changed, contact } with the opt-out columns serialised', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('super_admin'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(
      ok({ outcome: 'changed', contact: changedContact, event: 'contact_marketing_opted_out' }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('changed');
    expect(body.contact).toMatchObject({
      contact_id: CONTACT,
      member_id: MEMBER,
      is_primary: false,
      marketing_opt_out_at: NOW.toISOString(),
      marketing_opt_out_source: 'staff',
      marketing_opt_out_by_user_id: 'super_admin-1',
    });
    // The use case receives the SESSION identity + role and source 'staff'.
    expect(setContactMarketingOptOutMock).toHaveBeenCalledWith(
      {
        contactId: CONTACT,
        state: 'off',
        actor: { userId: 'super_admin-1', role: 'super_admin', source: 'staff' },
        requestId: 'req-super_admin',
      },
      expect.anything(),
    );
    expect(rememberMock).toHaveBeenCalledWith(
      expect.anything(),
      'key-1',
      'hash',
      expect.objectContaining({ status: 200 }),
    );
  });

  it('marketing role → 200 changed (on) and 200 { outcome: unchanged } with no contact body', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('marketing'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(
      ok({ outcome: 'changed', contact: changedContact, event: 'contact_marketing_opted_in' }),
    );
    const { POST } = await loadRoute();
    const first = await POST(makeRequest({ state: 'on' }), { params: routeParams() });
    expect(first.status).toBe(200);
    expect((await first.json()).outcome).toBe('changed');
    expect(setContactMarketingOptOutMock.mock.calls[0]![0]).toMatchObject({
      state: 'on',
      actor: { role: 'marketing', source: 'staff' },
    });

    requireApiPermissionMock.mockResolvedValueOnce(contextFor('marketing'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(
      ok({ outcome: 'unchanged', contact: changedContact }),
    );
    const second = await POST(makeRequest({ state: 'on' }, { key: 'key-2' }), { params: routeParams() });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ outcome: 'unchanged' });
  });

  it('the 60/min limit is consumed BEFORE the write, keyed per tenant + user; 429 carries Retry-After', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('marketing'));
    rateLimitCheckMock.mockResolvedValueOnce({ success: false, remaining: 0, reset: Date.now() + 30_000, fellBack: false });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(rateLimitCheckMock).toHaveBeenCalledWith('contacts:marketing:test:marketing-1', 60, 60);
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('missing Idempotency-Key → 400 missing_idempotency_key; nothing consumed, nothing written', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }, { key: null }), { params: routeParams() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toMatch(/missing_idempotency_key$/);
    expect(rateLimitCheckMock).not.toHaveBeenCalled();
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('a replayed key returns the stored outcome and never reaches the use case (no second audit row)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    classifyMock.mockResolvedValueOnce({
      kind: 'replay',
      previousResponse: { status: 200, body: { outcome: 'changed', contact: { contact_id: CONTACT } } },
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('changed');
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('invalid body (state outside on|off, extra keys) → 400 invalid_body', async () => {
    const { POST } = await loadRoute();
    for (const body of [{ state: 'maybe' }, { state: 'on', extra: 1 }, {}]) {
      requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
      const res = await POST(makeRequest(body), { params: routeParams() });
      expect(res.status).toBe(400);
      expect((await res.json()).type).toMatch(/invalid_body$/);
    }
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('unknown / other-tenant contact → 404 not_found (non-disclosure) + a probe audit row with ids only', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(404);
    expect((await res.json()).type).toMatch(/not_found$/);
    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    const event = (auditRecordMock.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(event).toMatchObject({
      type: 'member_cross_tenant_probe',
      actorUserId: 'admin-1',
      requestId: 'req-admin',
      payload: { attempted_contact_id: CONTACT, actor_tenant_id: 'test' },
    });
    expect(JSON.stringify(event)).not.toContain('@');
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('a REMOVED in-tenant contact → 404 with NO probe audit (security LOW-1: the probe signal stays high-signal)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'removed' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(404);
    expect((await res.json()).type).toMatch(/not_found$/);
    expect(auditRecordMock).not.toHaveBeenCalled();
  });

  it('a failed probe audit is LOGGED, and the 404 is still served (security LOW-2)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    auditRecordMock.mockResolvedValueOnce(err({ code: 'repo.unexpected', cause: new Error('audit down') }) as never);
    const { logger } = await import('@/lib/logger');
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(404);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-admin' }),
      expect.stringMatching(/probe audit failed/),
    );
  });

  it('a non-UUID contact id → 404 without touching the use case', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }, { contactId: 'nope' }), {
      params: routeParams('nope'),
    });
    expect(res.status).toBe(404);
    expect(setContactMarketingOptOutMock).not.toHaveBeenCalled();
  });

  it('suppressed address on "on" → 409 suppressed with an explanation', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('marketing'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'suppressed' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'on' }), { params: routeParams() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.type).toMatch(/suppressed$/);
    expect(typeof body.detail).toBe('string');
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('contact opted out themself → 409 self_opted_out (staff cannot lift a personal objection)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('marketing'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'self_opted_out' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'on' }), { params: routeParams() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.type).toMatch(/self_opted_out$/);
    expect(typeof body.detail).toBe('string');
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('suppression list unreadable on "on" → 503 suppression_unavailable + Retry-After', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('marketing'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(err({ type: 'suppression_unavailable' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'on' }), { params: routeParams() });
    expect(res.status).toBe(503);
    expect((await res.json()).type).toMatch(/suppression_unavailable$/);
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  it('server_error → 500 without leaking the message', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(contextFor('admin'));
    setContactMarketingOptOutMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'set-marketing: repo.unexpected pool exhausted' }),
    );
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ state: 'off' }), { params: routeParams() });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('pool exhausted');
  });
});
