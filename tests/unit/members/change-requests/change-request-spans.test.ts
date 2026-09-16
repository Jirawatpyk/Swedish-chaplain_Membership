/**
 * F114 T106 — OTel spans on the two transactional use cases
 * (`docs/observability.md` § 27 — tracer `swecham.members`).
 *
 *   `members.change_request.submit` wraps `submitChangeRequest`'s transaction;
 *   `members.change_request.decide` wraps `decideChangeRequest`'s.
 *
 * Attribute contract (§ 27.5 — ids, keys and outcomes only): the KEYS are
 * exactly `tenant.slug`, `change_request.id`, `change_request.scope`,
 * `change_request.field_count` (+ `change_request.outcome` on decide) and no
 * attribute VALUE ever equals a proposed field value, the reviewer's reason
 * or note, an email or a user id. The span is ended on every path.
 *
 * STATUS (PR-3 review B10): `SpanStatusCode.ERROR` means the system failed —
 * `server_error` and an escaped throw, nothing else. Every EXPECTED refusal
 * (`member_archived`, `rate_limited`, `not_found`, `already_decided`, a
 * validation error …) is the product working: the request was refused for a
 * stated reason and the caller was told. Marking those ERROR made the two
 * F114 spans' error rate a measure of how often members mistype a phone
 * number, which is not a signal anyone can act on and buries the one that is.
 * A refusal sets `change_request.refusal = <type>` instead and leaves the
 * status UNSET, so a dashboard can still slice by refusal reason.
 *
 * The tracer is a spy (`vi.mock('@/lib/otel-tracer')`) — the use cases run
 * for real over the in-memory fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { ok, type Result } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  membersMetrics: {
    changeRequests: {
      submitted: vi.fn(),
      refused: vi.fn(),
      noReviewers: vi.fn(),
      decided: vi.fn(),
      decideDurationMs: vi.fn(),
      decisionEmailSkipped: vi.fn(),
      pendingCount: vi.fn(),
      oldestAgeSeconds: vi.fn(),
    },
  },
}));

type SpanRecord = {
  name: string;
  attributes: Record<string, unknown>;
  statuses: Array<{ code: SpanStatusCode; message?: string }>;
  exceptions: unknown[];
  ended: number;
};
const spans: SpanRecord[] = [];
vi.mock('@/lib/otel-tracer', () => ({
  membersTracer: () => ({
    startActiveSpan: (
      name: string,
      options: { attributes?: Record<string, unknown> },
      fn: (span: {
        setAttribute: (k: string, v: unknown) => void;
        setStatus: (s: { code: SpanStatusCode; message?: string }) => void;
        recordException: (e: unknown) => void;
        end: () => void;
      }) => Promise<unknown>,
    ) => {
      const rec: SpanRecord = { name, attributes: { ...(options.attributes ?? {}) }, statuses: [], exceptions: [], ended: 0 };
      spans.push(rec);
      return fn({
        setAttribute: (k, v) => {
          rec.attributes[k] = v;
        },
        setStatus: (s) => {
          rec.statuses.push(s);
        },
        recordException: (e) => {
          rec.exceptions.push(e);
        },
        end: () => {
          rec.ended += 1;
        },
      });
    },
  }),
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId, type Member, type Contact } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { submitChangeRequest, type SubmitChangeRequestDeps } from '@/modules/members/application/use-cases/change-requests/submit-change-request';
import { decideChangeRequest, type DecideChangeRequestDeps } from '@/modules/members/application/use-cases/change-requests/decide-change-request';
import { makeAuditPortFake, makeClockFake, makeEmailPortFake, makeInMemoryChangeRequestRepo, makeReviewerDirectoryFake, makeReviewers } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId;
const REQ = '00000000-0000-4000-8000-000000000001' as ChangeRequestId;
const NOW = new Date('2026-09-15T08:00:00Z');
const PROPOSED_PHONE = '+66899999999';
const SECRET_REASON = 'SECRET-REASON';
const SECRET_NOTE = 'SECRET-NOTE';

const SUBMIT_KEYS = ['tenant.slug', 'change_request.id', 'change_request.scope', 'change_request.field_count'];
const DECIDE_KEYS = [...SUBMIT_KEYS, 'change_request.outcome'];

const member = (): Member =>
  ({
    tenantId: 'test-tenant',
    memberId: MEMBER,
    memberNumber: 42,
    companyName: 'Nordic Co',
    country: 'TH',
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
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as Member;

const contact = (): Contact =>
  ({
    tenantId: 'test-tenant',
    contactId: CONTACT,
    memberId: MEMBER,
    firstName: 'Anna',
    lastName: 'Svensson',
    email: 'anna@nordic.example',
    phone: '+66812345678',
    roleTitle: null,
    preferredLanguage: 'en',
    linkedUserId: USER,
    isPrimary: true,
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as Contact;

const pendingRequest = (): ChangeRequest => ({
  id: REQ,
  tenantId: 'test-tenant' as ChangeRequest['tenantId'],
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
  fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: PROPOSED_PHONE, affectsTaxDocuments: false, outcome: null, appliedAt: null }],
});

function submitDeps(opts: { memberInTx?: Member } = {}) {
  const m = member();
  const memberRepo = {
    findById: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    findByIdInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(opts.memberInTx ?? m)),
    findErasedAtByIdInTx: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: null })),
  };
  const deps = {
    tenant,
    changeRequestRepo: makeInMemoryChangeRequestRepo(),
    memberRepo,
    contactRepo: { findById: vi.fn(async (): Promise<Result<Contact, RepoError>> => ok(contact())) },
    audit: makeAuditPortFake(),
    emails: makeEmailPortFake(),
    reviewers: makeReviewerDirectoryFake(makeReviewers(1)),
    clock: makeClockFake(NOW),
    newRequestId: () => REQ,
  } as unknown as SubmitChangeRequestDeps;
  return deps;
}

function decideDeps(seed: ChangeRequest = pendingRequest()) {
  const m = member();
  const c = contact();
  return {
    tenant,
    changeRequestRepo: makeInMemoryChangeRequestRepo([seed]),
    memberRepo: {
      findByIdInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
      findErasedAtByIdInTx: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: null })),
      updateFieldsInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    },
    contactRepo: {
      listByMemberInTx: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok([c])),
      updateInTx: vi.fn(async (): Promise<Result<Contact, RepoError>> => ok(c)),
    },
    audit: makeAuditPortFake(),
    emails: makeEmailPortFake(),
    clock: makeClockFake(NOW),
  } as unknown as DecideChangeRequestDeps;
}

/** Every attribute value, stringified — the redaction assertion reads these. */
function attributeValues(rec: SpanRecord): string[] {
  return Object.values(rec.attributes).map((v) => String(v));
}

beforeEach(() => {
  vi.clearAllMocks();
  spans.length = 0;
});

describe('members.change_request.submit', () => {
  it('a created request: one span named members.change_request.submit with exactly the four bounded attribute keys — never the proposed value, the email or a user id', async () => {
    const r = await submitChangeRequest(submitDeps(), { memberId: MEMBER, contactId: CONTACT, rawBody: { contact: { phone: PROPOSED_PHONE } }, actorUserId: USER, actorRole: 'member', requestId: 'req-1' });
    expect(r.ok && r.value.outcome).toBe('submitted');
    expect(spans.map((s) => s.name)).toEqual(['members.change_request.submit']);
    const span = spans[0]!;
    expect(Object.keys(span.attributes).sort()).toEqual([...SUBMIT_KEYS].sort());
    expect(span.attributes).toMatchObject({ 'tenant.slug': 'test-tenant', 'change_request.id': REQ, 'change_request.scope': 'own_contact', 'change_request.field_count': 1 });
    for (const v of attributeValues(span)) {
      expect(v).not.toContain(PROPOSED_PHONE);
      expect(v).not.toContain('@');
      expect(v).not.toBe(USER);
    }
    expect(span.statuses.some((s) => s.code === SpanStatusCode.ERROR)).toBe(false);
    expect(span.ended).toBe(1);
  });

  it('a refusal inside the transaction (archived by a concurrent transition) is NOT an ERROR — it is an attribute, and the span still ends', async () => {
    const deps = submitDeps({ memberInTx: { ...member(), status: 'archived' } as Member });
    const r = await submitChangeRequest(deps, { memberId: MEMBER, contactId: CONTACT, rawBody: { contact: { phone: PROPOSED_PHONE } }, actorUserId: USER, actorRole: 'member', requestId: 'req-2' });
    expect(r).toEqual({ ok: false, error: { type: 'member_archived' } });
    const span = spans[0]!;
    // the product refused, correctly, for a stated reason: status UNSET
    expect(span.statuses).toEqual([]);
    expect(span.attributes['change_request.refusal']).toBe('member_archived');
    expect(span.ended).toBe(1);
    for (const v of attributeValues(span)) expect(v).not.toContain(PROPOSED_PHONE);
  });

  it('a server_error IS an ERROR — the one arm that means the system failed', async () => {
    const deps = submitDeps();
    (deps.changeRequestRepo as unknown as { insertInTx: unknown }).insertInTx = async () => ({ ok: false as const, error: { code: 'repo.unexpected' as const } });
    const r = await submitChangeRequest(deps, { memberId: MEMBER, contactId: CONTACT, rawBody: { contact: { phone: PROPOSED_PHONE } }, actorUserId: USER, actorRole: 'member', requestId: 'req-2b' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
    const span = spans[0]!;
    expect(span.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: 'server_error' }]);
    // never BOTH: a failure is not also a refusal reason
    expect(span.attributes).not.toHaveProperty('change_request.refusal');
    expect(span.ended).toBe(1);
  });

  it('a refusal BEFORE the transaction (forged keys) opens no span at all — the span is the transaction', async () => {
    const r = await submitChangeRequest(submitDeps(), { memberId: MEMBER, contactId: CONTACT, rawBody: { company: { tax_id: 'x' } }, actorUserId: USER, actorRole: 'member', requestId: 'req-3' });
    expect(r.ok).toBe(false);
    expect(spans).toHaveLength(0);
  });
});

describe('members.change_request.decide', () => {
  const decision = (reason: string | null, note: string | null) => ({
    changeRequestId: REQ,
    decisions: [{ key: 'phone', outcome: 'rejected' as const }],
    reason,
    note,
    actorUserId: REVIEWER,
    actorRole: 'admin' as const,
    requestId: 'req-d1',
  });

  it('a recorded decision: one span with the five bounded keys, outcome = the recorded outcome; the reason and the note appear in NO attribute', async () => {
    const r = await decideChangeRequest(decideDeps(), decision(SECRET_REASON, SECRET_NOTE));
    expect(r.ok && r.value.request.outcome).toBe('rejected');
    expect(spans.map((s) => s.name)).toEqual(['members.change_request.decide']);
    const span = spans[0]!;
    expect(Object.keys(span.attributes).sort()).toEqual([...DECIDE_KEYS].sort());
    expect(span.attributes).toMatchObject({ 'tenant.slug': 'test-tenant', 'change_request.id': REQ, 'change_request.scope': 'own_contact', 'change_request.field_count': 1, 'change_request.outcome': 'rejected' });
    for (const v of attributeValues(span)) {
      expect(v).not.toContain('SECRET');
      expect(v).not.toContain(PROPOSED_PHONE);
      expect(v).not.toBe(REVIEWER);
    }
    expect(span.statuses.some((s) => s.code === SpanStatusCode.ERROR)).toBe(false);
    expect(span.ended).toBe(1);
  });

  it('a refused decision (unknown id) is an attribute, not an ERROR — and the reason text reaches NO attribute', async () => {
    const r = await decideChangeRequest(decideDeps(), { ...decision(SECRET_REASON, null), changeRequestId: '00000000-0000-4000-8000-0000000000ff' as ChangeRequestId });
    expect(r).toEqual({ ok: false, error: { type: 'not_found' } });
    const span = spans[0]!;
    expect(span.statuses).toEqual([]);
    expect(span.attributes['change_request.refusal']).toBe('not_found');
    expect(span.ended).toBe(1);
    expect(JSON.stringify(span)).not.toContain('SECRET');
  });

  it('a repo FAULT is the ERROR arm, and the reason still reaches no attribute or status', async () => {
    const deps = decideDeps();
    (deps.changeRequestRepo as unknown as { decideInTx: unknown }).decideInTx = async () => ({ ok: false as const, error: { code: 'repo.unexpected' as const } });
    const r = await decideChangeRequest(deps, decision(SECRET_REASON, SECRET_NOTE));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
    const span = spans[0]!;
    expect(span.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: 'server_error' }]);
    expect(span.attributes).not.toHaveProperty('change_request.refusal');
    expect(span.ended).toBe(1);
    expect(JSON.stringify(span)).not.toContain('SECRET');
  });
});

/**
 * PR-3 review B10 — a THROW inside the transaction.
 *
 * Both use cases convert every fault to a `Result` inside their own
 * `decideTransaction` / `submitTransaction` body, so a throw never escapes to
 * the span callback; the callback's `catch` is defence-in-depth for what
 * bypasses that contract (an OOM, a tracer-internal throw, a later edit that
 * moves a statement above the try), `v8 ignore`d like the payments idiom it
 * mirrors (`confirm-payment.ts`). What IS observable is pinned here: a throw
 * carrying the reviewer's reason as its MESSAGE ends the span exactly once,
 * marks it ERROR as a `server_error`, and puts that message nowhere.
 */
describe('a throw inside the transaction still ends the span, and leaks no message', () => {
  it('the thrown message never reaches a status, an attribute or a recorded exception', async () => {
    const deps = decideDeps();
    (deps.changeRequestRepo as unknown as { findByIdInTx: unknown }).findByIdInTx = async () => {
      throw new EvalError(SECRET_REASON);
    };
    const r = await decideChangeRequest(deps, {
      changeRequestId: REQ,
      decisions: [{ key: 'phone', outcome: 'rejected' as const }],
      reason: SECRET_REASON,
      note: null,
      actorUserId: REVIEWER,
      actorRole: 'admin' as const,
      requestId: 'req-d2',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
    const span = spans[0]!;
    expect(span.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: 'server_error' }]);
    expect(span.exceptions).toEqual([]);
    expect(span.ended).toBe(1);
    expect(JSON.stringify(span)).not.toContain('SECRET');
  });
});
