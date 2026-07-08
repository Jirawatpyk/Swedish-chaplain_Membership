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
import {
  assertValidScheduledPlanChange,
  type AuditPort as F2AuditPort,
  type MutableScheduledPlanChange,
  type ScheduledPlanChange,
  type ScheduledPlanChangeRepo,
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
// 065 Fix A precision — the pending row's `reason` links to its originating
// suggestion (`tier_upgrade_accepted:<UUID>`); the finaliser parses it and
// resolves THAT suggestion's status via `tierUpgradeRepo.findById`. The
// suffix MUST be a valid UUID for the Domain parser to extract an id.
const LINKED_SUGGESTION_ID = '44444444-4444-4444-4444-444444444444';

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
  invoiceSubject: 'membership',
  paymentDate: null,
};

// R3 Batch 4e (R3-S6) — discriminated-union narrow at fixture boundary.
function makePending(
  overrides: Partial<MutableScheduledPlanChange> = {},
): ScheduledPlanChange {
  const candidate: MutableScheduledPlanChange = {
    tenantId: TENANT_SLUG,
    scheduledChangeId: SCHEDULED_CHANGE_ID,
    memberId: MEMBER_ID,
    effectiveAtCycleId: CYCLE_ID,
    fromPlanId: 'corporate-standard',
    toPlanId: 'corporate-premium',
    scheduledByUserId: 'admin-user-uuid',
    reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
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

function makeDeps(opts: {
  findPendingForCycle?: ScheduledPlanChange | null | Error;
  transitionStatus?: ScheduledPlanChange | Error;
  auditRecord?: 'ok' | 'persist_failed' | 'throws';
  // 065 Fix A precision — the status the pending row's linked suggestion
  // resolves to via `tierUpgradeRepo.findById`. Default 'applied' (gate
  // open). 'superseded' → the finaliser skips the transition. null →
  // suggestion not found (gate open). Error → findById throws (money-safe
  // skip).
  linkedSuggestion?: 'applied' | 'accepted_pending_apply' | 'superseded' | null | Error;
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

  // 065 Fix A precision — the finaliser resolves the pending row's linked
  // suggestion status via `tierUpgradeRepo.findById`. Stub only that method
  // (the helper consults nothing else on this repo).
  const tierUpgradeFindById = vi.fn(async () => {
    const s = opts.linkedSuggestion;
    if (s instanceof Error) throw s;
    if (s === null) return null;
    return { status: s ?? 'applied' };
  });

  // The helper only consults `tenant`, `scheduledPlanChangeRepo`,
  // `tierUpgradeRepo`, and `f2AuditEmitter` — leave the rest as `undefined`
  // casts.
  return {
    tenant,
    scheduledPlanChangeRepo: repo,
    tierUpgradeRepo: { findById: tierUpgradeFindById },
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

// ---------------------------------------------------------------------------
// 065 Fix A precision — per-pending-row suggestion-status gate.
//
// The finaliser parses the pending row's `reason`
// (`tier_upgrade_accepted:<id>`) and resolves THAT suggestion via
// `tierUpgradeRepo.findById`, skipping the transition ONLY when the linked
// suggestion is `superseded` (the cancelled-upgrade orphan). This is the
// precision behind the integration re-accept test: two suggestions can
// target one cycle, so the gate MUST key on the pending row's OWN
// suggestion, not a coarse cycle-wide existence probe.
// ---------------------------------------------------------------------------
describe('finaliseF2ScheduledPlanChangeForCycle — per-row suggestion gate (065 Fix A precision)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SKIPS the transition when the linked suggestion is superseded (no re-bill)', async () => {
    const deps = makeDeps({ linkedSuggestion: 'superseded' });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    // The pending row WAS fetched + its suggestion resolved superseded →
    // skip: no transition, no audit, no error log (this is an expected
    // money-safety skip, not a failure).
    expect(deps.scheduledPlanChangeRepo.findPendingForCycle).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.tierUpgradeRepo.findById).toHaveBeenCalledWith(
      TENANT_SLUG,
      LINKED_SUGGESTION_ID,
    );
    expect(deps.scheduledPlanChangeRepo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.f2AuditEmitter.record).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('PROCEEDS when the linked suggestion is applied (retry-heal — gate open)', async () => {
    const deps = makeDeps({ linkedSuggestion: 'applied' });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.tierUpgradeRepo.findById).toHaveBeenCalledWith(
      TENANT_SLUG,
      LINKED_SUGGESTION_ID,
    );
    expect(deps.scheduledPlanChangeRepo.transitionStatus).toHaveBeenCalledWith(
      tenant,
      SCHEDULED_CHANGE_ID,
      'applied',
    );
    expect(deps.f2AuditEmitter.record).toHaveBeenCalledTimes(1);
  });

  it('PROCEEDS when the linked suggestion is not found (gate open)', async () => {
    const deps = makeDeps({ linkedSuggestion: null });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    expect(deps.scheduledPlanChangeRepo.transitionStatus).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.f2AuditEmitter.record).toHaveBeenCalledTimes(1);
  });

  it('PROCEEDS without a findById lookup when the reason has no suggestion link (standalone schedule)', async () => {
    const deps = makeDeps({
      findPendingForCycle: makePending({ reason: 'admin_manual_schedule' }),
    });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    // No `tier_upgrade_accepted:` prefix → no suggestion lookup, but the
    // finaliser proceeds.
    expect(deps.tierUpgradeRepo.findById).not.toHaveBeenCalled();
    expect(deps.scheduledPlanChangeRepo.transitionStatus).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.f2AuditEmitter.record).toHaveBeenCalledTimes(1);
  });

  it('SKIPS (money-safe) + logs when the suggestion-status lookup throws', async () => {
    const deps = makeDeps({
      linkedSuggestion: new Error('connection refused'),
    });
    await _internal.finaliseF2ScheduledPlanChangeForCycle(
      deps,
      baseEvent,
      CYCLE_ID,
    );

    // Lookup failed → money-safe skip (no transition/audit) + structured
    // error log so the retry path is observable.
    expect(deps.scheduledPlanChangeRepo.transitionStatus).not.toHaveBeenCalled();
    expect(deps.f2AuditEmitter.record).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logFields] = loggerErrorMock.mock.calls[0]!;
    expect(logFields).toMatchObject({
      errorId: 'F2.PLAN_CHANGE.SUGGESTION_STATUS_LOOKUP_FAILED',
      scheduledChangeId: SCHEDULED_CHANGE_ID,
      suggestionId: LINKED_SUGGESTION_ID,
    });
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
