/**
 * F114 T083 — contract: `POST /api/portal/change-requests` on RESUBMIT
 * (contracts/portal-change-requests-api.md § 2; US5 AS2–AS4; FR-008, FR-011,
 * SC-013).
 *
 * Unlike T029 (which mocks the use case to pin the envelope), the REAL
 * `submitChangeRequest` runs here over the in-memory fakes so the wire
 * carries real behaviour:
 *   - a second submit by the same person → 201 `replaced: <previous id>`,
 *     the previous row `withdrawn/replaced` with `replaced_by_request_id`;
 *   - `staffNotified: false` when the previous `staff_notified_at` is < 1 h
 *     old — no new outbox row, the new row INHERITS the timestamp, the audit
 *     carries `coalesced: true`; > 1 h → a new email + `staffNotified: true`;
 *   - a decision that landed meanwhile is NOT withdrawn (a new request,
 *     `replaced: null`, the decided row stays decided);
 *   - the 11th CREATED request in 24 h → 429 `{ error: 'rate_limited',
 *     retryAfterSeconds }` + `Retry-After` (the same number), audited
 *     `member_change_request_rate_limited { member_id, window_count,
 *     retry_after_seconds }`, counted on `refused{rate_limited}`, nothing
 *     created or replaced, and NOT remembered under an Idempotency-Key
 *     (transient — the retry after the window must succeed);
 *   - replaced requests count toward the cap (the durable count is over
 *     ROWS, not pending rows) — the route's ATTEMPT bucket (60 / 10 min,
 *     review round 1 SEC-I2) is stubbed open here; the cap under test is the
 *     durable one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, type Result } from '@/lib/result';
import type { Member, Contact } from '@/modules/members';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import {
  makeAuditPortFake,
  makeClockFake,
  makeEmailPortFake,
  makeInMemoryChangeRequestRepo,
  makeReviewerDirectoryFake,
  makeReviewers,
  type AuditPortFake,
  type EmailPortFake,
  type InMemoryChangeRequestRepo,
} from '../../helpers/change-request-fakes';

const requireMemberContextMock = vi.fn();
const rememberMock = vi.fn(async () => undefined);
const metricRefused = vi.fn();
const loggerError = vi.fn();
let flagOn = true;
let repo: InMemoryChangeRequestRepo;
let audit: AuditPortFake;
let emails: EmailPortFake;
let clock: ReturnType<typeof makeClockFake>;
let seq = 0;

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
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    memberChangeGate: { resolve: async () => 'approval' },
    changeRequestRepo: repo,
    memberRepo: {
      findById: async (): Promise<Result<Member, RepoError>> => ok(member()),
      findByIdInTx: async (): Promise<Result<Member, RepoError>> => ok(member()),
      findErasedAtByIdInTx: async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: null }),
    },
    contactRepo: { findById: async (): Promise<Result<Contact, RepoError>> => ok(contact()) },
    audit,
    emails,
    reviewers: makeReviewerDirectoryFake(makeReviewers(2)),
    clock,
    newRequestId: () => `00000000-0000-4000-8000-0000000000${String(++seq).padStart(2, '0')}` as ChangeRequestId,
  })),
}));
vi.mock('@/lib/metrics', () => ({
  membersMetrics: {
    changeRequests: {
      refused: (...a: unknown[]) => metricRefused(...a),
      submitted: vi.fn(),
      noReviewers: vi.fn(),
      decided: vi.fn(),
      decideDurationMs: vi.fn(),
      decisionEmailSkipped: vi.fn(),
      pendingCount: vi.fn(),
      oldestAgeSeconds: vi.fn(),
    },
  },
}));
// The route's attempt bucket (review round 1, SEC-I2) — stubbed OPEN so this
// file exercises the DURABLE cap; change-requests-submit.test.ts pins the bucket.
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
    peek: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' } })),
  rememberIdempotentResponse: (...args: unknown[]) => rememberMock(...(args as [])),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/api/portal/change-requests/route';

const NOW = new Date('2026-09-11T08:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';

function member(): Member {
  return {
    tenantId: 'test-swecham',
    memberId: MEMBER,
    memberNumber: 42,
    companyName: 'Nordic Co',
    website: null,
    description: null,
    addressLine1: '1 Main Rd',
    addressLine2: null,
    city: 'Bangkok',
    province: null,
    postalCode: '10110',
    subDistrict: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingSubDistrict: null,
    billingCity: null,
    billingProvince: null,
    billingPostalCode: null,
    billingCountry: null,
    status: 'active',
    archivedAt: null,
  } as Member;
}

function contact(): Contact {
  return {
    contactId: CONTACT,
    memberId: MEMBER,
    firstName: 'Anna',
    lastName: 'Svensson',
    email: 'anna@nordic.example',
    phone: '+66812345678',
    roleTitle: null,
    preferredLanguage: 'sv',
    linkedUserId: USER,
    isPrimary: true,
    removedAt: null,
  } as Contact;
}

const memberContext = {
  current: { user: { id: USER, email: 'anna@nordic.example', role: 'member', status: 'active' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: MEMBER, companyName: 'Nordic Co', status: 'active' },
  memberId: MEMBER,
  ownContact: { contactId: CONTACT, memberId: MEMBER, firstName: 'Anna', lastName: 'Svensson', isPrimary: true },
  ownContactId: CONTACT,
  sourceIp: '127.0.0.1',
  requestId: 'req-rp-1',
};

async function submit(phone: string, opts: { key?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.key) headers.set('idempotency-key', opts.key);
  const res = await POST(new NextRequest('http://localhost/api/portal/change-requests', { method: 'POST', headers, body: JSON.stringify({ contact: { phone } }) }));
  return { res, body: (await res.json()) as Record<string, unknown> & { request?: { id: string; state: string } } };
}

beforeEach(() => {
  flagOn = true;
  seq = 0;
  repo = makeInMemoryChangeRequestRepo();
  audit = makeAuditPortFake();
  emails = makeEmailPortFake();
  clock = makeClockFake(NOW);
  requireMemberContextMock.mockResolvedValue(memberContext);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/portal/change-requests — resubmit replaces, coalesces, and is capped (US5)', () => {
  it('a second submit replaces the first: 201 replaced=<id>, previous withdrawn/replaced with the pointer; within 1 h staffNotified=false, no new outbox row, staff_notified_at inherited, audit coalesced', async () => {
    const first = await submit('+66899999999');
    expect(first.res.status).toBe(201);
    const firstId = first.body.request!.id;
    expect(emails.enqueued).toHaveLength(2);

    clock.set(new Date(NOW.getTime() + 20 * MINUTE));
    const second = await submit('+66877777777');
    expect(second.res.status).toBe(201);
    expect(second.body).toMatchObject({ outcome: 'submitted', replaced: firstId, staffNotified: false });
    expect(repo.rows.get(firstId)).toMatchObject({ state: 'withdrawn', withdrawnReason: 'replaced', replacedByRequestId: second.body.request!.id });
    expect(repo.rows.get(second.body.request!.id)).toMatchObject({ state: 'pending', staffNotifiedAt: NOW });
    expect(emails.enqueued).toHaveLength(2);
    expect(audit.events.map((e) => e.type)).toEqual(['member_change_request_submitted', 'member_change_request_withdrawn', 'member_change_request_submitted']);
    expect(audit.events[2]).toMatchObject({ payload: { replaced_request_id: firstId, coalesced: true } });
  });

  it('more than 1 h after the last staff notification: a new email per reviewer, staffNotified=true', async () => {
    const first = await submit('+66899999999');
    clock.set(new Date(NOW.getTime() + HOUR + MINUTE));
    const second = await submit('+66877777777');
    expect(second.res.status).toBe(201);
    expect(second.body).toMatchObject({ replaced: first.body.request!.id, staffNotified: true });
    expect(emails.enqueued).toHaveLength(4);
    expect(repo.rows.get(second.body.request!.id)?.staffNotifiedAt).toEqual(new Date(NOW.getTime() + HOUR + MINUTE));
  });

  it('a decision that landed meanwhile is not withdrawn: the resubmit is a NEW request with replaced=null and the decided row stays decided (US5 AS4)', async () => {
    const first = await submit('+66899999999');
    const firstId = first.body.request!.id;
    const row = repo.rows.get(firstId)!;
    repo.rows.set(firstId, {
      ...row,
      state: 'decided',
      outcome: 'rejected',
      decidedAt: NOW,
      decidedByUserId: 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId,
      decisionReason: 'Use the registered number',
      fields: row.fields.map((f) => ({ ...f, outcome: 'rejected' as const })),
    });
    const second = await submit('+66877777777');
    expect(second.res.status).toBe(201);
    expect(second.body).toMatchObject({ replaced: null, staffNotified: true });
    expect(repo.rows.get(firstId)?.state).toBe('decided');
    expect([...repo.rows.values()].filter((r) => r.state === 'pending')).toHaveLength(1);
  });

  it('the 11th request in 24 h → 429 rate_limited + Retry-After (from the oldest row); nothing created or replaced; audited; counted; replaced rows count', async () => {
    for (let i = 0; i < 10; i += 1) {
      clock.set(new Date(NOW.getTime() + i * MINUTE));
      const { res } = await submit(`+6689999${String(1000 + i).slice(1)}`);
      expect(res.status).toBe(201);
    }
    const pendingId = [...repo.rows.values()].find((r) => r.state === 'pending')!.id;
    const now = new Date(NOW.getTime() + 10 * MINUTE);
    clock.set(now);
    const { res, body } = await submit('+66811111111', { key: 'idem-cap' });
    expect(res.status).toBe(429);
    const expectedRetry = Math.ceil((NOW.getTime() + 24 * HOUR - now.getTime()) / 1000);
    expect(body).toEqual({ error: 'rate_limited', retryAfterSeconds: expectedRetry });
    expect(res.headers.get('Retry-After')).toBe(String(expectedRetry));
    expect(repo.rows.size).toBe(10);
    expect(repo.rows.get(pendingId)?.state).toBe('pending');
    expect([...repo.rows.values()].filter((r) => r.withdrawnReason === 'replaced')).toHaveLength(9);
    expect(audit.events.at(-1)).toMatchObject({
      type: 'member_change_request_rate_limited',
      actorUserId: USER,
      payload: { related_member_id: MEMBER, window_count: 10, retry_after_seconds: expectedRetry, actor_role: 'member' },
    });
    expect(metricRefused).toHaveBeenCalledWith('test-swecham', 'rate_limited');
    // transient: never remembered under the key, so the retry after the window is not replayed as a 429
    expect(rememberMock).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('after the window rolls the same person submits again — 201', async () => {
    for (let i = 0; i < 10; i += 1) {
      clock.set(new Date(NOW.getTime() + i * MINUTE));
      await submit(`+6689999${String(1000 + i).slice(1)}`);
    }
    clock.set(new Date(NOW.getTime() + 24 * HOUR + 1000));
    const { res } = await submit('+66811111111');
    expect(res.status).toBe(201);
    expect(repo.rows.size).toBe(11);
  });

  it('404 while the flag is off — before the member context', async () => {
    flagOn = false;
    const { res } = await submit('+66899999999');
    expect(res.status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
  });
});
