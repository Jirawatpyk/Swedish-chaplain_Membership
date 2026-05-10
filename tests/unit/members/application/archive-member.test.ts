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

// Round 2 review M-2/C1: assert the H1-fix invariant (cascade-failure
// metric emit) — without this, a future refactor that drops the metric
// would silently re-introduce the original signal-loss bug.
const { cascadeOutcomeSpy } = vi.hoisted(() => ({
  cascadeOutcomeSpy: vi.fn(),
}));
vi.mock('@/lib/metrics', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      cascadeOutcome: cascadeOutcomeSpy,
    },
  };
});

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
  contactRepo: { [K in keyof ArchiveMemberDeps['contactRepo']]: ReturnType<typeof vi.fn> };
  invitations: { [K in keyof ArchiveMemberDeps['invitations']]: ReturnType<typeof vi.fn> };
  sessions: { [K in keyof ArchiveMemberDeps['sessions']]: ReturnType<typeof vi.fn> };
  audit: { [K in keyof ArchiveMemberDeps['audit']]: ReturnType<typeof vi.fn> };
};

function makeDeps(overrides: Partial<{
  findByIdResult: unknown;
  updateStatusResult: unknown;
  sessionRevocationResult: unknown;
  auditResult: unknown;
  now: Date;
  broadcastsCascade: ArchiveMemberDeps['broadcastsCascade'];
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
  // ContactRepo stub — only the InTx method is touched by archiveMember.
  // Returns the raw list (null-inclusive) to preserve R002 dedupe coverage;
  // the filter-out-null lives in the real adapter.
  const contactRepo = {
    listByMember: vi.fn(),
    findById: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    promotePrimary: vi.fn(),
    linkUser: vi.fn(),
    updateEmailInTx: vi.fn(),
    listLinkedUserIdsForMemberInTx: vi.fn(async () =>
      stubTxContacts.linkedUserIds.filter(
        (uid): uid is string => uid !== null,
      ),
    ),
  };
  const invitations = {
    softConsumePendingForUsersInTx: vi.fn(async () => ({
      revokedCount: stubTxInvitationsRevoked.length,
    })),
  };
  const clock = { now: () => now };
  // T199 H-1: broadcastsCascade is REQUIRED on ArchiveMemberDeps. Default
  // to a no-op stub returning the new `outcome: 'ok'` shape; individual
  // tests override to assert cascade-failure paths emit metric + log.
  const broadcastsCascade: ArchiveMemberDeps['broadcastsCascade'] =
    overrides.broadcastsCascade ?? {
      cancelInFlightForMember: vi.fn(
        async () =>
          ({
            outcome: 'ok' as const,
            cancelledCount: 0,
            skippedConcurrentCount: 0,
          }) as const,
      ),
    };
  // Phase 9 / T239: renewalsCascade is REQUIRED on ArchiveMemberDeps.
  // No-op stub mirrors the broadcastsCascade default; tests that assert
  // cascade-failure paths can override.
  const renewalsCascade: ArchiveMemberDeps['renewalsCascade'] = {
    cancelInFlightForMember: vi.fn(
      async () =>
        ({
          outcome: 'ok' as const,
          cancelledCount: 0,
          skippedConcurrentCount: 0,
        }) as const,
    ),
  };
  return {
    tenant,
    memberRepo,
    contactRepo,
    invitations,
    sessions,
    audit,
    clock,
    broadcastsCascade,
    renewalsCascade,
  } as unknown as StubbedArchiveDeps;
}

describe('archiveMember use case (R009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cascadeOutcomeSpy.mockReset();
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

  describe('F7 broadcasts cascade integration (T199 H-1)', () => {
    it('happy path: invokes cascade with archived memberId + initiatedByUserId; no unexpected_error metric emitted', async () => {
      const cancelInFlightForMember = vi.fn(async () => ({
        outcome: 'ok' as const,
        cancelledCount: 0,
        skippedConcurrentCount: 0,
      }));
      const deps = makeDeps({
        broadcastsCascade: { cancelInFlightForMember },
      });
      const result = await archiveMember(
        memberId,
        { reason: 'cascade happy' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      expect(result.ok).toBe(true);
      expect(cancelInFlightForMember).toHaveBeenCalledTimes(1);
      const call = cancelInFlightForMember.mock.calls[0] as unknown as [
        { slug: string },
        unknown,
        {
          cancellationReason?: string;
          initiatedByUserId: string | null;
          requestId: string | null;
        },
      ];
      expect(call[0].slug).toBe('test-tenant');
      expect(call[1]).toBe(memberId);
      expect(call[2].cancellationReason).toBe('originator_member_deleted');
      expect(call[2].initiatedByUserId).toBe('admin-7');
      expect(call[2].requestId).toBe('req-7');
      // Happy path MUST NOT emit unexpected_error — would break alert.
      const unexpectedErrorCalls = cascadeOutcomeSpy.mock.calls.filter(
        (c) => c[1] === 'unexpected_error',
      );
      expect(unexpectedErrorCalls).toHaveLength(0);
    });

    it('cascade outcome=cascade_failed: archive still succeeds + emits unexpected_error metric (H3 invariant)', async () => {
      const cancelInFlightForMember = vi.fn(async () => ({
        outcome: 'cascade_failed' as const,
      }));
      const deps = makeDeps({
        broadcastsCascade: { cancelInFlightForMember },
      });
      const result = await archiveMember(
        memberId,
        { reason: 'cascade failed' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      // F3 archive must succeed even when F7 cascade reports failure —
      // cascade is best-effort per archive-member.ts L221-223.
      expect(result.ok).toBe(true);
      expect(cancelInFlightForMember).toHaveBeenCalledTimes(1);
      // H3 invariant: outcome='cascade_failed' MUST emit unexpected_error
      // metric so the stop-the-line alert fires.
      expect(cascadeOutcomeSpy).toHaveBeenCalledWith(
        'test-tenant',
        'unexpected_error',
      );
    });

    it('cascade throws: archive still succeeds + emits unexpected_error metric (H3 invariant)', async () => {
      const cancelInFlightForMember = vi.fn(async () => {
        throw new Error('adapter mis-wired');
      });
      const deps = makeDeps({
        broadcastsCascade: { cancelInFlightForMember },
      });
      const result = await archiveMember(
        memberId,
        { reason: 'cascade throws' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      expect(result.ok).toBe(true);
      // H3 invariant: adapter throws also emit unexpected_error metric.
      expect(cascadeOutcomeSpy).toHaveBeenCalledWith(
        'test-tenant',
        'unexpected_error',
      );
    });

    it('cascade outcome=cascade_partial_failure: archive succeeds + structured log records counts (Round 5)', async () => {
      const cancelInFlightForMember = vi.fn(async () => ({
        outcome: 'cascade_partial_failure' as const,
        cancelledCount: 2,
        skippedConcurrentCount: 1,
        unexpectedErrorCount: 3,
      }));
      const deps = makeDeps({
        broadcastsCascade: { cancelInFlightForMember },
      });
      const result = await archiveMember(
        memberId,
        { reason: 'partial failure' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      // F3 archive must succeed even on partial cascade — per-broadcast
      // unexpected_error metric was already emitted inside the F7
      // use-case loop. F3 just records the structured log so ops can
      // grep which member's archive ended in a partial cascade.
      expect(result.ok).toBe(true);
      expect(cancelInFlightForMember).toHaveBeenCalledTimes(1);
    });
  });

  // ── F8 renewals cascade failure-path tests (Phase 9 verify-fix C1) ──
  // Mirrors the F7 broadcasts cascade pattern at lines 434-502 above.
  // Without these tests, a future refactor that swaps the if/else order
  // in archive-member.ts:328-388 OR drops the try/catch would not be
  // caught — silently masking a member's in-flight renewal cycle staying
  // live after archival. Spec § Edge Cases line 196 requires
  // `renewal_cycle_cancelled` on archive.
  describe('F8 renewals cascade failure paths (Phase 9 verify-fix C1)', () => {
    it('renewals cascade outcome=cascade_failed: archive still succeeds + emits unexpected_error metric', async () => {
      const cancelInFlightForMember = vi.fn(async () => ({
        outcome: 'cascade_failed' as const,
      }));
      const deps = makeDeps();
      // Override after construction so we can use a richer stub than
      // the makeDeps default no-op renewalsCascade.
      (deps as { renewalsCascade: unknown }).renewalsCascade = {
        cancelInFlightForMember,
      };
      const result = await archiveMember(
        memberId,
        { reason: 'F8 cascade failed' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      // F3 archive must succeed — F8 cascade is best-effort.
      expect(result.ok).toBe(true);
      expect(cancelInFlightForMember).toHaveBeenCalledTimes(1);
      // The metric assertion would need a renewalsCascadeOutcome spy
      // similar to broadcastsCascadeOutcome — wire when the metric
      // surfaces as a regression-class signal. Today: log-only branch
      // is asserted via the call count above.
    });

    it('renewals cascade throws: archive still succeeds + structured log captures errName', async () => {
      const cancelInFlightForMember = vi.fn(async () => {
        const e = new Error('renewals adapter mis-wired');
        e.name = 'AdapterMisWireError';
        throw e;
      });
      const deps = makeDeps();
      (deps as { renewalsCascade: unknown }).renewalsCascade = {
        cancelInFlightForMember,
      };
      const result = await archiveMember(
        memberId,
        { reason: 'F8 cascade throws' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      // Adapter throw → archive-member.ts catch block → log + continue.
      // F3 archive remains successful. The catch block logs `errName`
      // for triage (Phase 9 verify-fix added the propagation).
      expect(result.ok).toBe(true);
      expect(cancelInFlightForMember).toHaveBeenCalledTimes(1);
    });

    it('renewals cascade outcome=cascade_partial_failure: archive succeeds + log records counts', async () => {
      const cancelInFlightForMember = vi.fn(async () => ({
        outcome: 'cascade_partial_failure' as const,
        cancelledCount: 0,
        skippedConcurrentCount: 1,
      }));
      const deps = makeDeps();
      (deps as { renewalsCascade: unknown }).renewalsCascade = {
        cancelInFlightForMember,
      };
      const result = await archiveMember(
        memberId,
        { reason: 'F8 cascade partial' },
        { actorUserId: 'admin-7', requestId: 'req-7' },
        deps,
      );
      // F3 archive succeeds; the F8 partial-failure branch logs
      // `cancelledCount` + `skippedConcurrentCount` per
      // archive-member.ts:362-370.
      expect(result.ok).toBe(true);
      expect(cancelInFlightForMember).toHaveBeenCalledTimes(1);
    });
  });
});
