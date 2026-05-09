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
import { EscalationTaskNotFoundError } from '@/modules/renewals/application/ports/renewal-escalation-task-repo';

const TENANT_ID = 'tenantA';
const TASK_UUID = '22222222-2222-2222-2222-222222220209';
const MEMBER_UUID = '00000000-0000-0000-0000-000000000209';
const CYCLE_UUID = '11111111-1111-1111-1111-111111110209';
// Round 5 I-9 close — actorUserId now zod-validated as UUID. Replace
// the previous `ADMIN_UUID` placeholder with a deterministic UUID so
// the schema accepts it.
const ADMIN_UUID = '33333333-3333-3333-3333-333333330209';

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
  actorUserId: ADMIN_UUID,
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
      closedByUserId: ADMIN_UUID,
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
        actor_user_id: ADMIN_UUID,
      },
    });
  });

  // Round 5 I-12 close — manager rejection at the zod gate.
  it('invalid_input — manager actorRole rejected at zod gate', async () => {
    const { deps, findByIdMock } = fakeDeps(openTaskRow());
    const r = await completeEscalationTask(deps, {
      ...baseInput,
      actorRole: 'manager' as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(findByIdMock).not.toHaveBeenCalled();
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
      closedByUserId: '99999999-9999-9999-9999-999999999999',
      closedAt: '2026-04-01T00:00:00.000Z',
    };
    const { deps, transitionStatusMock } = fakeDeps(closedRow as never);
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_open');
    expect(transitionStatusMock).not.toHaveBeenCalled();
  });

  // R6 C-3 close — TOCTOU concurrent-loss race: another admin closed
  // the task between findById and the partial-unique UPDATE; the repo
  // throws EscalationTaskNotFoundError. The use-case MUST remap to
  // task_not_open (409), NOT server_error (500).
  // R7 IMP-C close — also assert audit was NOT emitted (Constitution
  // Principle VIII order invariant: audit only fires AFTER state
  // mutation succeeds; a future refactor moving audit before
  // transitionStatus would silently emit phantom "task closed" rows).
  it('TOCTOU race — transitionStatus throws → kind:task_not_open + zero audit emit', async () => {
    const { deps, transitionStatusMock, emitInTxMock } = fakeDeps(openTaskRow());
    transitionStatusMock.mockImplementationOnce(async () => {
      throw new EscalationTaskNotFoundError(TASK_UUID);
    });
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_open');
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  // R10 B-arch-1 close — pin the non-Error throw path through the
  // outer catch + logUnexpectedError helper. A non-Error thrown
  // value (`throw 'string'`, `throw 42`) is wrapped by the helper
  // as `new Error(String(e))` and surfaced as `kind:'server_error'`.
  // The Application-layer 100% branch coverage threshold requires
  // this fallback path be exercised (was uncovered pre-R10).
  it('non-Error throw — wrapped via String(e) + kind:server_error', async () => {
    const { deps } = fakeDeps(openTaskRow(), async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'audit-DB-down-string';
    });
    const r = await completeEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'server_error') {
      // Helper coerces String(e) into Error; the Result message
      // surface picks up the stringified value. Narrow on `kind` first
      // because `message` only exists on `invalid_input | server_error`
      // variants.
      expect(r.error.message).toBe('audit-DB-down-string');
    } else {
      throw new Error(`expected server_error result, got ${JSON.stringify(r)}`);
    }
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
