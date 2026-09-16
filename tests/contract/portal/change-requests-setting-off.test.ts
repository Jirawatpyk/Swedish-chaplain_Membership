/**
 * F114 T094 — contract: the tenant setting OFF while the platform flag is ON
 * (US6 AS1, AS2; FR-031, FR-032; research R11).
 *
 * The REAL gate resolver runs over the real flag port + the settings fake, and
 * the REAL use cases run over the in-memory fakes, so the four routes below
 * are pinned against the actual chain `flag ∧ setting`, not a mocked mode:
 *
 *   - `GET /api/portal/change-requests/gate` → `mode: 'immediate'` (and the
 *     tenant row IS read — the flag is on, only the setting is off);
 *   - `PATCH /api/portal/profile` accepts a Group B field again, writes it
 *     immediately and emits `member_self_updated` (SC-011: the F3 path) — no
 *     request row, no staff email;
 *   - `POST /api/portal/change-requests` → 409 `approval_not_required` (the
 *     submit route's own race-guard code — nothing created);
 *   - a request that was pending BEFORE the flip is still decidable:
 *     `POST /api/admin/change-requests/[id]/decide` → 200 (FR-032).
 *
 * The positive control at the end flips the setting ON and watches the gate
 * answer `approval`, so the suite cannot pass on a harness that ignores the
 * setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, type Result } from '@/lib/result';
import type { Member, Contact } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { makeMemberChangeGateResolver } from '@/modules/members/application/use-cases/change-requests/resolve-member-change-gate';
import {
  makeAuditPortFake,
  makeClockFake,
  makeEmailPortFake,
  makeInMemoryChangeRequestRepo,
  makeReviewerDirectoryFake,
  makeTenantMemberChangeSettingsFake,
  type AuditPortFake,
  type EmailPortFake,
  type InMemoryChangeRequestRepo,
  type TenantMemberChangeSettingsFake,
} from '../../helpers/change-request-fakes';

const requireMemberContextMock = vi.fn();
const requireApiPermissionMock = vi.fn();
let flagOn = true;
let repo: InMemoryChangeRequestRepo;
let settings: TenantMemberChangeSettingsFake;
let audit: AuditPortFake;
let emails: EmailPortFake;
let memberRepo: Record<string, ReturnType<typeof vi.fn>>;
let contactRepo: Record<string, ReturnType<typeof vi.fn>>;

// the REAL resolver over the real flag port shape + the settings fake
const gateResolver = () =>
  makeMemberChangeGateResolver({
    flags: { memberChangeApproval: () => flagOn },
    tenantMemberSettings: settings,
  });

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
vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  return { ...actual, requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args) };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    changeRequestRepo: repo,
    memberRepo,
    contactRepo,
    audit,
    emails,
    reviewers: makeReviewerDirectoryFake(),
    tenantMemberChangeSettings: settings,
    memberChangeGate: gateResolver(),
    clock: makeClockFake(NOW),
    newRequestId: () => '00000000-0000-4000-8000-0000000000ff',
  })),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    memberRepo,
    contactRepo,
    audit,
    memberChangeGate: gateResolver(),
  })),
}));
vi.mock('@/lib/contact-marketing-deps', () => ({
  makeMarketingSuppressionLookup: vi.fn(() => ({ isSuppressed: async () => false })),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' } })),
  releaseIdempotencyRecord: vi.fn(async (..._a: unknown[]) => undefined),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
    peek: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));
vi.mock('@/lib/metrics', () => ({
  membersMetrics: {
    changeRequests: {
      refused: vi.fn(),
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
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { GET as gateGET } from '@/app/api/portal/change-requests/gate/route';
import { POST as submitPOST } from '@/app/api/portal/change-requests/route';
import { PATCH as profilePATCH } from '@/app/api/portal/profile/route';
import { POST as decidePOST } from '@/app/api/admin/change-requests/[id]/decide/route';

const NOW = new Date('2026-09-15T09:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const REQ = '00000000-0000-4000-8000-000000000001';

function member(): Member {
  return {
    tenantId: 'test-swecham',
    memberId: MEMBER,
    memberNumber: 42,
    companyName: 'Nordic Co',
    legalEntityType: null,
    country: 'TH',
    website: null,
    description: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: NOW,
    registrationFeePaid: false,
    status: 'active',
    lastActivityAt: null,
    notes: null,
    taxId: null,
    foundedYear: null,
    turnoverThb: null,
    archivedAt: null,
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
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Member;
}

function contact(): Contact {
  return {
    contactId: CONTACT,
    memberId: MEMBER,
    tenantId: 'test-swecham',
    firstName: 'Anna',
    lastName: 'Svensson',
    email: 'anna@nordic.example',
    phone: '+66812345678',
    roleTitle: null,
    preferredLanguage: 'sv',
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: SUBMITTER,
    marketing: { optedOutAt: null, source: null, byUserId: null },
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Contact;
}

const memberContext = () => ({
  current: { user: { id: SUBMITTER, email: 'anna@nordic.example', role: 'member', status: 'active' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: member(),
  memberId: MEMBER,
  ownContact: contact(),
  ownContactId: CONTACT,
  sourceIp: '127.0.0.1',
  requestId: 'req-off-1',
});

const staffContext = () => ({
  current: { user: { id: REVIEWER, email: 'staff@swecham.example', role: 'admin', status: 'active' }, session: { id: 's-2' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-off-2',
});

function pendingBeforeFlip(): ChangeRequest {
  return {
    id: REQ as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: SUBMITTER as UserId,
    submittedByContactId: CONTACT as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: new Date('2026-09-14T09:00:00Z'),
    staffNotifiedAt: new Date('2026-09-14T09:00:00Z'),
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
  };
}

function seedFakes() {
  const m = member();
  const c = contact();
  repo = makeInMemoryChangeRequestRepo([pendingBeforeFlip()]);
  repo.display.users.set(REVIEWER, { displayName: 'Sven Reviewer', deactivated: false });
  settings = makeTenantMemberChangeSettingsFake(false);
  audit = makeAuditPortFake();
  emails = makeEmailPortFake();
  memberRepo = {
    findById: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    findByIdInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    findErasedAtByIdInTx: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: null })),
    updateFieldsInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>): Promise<Result<Member, RepoError>> => ok({ ...m, ...patch } as Member)),
  };
  contactRepo = {
    findById: vi.fn(async (): Promise<Result<Contact, RepoError>> => ok(c)),
    listByMember: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok([c])),
    listByMemberInTx: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok([c])),
    updateInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>): Promise<Result<Contact, RepoError>> => ok({ ...c, ...patch } as Contact)),
  };
}

const gate = () => gateGET(new NextRequest('http://localhost/api/portal/change-requests/gate', { method: 'GET' }));
const submit = (body: unknown) =>
  submitPOST(new NextRequest('http://localhost/api/portal/change-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const profile = (body: unknown) =>
  profilePATCH(
    new NextRequest('http://localhost/api/portal/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-off-1' },
      body: JSON.stringify(body),
    }),
  );
const decide = (id = REQ) =>
  decidePOST(
    new NextRequest(`http://localhost/api/admin/change-requests/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisions: [{ key: 'phone', outcome: 'approved' }], reason: null, note: null }),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  flagOn = true;
  seedFakes();
  requireMemberContextMock.mockResolvedValue(memberContext());
  requireApiPermissionMock.mockResolvedValue(staffContext());
});
afterEach(() => vi.clearAllMocks());

describe('flag ON + tenant setting OFF (F114 T094)', () => {
  it('the gate answers immediate — and the tenant row WAS read (the flag is on; the setting is what says no)', async () => {
    const res = await gate();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'immediate', canProposeCompanyFields: true, pending: null });
    expect(settings.readInTenant).toHaveBeenCalledTimes(1);
  });

  it('PATCH /api/portal/profile accepts a Group B field again: written immediately, member_self_updated emitted, no request row, no staff email (US6 AS1 / SC-011)', async () => {
    const before = repo.rows.size;
    const res = await profile({ website: 'https://new.example' });
    expect(res.status).toBe(200);
    expect((await res.json()).website).toBe('https://new.example');
    expect(memberRepo['updateFieldsInTx']).toHaveBeenCalledWith({ __tx: true }, MEMBER, expect.objectContaining({ website: 'https://new.example' }));
    expect(audit.events.map((e) => e.type)).toContain('member_self_updated');
    expect(audit.events.map((e) => e.type)).not.toContain('member_self_update_forbidden');
    expect(audit.events.map((e) => e.type)).not.toContain('member_change_request_submitted');
    expect(repo.rows.size).toBe(before);
    expect(emails.enqueued).toHaveLength(0);
  });

  it("POST /api/portal/change-requests → 409 approval_not_required (the submit route's own race-guard code); nothing created", async () => {
    const before = repo.rows.size;
    const res = await submit({ contact: { phone: '+66899999999' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'approval_not_required' });
    expect(repo.rows.size).toBe(before);
    expect(audit.events).toHaveLength(0);
  });

  it('a request pending from BEFORE the flip is still decidable: decide → 200 (US6 AS2 / FR-032)', async () => {
    const res = await decide();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repeated: false, applied: ['phone'], request: { id: REQ, state: 'decided', outcome: 'approved' } });
    expect(repo.rows.get(REQ)?.state).toBe('decided');
    expect(audit.events.map((e) => e.type)).toEqual(['member_change_request_decided']);
  });

  it('positive control: the same harness with the setting ON answers approval — the setting is what flipped the gate', async () => {
    settings.state = { enabled: true };
    expect(await (await gate()).json()).toMatchObject({ mode: 'approval' });
    const res = await profile({ website: 'https://new.example' });
    expect(res.status).toBe(403);
    expect(audit.events.map((e) => e.type)).toContain('member_self_update_forbidden');
  });
});
