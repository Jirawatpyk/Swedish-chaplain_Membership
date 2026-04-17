/**
 * Unit tests for `archiveMember` use case (T138, US7) — R009 remediation.
 *
 * Uses port stubs + a mocked `runInTenant` + a minimal stub tx that
 * satisfies the Drizzle SELECT/UPDATE chain shape. Live cascade coverage
 * (sessions + invitations + RLS) stays in
 * `tests/integration/members/archive-cascade.test.ts` (5/5 green on live
 * Neon). These unit tests protect against regressions in input validation
 * and error-mapping logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

// Hoisted stub tx — must be declared before vi.mock hoists.
const stubTxContacts = { linkedUserIds: [] as Array<string | null> };
const stubTxInvitationsRevoked: string[] = [];

function makeStubTx() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () =>
          stubTxContacts.linkedUserIds.map((linkedUserId) => ({
            linkedUserId,
          })),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () =>
            stubTxInvitationsRevoked.map((userId) => ({ userId })),
          ),
        })),
      })),
    })),
  };
}

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return fn(makeStubTx());
    },
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { archiveMember, asMemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import type {
  ArchiveMemberDeps,
} from '@/modules/members/application/use-cases/archive-member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');

function makeMember(opts: {
  status?: 'active' | 'inactive' | 'archived';
  archivedAt?: Date | null;
} = {}) {
  return {
    tenantId: 'test-tenant' as never,
    memberId,
    companyName: 'Acme',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1' as never,
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    status: opts.status ?? 'active',
    archivedAt: opts.archivedAt ?? null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as const;
}

type StubbedArchiveDeps = ArchiveMemberDeps & {
  memberRepo: { [K in keyof ArchiveMemberDeps['memberRepo']]: ReturnType<typeof vi.fn> };
  sessions: { [K in keyof ArchiveMemberDeps['sessions']]: ReturnType<typeof vi.fn> };
  audit: { [K in keyof ArchiveMemberDeps['audit']]: ReturnType<typeof vi.fn> };
};

function makeDeps(overrides: Partial<{
  findByIdResult: unknown;
  updateStatusResult: unknown;
  sessionRevocationResult: unknown;
  auditResult: unknown;
  now: Date;
}> = {}): StubbedArchiveDeps {
  const now = overrides.now ?? new Date();
  const memberRepo = {
    findById: vi.fn(),
    findByIdInTx: vi.fn().mockResolvedValue(
      overrides.findByIdResult ?? ok(makeMember()),
    ),
    findManyByIdsInTx: vi.fn(),
    findSoftDuplicate: vi.fn(),
    findByLinkedUserId: vi.fn(),
    createWithPrimaryContact: vi.fn(),
    updateStatus: vi.fn(),
    updateStatusInTx: vi.fn().mockResolvedValue(
      overrides.updateStatusResult ??
        ok(makeMember({ status: 'archived', archivedAt: now })),
    ),
    updateFields: vi.fn(),
    updateFieldsInTx: vi.fn(),
    searchDirectory: vi.fn(),
    searchDirectoryWithCount: vi.fn(),
  };
  const sessions = {
    revokeAllFor: vi.fn(),
    revokeAllForInTx: vi.fn().mockResolvedValue(
      overrides.sessionRevocationResult ?? ok({ revokedCount: 2 }),
    ),
  };
  const audit = {
    record: vi.fn(),
    recordInTx: vi.fn().mockResolvedValue(overrides.auditResult ?? ok(undefined)),
  };
  const clock = { now: () => now };
  return { tenant, memberRepo, sessions, audit, clock } as unknown as StubbedArchiveDeps;
}

describe('archiveMember use case (R009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTxContacts.linkedUserIds = [];
    stubTxInvitationsRevoked.length = 0;
  });

  it('rejects invalid_body when reason exceeds 500 chars', async () => {
    const deps = makeDeps();
    const result = await archiveMember(
      memberId,
      { reason: 'x'.repeat(501) },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
    // No DB writes on validation failure
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
  });

  it('rejects invalid_body on unknown keys (strict schema)', async () => {
    const deps = makeDeps();
    const result = await archiveMember(
      memberId,
      { reason: 'ok', unknownField: 'boom' },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
  });

  it('happy path: archives member + emits member_archived audit', async () => {
    stubTxContacts.linkedUserIds = []; // no cascade
    const deps = makeDeps();
    const result = await archiveMember(
      memberId,
      { reason: 'company closed' },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('archived');

    // One member_archived audit, zero session revocations (no linked users)
    const archivedCalls = deps.audit.recordInTx.mock.calls.filter(
      (c) => (c[2] as { type: string }).type === 'member_archived',
    );
    expect(archivedCalls).toHaveLength(1);
    expect(deps.sessions.revokeAllForInTx).not.toHaveBeenCalled();
  });

  it('cascade: dedupes same user linked to multiple contacts (R002)', async () => {
    // Two contacts, same linked user — should revoke once
    stubTxContacts.linkedUserIds = ['user-shared', 'user-shared'];
    stubTxInvitationsRevoked.push('user-shared');
    const deps = makeDeps();
    const result = await archiveMember(
      memberId,
      {},
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledTimes(1);
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledWith(
      expect.anything(),
      'user-shared',
      'admin_force',
    );

    // Exactly one user_sessions_revoked audit
    const sessionAudits = deps.audit.recordInTx.mock.calls.filter(
      (c) => (c[2] as { type: string }).type === 'user_sessions_revoked',
    );
    expect(sessionAudits).toHaveLength(1);

    // cascaded_user_ids in member_archived payload has no duplicates
    const archivedCall = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_archived',
    );
    const payload = (archivedCall?.[2] as { payload: { cascaded_user_ids: string[] } })
      ?.payload;
    expect(payload.cascaded_user_ids).toEqual(['user-shared']);
  });

  it('skips linked users whose linkedUserId is null (soft-deleted F1 users)', async () => {
    stubTxContacts.linkedUserIds = [null, 'user-real', null];
    stubTxInvitationsRevoked.push('user-real');
    const deps = makeDeps();
    await archiveMember(
      memberId,
      {},
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledTimes(1);
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledWith(
      expect.anything(),
      'user-real',
      'admin_force',
    );
  });

  it('returns not_found when member repo reports repo.not_found', async () => {
    const deps = makeDeps({
      findByIdResult: err({ code: 'repo.not_found' }),
    });
    const result = await archiveMember(
      memberId,
      {},
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns state_error when member is already archived', async () => {
    const deps = makeDeps({
      findByIdResult: ok(
        makeMember({ status: 'archived', archivedAt: new Date() }),
      ),
    });
    const result = await archiveMember(
      memberId,
      {},
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.cannot_archive_already_archived');
      }
    }
  });

  it('returns server_error when session revocation fails', async () => {
    stubTxContacts.linkedUserIds = ['user-1'];
    const deps = makeDeps({
      sessionRevocationResult: err({
        code: 'repo.unexpected',
        cause: 'session repo down',
      }),
    });
    const result = await archiveMember(
      memberId,
      {},
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('audit payload carries reason verbatim (R004 — flagged for F9 carve-out)', async () => {
    const deps = makeDeps();
    await archiveMember(
      memberId,
      { reason: 'sensitive internal note' },
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    const archivedCall = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_archived',
    );
    const payload = (archivedCall?.[2] as { payload: { reason: string | null } })
      ?.payload;
    // Confirms current behaviour; spec amendment for F9 export carve-out
    // is tracked per staff-review R004.
    expect(payload.reason).toBe('sensitive internal note');
  });
});
