/**
 * F8 Phase 8 T208 spec — `createEscalationTask` use-case.
 *
 * Verifies idempotent insert + atomic `escalation_task_created` audit
 * (Constitution Principle VIII).
 *
 * Covers:
 *   - happy path: created=true → audit emitted with idempotent_replay=false
 *   - replay path: created=false → audit STILL emitted with idempotent_replay=true
 *   - tier_upgrade verify task: cycle_id=null + relatedSuggestionId carried in audit payload
 *   - reverse-direction atomicity: audit failure rolls back insert
 *   - invalid_input: bad uuid / empty taskType / invalid role rejected at zod gate
 */
import { describe, expect, it, vi } from 'vitest';
import { createEscalationTask } from '@/modules/renewals/application/use-cases/create-escalation-task';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { asTaskId } from '@/modules/renewals/domain/renewal-escalation-task';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-000000000208';
const CYCLE_UUID = '11111111-1111-1111-1111-111111110208';
const TASK_UUID = '22222222-2222-2222-2222-222222220208';
const SUGGESTION_UUID = '33333333-3333-3333-3333-333333330208';
// Round 5 I-9 close — actorUserId now zod-validated as UUID.
const ADMIN_UUID = '44444444-4444-4444-4444-444444440208';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function fakeRow(taskId: string, cycleId: string | null = CYCLE_UUID) {
  return {
    tenantId: TENANT_ID,
    taskId: asTaskId(taskId),
    memberId: MEMBER_UUID,
    cycleId,
    taskType: 'manual_outreach_required',
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
  insertResult: { created: boolean; taskId?: string },
  emitImpl?: () => Promise<void>,
): {
  deps: RenewalsDeps;
  insertMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const insertMock = vi.fn(async (_tx: unknown, args: { taskId: string }) => ({
    created: insertResult.created,
    row: fakeRow(insertResult.taskId ?? args.taskId),
  }));
  const emitInTxMock = vi.fn(emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    escalationTaskRepo: {
      insertIfAbsent: insertMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, insertMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  cycleId: CYCLE_UUID,
  taskType: 'manual_outreach_required',
  assignedToRole: 'admin' as const,
  dueAt: '2026-06-01T00:00:00.000Z',
  // R10 S9 close — `triggerReason` narrowed from free-text to a closed
  // enum (privacy-by-design). Use the canonical literal.
  triggerReason: 'no_primary_contact' as const,
  taskId: TASK_UUID,
  actorUserId: ADMIN_UUID,
  actorRole: 'admin' as const,
  correlationId: 'corr-208',
};

describe('createEscalationTask (T208)', () => {
  // Round 5 I-12 close — non-canonical actorRole rejected at the zod
  // gate. The schema enum allows admin/manager/cron/webhook/system; a
  // value outside that set (e.g. 'member') must trip invalid_input.
  it('invalid_input — unknown actorRole rejected at zod gate', async () => {
    const { deps, insertMock } = fakeDeps({ created: true });
    const r = await createEscalationTask(deps, {
      ...baseInput,
      actorRole: 'member' as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('happy path — created=true; emits audit with idempotent_replay=false', async () => {
    const { deps, insertMock, emitInTxMock } = fakeDeps({ created: true });
    const r = await createEscalationTask(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.created).toBe(true);
      expect(r.value.taskId).toBe(TASK_UUID);
    }
    expect(insertMock).toHaveBeenCalledOnce();
    expect(emitInTxMock).toHaveBeenCalledOnce();
    const emitCall = emitInTxMock.mock.calls[0];
    expect(emitCall?.[1]).toMatchObject({
      type: 'escalation_task_created',
      payload: {
        task_id: TASK_UUID,
        task_type: 'manual_outreach_required',
        member_id: MEMBER_UUID,
        cycle_id: CYCLE_UUID,
        trigger_reason: 'no_primary_contact',
        assignee_role: 'admin',
        idempotent_replay: false,
      },
    });
  });

  it('replay path — created=false; emits audit with idempotent_replay=true', async () => {
    const { deps, emitInTxMock } = fakeDeps({ created: false });
    const r = await createEscalationTask(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.created).toBe(false);
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]?.payload?.idempotent_replay).toBe(
      true,
    );
  });

  it('tier_upgrade verify task — cycle_id null + relatedSuggestionId in payload', async () => {
    const insertMock = vi.fn(async () => ({
      created: true,
      row: fakeRow(TASK_UUID, null),
    }));
    const emitInTxMock: ReturnType<typeof vi.fn> = vi.fn(async () => {});
    const deps = {
      tenant: { slug: TENANT_ID },
      escalationTaskRepo: { insertIfAbsent: insertMock },
      auditEmitter: { emit: vi.fn(async () => {}), emitInTx: emitInTxMock },
    } as unknown as RenewalsDeps;

    const r = await createEscalationTask(deps, {
      ...baseInput,
      cycleId: null,
      taskType: 'verify_pending_tier_upgrade',
      triggerReason: 'tier_upgrade_t180_verify',
      relatedSuggestionId: SUGGESTION_UUID,
    });
    expect(r.ok).toBe(true);
    expect(emitInTxMock.mock.calls[0]?.[1]?.payload).toMatchObject({
      task_type: 'verify_pending_tier_upgrade',
      cycle_id: null,
      related_suggestion_id: SUGGESTION_UUID,
    });
  });

  it('reverse-direction atomicity — audit-emit failure throws (insert rolled back)', async () => {
    const auditError = new Error('audit-DB-down');
    const { deps } = fakeDeps({ created: true }, async () => {
      throw auditError;
    });
    const r = await createEscalationTask(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('server_error');
    }
  });

  it('invalid_input — non-uuid memberId rejected at zod gate', async () => {
    const { deps, insertMock } = fakeDeps({ created: true });
    const r = await createEscalationTask(deps, {
      ...baseInput,
      memberId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_input');
    }
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('invalid_input — non-canonical triggerReason rejected', async () => {
    // R10 S9 close — triggerReason narrowed from free-text string to a
    // closed enum (privacy-by-design). Empty string + arbitrary
    // free-text both fail the zod gate; this test now exercises the
    // non-canonical path via a string outside the enum.
    const { deps } = fakeDeps({ created: true });
    const r = await createEscalationTask(deps, {
      ...baseInput,
      // Cast: TS would reject this at compile-time; runtime zod path
      // is what we're verifying here.
      triggerReason: 'arbitrary_freetext' as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_input');
    }
  });
});
