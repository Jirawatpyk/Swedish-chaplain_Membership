/**
 * F114 T052 — `getChangeRequestReview` (US2: FR-019 / FR-020; contracts/
 * admin-change-requests-api.md § review payload).
 *
 * Pinned: `current` is read LIVE; `changedSinceSubmitted = current ≠ seen`
 * (deep-equal on address groups); `alreadyCurrent = proposed = current`;
 * `undecidable: 'contact_removed'` on a contact-target row whose contact is
 * removed OR unlinked (member-target rows stay decidable); `taxHint` names
 * what the flag feeds; `canDecide` = pending ∧ canWrite ∧ ¬archived ∧
 * ¬erasing; `not_found` for an unknown id; `server_error` on a repo fault.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err, type Result } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId, type Member, type Contact } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { getChangeRequestReview } from '@/modules/members/application/use-cases/change-requests/get-change-request-review';
import { makeAuditPortFake, makeInMemoryChangeRequestRepo } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const REQ = '00000000-0000-4000-8000-000000000001' as ChangeRequestId;
const NOW = new Date('2026-09-11T09:00:00Z');

function member(overrides: Partial<Member> = {}): Member {
  return {
    tenantId: 'test-tenant',
    memberId: MEMBER,
    memberNumber: 42,
    companyName: 'Nordic Co',
    website: 'https://nordic.example',
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

function request(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: REQ,
    tenantId: 'test-tenant' as ChangeRequest['tenantId'],
    memberId: MEMBER,
    submittedByUserId: SUBMITTER,
    submittedByContactId: CONTACT,
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
        key: 'registered_address',
        target: 'member',
        seen: { line1: '1 Main Rd', line2: null, sub_district: null, city: 'Bangkok', province: null, postal_code: '10110' },
        proposed: { line1: '2 Main Rd', line2: null, sub_district: null, city: 'Bangkok', province: null, postal_code: '10110' },
        affectsTaxDocuments: true,
        outcome: null,
        appliedAt: null,
      },
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

function makeDeps(opts: { request?: ChangeRequest; member?: Member; contacts?: Contact[]; erasedAt?: Date | null } = {}) {
  const repo = makeInMemoryChangeRequestRepo([opts.request ?? request()]);
  const m = opts.member ?? member();
  const cs = opts.contacts ?? [contact()];
  const memberRepo = {
    findById: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    findErasedAtById: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: opts.erasedAt ?? null })),
  };
  const contactRepo = {
    listByMember: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok(cs)),
  };
  const audit = makeAuditPortFake();
  return { deps: { tenant, changeRequestRepo: repo, memberRepo, contactRepo, audit }, repo, memberRepo, contactRepo, audit };
}

const ACTOR = { userId: 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId, role: 'admin', requestId: 'req-review' };

describe('getChangeRequestReview', () => {
  it('reads current values LIVE and flags changedSinceSubmitted / alreadyCurrent per field', async () => {
    // the phone was edited by staff since submission; the company name was set to the proposed value already
    const { deps } = makeDeps({
      member: member({ companyName: 'Nordic Company' }),
      contacts: [contact({ phone: '+66800000000' as Contact['phone'] })],
    });
    const r = await getChangeRequestReview(deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byKey = new Map(r.value.fields.map((f) => [f.key, f]));
    expect(byKey.get('phone')).toMatchObject({ current: '+66800000000', changedSinceSubmitted: true, alreadyCurrent: false });
    expect(byKey.get('company_name')).toMatchObject({ current: 'Nordic Company', changedSinceSubmitted: true, alreadyCurrent: true });
    expect(byKey.get('first_name')).toMatchObject({ current: 'Anna', changedSinceSubmitted: false, alreadyCurrent: false });
    // address groups compare deep — the live registered address equals what the member saw
    expect(byKey.get('registered_address')).toMatchObject({ changedSinceSubmitted: false, alreadyCurrent: false });
    expect(byKey.get('registered_address')?.current).toEqual({
      line1: '1 Main Rd', line2: null, sub_district: null, city: 'Bangkok', province: null, postal_code: '10110',
    });
    expect(r.value.fields.map((f) => f.key)).toEqual(['first_name', 'phone', 'company_name', 'registered_address', 'billing_address']);
  });

  it('taxHint names what each tax-affecting flag feeds (FR-019)', async () => {
    const { deps } = makeDeps();
    const r = await getChangeRequestReview(deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    if (!r.ok) throw new Error('expected ok');
    const hints = Object.fromEntries(r.value.fields.map((f) => [f.key, f.taxHint]));
    expect(hints).toEqual({
      first_name: 'buyer_contact',
      phone: null,
      company_name: 'buyer_name',
      registered_address: 'buyer_address', // no billing address on record → the registered one is printed
      billing_address: 'billing_country', // proposed country is non-TH → VAT treatment to judge
    });
    expect(r.value.member).toEqual({
      id: MEMBER,
      companyName: 'Nordic Co',
      memberNumber: 42,
      status: 'active',
      archived: false,
      erasing: false,
      hasBillingAddress: false,
    });
  });

  it('a billing address proposed with a TH country (or no country) hints buyer_address, not billing_country', async () => {
    const req = request({
      fields: [
        {
          key: 'billing_address',
          target: 'member',
          seen: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
          proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Bangkok', province: null, postal_code: '10110', country: 'th' },
          affectsTaxDocuments: true,
          outcome: null,
          appliedAt: null,
        },
      ],
    });
    const { deps } = makeDeps({ request: req });
    const r = await getChangeRequestReview(deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(r.ok && r.value.fields[0]?.taxHint).toBe('buyer_address');
  });

  it('a removed OR unlinked submitting contact makes its contact-target rows undecidable (contact_removed); member rows stay decidable', async () => {
    for (const gone of [contact({ removedAt: NOW, isPrimary: false } as Partial<Contact>), contact({ linkedUserId: null })]) {
      const { deps } = makeDeps({ contacts: [gone] });
      const r = await getChangeRequestReview(deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
      if (!r.ok) throw new Error('expected ok');
      const byKey = new Map(r.value.fields.map((f) => [f.key, f]));
      expect(byKey.get('phone')?.undecidable).toBe('contact_removed');
      expect(byKey.get('first_name')?.undecidable).toBe('contact_removed');
      expect(byKey.get('company_name')?.undecidable).toBeNull();
      expect(r.value.canDecide).toBe(true);
    }
  });

  it('canDecide = pending ∧ canWrite ∧ not archived ∧ not erasing', async () => {
    const pendingWrite = makeDeps();
    expect((await getChangeRequestReview(pendingWrite.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR })).ok && true).toBe(true);
    const a = await getChangeRequestReview(pendingWrite.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(a.ok && a.value.canDecide).toBe(true);
    const readOnly = await getChangeRequestReview(pendingWrite.deps, { changeRequestId: REQ, canWrite: false, actor: ACTOR });
    expect(readOnly.ok && readOnly.value.canDecide).toBe(false);
    const archived = makeDeps({ member: member({ status: 'archived', archivedAt: NOW } as Partial<Member>) });
    const b = await getChangeRequestReview(archived.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(b.ok && b.value.canDecide).toBe(false);
    expect(b.ok && b.value.member.archived).toBe(true);
    const erasing = makeDeps({ erasedAt: NOW });
    const c = await getChangeRequestReview(erasing.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(c.ok && c.value.canDecide).toBe(false);
    expect(c.ok && c.value.member.erasing).toBe(true);
    const decided = makeDeps({ request: request({ state: 'decided', outcome: 'approved', decidedAt: NOW, decidedByUserId: 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId }) });
    const d = await getChangeRequestReview(decided.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(d.ok && d.value.canDecide).toBe(false);
    expect(d.ok && d.value.row.decidedBy).toEqual({ displayName: 'Reviewer', deactivated: false });
  });

  it('an unknown id → not_found + a member_cross_tenant_probe audit (Constitution I.3); a repo fault → server_error', async () => {
    const { deps, repo, audit } = makeDeps();
    const nf = await getChangeRequestReview(deps, { changeRequestId: '00000000-0000-4000-8000-0000000000ff' as ChangeRequestId, canWrite: true, actor: ACTOR });
    expect(nf).toEqual({ ok: false, error: { type: 'not_found' } });
    expect(audit.events).toEqual([
      expect.objectContaining({
        type: 'member_cross_tenant_probe',
        actorUserId: ACTOR.userId,
        payload: { attempted_change_request_id: '00000000-0000-4000-8000-0000000000ff', actor_tenant_id: 'test-tenant', action: 'review', actor_role: 'admin' },
      }),
    ]);
    repo.failNext('findListRowById');
    const se = await getChangeRequestReview(deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(se).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const m = makeDeps();
    m.memberRepo.findById.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await getChangeRequestReview(m.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR })).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const c = makeDeps();
    c.contactRepo.listByMember.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await getChangeRequestReview(c.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR })).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const e = makeDeps();
    e.memberRepo.findErasedAtById.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await getChangeRequestReview(e.deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR })).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });
});

describe('getChangeRequestReview — the live value is normalised like `seen` (round 6, code #2)', () => {
  it("a record holding 'CEO ' against a seen 'CEO' is NOT 'changed since submitted'", async () => {
    const { deps } = makeDeps({
      request: request({ fields: [{ key: 'role_title', target: 'contact', seen: 'CEO', proposed: 'CTO', affectsTaxDocuments: false, outcome: null, appliedAt: null }] }),
      contacts: [contact({ roleTitle: 'CEO ' })],
    });
    const r = await getChangeRequestReview(deps, { changeRequestId: REQ, canWrite: true, actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.value.fields.find((f) => f.key === 'role_title');
    expect(row).toMatchObject({ current: 'CEO', changedSinceSubmitted: false, alreadyCurrent: false });
  });
});
