/**
 * F8 Phase 8 T211 spec — `reassignEscalationTask` use-case.
 *
 * Verifies open-task reassignment + atomic `escalation_task_reassigned`
 * audit with from/to/actor user ids forensically captured.
 *
 * Covers:
 *   - happy path: assigned_to_user_id=null → user-1 (from_user_id=null in audit)
 *   - happy path: assigned_to_user_id=user-A → user-B (both ids in audit)
 *   - task_not_found / task_not_open
 *   - reverse-direction atomicity
 *   - invalid_input: bad uuids
 */
import { describe, expect, it, vi } from 'vitest';
import { reassignEscalationTask } from '@/modules/renewals/application/use-cases/reassign-escalation-task';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { asTaskId } from '@/modules/renewals/domain/renewal-escalation-task';

const TENANT_ID = 'tenantA';
const TASK_UUID = '22222222-2222-2222-2222-222222220211';
const MEMBER_UUID = '00000000-0000-0000-0000-000000000211';
const CYCLE_UUID = '11111111-1111-1111-1111-111111110211';
const TO_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const FROM_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function openTaskRow(assignedToUserId: string | null = null) {
  return {
    tenantId: TENANT_ID,
    taskId: asTaskId(TASK_UUID),
    memberId: MEMBER_UUID,
    cycleId: CYCLE_UUID,
    taskType: 'board_escalation',
    assignedToRole: 'admin' as const,
    assignedToUserId,
    dueAt: '2026-06-01T00:00:00.000Z',
    relatedSuggestionId: null,
    createdAt: '2026-05-09T00:00:00.000Z',
    status: 'open' as const,
    outcomeNote: null,
    skippedReason: null,
    closedByUserId: null,
    closedAt: null,
  };
}

function fakeDeps(
  findResult: ReturnType<typeof openTaskRow> | null,
  emitImpl?: () => Promise<void>,
): {
  deps: RenewalsDeps;
  findByIdMock: ReturnType<typeof vi.fn>;
  reassignMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const findByIdMock = vi.fn(async () => findResult);
  const reassignMock = vi.fn(async () => openTaskRow(TO_USER));
  const emitInTxMock = vi.fn(emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    escalationTaskRepo: {
      findById: findByIdMock,
      reassign: reassignMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, findByIdMock, reassignMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  taskId: TASK_UUID,
  toUserId: TO_USER,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-211',
};

describe('reassignEscalationTask (T211)', () => {
  it('happy path — from_user_id=null when previously unassigned', async () => {
    const { deps, reassignMock, emitInTxMock } = fakeDeps(openTaskRow(null));
    const r = await reassignEscalationTask(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fromUserId).toBeNull();
      expect(r.value.toUserId).toBe(TO_USER);
    }
    expect(reassignMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'escalation_task_reassigned',
      payload: {
        task_id: TASK_UUID,
        from_user_id: null,
        to_user_id: TO_USER,
        actor_user_id: 'admin-1',
      },
    });
  });

  it('happy path — captures from_user_id from existing assignment', async () => {
    const { deps, emitInTxMock } = fakeDeps(openTaskRow(FROM_USER));
    const r = await reassignEscalationTask(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fromUserId).toBe(FROM_USER);
    expect(emitInTxMock.mock.calls[0]?.[1]?.payload).toMatchObject({
      from_user_id: FROM_USER,
      to_user_id: TO_USER,
    });
  });

  it('task_not_found', async () => {
    const { deps, reassignMock } = fakeDeps(null);
    const r = await reassignEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_found');
    expect(reassignMock).not.toHaveBeenCalled();
  });

  it('task_not_open', async () => {
    const doneRow = {
      ...openTaskRow(),
      status: 'done' as const,
      outcomeNote: 'prior',
      closedByUserId: 'admin-old',
      closedAt: '2026-04-01T00:00:00.000Z',
    };
    const { deps } = fakeDeps(doneRow as never);
    const r = await reassignEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_open');
  });

  it('reverse-direction atomicity — audit failure rolls back', async () => {
    const auditErr = new Error('audit-DB-down');
    const { deps } = fakeDeps(openTaskRow(), async () => {
      throw auditErr;
    });
    const r = await reassignEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('invalid_input — non-uuid toUserId rejected', async () => {
    const { deps, findByIdMock } = fakeDeps(openTaskRow());
    const r = await reassignEscalationTask(deps, {
      ...baseInput,
      toUserId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
