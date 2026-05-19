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
 *   6. `server_error` when `findById` throws.
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
  assertValidScheduledPlanChange,
  type CancelScheduledPlanChangeDeps,
  type CancelScheduledPlanChangeInput,
  type AuditPort,
  type MutableScheduledPlanChange,
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
// R3 Batch 4a (R3-C2) — UUID required after schema tightening.
const SCHEDULED_ID = '33333333-3333-3333-3333-333333333333';
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const CYCLE_ID = '22222222-2222-2222-2222-222222222222';

// R2 Batch 3f (R2-S10) — `reason: null` is the explicit no-reason
// signal. The Input type used to be `?: string`; now it's
// `: string | null` to avoid the `exactOptionalPropertyTypes` spread
// footgun + align with the audit payload shape.
const baseInput: CancelScheduledPlanChangeInput = {
  scheduledChangeId: SCHEDULED_ID,
  memberId: MEMBER_ID,
  effectiveAtCycleId: CYCLE_ID,
  // R3 Batch 4d (R3-S1) — `cancelledByUserId` removed (always equalled actorUserId).
  reason: null,
};

// R3 Batch 4e (R3-S6) — `ScheduledPlanChange` is now a discriminated
// union over `status`. Test fixtures construct the loose
// `MutableScheduledPlanChange` shape and let `assertValidScheduledPlanChange`
// narrow it to the discriminated variant. The runtime assertion fails
// loudly if a fixture violates the status↔timestamp invariant, which
// keeps test data + production data consistent.
function makePending(
  overrides: Partial<MutableScheduledPlanChange> = {},
): ScheduledPlanChange {
  const candidate: MutableScheduledPlanChange = {
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
  assertValidScheduledPlanChange(candidate);
  return candidate;
}

function makeDeps(
  overrides: {
    // R2 Batch 3g (R2-I16) — use-case now looks up via `findById`,
    // not `findPendingForCycle`. Renamed.
    findByIdResult?: ScheduledPlanChange | null | Error;
    transitionStatusResult?: ScheduledPlanChange | Error;
    auditResult?: 'ok' | 'persist_failed' | 'invalid_payload';
  } = {},
): CancelScheduledPlanChangeDeps {
  const repo: ScheduledPlanChangeRepo = {
    findById: vi.fn(async () => {
      const r = overrides.findByIdResult;
      if (r instanceof Error) throw r;
      return (r === undefined ? makePending() : r) ?? null;
    }),
    findPendingForCycle: vi.fn(),
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

    // R2 Batch 3g — repo: findById called with tenant + scheduledChangeId
    expect(deps.repo.findById).toHaveBeenCalledWith(tenant, SCHEDULED_ID);
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
    // The audit-emit factory at recordAuditEvent.ts:* constructs
    // events with a `payload: {…}` shape. Narrow via discriminated
    // event_type to read `.reason` without `as any`.
    expect(event.event_type).toBe('plan_change_cancelled');
    if (event.event_type !== 'plan_change_cancelled')
      throw new Error('unreachable');
    expect(event.payload.reason).toBe(
      'Member requested rollback before renewal closes.',
    );
  });
});

describe('cancelScheduledPlanChange — invalid_input (R2 Batch 3a zod-validated)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['scheduledChangeId', { scheduledChangeId: '' }],
    ['memberId', { memberId: '' }],
    ['effectiveAtCycleId', { effectiveAtCycleId: '' }],
    // R3 Batch 4d (R3-S1) — `cancelledByUserId` removed from schema.
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
    // Repo + audit MUST NOT be called when zod validation fails
    expect(deps.repo.findById).not.toHaveBeenCalled();
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  // R2 Batch 3a (R2-C2) — uuid validation locks the boundary down
  // before findById / transitionStatus run. Previously these would
  // slip past truthy-only validation and only fail when the
  // audit-payload schema rejected post-transition.
  it.each([
    // R3 Batch 4a (R3-C2) — scheduledChangeId now also requires UUID.
    ['scheduledChangeId', { scheduledChangeId: 'not-a-uuid' }],
    ['scheduledChangeId', { scheduledChangeId: 'sched-uuid-001' }],
    ['memberId', { memberId: 'not-a-uuid' }],
    ['memberId', { memberId: '11111111-1111-1111-1111' }],
    ['effectiveAtCycleId', { effectiveAtCycleId: 'plain-string' }],
  ])('rejects non-uuid %s with invalid_input', async (field, overrides) => {
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
    expect(deps.repo.findById).not.toHaveBeenCalled();
  });

  it('first-issue translation when multiple fields fail', async () => {
    const deps = makeDeps();
    const result = await cancelScheduledPlanChange(deps, {
      ...baseInput,
      scheduledChangeId: '',
      memberId: 'not-a-uuid',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_input');
    // zod surfaces the FIRST failing field (schema order:
    // scheduledChangeId → memberId → effectiveAtCycleId)
    if (result.error.code !== 'invalid_input') throw new Error('unreachable');
    expect(result.error.field).toBe('scheduledChangeId');
  });
});

describe('cancelScheduledPlanChange — not_found', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns not_found when no pending row exists for the cycle', async () => {
    const deps = makeDeps({ findByIdResult: null });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_found');
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('R2 Batch 3g: returns not_found when found row belongs to a DIFFERENT member (defence-against-stale-UI cross-check)', async () => {
    // The scheduledChangeId is found in the tenant, but its memberId
    // does NOT match what the caller specified. Treat as not_found —
    // the row the user clicked on is no longer the one that exists
    // under their stale UI view.
    const deps = makeDeps({
      findByIdResult: makePending({
        memberId: '99999999-9999-9999-9999-999999999999',
      }),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_found');
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('R2 Batch 3g: returns not_found when found row belongs to a DIFFERENT cycle', async () => {
    const deps = makeDeps({
      findByIdResult: makePending({
        effectiveAtCycleId: '99999999-9999-9999-9999-999999999999',
      }),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_found');
    expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
  });
});

describe('cancelScheduledPlanChange — already_terminal (defence-in-depth)', () => {
  beforeEach(() => vi.clearAllMocks());

  // R2 Batch 3g + R3 Batch 4d (R3-S10) — `findById` can return
  // terminal rows. The use-case explicitly checks `isTerminalStatus`
  // to surface `already_terminal` as a distinct error code. Parametric
  // across all 3 terminal statuses.
  it.each([
    ['applied', { appliedAt: '2026-05-19T00:00:00Z' }],
    ['superseded', { supersededAt: '2026-05-19T00:00:00Z' }],
    ['cancelled', { cancelledAt: '2026-05-19T00:00:00Z' }],
  ] as const)(
    'refuses to transition if the repo returns a terminal row (status=%s)',
    async (status, timestamps) => {
      const deps = makeDeps({
        findByIdResult: makePending({
          status,
          ...timestamps,
        }),
      });
      const result = await cancelScheduledPlanChange(deps, baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('already_terminal');
      if (result.error.code !== 'already_terminal')
        throw new Error('unreachable');
      expect(result.error.status).toBe(status);
      expect(deps.repo.transitionStatus).not.toHaveBeenCalled();
      expect(deps.audit.record).not.toHaveBeenCalled();
    },
  );
});

describe('cancelScheduledPlanChange — server_error paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wraps findById errors as server_error', async () => {
    const deps = makeDeps({
      findByIdResult: new Error('connection reset by peer'),
    });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('server_error');
    if (result.error.code !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('findById');
    expect(result.error.message).toContain('connection reset by peer');
  });

  it('wraps transitionStatus errors as server_error when re-read shows row still pending', async () => {
    const deps = makeDeps({
      transitionStatusResult: new Error('connection reset'),
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

  // R3 Batch 4b (R3-I2) — TOCTOU race classification. Between
  // findById (pending) and transitionStatus, a concurrent admin can
  // apply/cancel/supersede the row. The use-case re-reads via
  // findById on the throw; if row is terminal, return `already_terminal`
  // (409) instead of `server_error` (500).
  it('R3-I2: classifies transitionStatus throw as already_terminal when re-read shows terminal row', async () => {
    const deps = makeDeps();
    // First findById (initial lookup) returns pending; second findById
    // (re-read after transition throw) returns applied terminal row.
    vi.mocked(deps.repo.findById)
      .mockResolvedValueOnce(makePending())
      .mockResolvedValueOnce(
        makePending({ status: 'applied', appliedAt: '2026-05-19T00:00:00Z' }),
      );
    vi.mocked(deps.repo.transitionStatus).mockRejectedValueOnce(
      new Error('transitionStatus: row sched-001 not found or already terminal'),
    );

    const result = await cancelScheduledPlanChange(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('already_terminal');
    if (result.error.code !== 'already_terminal') throw new Error('unreachable');
    expect(result.error.status).toBe('applied');
    // Audit MUST NOT fire if transition failed
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('R3-I2: falls back to server_error when re-read itself throws', async () => {
    const deps = makeDeps();
    vi.mocked(deps.repo.findById)
      .mockResolvedValueOnce(makePending())
      .mockRejectedValueOnce(new Error('re-read also failed'));
    vi.mocked(deps.repo.transitionStatus).mockRejectedValueOnce(
      new Error('original transitionStatus failure'),
    );

    const result = await cancelScheduledPlanChange(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('server_error');
    if (result.error.code !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('original transitionStatus');
  });
});

describe('cancelScheduledPlanChange — audit_failed paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns audit_failed with auditErrorType=persist_failed when audit.record returns persist_failed', async () => {
    const deps = makeDeps({ auditResult: 'persist_failed' });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    // R3 Batch 4b (R3-I5) — discriminator preserved for alert routing.
    expect(result.error.auditErrorType).toBe('persist_failed');
    expect(result.error.message).toBe('DB connection refused');
    // R3 Batch 4d (R3-S4) — transitioned row preserved so the route
    // can return 200 + diagnostic header (the row IS already cancelled;
    // a 500 would mis-lead the UI into retrying a successful mutation).
    expect(result.error.transitioned).toBeDefined();
    expect(result.error.transitioned.status).toBe('cancelled');
    expect(result.error.transitioned.scheduledChangeId).toBe(SCHEDULED_ID);
    // Row IS already cancelled at this point — audit failure is NOT
    // a rollback trigger, but the typed error surfaces to the caller
    // for monitoring/logging.
    expect(deps.repo.transitionStatus).toHaveBeenCalledWith(
      tenant,
      SCHEDULED_ID,
      'cancelled',
    );
  });

  it('returns audit_failed with auditErrorType=invalid_payload when audit returns invalid_payload', async () => {
    const deps = makeDeps({ auditResult: 'invalid_payload' });
    const result = await cancelScheduledPlanChange(deps, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    // R3 Batch 4b (R3-I5) — discriminator preserved.
    expect(result.error.auditErrorType).toBe('invalid_payload');
    expect(result.error.message).toContain('payload.member_id');
    // R3 Batch 4d (R3-S4) — transitioned row preserved.
    expect(result.error.transitioned).toBeDefined();
    expect(result.error.transitioned.status).toBe('cancelled');
  });
});
