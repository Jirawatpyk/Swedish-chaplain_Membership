/**
 * Post-ship R6 Batch 2c (D7) — unit tests for `cancelScheduledPlanChange`.
 *
 * Pinned contracts:
 *   1. Happy path — pending row exists for (member, cycle) → repo
 *      transitions to `cancelled` + audit emits `plan_change_cancelled`
 *      with the full normative payload.
 *   2. `invalid_input` on each required field.
 *   3. `not_found` when no pending row exists for the cycle.
 *   4. `not_found` when a pending row exists but for a DIFFERENT
 *      scheduledChangeId (caller racing against a concurrent supersede).
 *   5. `already_terminal` if the repo somehow returns a non-pending
 *      row (defence-in-depth — should not happen in production but
 *      the use-case refuses to transition rather than silently
 *      overwrite terminal state).
 *   6. `server_error` when `findPendingForCycle` throws.
 *   7. `server_error` when `transitionStatus` throws.
 *   8. `audit_failed` when the audit port returns `persist_failed`.
 *   9. Audit payload — verifies `reason` is null when not supplied,
 *      and the exact string when supplied.
 *
 * Mirrors the structure of `tests/unit/plans/application/soft-delete-plan.test.ts`
 * + `tests/contract/f2-scheduled-plan-change.contract.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import {
  cancelScheduledPlanChange,
  type CancelScheduledPlanChangeDeps,
  type CancelScheduledPlanChangeInput,
  type AuditPort,
  type ScheduledPlanChange,
  type ScheduledPlanChangeRepo,
} from '@/modules/plans';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tenant = asTenantContext('swecham');
const SCHEDULED_ID = 'sched-uuid-001';
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const CYCLE_ID = '22222222-2222-2222-2222-222222222222';

// NOTE: `reason` is intentionally OMITTED rather than set to
// `undefined` — under `exactOptionalPropertyTypes: true`, the latter
// is a type error for an optional `string | undefined` field.
const baseInput: CancelScheduledPlanChangeInput = {
  scheduledChangeId: SCHEDULED_ID,
  memberId: MEMBER_ID,
  effectiveAtCycleId: CYCLE_ID,
  cancelledByUserId: 'admin-user-uuid',
};

function makePending(
  overrides: Partial<ScheduledPlanChange> = {},
): ScheduledPlanChange {
  return {
    tenantId: tenant.slug,
    scheduledChangeId: SCHEDULED_ID,
    memberId: MEMBER_ID,
    effectiveAtCycleId: CYCLE_ID,
    fromPlanId: 'corporate-standard',
    toPlanId: 'corporate-premium',
    scheduledByUserId: 'admin-user-uuid',
    reason: null,
    status: 'pending',
    scheduledAt: '2026-05-01T00:00:00Z',
    appliedAt: null,
    supersededAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    findPendingForCycleResult?: ScheduledPlanChange | null | Error;
    transitionStatusResult?: ScheduledPlanChange | Error;
    auditResult?: 'ok' | 'persist_failed' | 'invalid_payload';
  } = {},
): CancelScheduledPlanChangeDeps {
  const repo: ScheduledPlanChangeRepo = {
    findPendingForCycle: vi.fn(async () => {
      const r = overrides.findPendingForCycleResult;
      if (r instanceof Error) throw r;
      return (r === undefined ? makePending() : r) ?? null;
    }),
    transitionStatus: vi.fn(async (_t, _id, nextStatus) => {
      const r = overrides.transitionStatusResult;
      if (r instanceof Error) throw r;
      return (
        r ??
        makePending({
          status: nextStatus,
          cancelledAt:
            nextStatus === 'cancelled' ? '2026-05-19T00:00:00Z' : null,
        })
      );
    }),
    supersedeAndInsertPendingAtomically: vi.fn(),
    listForMember: vi.fn(),
  };

  const audit: AuditPort = {
    record: vi.fn(async () => {
      switch (overrides.auditResult) {
        case 'persist_failed':
          return err({
            type: 'persist_failed' as const,
            message: 'DB connection refused',
          });
        case 'invalid_payload':
          return err({
            type: 'invalid_payload' as const,
            issues: ['payload.member_id: invalid'],
          });
        default:
          return ok(undefined as void);
      }
    }),
  };

  return {
    tenant,
    repo,
    audit,
    actorUserId: 'admin-user-uuid',
    requestId: 'req-cancel-001',
    sourceIp: '127.0.0.1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancelScheduledPlanChange — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels a pending row and emits plan_change_cancelled audit', async () => {
    const deps = makeDeps();
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.status).toBe('cancelled');
    expect(result.value.scheduledChangeId).toBe(SCHEDULED_ID);
    expect(result.value.cancelledAt).toBe('2026-05-19T00:00:00Z');

    // Repo: findPending called with tenant + member + cycle
    expect(deps.repo.findPendingForCycle).toHaveBeenCalledWith(
      tenant,
      MEMBER_ID,
      CYCLE_ID,
    );
    // Repo: transitionStatus called with cancelled
    expect(deps.repo.transitionStatus).toHaveBeenCalledWith(
      tenant,
      SCHEDULED_ID,
      'cancelled',
    );
    // Audit: exactly one call, correct event_type + payload shape + reason: null
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [auditCtx, event] = vi.mocked(deps.audit.record).mock.calls[0]!;
    expect(auditCtx).toMatchObject({
      tenant,
      actorUserId: 'admin-user-uuid',
      requestId: 'req-cancel-001',
      sourceIp: '127.0.0.1',
    });
    expect(event).toEqual({
      event_type: 'plan_change_cancelled',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_ID,
        effective_at_cycle_id: CYCLE_ID,
        reason: null,
      },
    });
  });

  it('threads a non-empty reason through to the audit payload', async () => {
    const deps = makeDeps();
    const result = await cancelScheduledPlanChange(deps, {
      ...baseInput,
      reason: 'Member requested rollback before renewal closes.',
    });

    expect(result.ok).toBe(true);
    const [, event] = vi.mocked(deps.audit.record).mock.calls[0]!;
    expect((event as any).payload.reason).toBe(
      'Member requested rollback before renewal closes.',
    );
  });
});

describe('cancelScheduledPlanChange — invalid_input', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['scheduledChangeId', { scheduledChangeId: '' }],
    ['memberId', { memberId: '' }],
    ['effectiveAtCycleId', { effectiveAtCycleId: '' }],
    ['cancelledByUserId', { cancelledByUserId: '' }],
  ])('rejects empty %s with invalid_input', async (field, overrides) => {
    const deps = makeDeps();
    const result = await cancelScheduledPlanChange(deps, {
      ...baseInput,
      ...(overrides as Partial<CancelScheduledPlanChangeInput>),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_input');
    if (result.error.code !== 'invalid_input') throw new Error('unreachable');
    expect(result.error.field).toBe(field);
    // Repo + audit MUST NOT be called when input fails light validation
    expect(deps.repo.findPendingForCycle).not.toHaveBeenCalled();
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });
});

describe('cancelScheduledPlanChange — not_found', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns not_found when no pending row exists for the cycle', async () => {
    const deps = makeDeps({ findPendingForCycleResult: null });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_found');
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns not_found when pending row has a DIFFERENT scheduledChangeId (race)', async () => {
    // Caller targets `SCHEDULED_ID` but the current pending row is
    // `other-sched-id` (concurrent supersede landed first).
    const deps = makeDeps({
      findPendingForCycleResult: makePending({
        scheduledChangeId: 'other-sched-id',
      }),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_found');
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });
});

describe('cancelScheduledPlanChange — already_terminal (defence-in-depth)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to transition if the repo returns a terminal row', async () => {
    // Repo contract says findPendingForCycle only returns pending rows.
    // Defence-in-depth: if it ever returns a terminal row anyway, we
    // refuse the transition.
    const deps = makeDeps({
      findPendingForCycleResult: makePending({
        status: 'applied',
        appliedAt: '2026-05-01T00:00:00Z',
      }),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('already_terminal');
    if (result.error.code !== 'already_terminal') throw new Error('unreachable');
    expect(result.error.status).toBe('applied');
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });
});

describe('cancelScheduledPlanChange — server_error paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wraps findPendingForCycle errors as server_error', async () => {
    const deps = makeDeps({
      findPendingForCycleResult: new Error('connection reset by peer'),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('server_error');
    if (result.error.code !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('findPendingForCycle');
    expect(result.error.message).toContain('connection reset by peer');
  });

  it('wraps transitionStatus errors as server_error', async () => {
    const deps = makeDeps({
      transitionStatusResult: new Error('row already terminal in DB'),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('server_error');
    if (result.error.code !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('transitionStatus');
    // Audit MUST NOT fire if transition failed — no event to record
    expect(deps.audit.record).not.toHaveBeenCalled();
  });
});

describe('cancelScheduledPlanChange — audit_failed paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns audit_failed when audit.record returns persist_failed', async () => {
    const deps = makeDeps({ auditResult: 'persist_failed' });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    expect(result.error.message).toBe('DB connection refused');
    // Row IS already cancelled at this point — audit failure is NOT
    // a rollback trigger, but the typed error surfaces to the caller
    // for monitoring/logging.
    expect(deps.repo.transitionStatus).toHaveBeenCalledWith(
      tenant,
      SCHEDULED_ID,
      'cancelled',
    );
  });

  it('returns audit_failed with joined issues when audit returns invalid_payload', async () => {
    const deps = makeDeps({ auditResult: 'invalid_payload' });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    expect(result.error.message).toContain('payload.member_id');
  });
});
