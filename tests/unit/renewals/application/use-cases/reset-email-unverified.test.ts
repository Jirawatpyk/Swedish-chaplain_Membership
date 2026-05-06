/**
 * F8 Phase 4 Wave I2b · T091 spec — `resetEmailUnverified` use-case.
 *
 * Target: 100% branch coverage (security-critical mutating path per
 * Constitution coverage table — clears bounce flag + closes admin
 * tasks).
 *
 * runInTenant is stubbed via partial deps mock — the real
 * implementation wraps in a Drizzle tx; tests verify the use-case
 * invokes `clearEmailUnverified` + `transitionStatus` +
 * `auditEmitter.emitInTx` regardless of tx mechanics.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { assertOk } from '../../_helpers/assert-result';
import {
  resetEmailUnverified,
  MANUAL_OUTREACH_TASK_TYPE,
} from '@/modules/renewals/application/use-cases/reset-email-unverified';
import { EscalationTaskNotFoundError } from '@/modules/renewals/application/ports/renewal-escalation-task-repo';
import { asTaskId } from '@/modules/renewals/domain/renewal-escalation-task';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalEscalationTask } from '@/modules/renewals/domain/renewal-escalation-task';

const TENANT_ID = 'tenantA';
const MEMBER_ID = '00000000-0000-0000-0000-000000000aaa';
const ACTOR_USER_ID = 'user-1';
const TASK_ID_1 = '00000000-0000-0000-0000-000000000b01';
const TASK_ID_2 = '00000000-0000-0000-0000-000000000b02';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildOpenTask(taskId: string): RenewalEscalationTask {
  return {
    tenantId: TENANT_ID,
    taskId: asTaskId(taskId),
    memberId: MEMBER_ID,
    cycleId: '00000000-0000-0000-0000-000000000c01',
    taskType: MANUAL_OUTREACH_TASK_TYPE,
    assignedToRole: 'admin',
    assignedToUserId: null,
    dueAt: '2026-06-01T00:00:00Z',
    relatedSuggestionId: null,
    createdAt: '2026-05-01T00:00:00Z',
    status: 'open',
    outcomeNote: null,
    skippedReason: null,
    closedByUserId: null,
    closedAt: null,
  };
}

function fakeDeps(opts: {
  openTasks: ReadonlyArray<RenewalEscalationTask>;
  flagPrior: boolean;
  flagAffected: number;
  transitionImpl?: (taskId: string) => Promise<RenewalEscalationTask>;
}): {
  deps: RenewalsDeps;
  clearMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  listOpenMock: ReturnType<typeof vi.fn>;
} {
  const clearMock = vi.fn(async () => ({
    previouslyUnverified: opts.flagPrior,
    affectedRows: opts.flagAffected,
  }));
  const transitionMock = vi.fn(async (_tx, _t, taskId, _args) => {
    if (opts.transitionImpl) return opts.transitionImpl(taskId);
    return { ...opts.openTasks[0]!, status: 'done' as const };
  });
  const emitInTxMock = vi.fn(async () => {});
  const listOpenMock = vi.fn(async () => opts.openTasks);
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    memberRenewalFlagsRepo: {
      clearEmailUnverified: clearMock,
      setEmailUnverified: vi.fn(),
    } as unknown as RenewalsDeps['memberRenewalFlagsRepo'],
    escalationTaskRepo: {
      listOpenForMemberByType: listOpenMock,
      transitionStatus: transitionMock,
      insertIfAbsent: vi.fn(),
      findById: vi.fn(),
      list: vi.fn(),
      listOpenForUser: vi.fn(),
      reassign: vi.fn(),
    } as unknown as RenewalsDeps['escalationTaskRepo'],
    auditEmitter: {
      emit: vi.fn(),
      emitInTx: emitInTxMock,
    } as unknown as RenewalsDeps['auditEmitter'],
  } as unknown as RenewalsDeps;
  return { deps, clearMock, transitionMock, emitInTxMock, listOpenMock };
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  actorUserId: ACTOR_USER_ID,
  actorRole: 'system' as const,
  correlationId: 'corr-1',
};

describe('resetEmailUnverified', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: clears flag + closes 1 open task + emits audit', async () => {
    const { deps, clearMock, transitionMock, emitInTxMock } = fakeDeps({
      openTasks: [buildOpenTask(TASK_ID_1)],
      flagPrior: true,
      flagAffected: 1,
    });
    const result = await resetEmailUnverified(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.cleared).toBe(true);
    expect(result.value.closedTaskCount).toBe(1);
    expect(result.value.closedTaskIds).toEqual([TASK_ID_1]);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
    const auditCall = emitInTxMock.mock.calls[0]!;
    expect(auditCall[1].type).toBe('escalation_task_completed');
    expect(auditCall[1].payload.task_id).toBe(TASK_ID_1);
    expect(auditCall[1].payload.task_type).toBe(MANUAL_OUTREACH_TASK_TYPE);
    expect(auditCall[1].payload.closure_reason).toBe(
      'email_re_verified_by_f1',
    );
  });

  it('closes ALL open manual_outreach_required tasks (multi-cycle defensive)', async () => {
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      openTasks: [buildOpenTask(TASK_ID_1), buildOpenTask(TASK_ID_2)],
      flagPrior: true,
      flagAffected: 1,
    });
    const result = await resetEmailUnverified(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.closedTaskCount).toBe(2);
    expect(transitionMock).toHaveBeenCalledTimes(2);
    expect(emitInTxMock).toHaveBeenCalledTimes(2);
  });

  it('idempotent: flag already false → cleared=false, closes 0 tasks (no audit)', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      openTasks: [],
      flagPrior: false,
      flagAffected: 1,
    });
    const result = await resetEmailUnverified(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.cleared).toBe(false);
    expect(result.value.closedTaskCount).toBe(0);
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('member-not-found (RLS-hidden / non-existent): cleared=false, closes 0 tasks', async () => {
    const { deps } = fakeDeps({
      openTasks: [],
      flagPrior: false,
      flagAffected: 0,
    });
    const result = await resetEmailUnverified(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.cleared).toBe(false);
    expect(result.value.closedTaskCount).toBe(0);
  });

  it('flag was true but row affected=0 (RLS-hidden between read+update): cleared=false', async () => {
    const { deps } = fakeDeps({
      openTasks: [],
      flagPrior: true,
      flagAffected: 0,
    });
    const result = await resetEmailUnverified(deps, VALID_INPUT);
    assertOk(result);
    expect(result.value.cleared).toBe(false);
  });

  it('TOCTOU defence: concurrent task close → EscalationTaskNotFoundError swallowed; tx continues', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      openTasks: [buildOpenTask(TASK_ID_1), buildOpenTask(TASK_ID_2)],
      flagPrior: true,
      flagAffected: 1,
      transitionImpl: async (taskId) => {
        if (taskId === TASK_ID_1) {
          throw new EscalationTaskNotFoundError(taskId);
        }
        return { ...buildOpenTask(TASK_ID_2), status: 'done' as const } as RenewalEscalationTask;
      },
    });
    const result = await resetEmailUnverified(deps, VALID_INPUT);
    assertOk(result);
    // Task 1 was concurrently closed → swallowed, NOT in closedTaskIds.
    // Task 2 was closed normally → audit emit fired.
    expect(result.value.closedTaskIds).toEqual([TASK_ID_2]);
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
  });

  it('unexpected transition error propagates (rolls back the entire tx)', async () => {
    const { deps } = fakeDeps({
      openTasks: [buildOpenTask(TASK_ID_1)],
      flagPrior: true,
      flagAffected: 1,
      transitionImpl: async () => {
        throw new Error('db: connection lost');
      },
    });
    await expect(resetEmailUnverified(deps, VALID_INPUT)).rejects.toThrow(
      /connection lost/,
    );
  });

  it('passes MANUAL_OUTREACH_TASK_TYPE to listOpenForMemberByType (FR-019a contract)', async () => {
    const { deps, listOpenMock } = fakeDeps({
      openTasks: [],
      flagPrior: false,
      flagAffected: 1,
    });
    await resetEmailUnverified(deps, VALID_INPUT);
    expect(listOpenMock).toHaveBeenCalledWith(
      TENANT_ID,
      MEMBER_ID,
      'manual_outreach_required',
    );
  });

  it('rejects empty tenantId with invalid_input', async () => {
    const { deps } = fakeDeps({
      openTasks: [],
      flagPrior: false,
      flagAffected: 0,
    });
    const result = await resetEmailUnverified(deps, {
      ...VALID_INPUT,
      tenantId: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects non-UUID memberId with invalid_input', async () => {
    const { deps } = fakeDeps({
      openTasks: [],
      flagPrior: false,
      flagAffected: 0,
    });
    const result = await resetEmailUnverified(deps, {
      ...VALID_INPUT,
      memberId: 'not-a-uuid',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects unknown actorRole (e.g. cron) with invalid_input — only admin/member/system accepted', async () => {
    const { deps } = fakeDeps({
      openTasks: [],
      flagPrior: false,
      flagAffected: 0,
    });
    const result = await resetEmailUnverified(deps, {
      ...VALID_INPUT,
      actorRole: 'cron' as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('passes correlationId + actorUserId + actorRole to audit context', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      openTasks: [buildOpenTask(TASK_ID_1)],
      flagPrior: true,
      flagAffected: 1,
    });
    await resetEmailUnverified(deps, {
      ...VALID_INPUT,
      requestId: 'req-xyz',
      actorRole: 'admin' as const,
    });
    const ctx = emitInTxMock.mock.calls[0]![2];
    expect(ctx.tenantId).toBe(TENANT_ID);
    expect(ctx.actorUserId).toBe(ACTOR_USER_ID);
    expect(ctx.actorRole).toBe('admin');
    expect(ctx.correlationId).toBe('corr-1');
    expect(ctx.requestId).toBe('req-xyz');
  });

  it('transitionStatus called with `to: done` + closure metadata', async () => {
    const { deps, transitionMock } = fakeDeps({
      openTasks: [buildOpenTask(TASK_ID_1)],
      flagPrior: true,
      flagAffected: 1,
    });
    await resetEmailUnverified(deps, VALID_INPUT);
    const args = transitionMock.mock.calls[0]![3];
    expect(args.to).toBe('done');
    expect(args.closedByUserId).toBe(ACTOR_USER_ID);
    expect(args.outcomeNote).toBe('email_re_verified_by_f1');
    expect(args.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
