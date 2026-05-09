/**
 * F8 Phase 8 T210 spec — `skipEscalationTask` use-case.
 *
 * Verifies open → skipped transition + atomic `escalation_task_skipped`
 * audit. Required reason 1..500 chars (Domain invariant + DB CHECK).
 *
 * Covers:
 *   - happy path with reason
 *   - missing reason rejected (zod min(1))
 *   - reason >500 chars rejected (zod max(500))
 *   - task_not_found / task_not_open
 *   - reverse-direction atomicity
 */
import { describe, expect, it, vi } from 'vitest';
import { skipEscalationTask } from '@/modules/renewals/application/use-cases/skip-escalation-task';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { asTaskId } from '@/modules/renewals/domain/renewal-escalation-task';

const TENANT_ID = 'tenantA';
const TASK_UUID = '22222222-2222-2222-2222-222222220210';
const MEMBER_UUID = '00000000-0000-0000-0000-000000000210';
const CYCLE_UUID = '11111111-1111-1111-1111-111111110210';

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
    taskType: 'in_person_meeting',
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
  skippedReason: 'Member declined meeting; will revisit at T-30',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-210',
};

describe('skipEscalationTask (T210)', () => {
  it('happy path — emits audit with skipped_reason', async () => {
    const { deps, transitionStatusMock, emitInTxMock } = fakeDeps(
      openTaskRow(),
    );
    const r = await skipEscalationTask(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(transitionStatusMock.mock.calls[0]?.[3]).toMatchObject({
      to: 'skipped',
      closedByUserId: 'admin-1',
      skippedReason: baseInput.skippedReason,
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'escalation_task_skipped',
      payload: {
        task_id: TASK_UUID,
        skipped_reason: baseInput.skippedReason,
        actor_user_id: 'admin-1',
      },
    });
  });

  it('invalid_input — empty skippedReason rejected', async () => {
    const { deps } = fakeDeps(openTaskRow());
    const r = await skipEscalationTask(deps, {
      ...baseInput,
      skippedReason: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('invalid_input — whitespace-only reason rejected (trim then min(1))', async () => {
    const { deps } = fakeDeps(openTaskRow());
    const r = await skipEscalationTask(deps, {
      ...baseInput,
      skippedReason: '   ',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('invalid_input — reason >500 chars rejected', async () => {
    const { deps } = fakeDeps(openTaskRow());
    const r = await skipEscalationTask(deps, {
      ...baseInput,
      skippedReason: 'x'.repeat(501),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('task_not_found', async () => {
    const { deps, transitionStatusMock } = fakeDeps(null);
    const r = await skipEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_found');
    expect(transitionStatusMock).not.toHaveBeenCalled();
  });

  it('task_not_open when status is skipped', async () => {
    const skippedRow = {
      ...openTaskRow(),
      status: 'skipped' as const,
      skippedReason: 'prior',
      closedByUserId: 'admin-old',
      closedAt: '2026-04-01T00:00:00.000Z',
    };
    const { deps } = fakeDeps(skippedRow as never);
    const r = await skipEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('task_not_open');
  });

  it('reverse-direction atomicity — audit failure rolls back', async () => {
    const auditErr = new Error('audit-DB-down');
    const { deps } = fakeDeps(openTaskRow(), async () => {
      throw auditErr;
    });
    const r = await skipEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });
});
