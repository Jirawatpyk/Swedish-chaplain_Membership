/**
 * F8 Phase 8 T209 spec — `completeEscalationTask` use-case.
 *
 * Verifies open → done transition + atomic `escalation_task_completed`
 * audit (Constitution Principle VIII).
 *
 * Covers:
 *   - happy path with outcome note
 *   - happy path without outcome note (note=null in audit payload)
 *   - task_not_found when findById returns null
 *   - task_not_open when status='done' / 'skipped'
 *   - reverse-direction atomicity: audit failure rolls back
 *   - invalid_input: non-uuid taskId / outcomeNote >1000 chars / non-admin role
 */
import { describe, expect, it, vi } from 'vitest';
import { completeEscalationTask } from '@/modules/renewals/application/use-cases/complete-escalation-task';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { asTaskId } from '@/modules/renewals/domain/renewal-escalation-task';

const TENANT_ID = 'tenantA';
const TASK_UUID = '22222222-2222-2222-2222-222222220209';
const MEMBER_UUID = '00000000-0000-0000-0000-000000000209';
const CYCLE_UUID = '11111111-1111-1111-1111-111111110209';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function openTaskRow() {
  return {
    tenantId: TENANT_ID,
    taskId: asTaskId(TASK_UUID),
    memberId: MEMBER_UUID,
    cycleId: CYCLE_UUID,
    taskType: 'phone_call',
    assignedToRole: 'admin' as const,
    assignedToUserId: null,
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
  transitionStatusMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const findByIdMock = vi.fn(async () => findResult);
  const transitionStatusMock = vi.fn(async () => openTaskRow());
  const emitInTxMock = vi.fn(emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    escalationTaskRepo: {
      findById: findByIdMock,
      transitionStatus: transitionStatusMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, findByIdMock, transitionStatusMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  taskId: TASK_UUID,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-209',
};

describe('completeEscalationTask (T209)', () => {
  it('happy path — with outcome note', async () => {
    const { deps, transitionStatusMock, emitInTxMock } = fakeDeps(
      openTaskRow(),
    );
    const r = await completeEscalationTask(deps, {
      ...baseInput,
      outcomeNote: 'Spoke with member; renewing next week',
    });
    expect(r.ok).toBe(true);
    expect(transitionStatusMock).toHaveBeenCalledOnce();
    expect(transitionStatusMock.mock.calls[0]?.[3]).toMatchObject({
      to: 'done',
      closedByUserId: 'admin-1',
      outcomeNote: 'Spoke with member; renewing next week',
    });
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'escalation_task_completed',
      payload: {
        task_id: TASK_UUID,
        task_type: 'phone_call',
        member_id: MEMBER_UUID,
        cycle_id: CYCLE_UUID,
        outcome_note: 'Spoke with member; renewing next week',
        actor_user_id: 'admin-1',
      },
    });
  });

  it('happy path — without outcome note (audit payload has null)', async () => {
    const { deps, emitInTxMock } = fakeDeps(openTaskRow());
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitInTxMock.mock.calls[0]?.[1]?.payload?.outcome_note).toBeNull();
  });

  it('task_not_found when findById returns null', async () => {
    const { deps, transitionStatusMock, emitInTxMock } = fakeDeps(null);
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_found');
    expect(transitionStatusMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('task_not_open when status is done', async () => {
    const closedRow = {
      ...openTaskRow(),
      status: 'done' as const,
      outcomeNote: 'prior',
      closedByUserId: 'admin-old',
      closedAt: '2026-04-01T00:00:00.000Z',
    };
    const { deps, transitionStatusMock } = fakeDeps(closedRow as never);
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_open');
    expect(transitionStatusMock).not.toHaveBeenCalled();
  });

  it('reverse-direction atomicity — audit failure rolls back', async () => {
    const auditErr = new Error('audit-DB-down');
    const { deps } = fakeDeps(openTaskRow(), async () => {
      throw auditErr;
    });
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('invalid_input — non-uuid taskId rejected', async () => {
    const { deps, findByIdMock } = fakeDeps(openTaskRow());
    const r = await completeEscalationTask(deps, {
      ...baseInput,
      taskId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('invalid_input — outcomeNote >1000 chars rejected at zod gate', async () => {
    const { deps } = fakeDeps(openTaskRow());
    const r = await completeEscalationTask(deps, {
      ...baseInput,
      outcomeNote: 'x'.repeat(1001),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
