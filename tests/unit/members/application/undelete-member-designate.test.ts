/**
 * 108 T032 (US2 / FR-014) — unarchive designates a primary contact.
 *
 * A member can reach "archived + zero live primaries" two ways: the archive
 * cascade removes contacts, or legacy rows predate the invariant. Restoring
 * such a member without designating a primary would create the one state
 * FR-010 forbids — and, since 108 PR-A shipped, a member with no live primary
 * silently stops receiving receipts, void notices and credit notes. So
 * unarchive must refuse until staff name the contact that takes over, and the
 * designation must commit with the status flip, not after it.
 *
 * Unit-level: `runInTenant` is stubbed so the orchestration (read → decide →
 * designate → flip → audit) is exercised without live Neon. The deferred DB
 * trigger that backstops the same rule is rehearsed in
 * `tests/integration/members/primary-contact-trigger.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ __tx: true }),
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { restoreOutcome: vi.fn() },
}));

import { undeleteMember, asMemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import type { Contact, ContactId } from '@/modules/members/domain/contact';
import type { Member } from '@/modules/members/domain/member';
import type { UndeleteMemberDeps } from '@/modules/members/application/use-cases/undelete-member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const LIVE_A = '22222222-2222-4222-8222-222222222222' as ContactId;
const LIVE_B = '33333333-3333-4333-8333-333333333333' as ContactId;
const REMOVED = '44444444-4444-4444-8444-444444444444' as ContactId;
const OTHER_MEMBERS = '55555555-5555-4555-8555-555555555555' as ContactId;

function makeMember(status: 'active' | 'archived' = 'archived') {
  return {
    tenantId: 'test-tenant',
    memberId,
    companyName: 'Acme',
    legalEntityType: null,
    country: 'TH',
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    status,
    archivedAt: status === 'archived' ? new Date(Date.now() - 10 * 86_400_000) : null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as const;
}

function contact(
  contactId: ContactId,
  opts: { isPrimary?: boolean; removed?: boolean; memberOverride?: string } = {},
) {
  return {
    tenantId: 'test-tenant',
    contactId,
    memberId: opts.memberOverride ?? memberId,
    firstName: 'First',
    lastName: `Last-${contactId.slice(0, 4)}`,
    email: `c-${contactId.slice(0, 8)}@example.com`,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    isPrimary: opts.isPrimary ?? false,
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing: { optedOutAt: null, source: null, byUserId: null },
    removedAt: opts.removed ? new Date('2026-02-01') : null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as const;
}

function makeDeps(contacts: ReadonlyArray<ReturnType<typeof contact>>) {
  const memberRepo = {
    findByIdInTx: vi.fn().mockResolvedValue(ok(makeMember())),
    // T041 reliability review L5 — erased members are partitioned out first.
    findErasedIdsInTx: vi.fn().mockResolvedValue(ok(new Set())),
    updateStatusInTx: vi
      .fn()
      .mockResolvedValue(ok({ ...makeMember(), status: 'active', archivedAt: null })),
  };
  const contactRepo = {
    listByMemberInTx: vi.fn().mockResolvedValue(ok(contacts)),
    // Non-tx read used only when the deferred trigger refused the COMMIT and
    // the in-tx list is gone with the rolled-back tx.
    listByMember: vi.fn().mockResolvedValue(ok(contacts)),
    designatePrimaryInTx: vi
      .fn()
      .mockImplementation(async (_tx: unknown, _m: unknown, contactId: ContactId) => {
        const target = contacts.find(
          (c) => c.contactId === contactId && c.removedAt === null,
        );
        return target === undefined
          ? err({ code: 'repo.not_found' as const })
          : ok({ ...target, isPrimary: true });
      }),
  };
  const audit = { recordInTx: vi.fn().mockResolvedValue(ok(undefined)) };
  const renewalsCascade = {
    restoreForMember: vi.fn().mockResolvedValue({ outcome: 'restored', cycleId: 'c1' }),
  };
  return {
    tenant,
    memberRepo,
    contactRepo,
    audit,
    clock: { now: () => new Date('2026-03-01T00:00:00Z') },
    renewalsCascade,
  } as unknown as UndeleteMemberDeps;
}

const meta = { actorUserId: 'admin-1', requestId: 'req-1' };

describe('undeleteMember — primary-contact designation (FR-014)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('proceeds untouched when the member already has a live primary', async () => {
    const deps = makeDeps([contact(LIVE_A, { isPrimary: true }), contact(LIVE_B)]);

    const result = await undeleteMember(memberId, meta, deps);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(deps.contactRepo.designatePrimaryInTx).not.toHaveBeenCalled();
    // Only the undelete event — no fabricated primary-contact change.
    const types = vi.mocked(deps.audit.recordInTx).mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toEqual(['member_undeleted']);
  });

  it('refuses with no_primary_contact + the designatable list when none is named', async () => {
    const deps = makeDeps([
      contact(LIVE_A),
      contact(LIVE_B),
      contact(REMOVED, { removed: true }),
    ]);

    const result = await undeleteMember(memberId, meta, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('state_error');
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    // The dialog needs choices; a removed contact is never a choice (FR-014).
    expect(result.error.designatable?.map((c) => c.contactId)).toEqual([
      LIVE_A,
      LIVE_B,
    ]);
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('designates the named live contact, audits it as a primary change, and restores', async () => {
    const deps = makeDeps([contact(LIVE_A), contact(LIVE_B)]);

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: LIVE_B,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(deps.contactRepo.designatePrimaryInTx).toHaveBeenCalledWith(
      expect.anything(),
      memberId,
      LIVE_B,
    );
    expect(deps.audit.recordInTx).toHaveBeenCalledWith(
      expect.anything(),
      tenant,
      expect.objectContaining({
        type: 'member_primary_contact_changed',
        payload: expect.objectContaining({
          member_id: memberId,
          // There was no primary to demote — an honest null, never a
          // fabricated predecessor id.
          old_primary_contact_id: null,
          new_primary_contact_id: LIVE_B,
        }),
      }),
    );
    const types = vi.mocked(deps.audit.recordInTx).mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toEqual(['member_primary_contact_changed', 'member_undeleted']);
  });

  it('refuses a designated contact that is removed', async () => {
    const deps = makeDeps([contact(LIVE_A), contact(REMOVED, { removed: true })]);

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: REMOVED,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('state_error');
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    expect(deps.contactRepo.designatePrimaryInTx).not.toHaveBeenCalled();
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('refuses a designated contact that belongs to another member (IDOR guard)', async () => {
    const deps = makeDeps([contact(LIVE_A)]);

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: OTHER_MEMBERS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('state_error');
    expect(deps.contactRepo.designatePrimaryInTx).not.toHaveBeenCalled();
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('offers an empty designatable list when the member has no live contacts at all', async () => {
    const deps = makeDeps([contact(REMOVED, { removed: true })]);

    const result = await undeleteMember(memberId, meta, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    expect(result.error.designatable).toEqual([]);
  });

  it('aborts the whole transaction when the designation loses a concurrent race', async () => {
    const deps = makeDeps([contact(LIVE_A), contact(LIVE_B)]);
    // The row was live at read time and removed before the UPDATE landed.
    vi.mocked(deps.contactRepo.designatePrimaryInTx).mockResolvedValue(
      err({ code: 'repo.not_found' as const }),
    );

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: LIVE_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('state_error');
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    // FR-014: the designation and the unarchive succeed or fail together.
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  // ── T041 review round 1 ────────────────────────────────────────────────────

  it('reports WHICH contact it designated, and null when a primary already existed', async () => {
    // L4c: the banner's success toast must not claim "primary contact set"
    // when a primary appeared between the 409 and the retry and nothing was
    // designated.
    const withPrimary = makeDeps([contact(LIVE_A, { isPrimary: true })]);
    const r1 = await undeleteMember(memberId, meta, withPrimary, {
      designatePrimaryContactId: LIVE_A,
    });
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.designatedContactId).toBeNull();
    expect(r1.value.member.status).toBe('active');

    const without = makeDeps([contact(LIVE_A), contact(LIVE_B)]);
    const r2 = await undeleteMember(memberId, meta, without, {
      designatePrimaryContactId: LIVE_B,
    });
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.designatedContactId).toBe(LIVE_B);
  });

  it('a DB failure during the designation is a server_error, not "choose a contact"', async () => {
    // Security review L4: `repo.unexpected` must not be collapsed into 409.
    const deps = makeDeps([contact(LIVE_A), contact(LIVE_B)]);
    vi.mocked(deps.contactRepo.designatePrimaryInTx).mockResolvedValue(
      err({ code: 'repo.unexpected' as const, cause: new Error('boom') }),
    );

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: LIVE_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('server_error');
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('a lost designation race refuses with a FRESH list, not the one read before the UPDATE', async () => {
    // L4b: the tx is still live after a 0-row UPDATE, so re-read.
    const deps = makeDeps([contact(LIVE_A), contact(LIVE_B)]);
    vi.mocked(deps.contactRepo.listByMemberInTx)
      .mockResolvedValueOnce(ok([contact(LIVE_A), contact(LIVE_B)] as unknown as Contact[]))
      .mockResolvedValueOnce(
        ok([contact(LIVE_A), contact(LIVE_B, { removed: true })] as unknown as Contact[]),
      );
    vi.mocked(deps.contactRepo.designatePrimaryInTx).mockResolvedValue(
      err({ code: 'repo.not_found' as const }),
    );

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: LIVE_B,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    expect(result.error.designatable?.map((c) => c.contactId)).toEqual([LIVE_A]);
  });

  it('the designatable list carries the email — the choice IS "which address gets the receipts"', async () => {
    // UX review M5.
    const deps = makeDeps([contact(LIVE_A), contact(LIVE_B)]);

    const result = await undeleteMember(memberId, meta, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.type !== 'state_error') return;
    expect(result.error.designatable?.[0]).toEqual(
      expect.objectContaining({ contactId: LIVE_A, email: expect.stringContaining('@') }),
    );
  });

  it('when the deferred trigger refuses the COMMIT, offers the list from a fresh read — never an empty list', async () => {
    // L4a: the rolled-back tx took the in-tx list with it; an empty list
    // would render the "no contacts left" variant for a member that has some.
    const deps = makeDeps([contact(LIVE_A), contact(LIVE_B)]);
    // Nothing designated → normally refused before any write. Force the path
    // where the in-tx read sees a primary (so the flip is attempted) and the
    // COMMIT is then refused by the trigger.
    vi.mocked(deps.contactRepo.listByMemberInTx).mockResolvedValueOnce(
      ok([contact(LIVE_A, { isPrimary: true })] as unknown as Contact[]),
    );
    const { runInTenant } = await import('@/lib/db');
    vi.mocked(runInTenant).mockImplementationOnce(async (_ctx, fn) => {
      await fn({ __tx: true } as never);
      const e = Object.assign(new Error('Failed query'), {
        cause: Object.assign(
          new Error('primary-contact-invariant: member x in tenant t has 0 live primary contact(s)'),
          { code: '23514' },
        ),
      });
      throw e;
    });

    const result = await undeleteMember(memberId, meta, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    expect(deps.contactRepo.listByMember).toHaveBeenCalledWith(tenant, memberId);
    expect(result.error.designatable?.map((c) => c.contactId)).toEqual([LIVE_A, LIVE_B]);
  });

  it('refuses to restore an ERASED member (the API had no erased_at gate)', async () => {
    // L5: the page hides the banner for an erased member; the route did not.
    const deps = makeDeps([contact(LIVE_A, { isPrimary: true })]);
    vi.mocked(deps.memberRepo.findErasedIdsInTx).mockResolvedValue(ok(new Set([memberId])));

    const result = await undeleteMember(memberId, meta, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: 'state_error', code: 'undelete_erased' });
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('never designates for a member that is not archived — the state check runs first', async () => {
    const deps = makeDeps([contact(LIVE_A)]);
    vi.mocked(deps.memberRepo.findByIdInTx).mockResolvedValue(
      ok(makeMember('active') as unknown as Member),
    );

    const result = await undeleteMember(memberId, meta, deps, {
      designatePrimaryContactId: LIVE_A,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('state_error');
    expect(deps.contactRepo.designatePrimaryInTx).not.toHaveBeenCalled();
  });
});
