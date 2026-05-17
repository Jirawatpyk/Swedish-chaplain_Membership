/**
 * Unit tests for `undeleteMember` use case (T139, US7) — R009 remediation.
 *
 * Uses port stubs + a mocked `runInTenant` to give fast (<100ms) feedback
 * on the orchestration logic without hitting live Neon. Live integration
 * coverage still lives in `tests/integration/members/undelete-window.test.ts`
 * (4/4 green on live Neon) — this file protects against regressions in
 * the use-case's error-mapping + input-validation code paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

// `runInTenant` must be mocked BEFORE importing the use case so the
// stub is baked into the module's closure.
vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix "No 'db' export defined on
  // mock" collection error from F3 infra adapter import chain.
  db: {},
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return fn({}); // empty stub tx — use case doesn't touch it directly
    },
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { undeleteMember, asMemberId } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import type {
  UndeleteMemberDeps,
} from '@/modules/members/application/use-cases/undelete-member';

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
    status: opts.status ?? 'archived',
    archivedAt: opts.archivedAt ?? new Date(Date.now() - 10 * 86_400_000),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as const;
}

type StubbedDeps = UndeleteMemberDeps & {
  memberRepo: { [K in keyof UndeleteMemberDeps['memberRepo']]: ReturnType<typeof vi.fn> };
  audit: { [K in keyof UndeleteMemberDeps['audit']]: ReturnType<typeof vi.fn> };
};

function makeDeps(overrides: Partial<{
  findByIdResult: unknown;
  updateStatusResult: unknown;
  auditResult: unknown;
  now: Date;
}> = {}): StubbedDeps {
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
      overrides.updateStatusResult ?? ok(makeMember({ status: 'active', archivedAt: null })),
    ),
    updateFields: vi.fn(),
    updateFieldsInTx: vi.fn(),
    searchDirectory: vi.fn(),
    searchDirectoryWithCount: vi.fn(),
  };
  const audit = {
    record: vi.fn(),
    recordInTx: vi.fn().mockResolvedValue(overrides.auditResult ?? ok(undefined)),
  };
  const clock = { now: () => now };
  return { tenant, memberRepo, audit, clock } as unknown as StubbedDeps;
}

describe('undeleteMember use case (R009)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: restores member + emits member_undeleted audit', async () => {
    const deps = makeDeps();
    const result = await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(deps.audit.recordInTx).toHaveBeenCalledWith(
      expect.anything(),
      tenant,
      expect.objectContaining({
        type: 'member_undeleted',
        payload: expect.objectContaining({ member_id: memberId }),
      }),
    );
  });

  it('returns not_found when member repo reports repo.not_found', async () => {
    const deps = makeDeps({
      findByIdResult: err({ code: 'repo.not_found' }),
    });
    const result = await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns state_error when member is active (cannot undelete active)', async () => {
    const deps = makeDeps({
      findByIdResult: ok(makeMember({ status: 'active', archivedAt: null })),
    });
    const result = await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.undelete_only_from_archived');
      }
    }
  });

  it('returns state_error with daysSinceArchive when archive > 90 days', async () => {
    const archivedAt = new Date(Date.now() - 120 * 86_400_000);
    const deps = makeDeps({
      findByIdResult: ok(makeMember({ status: 'archived', archivedAt })),
    });
    const result = await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('state_error');
      if (result.error.type === 'state_error') {
        expect(result.error.code).toBe('state.undelete_window_expired');
        expect(result.error.daysSinceArchive).toBeGreaterThanOrEqual(120);
      }
    }
  });

  it('does NOT persist or emit audit when state_error thrown', async () => {
    const deps = makeDeps({
      findByIdResult: ok(makeMember({ status: 'active', archivedAt: null })),
    });
    await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(deps.memberRepo.updateStatusInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('returns server_error on unexpected repo failure', async () => {
    const deps = makeDeps({
      findByIdResult: err({ code: 'repo.unexpected', cause: 'db down' }),
    });
    const result = await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns server_error when audit recording fails', async () => {
    const deps = makeDeps({
      auditResult: err({ code: 'repo.unexpected', cause: 'audit log down' }),
    });
    const result = await undeleteMember(
      memberId,
      { actorUserId: 'admin-1', requestId: 'req-1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });
});
