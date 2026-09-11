/**
 * F114 T032 — `submitChangeRequest`, every branch (US1: FR-001, FR-002,
 * FR-005–FR-008, FR-011, FR-012, FR-025).
 *
 * Pinned here:
 *   - forged keys (Group C / unknown) are refused BEFORE parsing and audited
 *     `member_self_update_forbidden` with `actor_role` = the session role;
 *   - a company key from a non-primary is refused `company_fields_require_primary`
 *     and audited the same way (FR-002);
 *   - a validation failure creates nothing (FR-006);
 *   - the diff drops equal values; nothing differing → `nothing_to_submit`;
 *     identical to the person's pending request → `already_pending` (FR-007);
 *   - ONE transaction: previous pending → withdrawn/replaced, insert, audit
 *     `member_change_request_submitted` { member_id, request_id, contact_id,
 *     scope, field_keys[], replaced_request_id, coalesced: false, actor_role },
 *     one outbox row PER REVIEWER with ids-only context_data and the reviewer's
 *     locale; any failure after the first write rolls back (UseCaseAbort);
 *   - zero reviewers → request still created + logger.warn (misconfigured tenant);
 *   - metrics `submitted.total{scope,coalesced=false}` / `refused.total{reason}`;
 *   - an archived member is refused before any write.
 *
 * `runInTenant` is stubbed (unit level); the same paths run on live Neon in
 * tests/integration/members/change-requests-submit-atomicity.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err, type Result } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
const loggerWarn = vi.fn();
const loggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: (...a: unknown[]) => loggerWarn(...a), info: vi.fn(), debug: vi.fn() },
}));
const metricSubmitted = vi.fn();
const metricRefused = vi.fn();
vi.mock('@/lib/metrics', () => ({
  membersMetrics: {
    changeRequests: {
      submitted: (...a: unknown[]) => metricSubmitted(...a),
      refused: (...a: unknown[]) => metricRefused(...a),
      decided: vi.fn(),
      decideDurationMs: vi.fn(),
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
import type { ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import {
  submitChangeRequest,
  type SubmitChangeRequestDeps,
} from '@/modules/members/application/use-cases/change-requests/submit-change-request';
import {
  makeAuditPortFake,
  makeClockFake,
  makeEmailPortFake,
  makeInMemoryChangeRequestRepo,
  makeReviewerDirectoryFake,
  makeReviewers,
} from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const OTHER_CONTACT = asContactId('22222222-2222-4222-8222-333333333333');
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const NOW = new Date('2026-09-11T08:00:00Z');
let seq = 0;
const nextId = (): ChangeRequestId => `00000000-0000-4000-8000-0000000000${String(++seq).padStart(2, '0')}` as ChangeRequestId;

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
    linkedUserId: USER,
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

function makeDeps(opts: { member?: Member; contact?: Contact | null; reviewers?: number } = {}) {
  const repo = makeInMemoryChangeRequestRepo();
  const audit = makeAuditPortFake();
  const emails = makeEmailPortFake();
  const reviewers = makeReviewerDirectoryFake(makeReviewers(opts.reviewers ?? 2, 'sv'));
  const m = opts.member ?? member();
  const c = opts.contact === undefined ? contact() : opts.contact;
  const memberRepo = {
    findById: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
    findByIdInTx: vi.fn(async (): Promise<Result<Member, RepoError>> => ok(m)),
  };
  const contactRepo = {
    findById: vi.fn(async (): Promise<Result<Contact, RepoError>> => (c ? ok(c) : err({ code: 'repo.not_found' as const }))),
  };
  const deps = {
    tenant,
    changeRequestRepo: repo,
    memberRepo,
    contactRepo,
    audit,
    emails,
    reviewers,
    clock: makeClockFake(NOW),
    newRequestId: nextId,
  } as unknown as SubmitChangeRequestDeps;
  return { deps, repo, audit, emails, reviewers, memberRepo, contactRepo };
}

const input = (rawBody: unknown, actorRole = 'member') => ({
  memberId: MEMBER,
  contactId: CONTACT,
  rawBody,
  actorUserId: USER,
  actorRole,
  requestId: 'req-1',
});

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
});

describe('submitChangeRequest — refusals before any write', () => {
  it('a Group C key is refused BEFORE parsing, audited as a forged self-service edit with the session role, and creates nothing', async () => {
    const { deps, repo, audit, emails } = makeDeps();
    const r = await submitChangeRequest(deps, input({ company: { tax_id: '0105551234567', website: 'https://x.example' } }));
    expect(r).toEqual({ ok: false, error: { type: 'forbidden', reason: 'forged_fields', fields: ['company.tax_id'] } });
    expect(repo.rows.size).toBe(0);
    expect(emails.enqueued).toHaveLength(0);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_self_update_forbidden',
      actorUserId: USER,
      payload: { member_id: MEMBER, attempted_fields: ['company.tax_id'], actor_role: 'member' },
    });
    expect(metricRefused).toHaveBeenCalledWith('test-tenant', 'forbidden');
    expect(runInTenant).not.toHaveBeenCalled();
  });

  it('an unknown top-level key, a Group A key and an unknown address line are all forged', async () => {
    const { deps } = makeDeps();
    const r = await submitChangeRequest(
      deps,
      input({ plan_id: 'x', contact: { preferred_language: 'th' }, company: { registered_address: { street: 'x' } } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ type: 'forbidden', reason: 'forged_fields' });
    expect((r.error as unknown as { fields: string[] }).fields.sort()).toEqual([
      'company.registered_address.street',
      'contact.preferred_language',
      'plan_id',
    ]);
  });

  it('a company key from a NON-primary contact → company_fields_require_primary, audited (FR-002)', async () => {
    const { deps, repo, audit } = makeDeps({ contact: contact({ isPrimary: false }) });
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' }, company: { website: null } }));
    expect(r).toEqual({
      ok: false,
      error: { type: 'forbidden', reason: 'company_fields_require_primary', fields: ['company.website'] },
    });
    expect(repo.rows.size).toBe(0);
    expect(audit.events[0]).toMatchObject({
      type: 'member_self_update_forbidden',
      payload: { member_id: MEMBER, attempted_fields: ['company.website'], actor_role: 'member' },
    });
  });

  it('the forgery audit is best-effort: a failed audit write still refuses (fail-closed) and logs', async () => {
    const { deps, audit } = makeDeps();
    audit.failNext();
    const r = await submitChangeRequest(deps, input({ company: { tax_id: 'x' } }));
    expect(r.ok).toBe(false);
    expect(loggerError).toHaveBeenCalled();
  });

  it('a validation failure creates nothing and carries field-level issues (FR-006)', async () => {
    const { deps, repo, audit } = makeDeps();
    const r = await submitChangeRequest(deps, input({ contact: { phone: 'nope' }, company: { website: 'javascript:alert(1)' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('validation_error');
    const paths = (r.error as { issues: Array<{ path: unknown[] }> }).issues.map((i) => i.path.join('.')).sort();
    expect(paths).toEqual(['company.website', 'contact.phone']);
    expect(repo.rows.size).toBe(0);
    expect(audit.events).toHaveLength(0);
    expect(metricRefused).toHaveBeenCalledWith('test-tenant', 'validation');
  });

  it('a contact that is not the caller\'s own / not of this member → contact_mismatch (IDOR guard)', async () => {
    const { deps } = makeDeps({ contact: contact({ contactId: OTHER_CONTACT, memberId: asMemberId('11111111-1111-4111-8111-999999999999') }) });
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'forbidden', reason: 'contact_mismatch' } });
  });

  it('a removed contact → not_found', async () => {
    const { deps } = makeDeps({ contact: null });
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toEqual({ ok: false, error: { type: 'not_found' } });
  });

  it('an archived member is refused before the transaction (FR-020 class)', async () => {
    const { deps, repo } = makeDeps({ member: member({ status: 'archived', archivedAt: NOW } as Partial<Member>) });
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toEqual({ ok: false, error: { type: 'member_archived' } });
    expect(repo.rows.size).toBe(0);
    expect(metricRefused).toHaveBeenCalledWith('test-tenant', 'archived');
  });

  it('a member archived by a concurrent transition is caught by the FOR UPDATE re-read and rolled back', async () => {
    const { deps, memberRepo, repo } = makeDeps();
    memberRepo.findByIdInTx.mockResolvedValueOnce(ok(member({ status: 'archived', archivedAt: NOW } as Partial<Member>)));
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toEqual({ ok: false, error: { type: 'member_archived' } });
    expect(repo.rows.size).toBe(0);
  });
});

describe('submitChangeRequest — the baseline is the current record (FR-007)', () => {
  it('nothing differing → nothing_to_submit, no row, no audit, no email', async () => {
    const { deps, repo, audit, emails } = makeDeps();
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66 81 234 5678' }, company: { website: 'https://nordic.example' } }));
    expect(r).toEqual({ ok: true, value: { outcome: 'nothing_to_submit' } });
    expect(repo.rows.size).toBe(0);
    expect(audit.events).toHaveLength(0);
    expect(emails.enqueued).toHaveLength(0);
  });

  it('identical to the person\'s pending request → already_pending, nothing created or replaced', async () => {
    const { deps, repo, emails } = makeDeps();
    const first = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(first.ok && first.value.outcome).toBe('submitted');
    const again = await submitChangeRequest(deps, input({ contact: { phone: '+66 89 999 9999' } }));
    expect(again.ok && again.value.outcome).toBe('already_pending');
    expect(again.ok && again.value.outcome === 'already_pending' && again.value.request.id).toBe(
      first.ok && first.value.outcome === 'submitted' ? first.value.request.id : 'x',
    );
    expect(repo.rows.size).toBe(1);
    expect(emails.enqueued).toHaveLength(2); // only the first submission notified
  });
});

describe('submitChangeRequest — the happy path in ONE transaction', () => {
  it('creates the request with only the differing fields, audits with ids/keys only, and queues one email per reviewer', async () => {
    const { deps, repo, audit, emails } = makeDeps({ reviewers: 3 });
    const r = await submitChangeRequest(
      deps,
      input({
        contact: { phone: '+66 89 999 9999', first_name: 'Anna' },
        company: {
          billing_address: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.outcome !== 'submitted') return;
    const { request } = r.value;
    expect(r.value.replaced).toBeNull();
    expect(r.value.staffNotified).toBe(true);
    expect(request.state).toBe('pending');
    expect(request.scope).toBe('mixed');
    expect(request.submitterRoleAtSubmission).toBe('primary');
    expect(request.submittedByContactId).toBe(CONTACT);
    expect(request.submittedByUserId).toBe(USER);
    expect(request.submittedAt).toEqual(NOW);
    expect(request.staffNotifiedAt).toEqual(NOW);
    expect(request.fields.map((f) => f.key)).toEqual(['phone', 'billing_address']);
    expect(request.fields[0]).toMatchObject({ seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false });
    expect(request.fields[1]).toMatchObject({ affectsTaxDocuments: true, proposed: { country: 'SE', line1: 'Box 9' } });
    expect(repo.rows.size).toBe(1);

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_change_request_submitted',
      actorUserId: USER,
      requestId: 'req-1',
      payload: {
        member_id: MEMBER,
        request_id: request.id,
        contact_id: CONTACT,
        scope: 'mixed',
        field_keys: ['phone', 'billing_address'],
        replaced_request_id: null,
        coalesced: false,
        actor_role: 'member',
      },
    });
    // never a value in the audit payload
    expect(JSON.stringify(audit.events[0]!.payload)).not.toContain('+668');
    expect(JSON.stringify(audit.events[0]!.payload)).not.toContain('Stockholm');

    expect(emails.enqueued).toHaveLength(3);
    for (const [i, e] of emails.enqueued.entries()) {
      expect(e.type).toBe('member_change_request_submitted_staff');
      expect(e.toEmail).toBe(`reviewer${i + 1}@staff.example`);
      expect(e.locale).toBe('sv');
      expect(e.contextData).toEqual({
        tenantId: 'test-tenant',
        requestId: request.id,
        memberId: MEMBER,
        submitterUserId: USER,
        fieldKeys: ['phone', 'billing_address'],
      });
      expect(JSON.stringify(e.contextData)).not.toContain('Stockholm');
    }
    expect(metricSubmitted).toHaveBeenCalledWith('test-tenant', 'mixed', false);
    expect(runInTenant).toHaveBeenCalledTimes(1);
  });

  it('a secondary contact proposing own fields → scope own_contact, submitter role secondary', async () => {
    const { deps } = makeDeps({ contact: contact({ isPrimary: false }) });
    const r = await submitChangeRequest(deps, input({ contact: { role_title: 'CFO' } }));
    expect(r.ok && r.value.outcome === 'submitted' && r.value.request.scope).toBe('own_contact');
    expect(r.ok && r.value.outcome === 'submitted' && r.value.request.submitterRoleAtSubmission).toBe('secondary');
    // a secondary's name change is NOT tax-affecting (only the primary's is)
    const r2 = await submitChangeRequest(deps, input({ contact: { last_name: 'Berg' } }));
    expect(r2.ok && r2.value.outcome === 'submitted' && r2.value.request.fields[0]?.affectsTaxDocuments).toBe(false);
  });

  it('the registered address is tax-affecting while the member has NO billing address (FR-019)', async () => {
    const { deps } = makeDeps();
    const r = await submitChangeRequest(
      deps,
      input({ company: { registered_address: { line1: '2 Other Rd', line2: null, sub_district: null, city: 'Bangkok', province: null, postal_code: '10110' } } }),
    );
    expect(r.ok && r.value.outcome === 'submitted' && r.value.request.fields[0]?.affectsTaxDocuments).toBe(true);
    const { deps: withBilling } = makeDeps({ member: member({ billingAddressLine1: 'Box 9', billingCity: 'Stockholm', billingPostalCode: '11122', billingCountry: 'SE' }) });
    const r2 = await submitChangeRequest(
      withBilling,
      input({ company: { registered_address: { line1: '2 Other Rd', line2: null, sub_district: null, city: 'Bangkok', province: null, postal_code: '10110' } } }),
    );
    expect(r2.ok && r2.value.outcome === 'submitted' && r2.value.request.fields[0]?.affectsTaxDocuments).toBe(false);
  });

  it('a DIFFERENT pending request from the same person is replaced: previous → withdrawn/replaced, new one pending, staff re-notified', async () => {
    const { deps, repo, audit, emails } = makeDeps();
    const first = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    const firstId = first.ok && first.value.outcome === 'submitted' ? first.value.request.id : ('' as ChangeRequestId);
    const second = await submitChangeRequest(deps, input({ contact: { phone: '+66877777777' } }));
    expect(second.ok && second.value.outcome === 'submitted' && second.value.replaced).toBe(firstId);
    const prev = repo.rows.get(firstId)!;
    expect(prev.state).toBe('withdrawn');
    expect(prev.withdrawnReason).toBe('replaced');
    expect(prev.replacedByRequestId).toBe(second.ok && second.value.outcome === 'submitted' ? second.value.request.id : 'x');
    expect([...repo.rows.values()].filter((r) => r.state === 'pending')).toHaveLength(1);
    expect(audit.events.map((e) => e.type)).toEqual([
      'member_change_request_submitted',
      'member_change_request_withdrawn',
      'member_change_request_submitted',
    ]);
    expect(audit.events[1]).toMatchObject({
      payload: { related_member_id: MEMBER, request_id: firstId, reason: 'replaced', actor_role: 'member' },
    });
    expect(audit.events[2]).toMatchObject({ payload: { replaced_request_id: firstId } });
    expect(emails.enqueued).toHaveLength(4);
  });

  it('zero reviewers: the request is still created and a warning is logged (misconfigured tenant)', async () => {
    const { deps, repo, emails } = makeDeps({ reviewers: 0 });
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r.ok && r.value.outcome === 'submitted' && r.value.staffNotified).toBe(false);
    expect(repo.rows.size).toBe(1);
    expect(emails.enqueued).toHaveLength(0);
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'test-tenant' }), expect.stringMatching(/no_reviewers/));
  });
});

describe('submitChangeRequest — throw-to-rollback after the first write', () => {
  it('an audit write failure aborts the transaction (nothing committed) and surfaces server_error', async () => {
    const { deps, audit } = makeDeps();
    audit.failNext();
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
    expect(loggerError).toHaveBeenCalled();
  });

  it('an outbox enqueue failure aborts the transaction (the request is never created without its notification)', async () => {
    const { deps, emails } = makeDeps();
    emails.failNext();
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('a repo insert failure (the race that slipped past FOR UPDATE) surfaces server_error', async () => {
    const { deps, repo } = makeDeps();
    repo.failNext('insertInTx');
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('a withdraw failure on the replaced request surfaces server_error', async () => {
    const { deps, repo } = makeDeps();
    await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    repo.failNext('withdrawInTx');
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66877777777' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('a pending-row read failure surfaces server_error; a member re-read failure too', async () => {
    const { deps, repo, memberRepo } = makeDeps();
    repo.failNext('findPendingBySubmitterInTx');
    expect(await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }))).toMatchObject({ ok: false, error: { type: 'server_error' } });
    memberRepo.findByIdInTx.mockResolvedValueOnce(err({ code: 'repo.not_found' as const }));
    expect(await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }))).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('an unexpected throw inside the transaction is a server_error, never a swallowed success', async () => {
    const { deps } = makeDeps();
    vi.mocked(runInTenant).mockRejectedValueOnce(new Error('neon down'));
    const r = await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });

  it('a member pre-read failure maps to not_found / server_error', async () => {
    const { deps, memberRepo } = makeDeps();
    memberRepo.findById.mockResolvedValueOnce(err({ code: 'repo.not_found' as const }));
    expect(await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }))).toEqual({ ok: false, error: { type: 'not_found' } });
    memberRepo.findById.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    expect(await submitChangeRequest(deps, input({ contact: { phone: '+66899999999' } }))).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });
});
