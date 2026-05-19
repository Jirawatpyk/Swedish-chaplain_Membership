/**
 * R2 Batch 3b (R2-I6) — unit tests for `scheduleNextRenewalPlanChange`.
 *
 * `tests/contract/f2-scheduled-plan-change.contract.test.ts:58-60`
 * explicitly defers "audit-emit branch coverage" to the unit suite, but
 * no unit suite existed for this use-case before this batch. The
 * happy-path is exercised at the contract layer; this file pins:
 *   1. invalid_input × 6 (each required field) + invariant
 *      (fromPlanId === toPlanId)
 *   2. server_error wrapping `supersedeAndInsertPendingAtomically` throws
 *   3. audit_failed × 2:
 *      - `plan_change_scheduled` emit returns persist_failed
 *      - `plan_change_superseded` emit returns persist_failed (only fires
 *        when a prior pending row was bumped; result.superseded != null)
 *   4. happy paths × 2:
 *      - new pending insert (result.superseded === null) → ONE audit emit
 *      - re-schedule (result.superseded !== null) → TWO audit emits
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import {
  scheduleNextRenewalPlanChange,
  type ScheduleNextRenewalPlanChangeDeps,
  type AuditPort,
  type ScheduledPlanChange,
  type ScheduledPlanChangeRepo,
  type ScheduleNextRenewalPlanChangeInput,
} from '@/modules/plans';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tenant = asTenantContext('swecham');
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const CYCLE_ID = '22222222-2222-2222-2222-222222222222';

const baseInput: ScheduleNextRenewalPlanChangeInput = {
  memberId: MEMBER_ID,
  effectiveAtCycleId: CYCLE_ID,
  fromPlanId: 'corporate-standard',
  toPlanId: 'corporate-premium',
  scheduledByUserId: 'admin-user-uuid',
};

function makeRow(
  overrides: Partial<ScheduledPlanChange> = {},
): ScheduledPlanChange {
  return {
    tenantId: 'swecham',
    scheduledChangeId: 'inserted-001',
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

type DepsOverrides = {
  supersedeResult?:
    | { inserted: ScheduledPlanChange; superseded: ScheduledPlanChange | null }
    | Error;
  auditResults?: ('ok' | 'persist_failed' | 'invalid_payload')[];
};

function makeDeps(overrides: DepsOverrides = {}): ScheduleNextRenewalPlanChangeDeps {
  const repo: ScheduledPlanChangeRepo = {
    supersedeAndInsertPendingAtomically: vi.fn(async () => {
      const r = overrides.supersedeResult;
      if (r instanceof Error) throw r;
      return r ?? { inserted: makeRow(), superseded: null };
    }),
    findPendingForCycle: vi.fn(),
    // R2 Batch 3g (R2-I16) — port-shape compliance.
    findById: vi.fn(async () => null),
    transitionStatus: vi.fn(),
    listForMember: vi.fn(),
  };
  let auditCallIndex = 0;
  const audit: AuditPort = {
    record: vi.fn(async () => {
      const arr = overrides.auditResults ?? [];
      const r = arr[auditCallIndex] ?? 'ok';
      auditCallIndex++;
      switch (r) {
        case 'persist_failed':
          return err({
            type: 'persist_failed' as const,
            message: 'Neon write failed',
          });
        case 'invalid_payload':
          return err({
            type: 'invalid_payload' as const,
            issues: ['payload.from_plan_id: invalid'],
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
    requestId: 'req-schedule-001',
    sourceIp: '127.0.0.1',
  };
}

describe('scheduleNextRenewalPlanChange — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('first schedule (no prior pending) → ONE audit emit (plan_change_scheduled)', async () => {
    const deps = makeDeps();
    const result = await scheduleNextRenewalPlanChange(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const event = vi.mocked(deps.audit.record).mock.calls[0]![1];
    expect(event.event_type).toBe('plan_change_scheduled');
  });

  it('re-schedule (prior pending bumped) → TWO audit emits (scheduled + superseded)', async () => {
    const supersededRow = makeRow({
      scheduledChangeId: 'prior-pending-id',
      status: 'superseded',
      supersededAt: '2026-05-01T01:00:00Z',
    });
    const insertedRow = makeRow({ scheduledChangeId: 'new-pending-id' });
    const deps = makeDeps({
      supersedeResult: { inserted: insertedRow, superseded: supersededRow },
    });
    const result = await scheduleNextRenewalPlanChange(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(deps.audit.record).toHaveBeenCalledTimes(2);
    const e1 = vi.mocked(deps.audit.record).mock.calls[0]![1];
    const e2 = vi.mocked(deps.audit.record).mock.calls[1]![1];
    expect(e1.event_type).toBe('plan_change_scheduled');
    expect(e2.event_type).toBe('plan_change_superseded');
  });
});

describe('scheduleNextRenewalPlanChange — invalid_input', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['memberId', { memberId: '' }],
    ['effectiveAtCycleId', { effectiveAtCycleId: '' }],
    ['fromPlanId', { fromPlanId: '' }],
    ['toPlanId', { toPlanId: '' }],
    ['scheduledByUserId', { scheduledByUserId: '' }],
  ])('rejects empty %s with invalid_input', async (field, overrides) => {
    const deps = makeDeps();
    const result = await scheduleNextRenewalPlanChange(deps, {
      ...baseInput,
      ...(overrides as Partial<ScheduleNextRenewalPlanChangeInput>),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_input');
    if (result.error.code !== 'invalid_input') throw new Error('unreachable');
    expect(result.error.field).toBe(field);
    expect(deps.repo.supersedeAndInsertPendingAtomically).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('rejects when fromPlanId === toPlanId (no-op rejected at boundary)', async () => {
    const deps = makeDeps();
    const result = await scheduleNextRenewalPlanChange(deps, {
      ...baseInput,
      toPlanId: 'corporate-standard',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_input');
    if (result.error.code !== 'invalid_input') throw new Error('unreachable');
    expect(result.error.field).toBe('toPlanId');
  });
});

describe('scheduleNextRenewalPlanChange — server_error', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wraps repo errors as server_error (no audit emit)', async () => {
    const deps = makeDeps({
      supersedeResult: new Error('postgres tx aborted'),
    });
    const result = await scheduleNextRenewalPlanChange(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('server_error');
    expect(deps.audit.record).not.toHaveBeenCalled();
  });
});

describe('scheduleNextRenewalPlanChange — audit_failed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns audit_failed when plan_change_scheduled emit returns persist_failed', async () => {
    const deps = makeDeps({ auditResults: ['persist_failed'] });
    const result = await scheduleNextRenewalPlanChange(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    // First emit attempted; second (superseded) NEVER attempted because we
    // bail on the first failure.
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
  });

  it('returns audit_failed when plan_change_superseded emit (second call) returns persist_failed', async () => {
    const supersededRow = makeRow({
      scheduledChangeId: 'prior-pending-id',
      status: 'superseded',
    });
    const deps = makeDeps({
      supersedeResult: { inserted: makeRow(), superseded: supersededRow },
      auditResults: ['ok', 'persist_failed'],
    });
    const result = await scheduleNextRenewalPlanChange(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    // Both emits attempted; the SECOND one failed.
    expect(deps.audit.record).toHaveBeenCalledTimes(2);
  });

  it('returns audit_failed with joined zod issues when audit returns invalid_payload', async () => {
    const deps = makeDeps({ auditResults: ['invalid_payload'] });
    const result = await scheduleNextRenewalPlanChange(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    expect(result.error.message).toContain('payload.from_plan_id');
  });
});
