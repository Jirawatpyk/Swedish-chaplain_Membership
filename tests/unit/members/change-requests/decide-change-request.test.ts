/**
 * F114 T047 — `decideChangeRequest`, every branch (US2: FR-013–FR-020,
 * FR-022–FR-025; research R4).
 *
 * Pinned here:
 *   - outcome derivation (all / some / none approved) — FR-016;
 *   - decisions must cover every field exactly once (`decisions_incomplete`);
 *     a reason is required iff any field is rejected (`reason_required`) —
 *     FR-014;
 *   - a decided request: an IDENTICAL repeat → `repeated: true` (no write, no
 *     audit, no email); a DIFFERENT decision → `already_decided` with the
 *     recorded decision; withdrawn → `not_pending` — FR-017;
 *   - archived / erased member → refused before any write — FR-020;
 *   - a contact-target row whose contact was removed/unlinked can only be
 *     rejected (`contact_removed`) — FR-020;
 *   - approval-time re-validation with the staff rules (`validation_error`);
 *   - approved fields applied via `memberRepo.updateFieldsInTx` /
 *     `contactRepo.updateInTx` with the right patches (address group → every
 *     line; billing country upper-cased); an `alreadyCurrent` field is still
 *     recorded approved without a write — FR-015;
 *   - audit `member_change_request_decided { related_member_id, request_id,
 *     outcome, fields: [{key, outcome}], reason_length, actor_role }` with the
 *     REVIEWER as actor and never a value; one `member_change_request_decided_
 *     member` outbox row to the submitter's CURRENT email in the contact's
 *     `preferred_language` — FR-023 / FR-024 / FR-025;
 *   - metrics `decided.total{outcome}` + `decide_ms`; `refused.total{reason}`;
 *   - throw-to-rollback on every failure after the first write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err, type Result } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
const loggerError = vi.fn();
const loggerInfo = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), info: (...a: unknown[]) => loggerInfo(...a), debug: vi.fn() },
}));
const metricDecided = vi.fn();
const metricRefused = vi.fn();
const metricDuration = vi.fn();
vi.mock('@/lib/metrics', () => ({
  membersMetrics: {
    changeRequests: {
      submitted: vi.fn(),
      refused: (...a: unknown[]) => metricRefused(...a),
      decided: (...a: unknown[]) => metricDecided(...a),
      decideDurationMs: (...a: unknown[]) => metricDuration(...a),
      pendingCount: vi.fn(),
      oldestAgeSeconds: vi.fn(),
    },
  },
}));

import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId, type Member, type Contact } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { RepoError } from '@/modules/members/application/ports/member-repo';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import {
  decideChangeRequest,
  type DecideChangeRequestDeps,
} from '@/modules/members/application/use-cases/change-requests/decide-change-request';
import {
  makeAuditPortFake,
  makeClockFake,
  makeEmailPortFake,
  makeInMemoryChangeRequestRepo,
} from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId;
const REQ = '00000000-0000-4000-8000-000000000001' as ChangeRequestId;
const NOW = new Date('2026-09-11T09:00:00Z');
const SUBMITTED_AT = new Date('2026-09-11T08:00:00Z');

function member(overrides: Partial<Member> = {}): Member {
  return {
    tenantId: 'test-tenant',
    memberId: MEMBER,
    memberNumber: 42,
    companyName: 'Nordic Co',
    legalEntityType: null,
    country: 'TH',
    taxId: null,
    isVatRegistered: false,
    website: 'https://nordic.example',
    description: null,
    foundedYear: null,
    turnoverThb: null,
    registeredCapitalThb: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: NOW,
    registrationFeePaid: true,
    lastActivityAt: null,
    notes: null,
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
    ...overrides,
  } as Member;
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    tenantId: 'test-tenant',
    contactId: CONTACT,
    memberId: MEMBER,
    firstName: 'Anna',
    lastName: 'Svensson',
    email: 'anna@nordic.example',
    phone: '+66812345678',
    roleTitle: null,
    preferredLanguage: 'sv',
    dateOfBirth: null,
    linkedUserId: SUBMITTER,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing: { optedOutAt: null, source: null, byUserId: null },
    isPrimary: true,
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Contact;
}

function pendingRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
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
    submittedAt: SUBMITTED_AT,
    staffNotifiedAt: SUBMITTED_AT,
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [
      { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null },
      { key: 'description', target: 'member', seen: null, proposed: 'A new description', affectsTaxDocuments: false, outcome: null, appliedAt: null },
      {
        key: 'billing_address',
        target: 'member',
        seen: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
        proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'se' },
        affectsTaxDocuments: true,
        outcome: null,
        appliedAt: null,
      },
    ],
    ...overrides,
  };
}

function makeDeps(opts: { request?: ChangeRequest; member?: Member; contacts?: Contact[]; erasedAt?: Date | null } = {}) {
  const repo = makeInMemoryChangeRequestRepo([opts.request ?? pendingRequest()]);
  const audit = makeAuditPortFake();
  const emails = makeEmailPortFake();
  const m = opts.member ?? member();
  const cs = opts.contacts ?? [contact()];
  const memberRepo = {
    findByIdInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    findErasedAtById: vi.fn(async (): Promise<Result<{ erasedAt: Date | null }, RepoError>> => ok({ erasedAt: opts.erasedAt ?? null })),
    updateFieldsInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>): Promise<Result<Member, RepoError>> => ok({ ...m, ...patch } as Member)),
  };
  const contactRepo = {
    listByMemberInTx: vi.fn(async (): Promise<Result<Contact[], RepoError>> => ok(cs)),
    updateInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>): Promise<Result<Contact, RepoError>> => ok({ ...cs[0]!, ...patch } as Contact)),
  };
  const deps = {
    tenant,
    changeRequestRepo: repo,
    memberRepo,
    contactRepo,
    audit,
    emails,
    clock: makeClockFake(NOW),
  } as unknown as DecideChangeRequestDeps;
  return { deps, repo, audit, emails, memberRepo, contactRepo };
}

const ALL_APPROVED = [
  { key: 'phone', outcome: 'approved' },
  { key: 'description', outcome: 'approved' },
  { key: 'billing_address', outcome: 'approved' },
] as const;
const PARTIAL = [
  { key: 'phone', outcome: 'approved' },
  { key: 'description', outcome: 'rejected' },
  { key: 'billing_address', outcome: 'approved' },
] as const;
const ALL_REJECTED = [
  { key: 'phone', outcome: 'rejected' },
  { key: 'description', outcome: 'rejected' },
  { key: 'billing_address', outcome: 'rejected' },
] as const;

const input = (decisions: ReadonlyArray<{ key: string; outcome: 'approved' | 'rejected' }>, reason: string | null = null, note: string | null = null) => ({
  changeRequestId: REQ,
  decisions,
  reason,
  note,
  actorUserId: REVIEWER,
  actorRole: 'admin',
  requestId: 'req-d1',
});

beforeEach(() => vi.clearAllMocks());

describe('decideChangeRequest — input rules (FR-014 / FR-016)', () => {
  it('decisions must cover every field exactly once', async () => {
    const { deps } = makeDeps();
    const missing = await decideChangeRequest(deps, input([{ key: 'phone', outcome: 'approved' }]));
    expect(missing).toMatchObject({ ok: false, error: { type: 'decisions_incomplete', missing: ['description', 'billing_address'], unknown: [] } });
    const unknown = await decideChangeRequest(deps, input([...ALL_APPROVED, { key: 'website', outcome: 'approved' }]));
    expect(unknown).toMatchObject({ ok: false, error: { type: 'decisions_incomplete', unknown: ['website'] } });
    const dup = await decideChangeRequest(deps, input([...ALL_APPROVED, { key: 'phone', outcome: 'rejected' }], 'x'));
    expect(dup).toMatchObject({ ok: false, error: { type: 'decisions_incomplete' } });
  });

  it('a reason is required iff at least one field is rejected; blank counts as missing; > 1000 is refused', async () => {
    const { deps } = makeDeps();
    expect(await decideChangeRequest(deps, input(PARTIAL, null))).toEqual({ ok: false, error: { type: 'reason_required' } });
    expect(await decideChangeRequest(deps, input(PARTIAL, '   '))).toEqual({ ok: false, error: { type: 'reason_required' } });
    expect(await decideChangeRequest(deps, input(PARTIAL, 'x'.repeat(1001)))).toMatchObject({ ok: false, error: { type: 'reason_too_long' } });
    expect(await decideChangeRequest(deps, input(ALL_APPROVED, null, 'n'.repeat(1001)))).toMatchObject({ ok: false, error: { type: 'reason_too_long' } });
    // all approved + a reason is fine (an optional remark); the reason is simply stored
    const r = await decideChangeRequest(deps, input(ALL_APPROVED, 'looks good'));
    expect(r.ok).toBe(true);
  });
});

describe('decideChangeRequest — refusals before any write (FR-017 / FR-020)', () => {
  it('a withdrawn request → not_pending', async () => {
    const { deps, audit } = makeDeps({ request: pendingRequest({ state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: NOW }) });
    expect(await decideChangeRequest(deps, input(ALL_APPROVED))).toEqual({ ok: false, error: { type: 'not_pending' } });
    expect(audit.events).toHaveLength(0);
  });

  it('an unknown id → not_found + a member_cross_tenant_probe audit with the reviewer as actor (Constitution I.3)', async () => {
    const { deps, audit } = makeDeps();
    const r = await decideChangeRequest(deps, { ...input(ALL_APPROVED), changeRequestId: '00000000-0000-4000-8000-0000000000ff' as ChangeRequestId });
    expect(r).toEqual({ ok: false, error: { type: 'not_found' } });
    expect(audit.events).toEqual([
      expect.objectContaining({
        type: 'member_cross_tenant_probe',
        actorUserId: REVIEWER,
        payload: { attempted_change_request_id: '00000000-0000-4000-8000-0000000000ff', actor_tenant_id: 'test-tenant', action: 'decide', actor_role: 'admin' },
      }),
    ]);
  });

  it('an archived member → member_archived (reject or unarchive first)', async () => {
    const { deps, memberRepo, repo } = makeDeps({ member: member({ status: 'archived', archivedAt: NOW } as Partial<Member>) });
    expect(await decideChangeRequest(deps, input(ALL_APPROVED))).toEqual({ ok: false, error: { type: 'member_archived' } });
    expect(memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
    expect(repo.rows.get(REQ)?.state).toBe('pending');
    expect(metricRefused).toHaveBeenCalledWith('test-tenant', 'archived');
  });

  it('a member under erasure → member_erasing', async () => {
    const { deps } = makeDeps({ erasedAt: NOW });
    expect(await decideChangeRequest(deps, input(ALL_APPROVED))).toEqual({ ok: false, error: { type: 'member_erasing' } });
  });

  it('a contact-target row whose contact was removed can only be rejected → contact_removed names the keys', async () => {
    const { deps } = makeDeps({ contacts: [contact({ removedAt: NOW, isPrimary: false } as Partial<Contact>)] });
    const r = await decideChangeRequest(deps, input(ALL_APPROVED));
    expect(r).toEqual({ ok: false, error: { type: 'contact_removed', keys: ['phone'] } });
  });

  it('an UNLINKED contact counts as removed for its rows; rejecting them is allowed and the email is skipped', async () => {
    const { deps, emails, repo } = makeDeps({ contacts: [contact({ linkedUserId: null })] });
    const r = await decideChangeRequest(
      deps,
      input([{ key: 'phone', outcome: 'rejected' }, { key: 'description', outcome: 'approved' }, { key: 'billing_address', outcome: 'approved' }], 'contact left'),
    );
    expect(r.ok).toBe(true);
    expect(repo.rows.get(REQ)?.outcome).toBe('partially_approved');
    expect(emails.enqueued).toHaveLength(0);
    expect(loggerInfo).toHaveBeenCalledWith(expect.objectContaining({ reason: 'recipient_gone' }), expect.any(String));
  });

  it('approval-time re-validation with the staff rules refuses an approved field that no longer passes (validation_error names the key)', async () => {
    const bad = pendingRequest({
      fields: [{ key: 'website', target: 'member', seen: null, proposed: 'javascript:alert(1)', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
    });
    const { deps, memberRepo } = makeDeps({ request: bad });
    const r = await decideChangeRequest(deps, input([{ key: 'website', outcome: 'approved' }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('validation_error');
    expect((r.error as { issues: Array<{ path: unknown[] }> }).issues[0]?.path.join('.')).toBe('company.website');
    expect(memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
    expect(metricRefused).toHaveBeenCalledWith('test-tenant', 'validation');
    // rejecting it instead is fine
    const rej = await decideChangeRequest(deps, input([{ key: 'website', outcome: 'rejected' }], 'unsafe link'));
    expect(rej.ok).toBe(true);
  });
});

describe('decideChangeRequest — the decision in ONE transaction (FR-015 / FR-023 / FR-025)', () => {
  it('approve all: every proposed value is applied, the request is approved with reviewer + time, one member email is queued', async () => {
    const { deps, repo, audit, emails, memberRepo, contactRepo } = makeDeps();
    const r = await decideChangeRequest(deps, input(ALL_APPROVED));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repeated).toBe(false);
    expect(r.value.applied).toEqual(['phone', 'description', 'billing_address']);
    expect(r.value.rejected).toEqual([]);
    const row = repo.rows.get(REQ)!;
    expect(row.state).toBe('decided');
    expect(row.outcome).toBe('approved');
    expect(row.decidedByUserId).toBe(REVIEWER);
    expect(row.decidedAt).toEqual(NOW);
    expect(row.fields.map((f) => [f.key, f.outcome, f.appliedAt])).toEqual([
      ['phone', 'approved', NOW],
      ['description', 'approved', NOW],
      ['billing_address', 'approved', NOW],
    ]);
    expect(contactRepo.updateInTx).toHaveBeenCalledWith({ __tx: true }, CONTACT, { phone: '+66899999999' });
    expect(memberRepo.updateFieldsInTx).toHaveBeenCalledWith({ __tx: true }, MEMBER, {
      description: 'A new description',
      billingAddressLine1: 'Box 9',
      billingAddressLine2: null,
      billingSubDistrict: null,
      billingCity: 'Stockholm',
      billingProvince: null,
      billingPostalCode: '11122',
      billingCountry: 'SE',
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_change_request_decided',
      actorUserId: REVIEWER,
      payload: {
        related_member_id: MEMBER,
        request_id: REQ,
        outcome: 'approved',
        fields: [
          { key: 'phone', outcome: 'approved' },
          { key: 'description', outcome: 'approved' },
          { key: 'billing_address', outcome: 'approved' },
        ],
        reason_length: 0,
        actor_role: 'admin',
      },
    });
    expect(audit.events[0]!.payload).not.toHaveProperty('member_id');
    expect(JSON.stringify(audit.events[0]!.payload)).not.toContain('Stockholm');
    expect(emails.enqueued).toEqual([
      {
        type: 'member_change_request_decided_member',
        toEmail: 'anna@nordic.example',
        locale: 'sv',
        contextData: { tenantId: 'test-tenant', requestId: REQ, memberId: MEMBER, submitterUserId: SUBMITTER },
      },
    ]);
    expect(metricDecided).toHaveBeenCalledWith('test-tenant', 'approved');
    expect(metricDuration).toHaveBeenCalledWith('test-tenant', expect.any(Number));
    expect(runInTenant).toHaveBeenCalledTimes(1);
  });

  it('partial: exactly the selected fields apply, the rest do not, outcome partially_approved with the reason + note recorded', async () => {
    const { deps, repo, memberRepo, audit } = makeDeps();
    const r = await decideChangeRequest(deps, input(PARTIAL, 'Please use the registered description', 'checked DBD'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.applied).toEqual(['phone', 'billing_address']);
    expect(r.value.rejected).toEqual(['description']);
    const row = repo.rows.get(REQ)!;
    expect(row.outcome).toBe('partially_approved');
    expect(row.decisionReason).toBe('Please use the registered description');
    expect(row.decisionNote).toBe('checked DBD');
    expect(row.fields.find((f) => f.key === 'description')).toMatchObject({ outcome: 'rejected', appliedAt: null });
    expect(memberRepo.updateFieldsInTx.mock.calls[0]?.[2]).not.toHaveProperty('description');
    expect(audit.events[0]!.payload).toMatchObject({ outcome: 'partially_approved', reason_length: 37 });
  });

  it('reject all: nothing is written to the record, outcome rejected, the member is still emailed', async () => {
    const { deps, repo, memberRepo, contactRepo, emails } = makeDeps();
    const r = await decideChangeRequest(deps, input(ALL_REJECTED, 'Use the registered phone'));
    expect(r.ok && r.value.rejected).toEqual(['phone', 'description', 'billing_address']);
    expect(repo.rows.get(REQ)?.outcome).toBe('rejected');
    expect(memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
    expect(contactRepo.updateInTx).not.toHaveBeenCalled();
    expect(emails.enqueued).toHaveLength(1);
    expect(metricDecided).toHaveBeenCalledWith('test-tenant', 'rejected');
  });

  it('a field whose proposed value already equals the live value is recorded approved WITHOUT a write (FR-015)', async () => {
    const { deps, repo, contactRepo, memberRepo } = makeDeps({ contacts: [contact({ phone: '+66899999999' as Contact['phone'] })] });
    const r = await decideChangeRequest(deps, input(ALL_APPROVED));
    expect(r.ok && r.value.applied).toEqual(['phone', 'description', 'billing_address']);
    expect(contactRepo.updateInTx).not.toHaveBeenCalled(); // phone already current → no contact write
    expect(memberRepo.updateFieldsInTx).toHaveBeenCalledTimes(1);
    expect(repo.rows.get(REQ)?.fields.find((f) => f.key === 'phone')).toMatchObject({ outcome: 'approved', appliedAt: NOW });
  });

  it('an IDENTICAL repeat on a decided request is a harmless no-op: repeated=true, no second write / audit / email', async () => {
    const { deps, audit, emails, memberRepo } = makeDeps();
    const first = await decideChangeRequest(deps, input(PARTIAL, 'reason'));
    expect(first.ok).toBe(true);
    const again = await decideChangeRequest(deps, input(PARTIAL, 'reason'));
    expect(again.ok && again.value.repeated).toBe(true);
    expect(again.ok && again.value.request.outcome).toBe('partially_approved');
    expect(audit.events).toHaveLength(1);
    expect(emails.enqueued).toHaveLength(1);
    expect(memberRepo.updateFieldsInTx).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT decision on a decided request → already_decided with the recorded decision', async () => {
    const { deps } = makeDeps();
    await decideChangeRequest(deps, input(PARTIAL, 'reason'));
    const r = await decideChangeRequest(deps, input(ALL_APPROVED));
    expect(r).toEqual({
      ok: false,
      error: { type: 'already_decided', decidedByUserId: REVIEWER, decidedAt: NOW, outcome: 'partially_approved' },
    });
    expect(metricRefused).toHaveBeenCalledWith('test-tenant', 'already_decided');
    // same outcomes but a different reason is also a different decision
    const r2 = await decideChangeRequest(deps, input(PARTIAL, 'other reason'));
    expect(r2).toMatchObject({ ok: false, error: { type: 'already_decided' } });
  });

  it('a concurrent loser (the FOR UPDATE row is decided by the time the write runs) surfaces already_decided', async () => {
    const { deps, repo } = makeDeps();
    // simulate: the read says pending but decideInTx matches 0 rows
    repo.failNext('decideInTx', { code: 'repo.not_found' });
    const r = await decideChangeRequest(deps, input(ALL_APPROVED));
    expect(r).toMatchObject({ ok: false, error: { type: 'already_decided' } });
  });
});

describe('decideChangeRequest — throw-to-rollback after the first write (FR-015 / US2 AS9)', () => {
  it('a contact write failure after the member write aborts everything (server_error)', async () => {
    const { deps, contactRepo, repo } = makeDeps();
    contactRepo.updateInTx.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const, cause: new Error('boom') }));
    const r = await decideChangeRequest(deps, input(ALL_APPROVED));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
    // the in-memory row is untouched because decideInTx never ran
    expect(repo.rows.get(REQ)?.state).toBe('pending');
    expect(loggerError).toHaveBeenCalled();
  });

  it('an audit failure or an outbox failure after the decision row aborts (server_error)', async () => {
    const a = makeDeps();
    a.audit.failNext();
    expect(await decideChangeRequest(a.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const b = makeDeps();
    b.emails.failNext();
    expect(await decideChangeRequest(b.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('a member re-read failure / a member write failure / a contacts read failure surface server_error', async () => {
    const a = makeDeps();
    a.memberRepo.findByIdInTx.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await decideChangeRequest(a.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const b = makeDeps();
    b.memberRepo.updateFieldsInTx.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await decideChangeRequest(b.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const c = makeDeps();
    c.contactRepo.listByMemberInTx.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await decideChangeRequest(c.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const d = makeDeps();
    d.memberRepo.findErasedAtById.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await decideChangeRequest(d.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const e = makeDeps();
    e.repo.failNext('findByIdInTx');
    expect(await decideChangeRequest(e.deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('an unexpected throw inside the transaction is a server_error, never a swallowed success', async () => {
    const { deps } = makeDeps();
    vi.mocked(runInTenant).mockRejectedValueOnce(new Error('neon down'));
    expect(await decideChangeRequest(deps, input(ALL_APPROVED))).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });
});
