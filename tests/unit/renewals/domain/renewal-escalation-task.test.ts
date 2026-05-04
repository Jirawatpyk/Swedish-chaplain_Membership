/**
 * T036 spec — RenewalEscalationTask invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  ESCALATION_TASK_STATUSES,
  ESCALATION_ASSIGNEE_ROLES,
  asTaskId,
  parseTaskId,
  assertEscalationTaskInvariants,
  isOverdueTask,
  type RenewalEscalationTask,
} from '@/modules/renewals/domain/renewal-escalation-task';

const VALID_UUID = '00000000-0000-0000-0000-0000000000e1';

function buildTask(
  overrides: Partial<RenewalEscalationTask> = {},
): RenewalEscalationTask {
  return {
    tenantId: 't',
    taskId: asTaskId(VALID_UUID),
    memberId: 'm',
    cycleId: null,
    taskType: 'phone_call',
    assignedToRole: 'admin' as const,
    assignedToUserId: null,
    dueAt: '2026-06-01T00:00:00Z',
    status: 'open' as const,
    outcomeNote: null,
    skippedReason: null,
    closedByUserId: null,
    relatedSuggestionId: null,
    createdAt: '2026-05-01T00:00:00Z',
    closedAt: null,
    ...overrides,
  } as RenewalEscalationTask;
}

describe('TaskId brand', () => {
  it('asTaskId — unchecked cast', () => {
    expect(asTaskId('any')).toBe('any');
  });
  it('parseTaskId — accepts UUID + rejects malformed', () => {
    expect(parseTaskId(VALID_UUID).ok).toBe(true);
    expect(parseTaskId('bad').ok).toBe(false);
    expect(parseTaskId(undefined as unknown as string).ok).toBe(false);
  });
});

describe('ESCALATION constants', () => {
  it('3-state + 3-role tuples', () => {
    expect(ESCALATION_TASK_STATUSES).toEqual(['open', 'done', 'skipped']);
    expect(ESCALATION_ASSIGNEE_ROLES).toEqual([
      'admin',
      'manager',
      'executive_director',
    ]);
  });
});

describe('assertEscalationTaskInvariants', () => {
  it('happy path — open task', () => {
    expect(assertEscalationTaskInvariants(buildTask()).ok).toBe(true);
  });

  // The 3 status-conditional invariants (open_has_closed_at,
  // done_missing_anchors, skipped_missing_anchors) are now enforced
  // at COMPILE TIME by the RenewalEscalationTask discriminated union.

  it('compile-error: open task with closedAt set', () => {
    // @ts-expect-error — open requires closedAt: null
    const _illegal: RenewalEscalationTask = {
      ...buildTask(),
      status: 'open',
      closedAt: '2026-05-15T00:00:00Z',
    };
    expect(_illegal).toBeDefined();
  });

  it('compile-error: done task without closedByUserId', () => {
    // @ts-expect-error — done requires closedByUserId: string + closedAt: string
    const _illegal: RenewalEscalationTask = {
      ...buildTask(),
      status: 'done',
      closedAt: '2026-05-15T00:00:00Z',
      closedByUserId: null,
    };
    expect(_illegal).toBeDefined();
  });

  it('accepts done with full anchors', () => {
    expect(
      assertEscalationTaskInvariants(
        buildTask({
          status: 'done',
          closedAt: '2026-05-15T00:00:00Z',
          closedByUserId: '00000000-0000-0000-0000-0000000000aa',
          outcomeNote: 'spoke with member; will renew next week',
        }),
      ).ok,
    ).toBe(true);
  });

  it('compile-error: skipped task without skippedReason', () => {
    // @ts-expect-error — skipped requires skippedReason: string + closedByUserId: string + closedAt: string
    const _illegal: RenewalEscalationTask = {
      ...buildTask(),
      status: 'skipped',
      closedAt: '2026-05-15T00:00:00Z',
      skippedReason: null,
      closedByUserId: 'admin-1',
    };
    expect(_illegal).toBeDefined();
  });

  it('accepts skipped with full anchors', () => {
    expect(
      assertEscalationTaskInvariants(
        buildTask({
          status: 'skipped',
          closedAt: '2026-05-15T00:00:00Z',
          closedByUserId: '00000000-0000-0000-0000-0000000000aa',
          skippedReason: 'member already cancelled',
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects oversized outcome_note', () => {
    const r = assertEscalationTaskInvariants(
      buildTask({ outcomeNote: 'x'.repeat(1001) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('outcome_note_too_long');
  });

  it('rejects oversized skipped_reason', () => {
    const r = assertEscalationTaskInvariants(
      buildTask({ skippedReason: 'x'.repeat(501) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('skipped_reason_too_long');
  });
});

describe('isOverdueTask', () => {
  it('open + past due_at = overdue', () => {
    const task = buildTask({ dueAt: '2026-04-01T00:00:00Z' });
    expect(isOverdueTask(task, new Date('2026-05-01T00:00:00Z'))).toBe(true);
  });
  it('open + future due_at = not overdue', () => {
    const task = buildTask({ dueAt: '2026-07-01T00:00:00Z' });
    expect(isOverdueTask(task, new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });
  it('terminal task is never overdue', () => {
    const task = buildTask({
      status: 'done',
      dueAt: '2025-01-01T00:00:00Z',
      closedAt: '2025-06-01T00:00:00Z',
      closedByUserId: '00000000-0000-0000-0000-0000000000aa',
    });
    expect(isOverdueTask(task, new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });
});
