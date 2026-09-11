/**
 * F114 T029 — contract: `POST /api/portal/change-requests`
 * (contracts/portal-change-requests-api.md § 2; US1 AS1, AS3–AS5, AS7, AS8;
 * FR-036, FR-038, FR-039).
 *
 * Mocks the member context, the composition root and the use case; verifies
 * the WIRE contract: 404 while the platform flag is off (dark ship), 409
 * `approval_not_required` when the tenant gate is `immediate`, the
 * `Idempotency-Key` semantics (optional; same key + same body → the stored
 * response with NO second use-case call; same key + different body → 422
 * `idempotency-key-reused`; reservation outage → 503), the error envelope
 * `{ error: <code>, message?, issues? }`, 201 `submitted` / 200
 * `nothing_to_submit` / 200 `already_pending`, 403 `forbidden` /
 * `company_fields_require_primary` / `member_archived`, 422 `validation_error`
 * with `issues`, 429 `rate_limited` with `Retry-After`, a staff session → the
 * member-context 403, and the `errorId` taxonomy on the 500 arm. Read-only
 * mode (FR-036 / T116) is the proxy's 503 — asserted in the read-only harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const submitMock = vi.fn();
const resolveGateMock = vi.fn(async () => 'approval');
type Classification = {
  readonly kind: 'first' | 'replay' | 'conflict';
  readonly previousResponse?: { readonly status: number; readonly body: unknown };
};
const classifyMock = vi.fn(async (): Promise<Classification> => ({ kind: 'first' }));
const reserveMock = vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } }));
const rememberMock = vi.fn(async () => undefined);
const loggerError = vi.fn();
let flagOn = true;

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: new Proxy(actual.env.features, {
        get: (target, prop) => (prop === 'memberChangeApproval' ? flagOn : Reflect.get(target, prop)),
      }),
    },
  };
});
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    memberChangeGate: { resolve: (...args: unknown[]) => resolveGateMock(...(args as [])) },
    changeRequestRepo: {},
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>('@/modules/members');
  return {
    ...actual,
    submitChangeRequest: (...args: unknown[]) => submitMock(...args),
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
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

const NOW = new Date('2026-09-11T08:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

const memberContext = {
  current: { user: { id: USER, email: 'anna@nordic.example', role: 'member', status: 'active' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: MEMBER, companyName: 'Nordic Co', status: 'active' },
  memberId: MEMBER,
  ownContact: { contactId: CONTACT, memberId: MEMBER, firstName: 'Anna', lastName: 'Svensson', isPrimary: true },
  ownContactId: CONTACT,
  sourceIp: '127.0.0.1',
  requestId: 'req-1',
};

const request = {
  id: REQUEST_ID,
  tenantId: 'test-swecham',
  memberId: MEMBER,
  submittedByUserId: USER,
  submittedByContactId: CONTACT,
  submitterRoleAtSubmission: 'primary',
  scope: 'own_contact',
  state: 'pending',
  outcome: null,
  withdrawnReason: null,
  replacedByRequestId: null,
  submittedAt: NOW,
  staffNotifiedAt: NOW,
  decidedAt: null,
  decidedByUserId: null,
  decisionReason: null,
  decisionNote: null,
  withdrawnAt: null,
  outcomeAcknowledgedAt: null,
  fields: [
    { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null },
  ],
};

function makeRequest(body: unknown, opts: { key?: string | null } = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.key !== undefined && opts.key !== null) headers.set('idempotency-key', opts.key);
  return new NextRequest('http://localhost/api/portal/change-requests', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function loadRoute() {
  return import('@/app/api/portal/change-requests/route');
}

describe('contract: POST /api/portal/change-requests (F114 T029)', () => {
  beforeEach(() => {
    flagOn = true;
    requireMemberContextMock.mockResolvedValue(memberContext);
    resolveGateMock.mockResolvedValue('approval');
    classifyMock.mockResolvedValue({ kind: 'first' });
  });
  afterEach(() => vi.clearAllMocks());

  it('404 while FEATURE_MEMBER_CHANGE_APPROVAL is off — before any session work (FR-039)', async () => {
    flagOn = false;
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('a staff session gets the member-context refusal (403), never reaching the use case', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(403);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('409 approval_not_required when the tenant gate is immediate (race guard — the form resolves the gate first)', async () => {
    resolveGateMock.mockResolvedValueOnce('immediate');
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'approval_not_required' });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body on malformed JSON', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeRequest('{not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('201 submitted with the ChangeRequestView (decidedBy = organisation, submittedBy.isMe = true) and the use case receives the session role', async () => {
    submitMock.mockResolvedValueOnce(ok({ outcome: 'submitted', request, replaced: null, staffNotified: true }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }, { key: 'key-1' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      outcome: 'submitted',
      replaced: null,
      staffNotified: true,
      request: {
        id: REQUEST_ID,
        memberId: MEMBER,
        scope: 'own_contact',
        state: 'pending',
        outcome: null,
        submittedAt: NOW.toISOString(),
        submittedBy: { contactId: CONTACT, displayName: 'Anna Svensson', isMe: true },
        decidedBy: 'organisation',
        decidedAt: null,
        fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
      },
    });
    expect(body.request).not.toHaveProperty('decidedByUserId');
    expect(submitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        memberId: MEMBER,
        contactId: CONTACT,
        rawBody: { contact: { phone: '+66899999999' } },
        actorUserId: USER,
        actorRole: 'member',
        requestId: 'req-1',
      }),
    );
    expect(rememberMock).toHaveBeenCalledWith(expect.anything(), 'key-1', 'hash', expect.objectContaining({ status: 201 }));
  });

  it('200 nothing_to_submit and 200 already_pending are not errors', async () => {
    const { POST } = await loadRoute();
    submitMock.mockResolvedValueOnce(ok({ outcome: 'nothing_to_submit' }));
    const a = await POST(makeRequest({ contact: { phone: '+66812345678' } }));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ outcome: 'nothing_to_submit' });
    submitMock.mockResolvedValueOnce(ok({ outcome: 'already_pending', request }));
    const b = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ outcome: 'already_pending', request: { id: REQUEST_ID } });
  });

  it('Idempotency-Key: same key + same body replays the stored response with NO second use-case call', async () => {
    classifyMock.mockResolvedValueOnce({ kind: 'replay', previousResponse: { status: 201, body: { outcome: 'submitted', request: { id: REQUEST_ID } } } });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }, { key: 'key-1' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ outcome: 'submitted', request: { id: REQUEST_ID } });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('Idempotency-Key: same key + different body → 422 idempotency-key-reused', async () => {
    classifyMock.mockResolvedValueOnce({ kind: 'conflict' });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66877777777' } }, { key: 'key-1' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'idempotency-key-reused' });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('Idempotency-Key: a reservation outage → 503 with Retry-After (never a duplicate request)', async () => {
    reserveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'redis_unavailable', message: 'down' } } as never);
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }, { key: 'key-1' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('the header is OPTIONAL: without it the request is processed and nothing is remembered', async () => {
    submitMock.mockResolvedValueOnce(ok({ outcome: 'submitted', request, replaced: null, staffNotified: true }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(201);
    expect(classifyMock).not.toHaveBeenCalled();
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it.each([
    ['forged Group C key', { type: 'forbidden', reason: 'forged_fields', fields: ['company.tax_id'] }, 403, 'forbidden'],
    ['company key from a secondary', { type: 'forbidden', reason: 'company_fields_require_primary', fields: ['company.website'] }, 403, 'company_fields_require_primary'],
    ['contact mismatch', { type: 'forbidden', reason: 'contact_mismatch', fields: [] }, 403, 'forbidden'],
    ['archived member', { type: 'member_archived' }, 403, 'member_archived'],
    ['not found', { type: 'not_found' }, 404, 'not_found'],
  ])('maps the use-case refusal "%s" to its status + error code', async (_label, error, status, code) => {
    submitMock.mockResolvedValueOnce(err(error));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ company: { website: 'x' } }));
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error).toBe(code);
    if ('fields' in error) expect(body.fields).toEqual(error.fields);
  });

  it('422 validation_error carries the zod issues so the form can map them back to fields', async () => {
    const issues = [{ code: 'custom', path: ['contact', 'phone'], message: 'invalid phone: phone.invalid_format' }];
    submitMock.mockResolvedValueOnce(err({ type: 'validation_error', issues }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: 'nope' } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'validation_error', issues });
  });

  it('429 rate_limited carries Retry-After + retryAfterSeconds (FR-008; the durable cap lands in US5)', async () => {
    submitMock.mockResolvedValueOnce(err({ type: 'rate_limited', retryAfterSeconds: 3600, windowCount: 10 }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(await res.json()).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 3600 });
  });

  it('500 on server_error names itself in the errorId taxonomy (M114.portal.submit.*) and never leaks the message', async () => {
    submitMock.mockResolvedValueOnce(err({ type: 'server_error', message: 'submit: repo.unexpected' }));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'M114.portal.submit.use_case_failed', requestId: 'req-1' }),
      expect.any(String),
    );
  });

  it('a throwing gate resolver is a 500 with its own errorId, never a guessed mode', async () => {
    resolveGateMock.mockRejectedValueOnce(new Error('tenant_member_settings read failed'));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ contact: { phone: '+66899999999' } }));
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.portal.submit.gate_failed' }), expect.any(String));
    expect(submitMock).not.toHaveBeenCalled();
  });
});
