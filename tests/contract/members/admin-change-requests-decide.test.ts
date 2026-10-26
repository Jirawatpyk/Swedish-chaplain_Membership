/**
 * F114 T045 — contract: `POST /api/admin/change-requests/[id]/decide`
 * (contracts/admin-change-requests-api.md § decide; US2 AS1–AS9; FR-013–
 * FR-018, FR-020, FR-039).
 *
 * The REAL `decideChangeRequest` runs over in-memory fakes (the composition
 * root is mocked to hand them out; `runInTenant` is a pass-through), so the
 * status codes below are pinned against real use-case behaviour, not a mock
 * of it: approve all → 200 `approved`; some de-selected + reason → 200
 * `partially_approved` with `applied` / `rejected`; `decisions` missing a
 * field → 422 `decisions_incomplete`; rejected without reason → 422
 * `reason_required`; reason > 1000 → 422; identical repeat → 200 `repeated:
 * true` (no second application / audit / email); different repeat → 409
 * `already_decided { decidedBy, decidedAt, outcome }`; archived → 409
 * `member_archived`; erasing → 409 `member_erasing`; approving a
 * removed-contact row → 422 `contact_removed`; withdrawn → 409 `not_pending`;
 * flag OFF → 404 BEFORE the gate; the route hands the gate the literal key
 * `members.write` and passes its 403 through (the denial + `permission_denied`
 * audit with the real role is the gate's own contract —
 * tests/contract/rbac/permission-denied-audit.test.ts); the 500 arm names
 * itself (`M114.admin.decide.use_case_failed`). Read-only mode (FR-036 /
 * T116) is the proxy's 503 — asserted in the read-only harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, type Result } from '@/lib/result';
import type { Member, Contact } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import {
  makeAuditPortFake,
  makeClockFake,
  makeEmailPortFake,
  makeInMemoryChangeRequestRepo,
  type AuditPortFake,
  type EmailPortFake,
  type InMemoryChangeRequestRepo,
} from '../../helpers/change-request-fakes';

const requireApiPermissionMock = vi.fn();
const loggerError = vi.fn();
let flagOn = true;
let readOnly = false;
let fakes: {
  repo: InMemoryChangeRequestRepo;
  audit: AuditPortFake;
  emails: EmailPortFake;
  memberRepo: {
    findById: ReturnType<typeof vi.fn>;
    findByIdInTx: ReturnType<typeof vi.fn>;
    findErasedAtByIdInTx: ReturnType<typeof vi.fn>;
    updateFieldsInTx: ReturnType<typeof vi.fn>;
  };
  contactRepo: { listByMember: ReturnType<typeof vi.fn>; listByMemberInTx: ReturnType<typeof vi.fn>; updateInTx: ReturnType<typeof vi.fn> };
};

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: new Proxy(actual.env.features, {
        get: (target, prop) => (prop === 'memberChangeApproval' ? flagOn : Reflect.get(target, prop)),
      }),
      flags: new Proxy(actual.env.flags, {
        get: (target, prop) => (prop === 'readOnlyMode' ? readOnly : Reflect.get(target, prop)),
      }),
    },
  };
});
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  return {
    ...actual,
    requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
  };
});
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    changeRequestRepo: fakes.repo,
    memberRepo: fakes.memberRepo,
    contactRepo: fakes.contactRepo,
    audit: fakes.audit,
    emails: fakes.emails,
    clock: makeClockFake(NOW),
  })),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/api/admin/change-requests/[id]/decide/route';

const NOW = new Date('2026-09-11T09:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const REQ = '00000000-0000-4000-8000-000000000001';

const staffContext = (role: string) => ({
  current: { user: { id: REVIEWER, email: 'staff@swecham.example', role, status: 'active' }, session: { id: 's-1' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-d1',
});

function member(overrides: Partial<Member> = {}): Member {
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
    ...overrides,
  } as Member;
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    contactId: CONTACT,
    memberId: MEMBER,
    firstName: 'Anna',
    lastName: 'Svensson',
    email: 'anna@nordic.example',
    phone: '+66812345678',
    roleTitle: null,
    preferredLanguage: 'sv',
    linkedUserId: SUBMITTER,
    isPrimary: true,
    removedAt: null,
    ...overrides,
  } as Contact;
}

function pending(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: REQ as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: SUBMITTER as UserId,
    submittedByContactId: CONTACT as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'mixed',
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
      { key: 'description', target: 'member', seen: null, proposed: 'A new description', affectsTaxDocuments: false, outcome: null, appliedAt: null },
    ],
    ...overrides,
  };
}

function seed(opts: { request?: ChangeRequest; member?: Member; contacts?: Contact[]; erasedAt?: Date | null } = {}) {
  const m = opts.member ?? member();
  const cs = opts.contacts ?? [contact()];
  const repo = makeInMemoryChangeRequestRepo([opts.request ?? pending()]);
  repo.display.users.set(REVIEWER, { displayName: 'Sven Reviewer', deactivated: false });
  fakes = {
    repo,
    audit: makeAuditPortFake(),
    emails: makeEmailPortFake(),
    memberRepo: {
      findById: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
      findByIdInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
      findErasedAtByIdInTx: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: opts.erasedAt ?? null })),
      updateFieldsInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>): Promise<Result<Member, RepoError>> => ok({ ...m, ...patch } as Member)),
    },
    contactRepo: {
      listByMember: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok(cs)),
      listByMemberInTx: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok(cs)),
      updateInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>): Promise<Result<Contact, RepoError>> => ok({ ...cs[0]!, ...patch } as Contact)),
    },
  };
}

function call(body: unknown, id = REQ): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/admin/change-requests/${id}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

const APPROVE_ALL = { decisions: [{ key: 'phone', outcome: 'approved' }, { key: 'description', outcome: 'approved' }], reason: null, note: null };
const PARTIAL = { decisions: [{ key: 'phone', outcome: 'approved' }, { key: 'description', outcome: 'rejected' }], reason: 'Use the registered description', note: 'checked' };

beforeEach(() => {
  flagOn = true;
  readOnly = false;
  seed();
  requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/change-requests/[id]/decide — round 5 (toolkit review)', () => {
  it('the lock-race LOSER (decideInTx finds no pending row) → 409 already_decided filled from the recorded row (FR-018), the use case having only nulls (round 6, tests Q-4)', async () => {
    fakes.repo.failNext('decideInTx', { code: 'repo.not_found' });
    const winnerRow = { ...fakes.repo.rows.get(REQ)!, state: 'decided' as const, outcome: 'approved' as const, decidedAt: new Date('2026-09-11T09:00:00Z'), decidedByUserId: REVIEWER as ChangeRequest['decidedByUserId'] };
    const original = fakes.repo.findListRowById.bind(fakes.repo);
    fakes.repo.findListRowById = async (tenant, id) => {
      const r = await original(tenant, id);
      return r.ok ? ok({ ...r.value, request: winnerRow, decidedBy: { displayName: 'Sven Reviewer', deactivated: false } }) : r;
    };
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      type: expect.stringMatching(/already_decided$/),
      decidedBy: { displayName: 'Sven Reviewer' },
      decidedAt: '2026-09-11T09:00:00.000Z',
      outcome: 'approved',
    });
  });

  it('an EMPTY decisions array is a 422 at the body schema (types F5: a zero-field decision must never reach the use case)', async () => {
    const res = await call({ decisions: [], reason: null, note: null });
    expect(res.status).toBe(422);
    expect(fakes.repo.rows.get(REQ)?.state).toBe('pending');
  });

  it('a view re-read fault AFTER the commit answers 200 with the bare request and viewUnavailable: true — never a fabricated member', async () => {
    fakes.repo.failNext('findListRowById');
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: { id: string; outcome: string | null; member?: unknown }; viewUnavailable?: boolean };
    expect(body.viewUnavailable).toBe(true);
    expect(body.request.id).toBe(REQ);
    expect(body.request.outcome).toBe('approved');
    expect(JSON.stringify(body)).not.toContain('"memberNumber":0');
    expect(JSON.stringify(body)).not.toContain('"companyName":""');
    expect(fakes.repo.rows.get(REQ)?.state).toBe('decided');
  });
});

describe('POST /api/admin/change-requests/[id]/decide — gates', () => {
  it('404 while the platform flag is off — before the permission gate runs (FR-039)', async () => {
    flagOn = false;
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(404);
    expect(requireApiPermissionMock).not.toHaveBeenCalled();
  });

  it("hands the gate the literal key 'members.write' and passes its 403 through", async () => {
    requireApiPermissionMock.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(403);
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'members.write');
    expect(fakes.repo.rows.get(REQ)?.state).toBe('pending');
  });

  it('READ_ONLY_MODE → 503 read_only_mode after the gate, nothing decided (FR-036 / T116)', async () => {
    readOnly = true;
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toMatchObject({ error: { code: 'read_only_mode' } });
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'members.write');
    expect(fakes.repo.rows.get(REQ)?.state).toBe('pending');
    expect(fakes.audit.events).toHaveLength(0);
  });

  it('a malformed id → 404 problem; a non-JSON body → 400; a body failing the schema → 422 validation_error', async () => {
    expect((await call(APPROVE_ALL, 'not-a-uuid')).status).toBe(404);
    const bad = await call('{nope');
    expect(bad.status).toBe(400);
    const schema = await call({ decisions: [{ key: 'phone', outcome: 'maybe' }] });
    expect(schema.status).toBe(422);
    expect(await schema.json()).toMatchObject({ type: expect.stringMatching(/validation_error$/), status: 422 });
  });
});

describe('POST /api/admin/change-requests/[id]/decide — decisions', () => {
  it('approve all → 200 approved: every field applied, the staff view carries the reviewer, one member email queued', async () => {
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      repeated: false,
      applied: ['phone', 'description'],
      rejected: [],
      request: {
        id: REQ,
        state: 'decided',
        outcome: 'approved',
        decidedAt: NOW.toISOString(),
        decidedBy: { displayName: 'Sven Reviewer', deactivated: false },
        submittedBy: { displayName: 'Submitter', roleAtSubmission: 'primary' },
      },
    });
    expect(body.request.fields.map((f: { key: string; outcome: string; appliedAt: string | null }) => [f.key, f.outcome, f.appliedAt])).toEqual([
      ['phone', 'approved', NOW.toISOString()],
      ['description', 'approved', NOW.toISOString()],
    ]);
    expect(fakes.contactRepo.updateInTx).toHaveBeenCalledWith({ __tx: true }, CONTACT, { phone: '+66899999999' });
    expect(fakes.memberRepo.updateFieldsInTx).toHaveBeenCalledWith({ __tx: true }, MEMBER, { description: 'A new description' });
    expect(fakes.audit.events).toHaveLength(1);
    expect(fakes.audit.events[0]).toMatchObject({
      type: 'member_change_request_decided',
      actorUserId: REVIEWER,
      payload: { related_member_id: MEMBER, request_id: REQ, outcome: 'approved', actor_role: 'admin' },
    });
    expect(fakes.emails.enqueued).toEqual([
      expect.objectContaining({ type: 'member_change_request_decided_member', toEmail: 'anna@nordic.example', locale: 'sv' }),
    ]);
  });

  it('super_admin decides too (the gate answers by permission, not by role literal)', async () => {
    requireApiPermissionMock.mockResolvedValue(staffContext('super_admin'));
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(200);
    expect(fakes.audit.events[0]?.payload).toMatchObject({ actor_role: 'super_admin' });
  });

  it('some de-selected + reason → 200 partially_approved with applied / rejected lists', async () => {
    const res = await call(PARTIAL);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      applied: ['phone'],
      rejected: ['description'],
      request: { outcome: 'partially_approved', decisionReason: 'Use the registered description', decisionNote: 'checked' },
    });
    expect(fakes.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('US3 (T059): every row rejected + reason → 200 rejected — member row untouched, the member email row present', async () => {
    const res = await call({ decisions: [{ key: 'phone', outcome: 'rejected' }, { key: 'description', outcome: 'rejected' }], reason: 'Please use the registered phone number', note: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ repeated: false, applied: [], rejected: ['phone', 'description'], request: { outcome: 'rejected', decisionReason: 'Please use the registered phone number' } });
    expect(body.request.fields.map((f: { outcome: string; appliedAt: string | null }) => [f.outcome, f.appliedAt])).toEqual([['rejected', null], ['rejected', null]]);
    expect(fakes.contactRepo.updateInTx).not.toHaveBeenCalled();
    expect(fakes.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
    expect(fakes.emails.enqueued).toEqual([expect.objectContaining({ type: 'member_change_request_decided_member', toEmail: 'anna@nordic.example' })]);
    expect(fakes.audit.events[0]?.payload).toMatchObject({ outcome: 'rejected', reason_length: 'Please use the registered phone number'.length });
  });

  it('decisions missing a field → 422 decisions_incomplete naming the missing keys', async () => {
    const res = await call({ decisions: [{ key: 'phone', outcome: 'approved' }], reason: null, note: null });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ type: expect.stringMatching(/decisions_incomplete$/), missing: ['description'], unknown: [] });
    expect(fakes.repo.rows.get(REQ)?.state).toBe('pending');
  });

  it('rejected without a reason → 422 reason_required; reason > 1000 → 422 reason_too_long', async () => {
    const a = await call({ ...PARTIAL, reason: null });
    expect(a.status).toBe(422);
    expect(await a.json()).toMatchObject({ type: expect.stringMatching(/reason_required$/) });
    const b = await call({ ...PARTIAL, reason: 'x'.repeat(1001) });
    expect(b.status).toBe(422);
    expect(await b.json()).toMatchObject({ type: expect.stringMatching(/reason_too_long$/), field: 'reason', max: 1000 });
  });

  it('an identical repeat → 200 repeated: true with the recorded decision — no second application / audit / email', async () => {
    expect((await call(PARTIAL)).status).toBe(200);
    const res = await call(PARTIAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repeated: true, request: { outcome: 'partially_approved' } });
    expect(fakes.audit.events).toHaveLength(1);
    expect(fakes.emails.enqueued).toHaveLength(1);
    expect(fakes.contactRepo.updateInTx).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT decision on a decided request → 409 already_decided { decidedBy, decidedAt, outcome }', async () => {
    expect((await call(PARTIAL)).status).toBe(200);
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      type: expect.stringMatching(/already_decided$/),
      decidedBy: { displayName: 'Sven Reviewer', deactivated: false },
      decidedAt: NOW.toISOString(),
      outcome: 'partially_approved',
    });
  });

  it('withdrawn → 409 not_pending', async () => {
    seed({ request: pending({ state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: NOW }) });
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ type: expect.stringMatching(/not_pending$/) });
  });

  it('archived → 409 member_archived; erasing → 409 member_erasing; unknown id → 404', async () => {
    seed({ member: member({ status: 'archived', archivedAt: NOW } as Partial<Member>) });
    const a = await call(APPROVE_ALL);
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ type: expect.stringMatching(/member_archived$/) });
    seed({ erasedAt: NOW });
    const b = await call(APPROVE_ALL);
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ type: expect.stringMatching(/member_erasing$/) });
    const c = await call(APPROVE_ALL, '00000000-0000-4000-8000-0000000000ff');
    expect(c.status).toBe(404);
  });

  it('approving a row whose contact was removed → 422 contact_removed naming the key; rejecting it is fine', async () => {
    seed({ contacts: [contact({ removedAt: NOW, isPrimary: false } as Partial<Contact>)] });
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ type: expect.stringMatching(/contact_removed$/), keys: ['phone'] });
    const rej = await call({ decisions: [{ key: 'phone', outcome: 'rejected' }, { key: 'description', outcome: 'approved' }], reason: 'contact left', note: null });
    expect(rej.status).toBe(200);
    expect(fakes.emails.enqueued).toHaveLength(0); // recipient gone → no member email
  });

  it('approval-time re-validation failure → 422 validation_error naming the field', async () => {
    seed({
      request: pending({
        fields: [{ key: 'website', target: 'member', seen: null, proposed: 'javascript:alert(1)', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
      }),
    });
    const res = await call({ decisions: [{ key: 'website', outcome: 'approved' }], reason: null, note: null });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ type: expect.stringMatching(/validation_error$/) });
    expect(JSON.stringify(body.issues)).toContain('website');
  });

  it('a use-case fault → 500 problem naming itself in the errorId taxonomy; nothing decided', async () => {
    fakes.repo.failNext('findByIdInTx');
    const res = await call(APPROVE_ALL);
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.admin.decide.use_case_failed' }), expect.any(String));
    expect(fakes.repo.rows.get(REQ)?.state).toBe('pending');
  });
});
