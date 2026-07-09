/**
 * F8 Phase 5 Wave B · T123 spec — `markCycleCompleteFromInvoicePaid`.
 *
 * F4 onPaidCallback target. Verifies:
 *   - Default auto-complete branch
 *   - FR-005b admin-block branch → held in pending_admin_reactivation
 *   - no-cycle-for-invoice (non-renewal payment, idempotent)
 *   - Idempotent re-fire (cycle already completed)
 *   - Race-condition skip (TransitionConflict)
 *   - Atomic state+audit (Principle VIII reverse-direction)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { renewalsMetrics } from '@/lib/metrics';
import {
  markCycleCompleteFromInvoicePaid,
  markCycleCompleteInTx,
} from '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid';
import type { MarkCycleCompleteDeps } from '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-123';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1230';
const INVOICE_UUID = '00000000-0000-0000-0000-0000000aaaaa';

// Round 2 review-fix (I-5): hoisted spy lets the I3 tx-thread test
// distinguish "tx threaded — runInTenant NOT called" (existingTx path)
// from "tx omitted — runInTenant called exactly once" (legacy
// backward-compat path). Round 1's passthrough mock could not tell
// these apart: the sentinel-identity assertion would still pass even
// if the production code accidentally re-wrapped in `runInTenant`,
// silently re-introducing the eventual-consistency window I3 closed.
//
// Round 3 review-fix (R3-I1+I2+I3): the `runInTenantOrReuse` helper
// was deleted from `@/lib/db` because the wrapper variant
// (`markCycleCompleteFromInvoicePaid`) now opens its own `runInTenant`
// directly + the InTx variant (`markCycleCompleteInTx`) takes the
// caller's tx — both paths are simpler than a shared helper. The
// hoisted spy on `runInTenant` alone still locks the S-11 invariant:
// passing tx → InTx must NOT call runInTenant; omitting tx → wrapper
// MUST call runInTenant exactly once.
const { runInTenantSpy } = vi.hoisted(() => ({
  runInTenantSpy: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
      fn({} as unknown),
  ),
}));

vi.mock('@/lib/db', () => ({
  runInTenant: runInTenantSpy,
}));

// Rolling-anchor Task 5 — spy (not mock) on the real metrics module so the
// wiring tests can assert `unlinkedPaymentResolved` call args while the
// underlying OTel no-op meter still runs for real (matches the rest of
// this file's convention of exercising the real logger/metrics stack).
const unlinkedPaymentResolvedSpy = vi.spyOn(
  renewalsMetrics,
  'unlinkedPaymentResolved',
);

const SENTINEL_TX = { sentinel: 'tx' } as never;

beforeEach(() => {
  runInTenantSpy.mockClear();
  unlinkedPaymentResolvedSpy.mockClear();
});

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

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_ID,
    status: 'awaiting_payment',
    linkedInvoiceId: INVOICE_UUID,
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  /**
   * COMP-1 L3 — `blocked` and `erased` now resolve through ONE combined
   * read (`readReactivationGuardsInTx`). `blocked: null` models a missing /
   * RLS-hidden member (the combined read returns `null` for the whole row),
   * so BOTH guards are unknown and the use-case auto-completes defensively.
   */
  blocked?: boolean | null;
  /** COMP-1 H4 — member erased state (erased_at IS NOT NULL). Defaults false. */
  erased?: boolean | null;
  transitionImpl?: () => Promise<RenewalCycle>;
  emitInTxImpl?: () => Promise<void>;
  // Rolling-anchor Task 5 — the unlinked-payment resolution hook's extra
  // repo surface. Defaults model "no F8 history at all" (heal_no_cycle
  // shape) so `!cycle` + allowUnlinkedResolution=true tests can exercise a
  // real end-to-end resolution without every test needing to configure
  // each mock individually.
  countCyclesForMember?: number;
  /**
   * F2 fix (final-review, 2026-07-09) — feeds `classifyMembershipPayment`'s
   * `settledCycleCountForMember` (completed-OR-ever-anchored predecessor
   * count, NOT the raw `countCyclesForMember`). Defaults to `0`, matching
   * `countCyclesForMember`'s own conservative default — every existing
   * test either short-circuits on `heal_no_cycle` before this value is
   * consulted, or explicitly sets `countCyclesForMember: 1` expecting
   * `first_payment` (settled=0 is exactly right). The ONE test that needs
   * a genuine settled predecessor (line ~733, `countCyclesForMember: 2`
   * expecting `renewal`) overrides this explicitly.
   */
  settledCycleCountForMember?: number;
  openCycleForHook?: RenewalCycle | null;
  memberPlan?: { planId: string; isArchived: boolean } | null;
  /**
   * Rolling-anchor Task 6 — override the LINKED-path re-anchor result.
   * Defaults to a successful re-anchor (echoes back the caller's args
   * merged into a fresh cycle). Pass `async () => null` to simulate a
   * lost re-anchor race (0 rows matched the guard).
   */
  reanchorImpl?: () => Promise<{ cycle: RenewalCycle; reminderEventsReset: number } | null>;
  /**
   * Rolling-anchor Task 6 — `findByIdInTx` return value, consulted ONLY
   * by the linked-path race-recovery re-read (after `reanchorPeriodInTx`
   * returns null). Defaults to re-returning the same `args.cycle` — the
   * race-recovery test overrides this to a DIFFERENT cycle shape
   * (simulating a concurrent write that moved the row).
   */
  findByIdCycle?: RenewalCycle | null;
}): {
  deps: MarkCycleCompleteDeps;
  findByInvoiceMock: ReturnType<typeof vi.fn>;
  findByIdMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  readGuardsMock: ReturnType<typeof vi.fn>;
  countCyclesMock: ReturnType<typeof vi.fn>;
  countSettledCyclesMock: ReturnType<typeof vi.fn>;
  findOpenCycleMock: ReturnType<typeof vi.fn>;
  reanchorMock: ReturnType<typeof vi.fn>;
  insertMock: ReturnType<typeof vi.fn>;
  findActiveForMemberMock: ReturnType<typeof vi.fn>;
  loadPlanFrozenFieldsMock: ReturnType<typeof vi.fn>;
  loadMemberPlanMock: ReturnType<typeof vi.fn>;
} {
  const findByInvoiceMock = vi.fn(async () => args.cycle ?? null);
  const findByIdMock = vi.fn(async () =>
    args.findByIdCycle !== undefined ? args.findByIdCycle : (args.cycle ?? null),
  );
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async () => ({ ...args.cycle!, status: 'completed' as const })),
  );
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));
  // `blocked: null` ⇒ the combined read returns `null` (member absent /
  // RLS-hidden) — neither guard is known, so the use-case auto-completes.
  // Otherwise resolve both guards (defaulting each to false).
  const readGuardsMock = vi.fn(async () =>
    args.blocked === null
      ? null
      : {
          blocked: args.blocked ?? false,
          erased: args.erased === undefined ? false : (args.erased ?? false),
        },
  );
  const countCyclesMock = vi.fn(async () => args.countCyclesForMember ?? 0);
  const countSettledCyclesMock = vi.fn(
    async () => args.settledCycleCountForMember ?? 0,
  );
  const findOpenCycleMock = vi.fn(async () => args.openCycleForHook ?? null);
  const reanchorMock = vi.fn(
    args.reanchorImpl ??
      (async (_tx: unknown, _tenantId: string, cycleId: string, reanchorArgs: Record<string, unknown>) => ({
        cycle: { ...buildCycle({ cycleId: cycleId as never, ...reanchorArgs }) },
        reminderEventsReset: 0,
      })),
  );
  const insertMock = vi.fn(async () =>
    buildCycle({
      cycleId: asCycleId('00000000-0000-0000-0000-0000000cffff'),
      status: 'upcoming',
      anchoredAt: null,
      anchorInvoiceId: null,
    }),
  );
  const findActiveForMemberMock = vi.fn(async () => null);
  const loadPlanFrozenFieldsMock = vi.fn(async () => ({
    status: 'found' as const,
    plan: {
      tierBucket: 'regular' as const,
      priceTHB: '50000.00' as never,
      termMonths: 12,
      currency: 'THB' as const,
    },
  }));
  const loadMemberPlanMock = vi.fn(async () =>
    args.memberPlan === undefined ? { planId: 'p1', isArchived: false } : args.memberPlan,
  );
  // FIX-3 (PR #173 review, 2026-07-09) — default January; no test in this
  // file exercises a non-January-start tenant's re-freeze decision (that's
  // covered by `_lib/reanchor-first-payment.test.ts`'s dedicated suite).
  const getFiscalYearStartMonthMock = vi.fn(async () => 1);
  const deps: MarkCycleCompleteDeps = {
    tenant: { slug: TENANT_ID } as MarkCycleCompleteDeps['tenant'],
    cyclesRepo: {
      findByInvoiceIdInTx: findByInvoiceMock,
      findByIdInTx: findByIdMock,
      transitionStatus: transitionMock,
      countCyclesForMemberInTx: countCyclesMock,
      countSettledCyclesForMemberInTx: countSettledCyclesMock,
      findOpenCycleForMemberInTx: findOpenCycleMock,
      reanchorPeriodInTx: reanchorMock,
      insert: insertMock,
      findActiveForMemberInTx: findActiveForMemberMock,
    } as unknown as MarkCycleCompleteDeps['cyclesRepo'],
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    } as unknown as MarkCycleCompleteDeps['auditEmitter'],
    memberRenewalFlagsRepo: {
      readReactivationGuardsInTx: readGuardsMock,
    } as unknown as MarkCycleCompleteDeps['memberRenewalFlagsRepo'],
    planLookupForRenewal: {
      loadPlanFrozenFields: loadPlanFrozenFieldsMock,
    } as unknown as MarkCycleCompleteDeps['planLookupForRenewal'],
    cycleIdFactory: { cycleId: () => asCycleId('00000000-0000-0000-0000-0000000cffff') },
    // FIX-8(d) (PR #173 review, 2026-07-09) — `clock` dropped from
    // `MarkCycleCompleteDeps` (dead dependency, never read).
    memberPlanLookup: {
      loadMemberPlanInTx: loadMemberPlanMock,
    } as unknown as MarkCycleCompleteDeps['memberPlanLookup'],
    fiscalYearSettings: {
      getFiscalYearStartMonth: getFiscalYearStartMonthMock,
    },
  };
  return {
    deps,
    findByInvoiceMock,
    findByIdMock,
    transitionMock,
    emitInTxMock,
    readGuardsMock,
    countCyclesMock,
    countSettledCyclesMock,
    findOpenCycleMock,
    reanchorMock,
    insertMock,
    findActiveForMemberMock,
    loadPlanFrozenFieldsMock,
    loadMemberPlanMock,
  };
}

describe('markCycleCompleteFromInvoicePaid (T123) — auto-complete branch', () => {
  it('happy path — transitions to completed + emits renewal_completed audit', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock, readGuardsMock } = fakeDeps({
      cycle,
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    // Round 2 (S-10): use-case returns MarkCycleCompleteOutcome
    // directly (no Result wrapper). Discriminate via `kind`.
    expect(r.kind).toBe('completed');
    // COMP-1 L3 — the auto-complete branch issues exactly ONE guards read.
    expect(readGuardsMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'completed',
      closedReason: 'paid',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed',
      payload: { invoice_id: INVOICE_UUID, payment_method: 'stripe_card' },
    });
  });

  it('blocked=null (member missing) — proceeds with auto-complete (defensive)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({ cycle, blocked: null });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('completed');
  });
});

describe('markCycleCompleteFromInvoicePaid (T123) — FR-005b admin-block branch', () => {
  it('blocked=true — held in pending_admin_reactivation + emits renewal_completed_post_lapse', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => ({
        ...cycle,
        status: 'pending_admin_reactivation' as const,
        enteredPendingAt: '2026-05-07T10:00:00Z',
      } as never),
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('held_pending_admin');
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'pending_admin_reactivation',
      enteredPendingAt: '2026-05-07T10:00:00Z',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed_post_lapse',
      payload: { held_for_admin_review: true },
    });
  });

  it('COMP-1 H4: erased member (block flag FALSE) — held, never auto-completed', async () => {
    // Erasure forces blocked=FALSE; without the erased_at guard this member
    // would auto-complete. Assert the erased read routes to the hold path.
    const cycle = buildCycle();
    const { deps, transitionMock, readGuardsMock } = fakeDeps({
      cycle,
      blocked: false,
      erased: true,
      transitionImpl: async () =>
        ({
          ...cycle,
          status: 'pending_admin_reactivation' as const,
          enteredPendingAt: '2026-05-07T10:00:00Z',
        }) as never,
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('held_pending_admin');
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'pending_admin_reactivation',
    });
    // COMP-1 L3 — both guards resolve through ONE combined read, not two.
    expect(readGuardsMock).toHaveBeenCalledTimes(1);
    expect(readGuardsMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      MEMBER_ID,
    );
  });
});

describe('markCycleCompleteFromInvoicePaid (T123) — non-renewal + idempotent paths', () => {
  it('no_cycle_for_invoice when invoice has no F8 cycle (e.g. ad-hoc admin invoice)', async () => {
    const { deps, transitionMock } = fakeDeps({ cycle: null });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('no_cycle_for_invoice');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('idempotent re-fire — cycle already completed, returns cycle_not_payable', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, transitionMock } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('completed');
    } else {
      throw new Error(`expected cycle_not_payable, got ${r.kind}`);
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('cycle in pending_admin_reactivation — skip (admin already holds)', async () => {
    const cycle = buildCycle({
      status: 'pending_admin_reactivation',
      enteredPendingAt: '2026-04-01T00:00:00Z',
    });
    const { deps } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('pending_admin_reactivation');
    } else {
      throw new Error(`expected cycle_not_payable, got ${r.kind}`);
    }
  });

  it('S-11 split: markCycleCompleteInTx reuses caller tx — runInTenant NOT called', async () => {
    // Round 2 review-fix (S-11): the use-case is split into two
    // variants. The InTx variant takes a caller-provided tx and
    // never opens its own runInTenant — locks the I3 atomic-tx
    // invariant at the type system level (no `existingTx?` branch
    // to forget). Round 1's hoisted spy still runs to prove the
    // assertion holds at runtime.
    const cycle = buildCycle();
    const { deps, findByInvoiceMock } = fakeDeps({ cycle });
    const sentinelTx = { sentinel: 'f4-tx-handle' } as never;
    const r = await markCycleCompleteInTx(deps, buildEvent(), sentinelTx);
    expect(r.kind).toBe('completed');
    // Assertion 1: sentinel-identity threads through to repo
    expect(findByInvoiceMock).toHaveBeenCalledWith(
      sentinelTx,
      TENANT_ID,
      INVOICE_UUID,
    );
    // Assertion 2: InTx variant does NOT call runInTenant — by
    // construction (no body wrapping) but locked by the spy.
    expect(runInTenantSpy).not.toHaveBeenCalled();
  });

  it('S-11 wrapper: markCycleCompleteFromInvoicePaid opens runInTenant exactly once', async () => {
    // Reciprocal: the wrapper variant DOES call runInTenant —
    // backward-compat half of the I3 contract.
    const cycle = buildCycle();
    const { deps, findByInvoiceMock } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('completed');
    expect(runInTenantSpy).toHaveBeenCalledTimes(1);
    expect(findByInvoiceMock).toHaveBeenCalled();
  });
});

describe('markCycleCompleteFromInvoicePaid (T123) — race + atomicity', () => {
  it('TransitionConflict — idempotent skip (admin moved cycle out of awaiting_payment)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'awaiting_payment',
          'cancelled',
        );
      },
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('cycle_not_payable');
  });

  it('Principle VIII — audit emit failure throws (rolls back F4 invoice)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    await expect(
      markCycleCompleteFromInvoicePaid(deps, buildEvent()),
    ).rejects.toThrow(/audit_log: insert failed/);
  });

  it('infra throw on transition (non-conflict) — propagates so F4 rolls back', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      transitionImpl: async () => {
        throw new Error('connection reset');
      },
    });
    await expect(
      markCycleCompleteFromInvoicePaid(deps, buildEvent()),
    ).rejects.toThrow(/connection reset/);
  });

  // R11 coverage closure — holdForAdminReview private function had its
  // catch branch (CycleTransitionConflictError + CycleNotFoundError +
  // rethrow) uncovered. Same idempotent-skip semantics as the default
  // markCycleCompleteInTx path: if a concurrent confirm flipped the
  // cycle out of awaiting_payment, the F4 callback must NOT 5xx — it
  // returns cycle_not_payable so F4 sees an idempotent acknowledgement.

  it('blocked=true + transition CycleTransitionConflictError — idempotent skip (returns cycle_not_payable)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'awaiting_payment',
          'cancelled',
        );
      },
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('cycle_not_payable');
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('awaiting_payment');
    }
  });

  it('blocked=true + transition CycleNotFoundError — idempotent skip (returns cycle_not_payable)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => {
        throw new CycleNotFoundError(CYCLE_UUID);
      },
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('cycle_not_payable');
  });

  it('blocked=true + non-conflict throw — propagates so F4 rolls back', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => {
        throw new Error('hold-for-admin connection reset');
      },
    });
    await expect(
      markCycleCompleteFromInvoicePaid(deps, buildEvent()),
    ).rejects.toThrow(/hold-for-admin connection reset/);
  });
});

describe('markCycleCompleteInTx (rolling-anchor Task 5) — unlinked-payment resolution wiring', () => {
  it('allowUnlinkedResolution defaults true — no linked cycle delegates to the hook (event-fee fast skip)', async () => {
    const { deps, readGuardsMock, countCyclesMock } = fakeDeps({ cycle: null });
    const r = await markCycleCompleteInTx(
      deps,
      buildEvent({ invoiceSubject: 'event' }),
      SENTINEL_TX,
    );
    expect(r.kind).toBe('no_cycle_for_invoice');
    // The hook's event_invoice fast path does zero reads — proves the
    // wiring genuinely delegates to the REAL hook rather than short-
    // circuiting itself.
    expect(readGuardsMock).not.toHaveBeenCalled();
    expect(countCyclesMock).not.toHaveBeenCalled();
  });

  it('allowUnlinkedResolution=true (default) — heal_no_cycle resolution actually runs + outcome maps to no_cycle_for_invoice', async () => {
    const { deps, insertMock, readGuardsMock } = fakeDeps({
      cycle: null,
      countCyclesForMember: 0,
      openCycleForHook: null,
    });
    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);
    expect(r.kind).toBe('no_cycle_for_invoice');
    // Real end-to-end resolution work happened (not just a fast skip):
    // the erased-guard read ran, and a fresh cycle was created + stamped.
    expect(readGuardsMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('markCycleCompleteFromInvoicePaid (wrapper) forces allowUnlinkedResolution=false — hook NEVER runs, even for a membership invoice', async () => {
    const { deps, readGuardsMock, countCyclesMock } = fakeDeps({
      cycle: null,
      countCyclesForMember: 0,
      openCycleForHook: null,
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('no_cycle_for_invoice');
    // Degraded-mode refusal: zero unlinked-resolution reads at all.
    expect(readGuardsMock).not.toHaveBeenCalled();
    expect(countCyclesMock).not.toHaveBeenCalled();
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });
});

describe('markCycleCompleteInTx (rolling-anchor Task 6) — LINKED-path first-payment re-anchor', () => {
  it('linked invoice + only-cycle unanchored member → reanchored (NOT completed)', async () => {
    // Default buildCycle(): status='awaiting_payment', linkedInvoiceId=
    // INVOICE_UUID (this event's invoice), anchoredAt=null — exactly the
    // confirm-renewal pre-linked-invoice shape spec §1 site 2 targets.
    const cycle = buildCycle();
    const {
      deps,
      reanchorMock,
      transitionMock,
      emitInTxMock,
      countCyclesMock,
      readGuardsMock,
      insertMock,
    } = fakeDeps({ cycle, countCyclesForMember: 1 });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    expect(r.kind).toBe('reanchored');
    if (r.kind === 'reanchored') {
      expect(r.cycleId).toBe(CYCLE_UUID);
      expect(r.memberId).toBe(MEMBER_ID);
    }

    // Classification consulted countCyclesForMemberInTx for THIS member.
    expect(countCyclesMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_ID, MEMBER_ID);

    // reanchorPeriodInTx called once, anchoring to THIS invoice.
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock).toHaveBeenCalledWith(
      SENTINEL_TX,
      TENANT_ID,
      CYCLE_UUID,
      expect.objectContaining({ anchorInvoiceId: INVOICE_UUID }),
    );

    // NOT completed: the awaiting_payment→completed transition never runs,
    // no next cycle is created, and no heal-path insert runs either.
    expect(transitionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();

    // Audit is renewal_cycle_reanchored (not renewal_completed).
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_cycle_reanchored',
      payload: expect.objectContaining({
        cycle_id: CYCLE_UUID,
        member_id: MEMBER_ID,
        invoice_id: INVOICE_UUID,
      }),
    });

    // Stop-the-line fix (erased-member-auto-reactivation regression) — the
    // guards read now happens BEFORE classification (not after, as the
    // reanchor branch used to bypass it entirely), so the erased flag can
    // feed `classifyMembershipPayment` and route an erased member's
    // first-ever payment to the hold-for-admin path instead of re-anchoring.
    // For this NON-erased member, the read still resolves `memberErased:
    // false` and reanchor proceeds exactly as before — see the sibling
    // "erased member" test below for the gated case.
    expect(readGuardsMock).toHaveBeenCalledTimes(1);
  });

  // FIX-7(e) (PR #173 review, 2026-07-09) — the sibling `'upcoming'` open
  // status (the OTHER status `toOpenCycleClassifierInput` folds into the
  // classifier's open set alongside `'awaiting_payment'`) was untested for
  // the LINKED-path re-anchor branch. A linked invoice + an `'upcoming'`,
  // never-anchored, only-ever cycle must re-anchor exactly like the
  // `'awaiting_payment'` shape above.
  it('linked invoice + status=upcoming, only-cycle unanchored member → reanchored (NOT completed)', async () => {
    const cycle = buildCycle({ status: 'upcoming' });
    const { deps, reanchorMock, transitionMock, insertMock, emitInTxMock } =
      fakeDeps({ cycle, countCyclesForMember: 1 });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    expect(r.kind).toBe('reanchored');
    if (r.kind === 'reanchored') {
      expect(r.cycleId).toBe(CYCLE_UUID);
      expect(r.memberId).toBe(MEMBER_ID);
    }
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock).toHaveBeenCalledWith(
      SENTINEL_TX,
      TENANT_ID,
      CYCLE_UUID,
      expect.objectContaining({ anchorInvoiceId: INVOICE_UUID }),
    );
    expect(transitionMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_cycle_reanchored',
      payload: expect.objectContaining({
        cycle_id: CYCLE_UUID,
        member_id: MEMBER_ID,
        invoice_id: INVOICE_UUID,
      }),
    });
  });

  it('F3 (final-review): degraded mode (wrapper) + first-payment shape → NOT reanchored, falls through to legacy complete flow', async () => {
    // Same first-payment shape as the happy-path test above (only cycle,
    // never anchored, linked to THIS invoice), but driven through the
    // WRAPPER (`markCycleCompleteFromInvoicePaid`), which forces
    // `allowUnlinkedResolution=false` (separately-committed, non-atomic
    // tx). The reanchor branch must be skipped entirely — a re-anchor is
    // too consequential a mutation to commit outside F4's real payment
    // tx — falling through to the pre-existing auto-complete flow
    // instead (legacy behaviour, byte-identical to the
    // already-anchored-cycle test below).
    const cycle = buildCycle();
    const {
      deps,
      reanchorMock,
      transitionMock,
      emitInTxMock,
      countCyclesMock,
      readGuardsMock,
    } = fakeDeps({ cycle, countCyclesForMember: 1 });

    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());

    expect(r.kind).toBe('completed');
    // The reanchor ACTION never runs — only the completion path does.
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'completed',
      closedReason: 'paid',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed',
    });
    // Classification still ran (countCycles + guards consulted once each)
    // — only the reanchor ACTION was gated, not the classify read itself.
    expect(countCyclesMock).toHaveBeenCalledTimes(1);
    expect(readGuardsMock).toHaveBeenCalledTimes(1);
    // Reuses the SAME metric bucket as the sibling `!cycle` degraded
    // refusal so both land on one dashboard counter.
    expect(renewalsMetrics.unlinkedPaymentResolved).toHaveBeenCalledWith('skipped');
  });

  it('COMP-1 H4: erased member, first-ever unanchored cycle → held for admin, NOT reanchored', async () => {
    // Same first-payment shape as the happy-path test above (only cycle,
    // never anchored), but the member is GDPR-erased. Without threading the
    // real erased flag into classification, this misclassified as
    // `first_payment` and silently re-anchored an erased member's renewal
    // timeline — COMP-1 forbids that just as much as auto-completing one.
    const cycle = buildCycle();
    const {
      deps,
      reanchorMock,
      transitionMock,
      emitInTxMock,
      countCyclesMock,
      readGuardsMock,
    } = fakeDeps({
      cycle,
      countCyclesForMember: 1,
      erased: true,
      transitionImpl: async () =>
        ({
          ...cycle,
          status: 'pending_admin_reactivation' as const,
          enteredPendingAt: '2026-05-07T10:00:00Z',
        }) as never,
    });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    expect(r.kind).toBe('held_pending_admin');
    // Classification ran (cycle is open) and consulted countCyclesForMember,
    // but resolved to not_applicable(erased) — never first_payment.
    expect(countCyclesMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock).not.toHaveBeenCalled();
    // ONE combined guards read feeds BOTH classification and the
    // hold-for-admin gate below — not two separate reads.
    expect(readGuardsMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'pending_admin_reactivation',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed_post_lapse',
      payload: { held_for_admin_review: true },
    });
  });

  it('linked invoice + already-anchored cycle → existing completed behaviour is byte-identical', async () => {
    const cycle = buildCycle({
      anchoredAt: '2025-06-01T00:00:00Z',
      anchorInvoiceId: '00000000-0000-0000-0000-0000000ap0st',
    });
    const { deps, transitionMock, emitInTxMock, reanchorMock, countCyclesMock } =
      fakeDeps({ cycle, countCyclesForMember: 1 });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    expect(r.kind).toBe('completed');
    // Classification ran (cycle is open) but resolved to 'renewal' since
    // anchoredAt !== null — reanchor never fires.
    expect(countCyclesMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'completed',
      closedReason: 'paid',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed',
    });
  });

  it('linked invoice + member has predecessor cycles → completed (existing renewal behaviour, not reanchor)', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const { deps, transitionMock, reanchorMock, countCyclesMock } = fakeDeps({
      cycle,
      // Member has a prior (predecessor) cycle in addition to this one,
      // and it WAS settled (completed/anchored) — classifyMembershipPayment's
      // settled-history branch does not match `first_payment`, so this is
      // 'renewal' even though anchoredAt is null on THIS cycle.
      countCyclesForMember: 2,
      settledCycleCountForMember: 1,
    });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    expect(r.kind).toBe('completed');
    expect(countCyclesMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock).not.toHaveBeenCalled();
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  // F2 fix (final-review, 2026-07-09) — a predecessor cycle that was
  // cancelled/lapsed WITHOUT ever anchoring (genuinely never paid) must
  // NOT count as "renewal history" — reanchors, not completes.
  it('linked invoice + predecessor cycle exists but was NEVER settled (cancelled, never anchored) → reanchored, not completed', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const { deps, transitionMock, reanchorMock, countCyclesMock } = fakeDeps({
      cycle,
      countCyclesForMember: 2, // a predecessor row exists...
      settledCycleCountForMember: 0, // ...but it was NEVER settled
    });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    expect(r.kind).toBe('reanchored');
    expect(countCyclesMock).toHaveBeenCalledTimes(1);
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('lost the re-anchor race (0 rows) → re-reads by id + falls through to the existing flow, never loops', async () => {
    const cycle = buildCycle(); // awaiting_payment, anchoredAt=null
    // Simulate a concurrent write that moved the row out of the
    // un-anchored-open state between our classify read and the guarded
    // UPDATE (e.g. an admin manually cancelled the cycle mid-race).
    const refreshedCycle = buildCycle({
      status: 'cancelled',
      anchoredAt: '2026-01-01T00:00:00Z',
      closedAt: '2026-01-01T00:00:00Z',
      closedReason: 'cancelled',
    });
    const { deps, reanchorMock, findByIdMock, transitionMock, countCyclesMock } =
      fakeDeps({
        cycle,
        countCyclesForMember: 1,
        reanchorImpl: async () => null,
        findByIdCycle: refreshedCycle,
      });

    const r = await markCycleCompleteInTx(deps, buildEvent(), SENTINEL_TX);

    // Reanchor was attempted exactly once (never retried/looped).
    expect(reanchorMock).toHaveBeenCalledTimes(1);
    // Re-read happened by cycle id (not by invoice id — the row's own PK).
    expect(findByIdMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_ID, CYCLE_UUID);
    // Refreshed cycle is 'cancelled' (not awaiting_payment) — falls
    // through to the EXISTING status guard, which reports it as
    // cycle_not_payable. autoComplete never attempted.
    expect(r.kind).toBe('cycle_not_payable');
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('cancelled');
    }
    expect(transitionMock).not.toHaveBeenCalled();
    // countCyclesForMemberInTx consulted exactly once (the initial
    // classify) — the race-recovery path does not reclassify/loop.
    expect(countCyclesMock).toHaveBeenCalledTimes(1);
  });
});
