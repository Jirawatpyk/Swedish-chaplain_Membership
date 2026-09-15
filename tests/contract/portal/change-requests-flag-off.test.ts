/**
 * F114 T118 — contract: the platform flag OFF with rows present (FR-039; US6
 * research R11 "dark ship"). `FEATURE_MEMBER_CHANGE_APPROVAL=false` while the
 * in-memory repo holds rows from a previous flag-on run:
 *
 *   - every F114 route answers 404 BEFORE any session work — the eleven
 *     handlers in ten route files are enumerated here by hand from
 *     `src/app/api/{portal,admin}/**` (a route added without a row fails the
 *     count control at the bottom);
 *   - the immediate self-service path is widened back: the REAL gate
 *     resolver answers `immediate` WITHOUT reading the tenant row (even a
 *     tenant row with approval ON), and `PATCH /api/portal/profile` accepts
 *     a Group B field again over the real use case;
 *   - the stored rows are untouched (repo state identical before / after);
 *   - once the flag flips back ON in the same test, the decide route answers
 *     200 on a row seeded before the flip.
 *
 * UI half: see T096 — the profile banner / nav badge / dashboard item
 * assertions belong to the UI slice, not here.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
let flagOn = false;
let repo: InMemoryChangeRequestRepo;
let settings: TenantMemberChangeSettingsFake;
let audit: AuditPortFake;
let emails: EmailPortFake;
let memberRepo: Record<string, ReturnType<typeof vi.fn>>;
let contactRepo: Record<string, ReturnType<typeof vi.fn>>;

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

import { GET as portalListGET, POST as submitPOST } from '@/app/api/portal/change-requests/route';
import { DELETE as withdrawDELETE } from '@/app/api/portal/change-requests/current/route';
import { GET as gateGET } from '@/app/api/portal/change-requests/gate/route';
import { GET as portalItemGET } from '@/app/api/portal/change-requests/[id]/route';
import { POST as acknowledgePOST } from '@/app/api/portal/change-requests/[id]/acknowledge/route';
import { GET as queueGET } from '@/app/api/admin/change-requests/route';
import { GET as reviewGET } from '@/app/api/admin/change-requests/[id]/route';
import { POST as decidePOST } from '@/app/api/admin/change-requests/[id]/decide/route';
import { GET as memberHistoryGET } from '@/app/api/admin/members/[id]/change-requests/route';
import { GET as settingGET, PATCH as settingPATCH } from '@/app/api/admin/settings/member-changes/route';
import { PATCH as profilePATCH } from '@/app/api/portal/profile/route';

const NOW = new Date('2026-09-15T09:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const REQ = '00000000-0000-4000-8000-000000000001';
const DECIDED_REQ = '00000000-0000-4000-8000-000000000002';

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
  requestId: 'req-flag-1',
});

const staffContext = () => ({
  current: { user: { id: REVIEWER, email: 'staff@swecham.example', role: 'admin', status: 'active' }, session: { id: 's-2' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-flag-2',
});

function row(id: string, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: id as ChangeRequestId,
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
    ...overrides,
  };
}

/** Rows "from a previous flag-on run": one pending, one decided-unacknowledged. */
function seedRows(): ChangeRequest[] {
  return [
    row(REQ),
    row(DECIDED_REQ, {
      state: 'decided',
      outcome: 'approved',
      decidedAt: new Date('2026-09-14T12:00:00Z'),
      decidedByUserId: REVIEWER as UserId,
      fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'approved', appliedAt: new Date('2026-09-14T12:00:00Z') }],
    }),
  ];
}

function seedFakes() {
  const m = member();
  const c = contact();
  repo = makeInMemoryChangeRequestRepo(seedRows());
  repo.display.users.set(REVIEWER, { displayName: 'Sven Reviewer', deactivated: false });
  // a tenant row with approval ON — the flag must win regardless (FR-039)
  settings = makeTenantMemberChangeSettingsFake(true);
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

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DECISION = { decisions: [{ key: 'phone', outcome: 'approved' }], reason: null, note: null };

/** Every F114 handler — label → a call with a body / id a flag-ON run would accept. */
const ROUTES: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
  ['GET /api/portal/change-requests', () => portalListGET(new NextRequest('http://localhost/api/portal/change-requests', { method: 'GET' }))],
  ['POST /api/portal/change-requests', () => submitPOST(new NextRequest('http://localhost/api/portal/change-requests', { method: 'POST', ...json({ contact: { phone: '+66899999999' } }) }))],
  ['DELETE /api/portal/change-requests/current', () => withdrawDELETE(new NextRequest('http://localhost/api/portal/change-requests/current', { method: 'DELETE' }))],
  ['GET /api/portal/change-requests/gate', () => gateGET(new NextRequest('http://localhost/api/portal/change-requests/gate', { method: 'GET' }))],
  ['GET /api/portal/change-requests/[id]', () => portalItemGET(new NextRequest(`http://localhost/api/portal/change-requests/${DECIDED_REQ}`, { method: 'GET' }), params(DECIDED_REQ))],
  ['POST /api/portal/change-requests/[id]/acknowledge', () => acknowledgePOST(new NextRequest(`http://localhost/api/portal/change-requests/${DECIDED_REQ}/acknowledge`, { method: 'POST' }), params(DECIDED_REQ))],
  ['GET /api/admin/change-requests', () => queueGET(new NextRequest('http://localhost/api/admin/change-requests', { method: 'GET' }))],
  ['GET /api/admin/change-requests/[id]', () => reviewGET(new NextRequest(`http://localhost/api/admin/change-requests/${REQ}`, { method: 'GET' }), params(REQ))],
  ['POST /api/admin/change-requests/[id]/decide', () => decidePOST(new NextRequest(`http://localhost/api/admin/change-requests/${REQ}/decide`, { method: 'POST', ...json(DECISION) }), params(REQ))],
  ['GET /api/admin/members/[id]/change-requests', () => memberHistoryGET(new NextRequest(`http://localhost/api/admin/members/${MEMBER}/change-requests`, { method: 'GET' }), params(MEMBER))],
  ['GET /api/admin/settings/member-changes', () => settingGET(new NextRequest('http://localhost/api/admin/settings/member-changes', { method: 'GET' }))],
  ['PATCH /api/admin/settings/member-changes', () => settingPATCH(new NextRequest('http://localhost/api/admin/settings/member-changes', { method: 'PATCH', ...json({ approvalEnabled: false }) }))],
];

const snapshot = () => JSON.stringify([...repo.rows.entries()]);

beforeEach(() => {
  flagOn = false;
  seedFakes();
  requireMemberContextMock.mockResolvedValue(memberContext());
  requireApiPermissionMock.mockResolvedValue(staffContext());
});
afterEach(() => vi.clearAllMocks());

describe('FEATURE_MEMBER_CHANGE_APPROVAL=false with rows present (F114 T118 / FR-039)', () => {
  it('positive control: the route list covers every F114 handler (12 — ten route files, two with a second verb)', () => {
    expect(ROUTES).toHaveLength(12);
  });

  // Seam pass 2026-09-15: the count above is a list pin — a route FILE added under one of the
  // F114 trees without a flag check would not fail it. Walk the trees on disk and require that
  // every `route.ts` found is a path the list exercises, and vice versa (the error-id guard's
  // rule 5, applied here).
  it('positive control: every route.ts on disk under the F114 trees is in the list, and vice versa', () => {
    const trees = [
      'src/app/api/portal/change-requests',
      'src/app/api/admin/change-requests',
      'src/app/api/admin/members/[id]/change-requests',
      'src/app/api/admin/settings/member-changes',
    ];
    const onDisk = new Set<string>();
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, `${rel}/${entry}`);
        else if (entry === 'route.ts') onDisk.add(rel);
      }
    };
    for (const tree of trees) walk(join(process.cwd(), tree), tree.replace(/^src\/app/, ''));
    expect(onDisk.size).toBeGreaterThan(0);
    const listed = new Set(ROUTES.map(([label]) => label.split(' ')[1]!));
    expect([...onDisk].sort()).toEqual([...listed].sort());
  });

  it.each(ROUTES.map(([label, call]) => [label, call] as const))('%s → 404 before any session work; rows untouched', async (_label, call) => {
    const before = snapshot();
    const res = await call();
    expect(res.status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
    expect(requireApiPermissionMock).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
    expect(audit.events).toHaveLength(0);
    expect(emails.enqueued).toHaveLength(0);
    expect(settings.state).toEqual({ enabled: true });
  });

  it('the gate resolver answers immediate WITHOUT reading the tenant row — even one with approval ON (flag first, then setting)', async () => {
    await expect(gateResolver().resolve({ slug: 'test-swecham' } as never)).resolves.toBe('immediate');
    expect(settings.readInTenant).not.toHaveBeenCalled();
  });

  it('PATCH /api/portal/profile accepts the full flag-OFF field set again — a Group B field writes immediately, member_self_updated emitted, no request row', async () => {
    const before = snapshot();
    const res = await profilePATCH(
      new NextRequest('http://localhost/api/portal/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-flag-1' },
        body: JSON.stringify({ website: 'https://new.example', primary_contact: { phone: '+66811111111' } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(memberRepo['updateFieldsInTx']).toHaveBeenCalledWith({ __tx: true }, MEMBER, expect.objectContaining({ website: 'https://new.example' }));
    expect(contactRepo['updateInTx']).toHaveBeenCalledWith({ __tx: true }, CONTACT, expect.objectContaining({ phone: '+66811111111' }));
    expect(audit.events.map((e) => e.type)).toContain('member_self_updated');
    expect(audit.events.map((e) => e.type)).not.toContain('member_self_update_forbidden');
    expect(settings.readInTenant).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('the rows are retained and become decidable again once the flag returns: decide → 200 on the row seeded before the flip', async () => {
    expect((await decidePOST(new NextRequest(`http://localhost/api/admin/change-requests/${REQ}/decide`, { method: 'POST', ...json(DECISION) }), params(REQ))).status).toBe(404);
    expect(repo.rows.get(REQ)?.state).toBe('pending');

    flagOn = true;
    const res = await decidePOST(new NextRequest(`http://localhost/api/admin/change-requests/${REQ}/decide`, { method: 'POST', ...json(DECISION) }), params(REQ));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repeated: false, applied: ['phone'], request: { id: REQ, state: 'decided', outcome: 'approved' } });
    expect(repo.rows.get(REQ)?.state).toBe('decided');
    expect(repo.rows.get(DECIDED_REQ)?.state).toBe('decided');
    expect(audit.events.map((e) => e.type)).toEqual(['member_change_request_decided']);
    // and the settings surface is back too
    expect((await settingGET(new NextRequest('http://localhost/api/admin/settings/member-changes', { method: 'GET' }))).status).toBe(200);
  });
});
