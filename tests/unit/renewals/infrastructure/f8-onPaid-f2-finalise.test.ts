/**
 * Post-ship R6 Batch 2d (D7) — unit tests for the F2 finalisation
 * helper inside `apply-tier-upgrade-on-paid-callback.ts`.
 *
 * Pins the contract for the post-tx phase that closes Item 4 of the
 * R6 deferred-items list:
 *   - Looks up the F2 pending `scheduled_plan_change` row for the
 *     (member, cycle).
 *   - When present, transitions it to `applied` and emits the
 *     `plan_change_applied` F2 audit event.
 *   - When absent, is a no-op (the common case — same-tier renewal).
 *   - On any failure, logs critically + returns void (the F4 + F8
 *     in-tx state is committed by this point; F2 emit is non-rollback,
 *     mirroring the `accept-tier-upgrade.ts` post-tx F2 emit pattern).
 *
 * The helper is exported through the `_internal` namespace so this
 * test can drive it without needing to spin up the full
 * `makeApplyTierUpgradeOnPaidCallback` factory (which the existing
 * `f8-on-paid-callbacks.test.ts` covers).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asSatang } from '@/lib/money';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type {
  AuditPort as F2AuditPort,
  ScheduledPlanChange,
  ScheduledPlanChangeRepo,
} from '@/modules/plans';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { _internal } from '@/modules/renewals/infrastructure/_lib/apply-tier-upgrade-on-paid-callback';

// vi.mock factories are hoisted; use `vi.hoisted` so the spy lives
// alongside the factory's evaluation order. Direct `const fn = vi.fn()`
// at module top would be a hoist-order ReferenceError.
const { loggerErrorMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_SLUG = 'swecham';
const tenant = asTenantContext(TENANT_SLUG);
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const CYCLE_ID = '22222222-2222-2222-2222-222222222222';
const INVOICE_ID = '33333333-3333-3333-3333-333333333333';
const SCHEDULED_CHANGE_ID = 'sched-uuid-2d-001';

const baseEvent: F4InvoicePaidEvent = {
  tenantId: TENANT_SLUG,
  invoiceId: INVOICE_ID,
  memberId: MEMBER_ID,
  paidAt: '2026-05-19T10:00:00Z',
  amountSatang: asSatang(5_000_000n),
  vatSatang: asSatang(327_103n),
  currency: 'THB',
  paymentMethod: 'bank_transfer',
  triggeredBy: 'webhook',
};

function makePending(
  overrides: Partial<ScheduledPlanChange> = {},
): ScheduledPlanChange {
  return {
    tenantId: TENANT_SLUG,
    scheduledChangeId: SCHEDULED_CHANGE_ID,
    memberId: MEMBER_ID,
    effectiveAtCycleId: CYCLE_ID,
    fromPlanId: 'corporate-standard',
    toPlanId: 'corporate-premium',
    scheduledByUserId: 'admin-user-uuid',
    reason: 'tier_upgrade_accepted:s-001',
    status: 'pending',
    scheduledAt: '2026-05-01T00:00:00Z',
    appliedAt: null,
    supersededAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function makeDeps(opts: {
  findPendingForCycle?: ScheduledPlanChange | null | Error;
  transitionStatus?: ScheduledPlanChange | Error;
  auditRecord?: 'ok' | 'persist_failed' | 'throws';
}): RenewalsDeps {
  const repo: ScheduledPlanChangeRepo = {
    findPendingForCycle: vi.fn(async () => {
      const r = opts.findPendingForCycle;
      if (r instanceof Error) throw r;
      return r === undefined ? makePending() : r;
    }),
    // R2 Batch 3g (R2-I16) — F2 finaliser does not use findById, but
    // the port type requires the method.
    findById: vi.fn(async () => null),
    transitionStatus: vi.fn(async (_t, scheduledChangeId, nextStatus) => {
      const r = opts.transitionStatus;
      if (r instanceof Error) throw r;
      return (
        r ??
        makePending({
          scheduledChangeId,
          status: nextStatus,
          appliedAt:
            nextStatus === 'applied' ? '2026-05-19T10:00:00Z' : null,
        })
      );
    }),
    supersedeAndInsertPendingAtomically: vi.fn(),
    listForMember: vi.fn(),
  };

  const audit: F2AuditPort = {
    record: vi.fn(async () => {
      switch (opts.auditRecord) {
        case 'persist_failed':
          return err({
            type: 'persist_failed' as const,
            message: 'Neon endpoint timeout',
          });
        case 'throws':
          throw new Error('emitter throw — defence-in-depth path');
        default:
          return ok(undefined as void);
      }
    }),
  };

  // The helper only consults `tenant`, `scheduledPlanChangeRepo`,
  // and `f2AuditEmitter` — leave the rest as `undefined` casts.
  return {
    tenant,
    scheduledPlanChangeRepo: repo,
    f2AuditEmitter: audit,
  } as unknown as RenewalsDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('finaliseF2ScheduledPlanChangeForCycle — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('transitions pending → applied and emits plan_change_applied audit', async () => {
    const deps = makeDeps({});
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.scheduledPlanChangeRepo.findPendingForCycle).toHaveBeenCalledWith(
      tenant,
      MEMBER_ID,
      CYCLE_ID,
    );
    expect(deps.scheduledPlanChangeRepo.transitionStatus).toHaveBeenCalledWith(
      tenant,
      SCHEDULED_CHANGE_ID,
      'applied',
    );
    expect(deps.f2AuditEmitter.record).toHaveBeenCalledTimes(1);
    const [auditCtx, event] = vi.mocked(deps.f2AuditEmitter.record).mock
      .calls[0]!;
    expect(auditCtx).toEqual({
      tenant,
      actorUserId: 'system:f8-on-paid-webhook',
      requestId: `f8-onPaid:${INVOICE_ID}`,
      sourceIp: null,
    });
    expect(event).toEqual({
      event_type: 'plan_change_applied',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        from_plan_id: 'corporate-standard',
        to_plan_id: 'corporate-premium',
        applied_at_invoice_id: INVOICE_ID,
      },
    });
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

describe('finaliseF2ScheduledPlanChangeForCycle — no-op paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when no pending row exists for the cycle (common case)', async () => {
    const deps = makeDeps({ findPendingForCycle: null });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.scheduledPlanChangeRepo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.f2AuditEmitter.record).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

describe('finaliseF2ScheduledPlanChangeForCycle — failure paths (non-rollback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs + returns void when findPendingForCycle throws (no audit emit)', async () => {
    const deps = makeDeps({
      findPendingForCycle: new Error('connection refused'),
    });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.scheduledPlanChangeRepo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.f2AuditEmitter.record).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logFields] = loggerErrorMock.mock.calls[0]!;
    expect(logFields).toMatchObject({
      errorId: 'F2.PLAN_CHANGE.FIND_PENDING_FAILED',
      tenantId: TENANT_SLUG,
      memberId: MEMBER_ID,
      cycleId: CYCLE_ID,
      invoiceId: INVOICE_ID,
    });
  });

  it('logs + returns void when transitionStatus throws (no audit emit)', async () => {
    const deps = makeDeps({
      transitionStatus: new Error('row already terminal in DB'),
    });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.f2AuditEmitter.record).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logFields] = loggerErrorMock.mock.calls[0]!;
    expect(logFields).toMatchObject({
      errorId: 'F2.PLAN_CHANGE.TRANSITION_APPLIED_FAILED',
      scheduledChangeId: SCHEDULED_CHANGE_ID,
    });
  });

  it('logs (but does not throw) when audit returns persist_failed', async () => {
    const deps = makeDeps({ auditRecord: 'persist_failed' });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    // Transition + audit BOTH attempted, but the typed-err audit
    // result lands as a structured log rather than throwing.
    expect(deps.scheduledPlanChangeRepo.transitionStatus).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.f2AuditEmitter.record).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logFields] = loggerErrorMock.mock.calls[0]!;
    expect(logFields).toMatchObject({
      event: 'f8_onPaid.f2_audit_emit_failed',
      audit_event: 'plan_change_applied',
    });
  });

  it('logs (but does not throw) when audit throws (defence-in-depth)', async () => {
    const deps = makeDeps({ auditRecord: 'throws' });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.f2AuditEmitter.record).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logFields] = loggerErrorMock.mock.calls[0]!;
    expect(logFields).toMatchObject({
      event: 'f8_onPaid.f2_audit_emit_threw',
      errorId: 'F2.PLAN_CHANGE.APPLIED_AUDIT_EMIT_THREW',
    });
  });
});
