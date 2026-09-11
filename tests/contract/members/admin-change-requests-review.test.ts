/**
 * F114 T046 — contract: `GET /api/admin/change-requests/[id]` (contracts/
 * admin-change-requests-api.md § review payload; FR-019 / FR-020 / FR-039).
 *
 * The REAL `getChangeRequestReview` runs over in-memory fakes so the wire
 * pins are real behaviour: `fields[].current` live, `changedSinceSubmitted`
 * after a direct staff edit, `alreadyCurrent` when equal, `taxHint` ∈
 * `buyer_name|buyer_address|buyer_contact|billing_country|null`,
 * `undecidable: 'contact_removed'`, `canDecide` false for manager / archived /
 * erasing (the route derives `canWrite` from the REAL evaluator), an unknown /
 * other tenant's id → 404 (RLS shows nothing), flag OFF → 404 before the gate,
 * the gate key is the literal `members.read`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, type Result } from '@/lib/result';
import type { Member, Contact } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { makeInMemoryChangeRequestRepo, type InMemoryChangeRequestRepo } from '../../helpers/change-request-fakes';

const requireApiPermissionMock = vi.fn();
let flagOn = true;
let readOnly = false;
let fakes: {
  repo: InMemoryChangeRequestRepo;
  memberRepo: { findById: ReturnType<typeof vi.fn>; findErasedAtById: ReturnType<typeof vi.fn> };
  contactRepo: { listByMember: ReturnType<typeof vi.fn> };
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
vi.mock('@/lib/db', () => ({ db: {}, runInTenant: vi.fn() }));
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
  })),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { GET } from '@/app/api/admin/change-requests/[id]/route';

const NOW = new Date('2026-09-11T09:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const REQ = '00000000-0000-4000-8000-000000000001';

const staffContext = (role: string) => ({
  current: { user: { id: REVIEWER, email: 'staff@swecham.example', role, status: 'active' }, session: { id: 's-1' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-r1',
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
      { key: 'first_name', target: 'contact', seen: 'Anna', proposed: 'Annika', affectsTaxDocuments: true, outcome: null, appliedAt: null },
      { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null },
      { key: 'company_name', target: 'member', seen: 'Nordic Co', proposed: 'Nordic Company', affectsTaxDocuments: true, outcome: null, appliedAt: null },
      {
        key: 'billing_address',
        target: 'member',
        seen: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
        proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
        affectsTaxDocuments: true,
        outcome: null,
        appliedAt: null,
      },
    ],
    ...overrides,
  };
}

function seed(opts: { request?: ChangeRequest; member?: Member; contacts?: Contact[]; erasedAt?: Date | null } = {}) {
  const m = opts.member ?? member();
  const cs = opts.contacts ?? [contact()];
  fakes = {
    repo: makeInMemoryChangeRequestRepo([opts.request ?? pending()]),
    memberRepo: {
      findById: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
      findErasedAtById: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: opts.erasedAt ?? null })),
    },
    contactRepo: { listByMember: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok(cs)) },
  };
}

function call(id = REQ): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/admin/change-requests/${id}`, { method: 'GET' });
  return GET(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  flagOn = true;
  readOnly = false;
  seed();
  requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/change-requests/[id]', () => {
  it('404 while the platform flag is off — before the gate (FR-039)', async () => {
    flagOn = false;
    expect((await call()).status).toBe(404);
    expect(requireApiPermissionMock).not.toHaveBeenCalled();
  });

  it("hands the gate the literal key 'members.read' and passes its 403 through", async () => {
    requireApiPermissionMock.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'members.read');
  });

  it('the review payload: live current values, three-value flags, tax hints, member facts, canDecide', async () => {
    // staff edited the phone directly since submission; the company name already equals the proposal
    seed({ member: member({ companyName: 'Nordic Company' }), contacts: [contact({ phone: '+66800000000' as Contact['phone'] })] });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request).toMatchObject({ id: REQ, state: 'pending', submittedBy: { displayName: 'Submitter', roleAtSubmission: 'primary' }, decidedBy: null });
    expect(body.member).toEqual({ id: MEMBER, companyName: 'Nordic Company', memberNumber: 42, status: 'active', archived: false, erasing: false, hasBillingAddress: false });
    expect(body.canDecide).toBe(true);
    const byKey = Object.fromEntries(body.fields.map((f: { key: string }) => [f.key, f]));
    expect(byKey.phone).toMatchObject({ target: 'contact', seen: '+66812345678', proposed: '+66899999999', current: '+66800000000', changedSinceSubmitted: true, alreadyCurrent: false, taxHint: null, undecidable: null, outcome: null, appliedAt: null });
    expect(byKey.company_name).toMatchObject({ current: 'Nordic Company', changedSinceSubmitted: true, alreadyCurrent: true, taxHint: 'buyer_name' });
    expect(byKey.first_name).toMatchObject({ current: 'Anna', changedSinceSubmitted: false, alreadyCurrent: false, taxHint: 'buyer_contact' });
    expect(byKey.billing_address).toMatchObject({ changedSinceSubmitted: false, alreadyCurrent: false, taxHint: 'billing_country', affectsTaxDocuments: true });
    expect(byKey.billing_address.current).toEqual({ line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null });
  });

  it('a removed contact → its rows undecidable: contact_removed; member rows unaffected', async () => {
    seed({ contacts: [contact({ removedAt: NOW, isPrimary: false } as Partial<Contact>)] });
    const body = await (await call()).json();
    const byKey = Object.fromEntries(body.fields.map((f: { key: string }) => [f.key, f]));
    expect(byKey.phone.undecidable).toBe('contact_removed');
    expect(byKey.first_name.undecidable).toBe('contact_removed');
    expect(byKey.company_name.undecidable).toBeNull();
  });

  it('canDecide is false for manager (members.read without members.write), for an archived member and for a member under erasure', async () => {
    requireApiPermissionMock.mockResolvedValue(staffContext('manager'));
    expect((await (await call()).json()).canDecide).toBe(false);
    requireApiPermissionMock.mockResolvedValue(staffContext('marketing'));
    expect((await (await call()).json()).canDecide).toBe(false);
    requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
    seed({ member: member({ status: 'archived', archivedAt: NOW } as Partial<Member>) });
    const archived = await (await call()).json();
    expect(archived.canDecide).toBe(false);
    expect(archived.member.archived).toBe(true);
    seed({ erasedAt: NOW });
    const erasing = await (await call()).json();
    expect(erasing.canDecide).toBe(false);
    expect(erasing.member.erasing).toBe(true);
  });

  it("an unknown id (another tenant's row is invisible under RLS) → 404 problem; a malformed id → 404", async () => {
    const res = await call('00000000-0000-4000-8000-0000000000ff');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ type: expect.stringMatching(/not_found$/), status: 404 });
    expect((await call('nope')).status).toBe(404);
  });

  it('READ_ONLY_MODE leaves the read untouched — 200 (FR-036 / T116)', async () => {
    readOnly = true;
    expect((await call()).status).toBe(200);
  });

  it('a repo fault → 500 problem', async () => {
    fakes.repo.failNext('findListRowById');
    expect((await call()).status).toBe(500);
  });
});
