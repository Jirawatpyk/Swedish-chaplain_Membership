/**
 * Renewal rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238)
 * — `resolveUnlinkedMembershipPaymentInTx` spec.
 *
 * Verifies:
 *   1. Non-membership invoiceSubject → skipped:event_invoice, zero reads.
 *   2. GDPR-erased member → skipped:erased.
 *   3. heal_no_cycle → fresh cycle created + anchor stamped in one pass.
 *   4. first_payment → re-anchor (not complete); FY-crossing re-freeze
 *      (found + unresolvable); race → reclassify.
 *   5. renewal → complete + gapless next cycle; orphaned-invoice log;
 *      race → idempotent skip.
 *   6. terminal_only → skipped.
 *   7. Callback interplay with createNextCycleOnPaidInTx (behaviour 8).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang, parseThbDecimal } from '@/lib/money';
import {
  resolveUnlinkedMembershipPaymentInTx,
  type ResolveUnlinkedMembershipPaymentDeps,
} from '@/modules/renewals/application/use-cases/resolve-unlinked-membership-payment';
import { createNextCycleOnPaidInTx } from '@/modules/renewals/application/use-cases/create-next-cycle-on-paid';
import { PlanNotResolvableError } from '@/modules/renewals/application/use-cases/create-cycle-in-tx';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { buildCycle } from './_helpers/build-cycle';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { unlinkedPaymentResolved: vi.fn(), paymentOnTerminatedMember: vi.fn() },
}));

import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-1';
const INVOICE_UUID = '00000000-0000-0000-0000-0000000aaaaa';

function buildEvent(overrides: Partial<F4InvoicePaidEvent> = {}): F4InvoicePaidEvent {
  return {
    tenantId: TENANT_ID,
    invoiceId: INVOICE_UUID,
    memberId: MEMBER_ID,
    paidAt: '2026-05-07T10:00:00Z',
    amountSatang: asSatang(5_000_000n),
    vatSatang: asSatang(350_000n),
    currency: 'THB',
    paymentMethod: 'stripe_card',
    triggeredBy: 'webhook',
    invoiceSubject: 'membership',
    paymentDate: null,
    ...overrides,
  };
}

const SENTINEL_TX = { sentinel: 'tx' } as never;

// ---------------------------------------------------------------------------
// Mock-based deps builder (for skip/race/branch-logic tests that only need
// call-shape assertions, not full state semantics).
// ---------------------------------------------------------------------------
function fakeDeps(args: {
  erased?: boolean | null;
  blocked?: boolean;
  cycleCountForMember?: number;
  /**
   * F2 fix (final-review, 2026-07-09) — feeds `classifyMembershipPayment`'s
   * `settledCycleCountForMember` (completed-OR-ever-anchored predecessor
   * count, NOT the raw `cycleCountForMember`). Defaults to
   * `Math.max(cycleCountForMember - 1, 0)` — mirrors every pre-existing
   * test's implicit assumption that a predecessor row (when present) WAS
   * settled, so no existing test needs updating. Tests targeting the
   * cancelled-only-history bug override this explicitly.
   */
  settledCycleCountForMember?: number;
  openCycle?: RenewalCycle | null;
  /**
   * 066 F-5 review — the member's latest cycle across ALL statuses, read by
   * the terminal_only branch to gate the payment_on_terminated_member net on
   * ACTUAL termination (isMembershipLapsed). Defaults to null (no cycle →
   * not terminated → net skipped). Terminal_only tests that expect the net to
   * fire must pass a lapsed/expired-cancelled cycle here.
   */
  latestCycle?: RenewalCycle | null;
  memberPlan?: { planId: string; isArchived: boolean } | null;
  reanchorResult?:
    | { cycle: RenewalCycle; reminderEventsReset: number }
    | null;
  transitionImpl?: () => Promise<RenewalCycle>;
  createInsertImpl?: () => Promise<RenewalCycle>;
  findActiveForMemberImpl?: () => Promise<RenewalCycle | null>;
  planLookupImpl?: (input: unknown) => Promise<unknown>;
} = {}): {
  deps: ResolveUnlinkedMembershipPaymentDeps;
  mocks: {
    escalationInsert: ReturnType<typeof vi.fn>;
    readGuards: ReturnType<typeof vi.fn>;
    countCycles: ReturnType<typeof vi.fn>;
    countSettledCycles: ReturnType<typeof vi.fn>;
    findOpenCycle: ReturnType<typeof vi.fn>;
    findLatestCycle: ReturnType<typeof vi.fn>;
    reanchor: ReturnType<typeof vi.fn>;
    transitionStatus: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    findActiveForMember: ReturnType<typeof vi.fn>;
    loadPlanFrozenFields: ReturnType<typeof vi.fn>;
    loadMemberPlan: ReturnType<typeof vi.fn>;
    emitInTx: ReturnType<typeof vi.fn>;
    getFiscalYearStartMonthInTx: ReturnType<typeof vi.fn>;
  };
} {
  const readGuards = vi.fn(async () => ({
    blocked: args.blocked ?? false,
    erased: args.erased ?? false,
  }));
  const countCycles = vi.fn(async () => args.cycleCountForMember ?? 0);
  const countSettledCycles = vi.fn(
    async () =>
      args.settledCycleCountForMember ??
      Math.max((args.cycleCountForMember ?? 0) - 1, 0),
  );
  const findOpenCycle = vi.fn(async () => args.openCycle ?? null);
  const findLatestCycle = vi.fn(async () => args.latestCycle ?? null);
  const reanchor = vi.fn(
    args.reanchorResult !== undefined
      ? async () => args.reanchorResult
      : async () => ({
          cycle: { ...(args.openCycle ?? buildCycle()), status: 'upcoming' as const, anchoredAt: '2026-05-01T00:00:00.000Z', anchorInvoiceId: INVOICE_UUID },
          reminderEventsReset: 0,
        }),
  );
  const transitionStatus = vi.fn(
    args.transitionImpl ?? (async () => ({ ...(args.openCycle ?? buildCycle()), status: 'completed' as const })),
  );
  const insert = vi.fn(
    args.createInsertImpl ??
      (async () =>
        buildCycle({
          cycleId: asCycleId('00000000-0000-0000-0000-0000000c9999'),
          status: 'upcoming',
          anchoredAt: null,
          anchorInvoiceId: null,
          periodFrom: '2026-05-01T00:00:00.000Z',
          periodTo: '2027-05-01T00:00:00.000Z',
        })),
  );
  const findActiveForMember = vi.fn(args.findActiveForMemberImpl ?? (async () => null));
  const loadPlanFrozenFields = vi.fn(
    args.planLookupImpl ??
      (async () => ({
        status: 'found' as const,
        plan: {
          tierBucket: 'regular' as const,
          priceTHB: parseThbDecimal('50000.00'),
          termMonths: 12,
          currency: 'THB' as const,
        },
      })),
  );
  const loadMemberPlan = vi.fn(async () =>
    args.memberPlan === undefined ? { planId: 'p1', isArchived: false } : args.memberPlan,
  );
  const emitInTx = vi.fn(async () => {});
  const escalationInsert = vi.fn(async () => ({ created: true, row: { taskId: 'task-1' } }));
  // FIX-3 (PR #173 review, 2026-07-09) — default January; the pre-existing
  // FY-crossing tests below already assume a January-start tenant.
  const getFiscalYearStartMonthInTx = vi.fn(async () => 1);

  const deps: ResolveUnlinkedMembershipPaymentDeps = {
    cyclesRepo: {
      findActiveForMemberInTx: findActiveForMember,
      insert,
      countCyclesForMemberInTx: countCycles,
      countSettledCyclesForMemberInTx: countSettledCycles,
      findOpenCycleForMemberInTx: findOpenCycle,
      findLatestCycleForMemberInTx: findLatestCycle,
      reanchorPeriodInTx: reanchor,
      transitionStatus,
    } as unknown as ResolveUnlinkedMembershipPaymentDeps['cyclesRepo'],
    planLookup: { loadPlanFrozenFields } as unknown as ResolveUnlinkedMembershipPaymentDeps['planLookup'],
    auditEmitter: { emit: vi.fn(), emitInTx } as unknown as ResolveUnlinkedMembershipPaymentDeps['auditEmitter'],
    idFactory: { cycleId: () => asCycleId('00000000-0000-0000-0000-0000000c9999') },
    memberRenewalFlagsRepo: { readReactivationGuardsInTx: readGuards } as unknown as ResolveUnlinkedMembershipPaymentDeps['memberRenewalFlagsRepo'],
    memberPlanLookup: { loadMemberPlanInTx: loadMemberPlan } as unknown as ResolveUnlinkedMembershipPaymentDeps['memberPlanLookup'],
    // Package A — cohort-E fallback audit port (unused when memberPlan matches
    // the cycle's plan, i.e. no divergence — the default here).
    planChangeBillingEffectAudit: { emitInTx: vi.fn(async () => {}) } as unknown as ResolveUnlinkedMembershipPaymentDeps['planChangeBillingEffectAudit'],
    fiscalYearSettings: { getFiscalYearStartMonthInTx },
    escalationTaskRepo: { insertIfAbsent: escalationInsert } as unknown as ResolveUnlinkedMembershipPaymentDeps['escalationTaskRepo'],
  };

  return {
    deps,
    mocks: {
      escalationInsert,
      readGuards,
      countCycles,
      countSettledCycles,
      findOpenCycle,
      findLatestCycle,
      reanchor,
      transitionStatus,
      insert,
      findActiveForMember,
      loadPlanFrozenFields,
      loadMemberPlan,
      emitInTx,
      getFiscalYearStartMonthInTx,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 1: non-membership', () => {
  it('invoiceSubject=event → skipped:event_invoice, no reads at all', async () => {
    const { deps, mocks } = fakeDeps();
    const r = await resolveUnlinkedMembershipPaymentInTx(
      deps,
      buildEvent({ invoiceSubject: 'event' }),
      SENTINEL_TX,
    );
    expect(r).toEqual({ kind: 'skipped', reason: 'event_invoice' });
    expect(mocks.readGuards).not.toHaveBeenCalled();
    expect(mocks.countCycles).not.toHaveBeenCalled();
    expect(renewalsMetrics.unlinkedPaymentResolved).not.toHaveBeenCalled();
  });
});

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 2: erased member', () => {
  it('erased=true → skipped:erased + info log, no cycle reads', async () => {
    const { deps, mocks } = fakeDeps({ erased: true });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'erased' });
    expect(mocks.countCycles).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });
});

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 6: terminal_only', () => {
  it('cycles exist, none open, latest LAPSED (terminated) → skipped:terminal_only + 066 §4.4(2) net', async () => {
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 2,
      openCycle: null,
      // 066 F-5 review — the net now fires only when the member is ACTUALLY
      // terminated: latest cycle is `lapsed` (→ deriveMembershipAccess
      // 'terminated').
      latestCycle: buildCycle({
        status: 'lapsed',
        closedReason: 'grace_expired',
        closedAt: '2026-04-01T00:00:00.000Z',
      }),
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'terminal_only' });
    // 066 §4.4(2) — the payment_on_terminated_member audit event, in-tx.
    const auditCall = mocks.emitInTx.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === 'payment_on_terminated_member',
    );
    expect(auditCall).toBeDefined();
    expect(
      (auditCall![1] as { payload: { heal_site: string; cycle_id: null } }).payload,
    ).toMatchObject({ heal_site: 'terminal_only', cycle_id: null });
    // Idempotent admin work-item.
    expect(mocks.escalationInsert).toHaveBeenCalledTimes(1);
    expect(mocks.escalationInsert.mock.calls[0]![1]).toMatchObject({
      taskType: 'post_termination_payment_review',
      assignedToRole: 'admin',
      cycleId: null,
    });
    expect(renewalsMetrics.paymentOnTerminatedMember).toHaveBeenCalledWith('terminal_only');
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });

  // 066 F-5 whole-branch review — the net must NOT fire for a member who has
  // no OPEN cycle but is NOT terminated (suspended or still-covered). Firing
  // it would write a false 10y tax-evidence record + spurious admin task.
  it('latest cycle SUSPENDED (pending_admin_reactivation) → skipped:terminal_only, NO net', async () => {
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 2,
      openCycle: null,
      latestCycle: buildCycle({
        status: 'pending_admin_reactivation',
        enteredPendingAt: '2026-04-01T00:00:00.000Z',
      }),
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'terminal_only' });
    const auditCall = mocks.emitInTx.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === 'payment_on_terminated_member',
    );
    expect(auditCall).toBeUndefined();
    expect(mocks.escalationInsert).not.toHaveBeenCalled();
    expect(renewalsMetrics.paymentOnTerminatedMember).not.toHaveBeenCalled();
    // Still counted as a resolved-skip (benign ad-hoc payment).
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });

  it('latest cycle CANCELLED but still within coverage (full access) → skipped:terminal_only, NO net', async () => {
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 2,
      openCycle: null,
      // cancelled + FUTURE expiresAt → deriveMembershipAccess 'full'.
      latestCycle: buildCycle({
        status: 'cancelled',
        closedReason: 'admin_reactivated',
        closedAt: '2026-04-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'terminal_only' });
    const auditCall = mocks.emitInTx.mock.calls.find(
      (c) => (c[1] as { type?: string })?.type === 'payment_on_terminated_member',
    );
    expect(auditCall).toBeUndefined();
    expect(mocks.escalationInsert).not.toHaveBeenCalled();
    expect(renewalsMetrics.paymentOnTerminatedMember).not.toHaveBeenCalled();
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });
});

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 3: heal_no_cycle', () => {
  it('zero cycles → creates + anchors a fresh cycle; audit old_period_*=null', async () => {
    const { deps, mocks } = fakeDeps({ cycleCountForMember: 0, openCycle: null });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r.kind).toBe('healed');
    expect(mocks.loadMemberPlan).toHaveBeenCalledWith(SENTINEL_TX, TENANT_ID, MEMBER_ID);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.reanchor).toHaveBeenCalledTimes(1);
    // calls[0] is createCycleInTx's own `renewal_cycle_created` emit;
    // calls[1] is the anchor-stamp `renewal_cycle_reanchored` emit.
    const auditCall = mocks.emitInTx.mock.calls[1]?.[1];
    expect(auditCall).toMatchObject({
      type: 'renewal_cycle_reanchored',
      payload: expect.objectContaining({
        old_period_from: null,
        old_period_to: null,
        old_status: 'none',
        refroze_plan_fields: false,
      }),
    });
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('healed');
  });

  it('member plan unresolvable (should-never-happen) → throws loudly', async () => {
    const { deps } = fakeDeps({ cycleCountForMember: 0, openCycle: null, memberPlan: null });
    await expect(
      resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX),
    ).rejects.toThrow(/could not resolve member/);
  });

  it('lost the active-cycle-create race (skipped_active_exists) → reclassifies, falls to renewal', async () => {
    const anchoredOpenCycle = buildCycle({ status: 'awaiting_payment', anchoredAt: '2026-01-01T00:00:00Z' });
    const { deps, mocks } = fakeDeps({ cycleCountForMember: 0, openCycle: null });
    // createCycleInTx checks findActiveForMemberInTx BEFORE inserting —
    // returning a row there forces the skipped_active_exists branch (a
    // concurrent tx created + anchored a cycle for this member first).
    mocks.findActiveForMember.mockResolvedValue(anchoredOpenCycle);
    // Call 1 (initial classify) → 0/null (heal_no_cycle triggers). Call 2
    // (reclassify re-read, AFTER the race) → 1/anchored-open-cycle → renewal.
    mocks.countCycles.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mocks.findOpenCycle.mockResolvedValueOnce(null).mockResolvedValueOnce(anchoredOpenCycle);

    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r.kind).toBe('renewed');
    expect(mocks.insert).not.toHaveBeenCalled(); // skipped_active_exists — no insert
    expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
  });

  it('lost the active-cycle-create race and reclassifies to something other than renewal → skipped:race_lost', async () => {
    const { deps, mocks } = fakeDeps({ cycleCountForMember: 0, openCycle: null });
    mocks.findActiveForMember.mockResolvedValue(buildCycle());
    // Call 1 (initial classify) → 0/null (heal_no_cycle triggers, hits the
    // active-cycle-create race). Call 2 (reclassify re-read) → 1/null
    // (terminal-only) — NOT renewal, so race_lost.
    mocks.countCycles.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'race_lost' });
  });

  // ---------------------------------------------------------------------
  // F1 fix (Task 5 review, Critical) — a catalogue gap while healing must
  // NOT block the payment.
  // ---------------------------------------------------------------------
  it('F1: createCycleInTx throws PlanNotResolvableError (catalogue gap) → skipped:plan_unresolvable, payment path does not throw, metric=skipped', async () => {
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 0,
      openCycle: null,
      planLookupImpl: async () => ({ status: 'not_found' as const }),
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'plan_unresolvable' });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'p1', planStatus: 'not_found' }),
      expect.stringContaining('plan unresolvable'),
    );
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });
});

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 4: first_payment', () => {
  it('re-anchors the never-before-paid cycle; no FY crossing → refroze_plan_fields:false', async () => {
    const openCycle = buildCycle({
      status: 'upcoming',
      anchoredAt: null,
      periodFrom: '2026-05-01T00:00:00Z',
      periodTo: '2027-05-01T00:00:00Z',
    });
    const { deps, mocks } = fakeDeps({ cycleCountForMember: 1, openCycle });
    const r = await resolveUnlinkedMembershipPaymentInTx(
      deps,
      buildEvent({ paymentDate: '2026-05-16' }),
      SENTINEL_TX,
    );
    expect(r).toEqual({ kind: 'reanchored', cycleId: openCycle.cycleId });
    expect(mocks.loadPlanFrozenFields).not.toHaveBeenCalled();
    expect(mocks.reanchor).toHaveBeenCalledWith(
      SENTINEL_TX,
      TENANT_ID,
      openCycle.cycleId,
      expect.objectContaining({
        periodFrom: '2026-05-01T00:00:00.000Z',
        anchoredAt: '2026-05-01T00:00:00.000Z',
        anchorInvoiceId: INVOICE_UUID,
        frozenPlanPriceThb: openCycle.frozenPlanPriceThb,
        frozenPlanTermMonths: openCycle.frozenPlanTermMonths,
      }),
    );
    const auditCall = mocks.emitInTx.mock.calls[0]?.[1];
    expect(auditCall).toMatchObject({
      type: 'renewal_cycle_reanchored',
      payload: expect.objectContaining({
        old_period_from: openCycle.periodFrom,
        old_period_to: openCycle.periodTo,
        old_status: 'upcoming',
        refroze_plan_fields: false,
      }),
    });
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('reanchored');
  });

  // F2 fix (final-review, 2026-07-09) — a predecessor cycle that was
  // cancelled/lapsed WITHOUT ever anchoring (genuinely never paid) must
  // NOT count as "renewal history" — this member's first real payment is
  // still first_payment even though `cycleCountForMember > 1`.
  it('cancelled-only-history: predecessor cycle exists but was NEVER settled → still re-anchors (first_payment)', async () => {
    const openCycle = buildCycle({
      status: 'upcoming',
      anchoredAt: null,
      periodFrom: '2026-05-01T00:00:00Z',
      periodTo: '2027-05-01T00:00:00Z',
    });
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 2, // a predecessor row exists (e.g. cancelled)...
      settledCycleCountForMember: 0, // ...but it was NEVER settled/anchored
      openCycle,
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(
      deps,
      buildEvent({ paymentDate: '2026-05-16' }),
      SENTINEL_TX,
    );
    expect(r).toEqual({ kind: 'reanchored', cycleId: openCycle.cycleId });
    expect(mocks.reanchor).toHaveBeenCalledTimes(1);
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('reanchored');
  });

  it('re-anchor crosses a fiscal-year boundary + plan resolvable → re-freezes fields', async () => {
    const openCycle = buildCycle({
      status: 'upcoming',
      anchoredAt: null,
      periodFrom: '2025-11-01T00:00:00Z',
      periodTo: '2026-11-01T00:00:00Z',
      frozenPlanPriceThb: parseThbDecimal('40000.00'),
      frozenPlanTermMonths: 12,
    });
    const newPlan = {
      status: 'found' as const,
      plan: { tierBucket: 'regular' as const, priceTHB: parseThbDecimal('45000.00'), termMonths: 12, currency: 'THB' as const },
    };
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 1,
      openCycle,
      planLookupImpl: async () => newPlan,
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(
      deps,
      buildEvent({ paymentDate: '2026-03-16' }), // crosses into FY2026
      SENTINEL_TX,
    );
    expect(r.kind).toBe('reanchored');
    expect(mocks.loadPlanFrozenFields).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, planId: openCycle.planIdAtCycleStart, mode: 'freeze' }),
    );
    expect(mocks.reanchor).toHaveBeenCalledWith(
      SENTINEL_TX,
      TENANT_ID,
      openCycle.cycleId,
      expect.objectContaining({
        frozenPlanPriceThb: '45000.00',
        frozenPlanTermMonths: 12,
      }),
    );
    const auditCall = mocks.emitInTx.mock.calls[0]?.[1];
    expect(auditCall.payload.refroze_plan_fields).toBe(true);
  });

  it('re-anchor crosses FY boundary but plan unresolvable → keeps old fields + logs error', async () => {
    const openCycle = buildCycle({
      status: 'upcoming',
      anchoredAt: null,
      periodFrom: '2025-11-01T00:00:00Z',
      periodTo: '2026-11-01T00:00:00Z',
      frozenPlanPriceThb: parseThbDecimal('40000.00'),
      frozenPlanTermMonths: 12,
    });
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 1,
      openCycle,
      planLookupImpl: async () => ({ status: 'not_found' as const }),
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(
      deps,
      buildEvent({ paymentDate: '2026-03-16' }),
      SENTINEL_TX,
    );
    expect(r.kind).toBe('reanchored');
    expect(logger.error).toHaveBeenCalled();
    expect(mocks.reanchor).toHaveBeenCalledWith(
      SENTINEL_TX,
      TENANT_ID,
      openCycle.cycleId,
      expect.objectContaining({
        frozenPlanPriceThb: openCycle.frozenPlanPriceThb,
        frozenPlanTermMonths: openCycle.frozenPlanTermMonths,
      }),
    );
    const auditCall = mocks.emitInTx.mock.calls[0]?.[1];
    expect(auditCall.payload.refroze_plan_fields).toBe(false);
  });

  it('lost the reanchor-guard race (reanchorPeriodInTx→null) → reclassifies, falls to renewal', async () => {
    const openCycle = buildCycle({ status: 'upcoming', anchoredAt: null });
    const anchoredNow = buildCycle({ status: 'awaiting_payment', anchoredAt: '2026-01-01T00:00:00Z' });
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 1,
      openCycle,
      reanchorResult: null,
    });
    mocks.countCycles.mockResolvedValue(1);
    mocks.findOpenCycle.mockResolvedValueOnce(openCycle).mockResolvedValueOnce(anchoredNow);

    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r.kind).toBe('renewed');
  });

  it('lost the reanchor-guard race and reclassifies to non-renewal → skipped:race_lost', async () => {
    const openCycle = buildCycle({ status: 'upcoming', anchoredAt: null });
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 1,
      openCycle,
      reanchorResult: null,
    });
    mocks.countCycles.mockResolvedValue(1);
    mocks.findOpenCycle.mockResolvedValueOnce(openCycle).mockResolvedValueOnce(null);

    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'race_lost' });
  });
});

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 5: renewal', () => {
  it('completes the open cycle + creates gapless next cycle', async () => {
    const openCycle = buildCycle({
      status: 'awaiting_payment',
      anchoredAt: '2025-06-01T00:00:00Z',
      periodFrom: '2026-06-01T00:00:00Z',
      periodTo: '2027-06-01T00:00:00Z',
      linkedInvoiceId: null,
    });
    const { deps, mocks } = fakeDeps({ cycleCountForMember: 2, openCycle });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'renewed', cycleId: openCycle.cycleId });
    expect(mocks.transitionStatus).toHaveBeenCalledWith(
      SENTINEL_TX,
      TENANT_ID,
      openCycle.cycleId,
      expect.objectContaining({
        from: 'awaiting_payment',
        to: 'completed',
        closedReason: 'paid',
        linkedInvoiceId: INVOICE_UUID,
      }),
    );
    expect(mocks.insert).toHaveBeenCalledTimes(1); // the next cycle
    expect(mocks.emitInTx).toHaveBeenCalledWith(
      SENTINEL_TX,
      expect.objectContaining({ type: 'renewal_completed' }),
      expect.anything(),
    );
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('renewed');
  });

  it('cycle linked to a DIFFERENT (dispatched) invoice → logs orphaned-invoice error but still completes', async () => {
    const openCycle = buildCycle({
      status: 'awaiting_payment',
      anchoredAt: '2025-06-01T00:00:00Z',
      linkedInvoiceId: '00000000-0000-0000-0000-0000000bbbbb',
    });
    const { deps } = fakeDeps({ cycleCountForMember: 2, openCycle });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r.kind).toBe('renewed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orphanedInvoiceId: '00000000-0000-0000-0000-0000000bbbbb' }),
      expect.stringContaining('orphaned dispatched invoice'),
    );
  });

  it('cycle linked to THIS invoice already (idempotent re-fire shape) → no orphan log', async () => {
    const openCycle = buildCycle({
      status: 'awaiting_payment',
      anchoredAt: '2025-06-01T00:00:00Z',
      linkedInvoiceId: INVOICE_UUID,
    });
    const { deps } = fakeDeps({ cycleCountForMember: 2, openCycle });
    await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lost the completion race (CycleTransitionConflictError) → idempotent skip:race_lost', async () => {
    const openCycle = buildCycle({ status: 'awaiting_payment', anchoredAt: '2025-06-01T00:00:00Z' });
    const { deps, mocks } = fakeDeps({
      cycleCountForMember: 2,
      openCycle,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(openCycle.cycleId, 'awaiting_payment', 'cancelled');
      },
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'race_lost' });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });

  it('lost the completion race (CycleNotFoundError) → idempotent skip:race_lost', async () => {
    const openCycle = buildCycle({ status: 'awaiting_payment', anchoredAt: '2025-06-01T00:00:00Z' });
    const { deps } = fakeDeps({
      cycleCountForMember: 2,
      openCycle,
      transitionImpl: async () => {
        throw new CycleNotFoundError(openCycle.cycleId);
      },
    });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'skipped', reason: 'race_lost' });
  });

  it('non-conflict throw on transitionStatus propagates (F4 tx rolls back)', async () => {
    const openCycle = buildCycle({ status: 'awaiting_payment', anchoredAt: '2025-06-01T00:00:00Z' });
    const { deps } = fakeDeps({
      cycleCountForMember: 2,
      openCycle,
      transitionImpl: async () => {
        throw new Error('connection reset');
      },
    });
    await expect(
      resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX),
    ).rejects.toThrow(/connection reset/);
  });

  // ---------------------------------------------------------------------
  // F4 fix (final-review, 2026-07-09, defensive) — 'reminded' has NO
  // direct edge into 'completed' (only 'upcoming' and 'awaiting_payment'
  // do — see cycle-status.ts's TRANSITIONS map). `toClassifierOpenCycle`
  // folds a 'reminded' RAW cycle to 'upcoming' for classification only —
  // the raw cycle object (still status='reminded') is what actually gets
  // passed into `renewalComplete`. Without the two-step guard this would
  // throw `InvalidCycleTransitionError`, crashing the hook. 'reminded'
  // has no writer in `src/` today (vestigial), so this scenario is
  // unreachable in production — this test locks the defensive guard.
  // ---------------------------------------------------------------------
  it("F4 (defensive): 'reminded'-status open cycle → legal two-step transition, no crash", async () => {
    const openCycle = buildCycle({
      status: 'reminded',
      anchoredAt: '2025-06-01T00:00:00Z',
      periodFrom: '2026-06-01T00:00:00Z',
      periodTo: '2027-06-01T00:00:00Z',
      linkedInvoiceId: null,
    });
    const { deps, mocks } = fakeDeps({ cycleCountForMember: 2, openCycle });
    const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r).toEqual({ kind: 'renewed', cycleId: openCycle.cycleId });
    expect(mocks.transitionStatus).toHaveBeenCalledTimes(2);
    expect(mocks.transitionStatus).toHaveBeenNthCalledWith(
      1,
      SENTINEL_TX,
      TENANT_ID,
      openCycle.cycleId,
      expect.objectContaining({ from: 'reminded', to: 'awaiting_payment' }),
    );
    expect(mocks.transitionStatus).toHaveBeenNthCalledWith(
      2,
      SENTINEL_TX,
      TENANT_ID,
      openCycle.cycleId,
      expect.objectContaining({
        from: 'awaiting_payment',
        to: 'completed',
        closedReason: 'paid',
        linkedInvoiceId: INVOICE_UUID,
      }),
    );
  });

  // ---------------------------------------------------------------------
  // F1 fix (Task 5 review, Critical) — deliberate ASYMMETRY pin: unlike
  // healNoCycle's guard, a PlanNotResolvableError surfacing from the
  // renewal branch's own next-cycle creation must PROPAGATE, exactly
  // mirroring create-next-cycle-on-paid.ts's documented NEVER-swallow
  // rationale ("a swallow would commit the payment while the member
  // silently drops out of the renewal pipeline with no retry trigger").
  // Here the payment is COMPLETING a renewal (not healing a zero-cycle
  // member), so a catalogue gap is a real ops incident that must roll
  // back the whole tx.
  // ---------------------------------------------------------------------
  it('F1 asymmetry: PlanNotResolvableError from the renewal branch\'s next-cycle creation PROPAGATES (does not swallow)', async () => {
    const openCycle = buildCycle({
      status: 'awaiting_payment',
      anchoredAt: '2025-06-01T00:00:00Z',
      periodFrom: '2026-06-01T00:00:00Z',
      periodTo: '2027-06-01T00:00:00Z',
      linkedInvoiceId: null,
    });
    const { deps } = fakeDeps({
      cycleCountForMember: 2,
      openCycle,
      planLookupImpl: async () => ({ status: 'not_found' as const }),
    });
    await expect(
      resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX),
    ).rejects.toBeInstanceOf(PlanNotResolvableError);
  });

  // ---------------------------------------------------------------------
  // F4 fix (Task 5 review, FR-005b parity) — a blocked member must not
  // auto-complete via this unlinked renewal branch, mirroring
  // markCycleCompleteInTx's holdForAdminReview gate on the linked path.
  // ---------------------------------------------------------------------
  describe('F4: blocked_from_auto_reactivation parity (held-for-admin)', () => {
    it('blocked member + awaiting_payment open cycle → held via a single transition; no completion, no next cycle', async () => {
      const openCycle = buildCycle({
        status: 'awaiting_payment',
        anchoredAt: '2025-06-01T00:00:00Z',
        periodFrom: '2026-06-01T00:00:00Z',
        periodTo: '2027-06-01T00:00:00Z',
        linkedInvoiceId: null,
      });
      const { deps, mocks } = fakeDeps({ cycleCountForMember: 2, openCycle, blocked: true });
      const evt = buildEvent();
      const r = await resolveUnlinkedMembershipPaymentInTx(deps, evt, SENTINEL_TX);
      expect(r).toEqual({ kind: 'held_pending_admin', cycleId: openCycle.cycleId });
      expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
      expect(mocks.transitionStatus).toHaveBeenCalledWith(
        SENTINEL_TX,
        TENANT_ID,
        openCycle.cycleId,
        expect.objectContaining({
          from: 'awaiting_payment',
          to: 'pending_admin_reactivation',
          enteredPendingAt: evt.paidAt,
          linkedInvoiceId: INVOICE_UUID,
        }),
      );
      expect(mocks.insert).not.toHaveBeenCalled(); // no next cycle created
      expect(mocks.emitInTx).toHaveBeenCalledWith(
        SENTINEL_TX,
        expect.objectContaining({
          type: 'renewal_completed_post_lapse',
          payload: expect.objectContaining({ held_for_admin_review: true }),
        }),
        expect.anything(),
      );
      expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('held');
    });

    it('blocked member + upcoming (anchored) open cycle → held via two-step transition (upcoming→awaiting_payment→pending_admin_reactivation); no next cycle', async () => {
      const openCycle = buildCycle({
        status: 'upcoming',
        anchoredAt: '2025-06-01T00:00:00Z', // anchored so renewal classification fires
        periodFrom: '2026-06-01T00:00:00Z',
        periodTo: '2027-06-01T00:00:00Z',
        linkedInvoiceId: null,
      });
      const { deps, mocks } = fakeDeps({ cycleCountForMember: 2, openCycle, blocked: true });
      const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
      expect(r).toEqual({ kind: 'held_pending_admin', cycleId: openCycle.cycleId });
      expect(mocks.transitionStatus).toHaveBeenCalledTimes(2);
      expect(mocks.transitionStatus).toHaveBeenNthCalledWith(
        1,
        SENTINEL_TX,
        TENANT_ID,
        openCycle.cycleId,
        expect.objectContaining({ from: 'upcoming', to: 'awaiting_payment' }),
      );
      expect(mocks.transitionStatus).toHaveBeenNthCalledWith(
        2,
        SENTINEL_TX,
        TENANT_ID,
        openCycle.cycleId,
        expect.objectContaining({ from: 'awaiting_payment', to: 'pending_admin_reactivation' }),
      );
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('held');
    });

    it('non-blocked member is unaffected — existing renewal-completion behaviour stays green', async () => {
      const openCycle = buildCycle({
        status: 'awaiting_payment',
        anchoredAt: '2025-06-01T00:00:00Z',
        periodFrom: '2026-06-01T00:00:00Z',
        periodTo: '2027-06-01T00:00:00Z',
        linkedInvoiceId: null,
      });
      const { deps, mocks } = fakeDeps({ cycleCountForMember: 2, openCycle, blocked: false });
      const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
      expect(r).toEqual({ kind: 'renewed', cycleId: openCycle.cycleId });
      expect(mocks.insert).toHaveBeenCalledTimes(1); // next cycle created
      expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('renewed');
    });

    // ---------------------------------------------------------------------
    // R1 fix (Task 5 residual-closing wave) — `reclassifyAfterRace` (the
    // shared double-race fallback for `heal_no_cycle` / `first_payment`)
    // previously fell through to `renewalComplete` unconditionally on a
    // `renewal` reclassification, bypassing the FR-005b admin-hold gate for
    // a blocked member who loses a create/re-anchor race. `blocked` is now
    // threaded all the way through to this fallback.
    // ---------------------------------------------------------------------
    it('R1: blocked member loses the first_payment reanchor-guard race, reclassifies to renewal → HELD, not completed', async () => {
      const openCycle = buildCycle({ status: 'upcoming', anchoredAt: null });
      const anchoredNow = buildCycle({ status: 'awaiting_payment', anchoredAt: '2026-01-01T00:00:00Z' });
      const { deps, mocks } = fakeDeps({
        cycleCountForMember: 1,
        openCycle,
        reanchorResult: null,
        blocked: true,
      });
      mocks.countCycles.mockResolvedValue(1);
      mocks.findOpenCycle.mockResolvedValueOnce(openCycle).mockResolvedValueOnce(anchoredNow);

      const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
      expect(r).toEqual({ kind: 'held_pending_admin', cycleId: anchoredNow.cycleId });
      expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
      expect(mocks.transitionStatus).toHaveBeenCalledWith(
        SENTINEL_TX,
        TENANT_ID,
        anchoredNow.cycleId,
        expect.objectContaining({ from: 'awaiting_payment', to: 'pending_admin_reactivation' }),
      );
      expect(mocks.insert).not.toHaveBeenCalled(); // no next cycle — admin decides
      expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('held');
    });

    it('R1: blocked member loses the heal_no_cycle active-create race, reclassifies to renewal → HELD, not completed', async () => {
      const anchoredOpenCycle = buildCycle({ status: 'awaiting_payment', anchoredAt: '2026-01-01T00:00:00Z' });
      const { deps, mocks } = fakeDeps({ cycleCountForMember: 0, openCycle: null, blocked: true });
      mocks.findActiveForMember.mockResolvedValue(anchoredOpenCycle);
      mocks.countCycles.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      mocks.findOpenCycle.mockResolvedValueOnce(null).mockResolvedValueOnce(anchoredOpenCycle);

      const r = await resolveUnlinkedMembershipPaymentInTx(deps, buildEvent(), SENTINEL_TX);
      expect(r).toEqual({ kind: 'held_pending_admin', cycleId: anchoredOpenCycle.cycleId });
      expect(mocks.insert).not.toHaveBeenCalled(); // skipped_active_exists — no insert
      expect(mocks.transitionStatus).toHaveBeenCalledTimes(1);
      expect(mocks.transitionStatus).toHaveBeenCalledWith(
        SENTINEL_TX,
        TENANT_ID,
        anchoredOpenCycle.cycleId,
        expect.objectContaining({ from: 'awaiting_payment', to: 'pending_admin_reactivation' }),
      );
      expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('held');
    });
  });
});

// ---------------------------------------------------------------------------
// Behaviour 8 — callback interplay with createNextCycleOnPaidInTx, using a
// minimal in-memory repo so cross-function state semantics (not just call
// counts) are exercised.
// ---------------------------------------------------------------------------
function makeInMemoryCyclesRepo() {
  const rows = new Map<string, RenewalCycle>();
  const ACTIVE = new Set(['upcoming', 'reminded', 'awaiting_payment']);

  return {
    rows,
    async insert(_tx: unknown, _tenantId: string, input: Record<string, unknown>) {
      const cycle = {
        tenantId: TENANT_ID,
        cycleId: input.cycleId,
        memberId: input.memberId,
        status: (input.startStatus as string | undefined) ?? 'upcoming',
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        expiresAt: input.periodTo,
        cycleLengthMonths: input.cycleLengthMonths,
        tierAtCycleStart: input.tierAtCycleStart,
        planIdAtCycleStart: input.planIdAtCycleStart,
        frozenPlanPriceThb: input.frozenPlanPriceThb,
        frozenPlanTermMonths: input.frozenPlanTermMonths,
        frozenPlanCurrency: 'THB',
        enteredPendingAt: null,
        linkedInvoiceId: null,
        linkedCreditNoteId: null,
        anchoredAt: null,
        anchorInvoiceId: null,
        closedAt: null,
        closedReason: null,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      } as unknown as RenewalCycle;
      rows.set(cycle.cycleId, cycle);
      return cycle;
    },
    async findActiveForMemberInTx(_tx: unknown, _tenantId: string, memberId: string) {
      for (const c of rows.values()) {
        if (c.memberId === memberId && ACTIVE.has(c.status)) return c;
      }
      return null;
    },
    async countCyclesForMemberInTx(_tx: unknown, _tenantId: string, memberId: string) {
      let n = 0;
      for (const c of rows.values()) if (c.memberId === memberId) n++;
      return n;
    },
    // F2 fix (final-review, 2026-07-09) — real settled-history semantics
    // (status='completed' OR anchoredAt !== null), excluding the caller's
    // open cycle — mirrors the production Drizzle query.
    async countSettledCyclesForMemberInTx(
      _tx: unknown,
      _tenantId: string,
      memberId: string,
      excludeCycleId: string,
    ) {
      let n = 0;
      for (const c of rows.values()) {
        if (
          c.memberId === memberId &&
          c.cycleId !== excludeCycleId &&
          (c.status === 'completed' || c.anchoredAt !== null)
        ) {
          n++;
        }
      }
      return n;
    },
    async findOpenCycleForMemberInTx(_tx: unknown, _tenantId: string, memberId: string) {
      for (const c of rows.values()) {
        if (c.memberId === memberId && ACTIVE.has(c.status)) return c;
      }
      return null;
    },
    // 066 F-5 review — latest cycle across ALL statuses (created_at DESC,
    // cycle_id DESC), mirroring the Drizzle in-tx read.
    async findLatestCycleForMemberInTx(_tx: unknown, _tenantId: string, memberId: string) {
      const mine = [...rows.values()].filter((c) => c.memberId === memberId);
      mine.sort((a, b) => {
        const byCreated = String(b.createdAt).localeCompare(String(a.createdAt));
        return byCreated !== 0 ? byCreated : String(b.cycleId).localeCompare(String(a.cycleId));
      });
      return mine[0] ?? null;
    },
    async reanchorPeriodInTx(
      _tx: unknown,
      _tenantId: string,
      cycleId: string,
      args: Record<string, unknown>,
    ) {
      const c = rows.get(cycleId) as unknown as Record<string, unknown> | undefined;
      if (!c) return null;
      if (c.anchoredAt !== null || !ACTIVE.has(c.status as string)) return null;
      Object.assign(c, {
        periodFrom: args.periodFrom,
        periodTo: args.periodTo,
        status: 'upcoming',
        anchoredAt: args.anchoredAt,
        anchorInvoiceId: args.anchorInvoiceId,
        linkedInvoiceId: null,
        frozenPlanPriceThb: args.frozenPlanPriceThb,
        frozenPlanTermMonths: args.frozenPlanTermMonths,
      });
      return { cycle: { ...c } as unknown as RenewalCycle, reminderEventsReset: 0 };
    },
    async transitionStatus(
      _tx: unknown,
      _tenantId: string,
      cycleId: string,
      args: { from: string; to: string; closedAt?: string; closedReason?: string; linkedInvoiceId?: string },
    ) {
      const c = rows.get(cycleId) as unknown as Record<string, unknown> | undefined;
      if (!c) throw new CycleNotFoundError(cycleId);
      if (c.status !== args.from) {
        throw new CycleTransitionConflictError(cycleId, args.from as never, c.status as never);
      }
      c.status = args.to;
      if (args.closedAt !== undefined) c.closedAt = args.closedAt;
      if (args.closedReason !== undefined) c.closedReason = args.closedReason;
      if (args.linkedInvoiceId !== undefined) c.linkedInvoiceId = args.linkedInvoiceId;
      return { ...c } as unknown as RenewalCycle;
    },
    async findByInvoiceIdInTx(_tx: unknown, _tenantId: string, invoiceId: string) {
      for (const c of rows.values()) if (c.linkedInvoiceId === invoiceId) return c;
      return null;
    },
  };
}

function makeInterplayDeps(cyclesRepo: ReturnType<typeof makeInMemoryCyclesRepo>) {
  const loadPlanFrozenFields = vi.fn(async () => ({
    status: 'found' as const,
    plan: {
      tierBucket: 'regular' as const,
      priceTHB: parseThbDecimal('50000.00'),
      termMonths: 12,
      currency: 'THB' as const,
    },
  }));
  const emitInTx = vi.fn(async () => {});
  let counter = 0;
  const deps: ResolveUnlinkedMembershipPaymentDeps = {
    cyclesRepo: cyclesRepo as unknown as ResolveUnlinkedMembershipPaymentDeps['cyclesRepo'],
    planLookup: { loadPlanFrozenFields } as unknown as ResolveUnlinkedMembershipPaymentDeps['planLookup'],
    auditEmitter: { emit: vi.fn(), emitInTx } as unknown as ResolveUnlinkedMembershipPaymentDeps['auditEmitter'],
    idFactory: { cycleId: () => asCycleId(`00000000-0000-0000-0000-${String(++counter).padStart(12, '0')}`) },
    memberRenewalFlagsRepo: {
      readReactivationGuardsInTx: vi.fn(async () => ({ blocked: false, erased: false })),
    } as unknown as ResolveUnlinkedMembershipPaymentDeps['memberRenewalFlagsRepo'],
    memberPlanLookup: {
      loadMemberPlanInTx: vi.fn(async () => ({ planId: 'p1', isArchived: false })),
    } as unknown as ResolveUnlinkedMembershipPaymentDeps['memberPlanLookup'],
    // Package A — cohort-E fallback audit port (interplay cycles are all on
    // 'p1' == the member plan, so no divergence -> never invoked here).
    planChangeBillingEffectAudit: { emitInTx: vi.fn(async () => {}) } as unknown as ResolveUnlinkedMembershipPaymentDeps['planChangeBillingEffectAudit'],
    // FIX-3 (PR #173 review, 2026-07-09) — January default; none of the
    // interplay tests below exercise a fiscal-year crossing.
    fiscalYearSettings: { getFiscalYearStartMonthInTx: vi.fn(async () => 1) },
    escalationTaskRepo: { insertIfAbsent: vi.fn(async () => ({ created: true, row: { taskId: 'task-1' } })) } as unknown as ResolveUnlinkedMembershipPaymentDeps['escalationTaskRepo'],
  };
  return { deps, cyclesRepo };
}

describe('resolveUnlinkedMembershipPaymentInTx — behaviour 8: callback interplay', () => {
  it('after heal_no_cycle, createNextCycleOnPaidInTx finds the fresh ACTIVE cycle → no extra cycle created', async () => {
    const repo = makeInMemoryCyclesRepo();
    const { deps } = makeInterplayDeps(repo);
    const evt = buildEvent();
    const outcome = await resolveUnlinkedMembershipPaymentInTx(deps, evt, SENTINEL_TX);
    expect(outcome.kind).toBe('healed');
    expect(repo.rows.size).toBe(1);

    await createNextCycleOnPaidInTx(
      { cyclesRepo: repo as never, planLookup: deps.planLookup, auditEmitter: deps.auditEmitter, idFactory: deps.idFactory, memberPlanLookup: deps.memberPlanLookup, planChangeBillingEffectAudit: deps.planChangeBillingEffectAudit },
      evt,
      SENTINEL_TX,
    );
    // createNextCycleOnPaidInTx resolves the "prior" cycle via
    // findByInvoiceIdInTx(evt.invoiceId) — heal_no_cycle never links
    // linked_invoice_id (only anchor_invoice_id), so it finds nothing and
    // no-ops. Count stays at 1.
    expect(repo.rows.size).toBe(1);
  });

  it('after first_payment re-anchor, createNextCycleOnPaidInTx finds the fresh ACTIVE cycle → no extra cycle created', async () => {
    const repo = makeInMemoryCyclesRepo();
    const openCycle = buildCycle({
      status: 'upcoming',
      anchoredAt: null,
      periodFrom: '2026-05-01T00:00:00Z',
      periodTo: '2027-05-01T00:00:00Z',
    });
    repo.rows.set(openCycle.cycleId, openCycle);
    const { deps } = makeInterplayDeps(repo);
    const evt = buildEvent({ paymentDate: '2026-05-16' });

    const outcome = await resolveUnlinkedMembershipPaymentInTx(deps, evt, SENTINEL_TX);
    expect(outcome.kind).toBe('reanchored');
    expect(repo.rows.size).toBe(1);

    await createNextCycleOnPaidInTx(
      { cyclesRepo: repo as never, planLookup: deps.planLookup, auditEmitter: deps.auditEmitter, idFactory: deps.idFactory, memberPlanLookup: deps.memberPlanLookup, planChangeBillingEffectAudit: deps.planChangeBillingEffectAudit },
      evt,
      SENTINEL_TX,
    );
    expect(repo.rows.size).toBe(1);
  });

  it('after renewal completion, createNextCycleOnPaidInTx no-ops (createCycleInTx idempotency) — exactly one next cycle', async () => {
    const repo = makeInMemoryCyclesRepo();
    const openCycle = buildCycle({
      status: 'awaiting_payment',
      anchoredAt: '2025-06-01T00:00:00Z',
      periodFrom: '2026-06-01T00:00:00Z',
      periodTo: '2027-06-01T00:00:00Z',
      linkedInvoiceId: null,
    });
    repo.rows.set(openCycle.cycleId, openCycle);
    const { deps } = makeInterplayDeps(repo);
    const evt = buildEvent();

    const outcome = await resolveUnlinkedMembershipPaymentInTx(deps, evt, SENTINEL_TX);
    expect(outcome.kind).toBe('renewed');
    // Prior cycle (now completed + linked) + exactly one next cycle.
    expect(repo.rows.size).toBe(2);

    await createNextCycleOnPaidInTx(
      { cyclesRepo: repo as never, planLookup: deps.planLookup, auditEmitter: deps.auditEmitter, idFactory: deps.idFactory, memberPlanLookup: deps.memberPlanLookup, planChangeBillingEffectAudit: deps.planChangeBillingEffectAudit },
      evt,
      SENTINEL_TX,
    );
    // createNextCycleOnPaidInTx now finds the prior (linked, completed)
    // cycle via findByInvoiceIdInTx and tries periodFrom=prior.periodTo —
    // but createCycleInTx's findActiveForMemberInTx guard sees the
    // already-created next cycle as active and no-ops. Still exactly 2.
    expect(repo.rows.size).toBe(2);
  });
});
