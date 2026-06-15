/**
 * F8-completion Slice 1 · Task 1.2 — `createCycleInTx` shared helper.
 *
 * The single home for all cycle-creation invariants:
 *   - in-tx-visible idempotency no-op (`findActiveForMemberInTx`),
 *   - frozen-price snapshot (`loadPlanFrozenFields`),
 *   - gapless period derivation (`periodTo = periodFrom + termMonths`),
 *   - `renewal_cycle_created` audit emit IN THE SAME tx after insert.
 *
 * All four creation entry points (on-paid callback, member import,
 * create-member onboarding listener, Slice-3 admin fresh-cycle) consume
 * this helper — none forks a parallel creator.
 *
 * Pure unit test — every dependency is mocked. The live-Neon proof of
 * the in-tx idempotency seam lives in the Task 1.4 integration test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCycleInTx,
  PlanNotResolvableError,
  type CreateCycleInTxDeps,
  type CreateCycleInTxInput,
} from '@/modules/renewals/application/use-cases/create-cycle-in-tx';
import { asCycleId, type RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { TenantTx } from '@/lib/db';

const FIXED_CYCLE_ID = asCycleId('00000000-0000-0000-0000-0000000000c1');

const fakeTx = {} as TenantTx;

function makeDeps(overrides?: {
  findActive?: RenewalCycle | null;
  planResult?: unknown;
  /**
   * 070 re-query coverage — a YEAR-AWARE plan-lookup. When supplied, the
   * `loadPlanFrozenFields` mock returns the entry whose key matches the
   * `fiscalYear` it was called with, so the provisional (raw-year) call and
   * the definitive (anchored-year) call can return DISTINCT results. Any
   * year absent from the map resolves to `{ status: 'not_found' }` (an
   * unexpected year is a test-detectable miss, never a silent `found`).
   */
  planResultByYear?: Record<number, unknown>;
}): {
  deps: CreateCycleInTxDeps;
  findActiveForMemberInTx: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  loadPlanFrozenFields: ReturnType<typeof vi.fn>;
  emitInTx: ReturnType<typeof vi.fn>;
} {
  const findActiveForMemberInTx = vi.fn().mockResolvedValue(
    overrides?.findActive ?? null,
  );
  // insert echoes back a minimal RenewalCycle-shaped object so the
  // helper's `{ kind: 'created', cycle }` return is observable.
  const insert = vi.fn().mockImplementation(
    async (_tx, _tenantId, input) =>
      ({
        ...input,
        status: input.startStatus ?? 'upcoming',
        expiresAt: input.periodTo,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        linkedInvoiceId: null,
        linkedCreditNoteId: null,
        enteredPendingAt: null,
        closedAt: null,
        closedReason: null,
      }) as unknown as RenewalCycle,
  );
  const byYear = overrides?.planResultByYear;
  const loadPlanFrozenFields = byYear
    ? vi.fn().mockImplementation(async ({ fiscalYear }: { fiscalYear: number }) =>
        byYear[fiscalYear] ?? { status: 'not_found' },
      )
    : vi.fn().mockResolvedValue(
        overrides?.planResult ?? {
          status: 'found',
          plan: {
            tierBucket: 'regular',
            priceTHB: '15000.00',
            termMonths: 12,
            currency: 'THB',
          },
        },
      );
  const emitInTx = vi.fn().mockResolvedValue(undefined);

  const deps: CreateCycleInTxDeps = {
    cyclesRepo: { findActiveForMemberInTx, insert } as unknown as CreateCycleInTxDeps['cyclesRepo'],
    planLookup: { loadPlanFrozenFields },
    auditEmitter: {
      emit: vi.fn(),
      emitInTx,
      bulkEmitInTx: vi.fn(),
    },
    idFactory: { cycleId: () => FIXED_CYCLE_ID },
  };
  return { deps, findActiveForMemberInTx, insert, loadPlanFrozenFields, emitInTx };
}

const baseInput: CreateCycleInTxInput = {
  tenantId: 'tenant-a',
  memberId: '11111111-1111-1111-1111-111111111111',
  periodFrom: '2026-01-01T00:00:00.000Z',
  planId: 'regular',
  actorUserId: null,
  actorRole: 'system',
  correlationId: 'corr-1',
};

describe('createCycleInTx — Slice 1 / Task 1.2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when an active cycle already exists (in-tx idempotency)', async () => {
    const existing = { cycleId: asCycleId('00000000-0000-0000-0000-0000000000ee') } as RenewalCycle;
    const { deps, insert, loadPlanFrozenFields, emitInTx } = makeDeps({
      findActive: existing,
    });

    const out = await createCycleInTx(deps, fakeTx, baseInput);

    expect(out).toEqual({ kind: 'skipped_active_exists' });
    expect(insert).not.toHaveBeenCalled();
    expect(loadPlanFrozenFields).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('derives periodTo = periodFrom + 12 months and freezes the resolved plan price (VAT-irrelevant snapshot)', async () => {
    const { deps, insert } = makeDeps();

    const out = await createCycleInTx(deps, fakeTx, baseInput);

    expect(out.kind).toBe('created');
    expect(insert).toHaveBeenCalledTimes(1);
    const [tx, tenantId, newCycle] = insert.mock.calls[0]!;
    expect(tx).toBe(fakeTx);
    expect(tenantId).toBe('tenant-a');
    expect(newCycle).toMatchObject({
      cycleId: FIXED_CYCLE_ID,
      memberId: baseInput.memberId,
      periodFrom: '2026-01-01T00:00:00.000Z',
      periodTo: '2027-01-01T00:00:00.000Z',
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: 'regular',
      frozenPlanPriceThb: '15000.00',
      frozenPlanTermMonths: 12,
    });
  });

  it('070 §86/4 — freezes by the RESOLVED periodFrom fiscal-year with mode \'freeze\' (FREEZE caller)', async () => {
    // Regression guard for the latent multi-active-year footgun: the
    // frozen price MUST resolve by the cycle's own fiscal year, not the
    // "most-recent active" row. createCycleInTx derives the year from the
    // RESOLVED periodFrom (post current-period anchoring) and asks the
    // port for that exact year with mode 'freeze' (a freeze, not a
    // plan-offer check). A regular 2026-01-01 period → FY 2026.
    const { deps, loadPlanFrozenFields } = makeDeps();

    await createCycleInTx(deps, fakeTx, baseInput);

    expect(loadPlanFrozenFields).toHaveBeenCalledTimes(1);
    expect(loadPlanFrozenFields).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      mode: 'freeze',
    });
  });

  it('070 §86/4 — fiscalYear tracks the ANCHORED periodFrom, not the raw input year (import cold-start)', async () => {
    // A long-standing member registered 2020-03-15 anchored to the current
    // period (now 2026-06-14) lands on 2026-03-15 → FY 2026. The freeze
    // lookup MUST use 2026 (the cycle's real year), never 2020.
    const { deps, loadPlanFrozenFields } = makeDeps();

    await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2020-03-15T00:00:00.000Z',
      anchorToCurrentPeriod: { nowIso: '2026-06-14T00:00:00.000Z' },
    });

    expect(loadPlanFrozenFields).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      mode: 'freeze',
    });
  });

  it('070 §86/4 — RE-QUERIES the definitive year when anchoring crosses a year boundary (provisional 2020 → definitive 2026) and freezes from the DEFINITIVE call', async () => {
    // The two-step freeze lookup: a provisional lookup keyed on the RAW input
    // year (2020) supplies the term used to anchor periodFrom; once the cycle's
    // REAL fiscal year is known (2026, post-anchoring) a DEFINITIVE re-lookup
    // pins the frozen price/term/tier to that year. A YEAR-AWARE mock returns
    // DISTINCT plans per year so we prove the cycle freezes from the 2026 call,
    // not the 2020 provisional — a single-call refactor would fail this.
    const { deps, loadPlanFrozenFields, insert } = makeDeps({
      planResultByYear: {
        2020: {
          status: 'found',
          plan: {
            tierBucket: 'regular',
            priceTHB: '9000.00', // stale provisional-year price
            termMonths: 12,
            currency: 'THB',
          },
        },
        2026: {
          status: 'found',
          plan: {
            tierBucket: 'premium', // definitive-year tier — distinct from provisional
            priceTHB: '18000.00', // definitive-year price — distinct from provisional
            termMonths: 12,
            currency: 'THB',
          },
        },
      },
    });

    const out = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2020-03-15T00:00:00.000Z',
      anchorToCurrentPeriod: { nowIso: '2026-06-14T00:00:00.000Z' },
    });

    // TWO distinct lookups fired: provisional (raw 2020) THEN definitive (2026).
    expect(loadPlanFrozenFields).toHaveBeenCalledTimes(2);
    expect(loadPlanFrozenFields).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2020,
      mode: 'freeze',
    });
    expect(loadPlanFrozenFields).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      mode: 'freeze',
    });

    // The cycle freezes the DEFINITIVE (2026) plan, NOT the provisional (2020).
    expect(out.kind).toBe('created');
    const [, , newCycle] = insert.mock.calls[0]!;
    expect(newCycle).toMatchObject({
      periodFrom: '2026-03-15T00:00:00.000Z',
      periodTo: '2027-03-15T00:00:00.000Z',
      tierAtCycleStart: 'premium',
      frozenPlanPriceThb: '18000.00',
    });
  });

  it('070 §86/4 — definitive re-lookup MISS (not_found) → throws PlanNotResolvableError, inserts no cycle', async () => {
    // Provisional (raw 2020) resolves so anchoring proceeds; the definitive
    // (anchored 2026) year is NOT in the catalogue → the re-lookup misses. The
    // :256-262 throw path: refuse to create an unbillable cycle with no frozen
    // §86/4 price, and roll back (no insert, no audit).
    const { deps, insert, emitInTx, loadPlanFrozenFields } = makeDeps({
      planResultByYear: {
        2020: {
          status: 'found',
          plan: {
            tierBucket: 'regular',
            priceTHB: '9000.00',
            termMonths: 12,
            currency: 'THB',
          },
        },
        // 2026 absent → year-aware mock returns { status: 'not_found' }.
      },
    });

    const err = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2020-03-15T00:00:00.000Z',
      anchorToCurrentPeriod: { nowIso: '2026-06-14T00:00:00.000Z' },
    }).then(
      () => {
        throw new Error('expected createCycleInTx to throw on definitive miss');
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PlanNotResolvableError);
    const typed = err as PlanNotResolvableError;
    expect(typed.planStatus).toBe('not_found');
    expect(typed.planId).toBe(baseInput.planId);
    expect(typed.memberId).toBe(baseInput.memberId);
    // The definitive (2026) lookup DID fire — the throw is from the re-query,
    // not the provisional call (which resolved 'found').
    expect(loadPlanFrozenFields).toHaveBeenCalledTimes(2);
    expect(loadPlanFrozenFields).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      mode: 'freeze',
    });
    // Cycle is NOT inserted and no audit fires — the tx rolls back.
    expect(insert).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('070 §86/4 — definitive re-lookup MISS (plan_inactive) → throws PlanNotResolvableError, inserts no cycle', async () => {
    // Same re-query throw path, but the anchored-year row exists and is
    // inactive. A FREEZE caller (mode 'freeze') treats an
    // exact-year row as found regardless of is_active, so a port that returns
    // plan_inactive for the definitive year is an explicit "no row" signal →
    // the re-query throws plan_inactive (distinct from the not_found case).
    const { deps, insert, emitInTx, loadPlanFrozenFields } = makeDeps({
      planResultByYear: {
        2020: {
          status: 'found',
          plan: {
            tierBucket: 'regular',
            priceTHB: '9000.00',
            termMonths: 12,
            currency: 'THB',
          },
        },
        2026: { status: 'plan_inactive' },
      },
    });

    const err = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2020-03-15T00:00:00.000Z',
      anchorToCurrentPeriod: { nowIso: '2026-06-14T00:00:00.000Z' },
    }).then(
      () => {
        throw new Error('expected createCycleInTx to throw on definitive miss');
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PlanNotResolvableError);
    expect((err as PlanNotResolvableError).planStatus).toBe('plan_inactive');
    expect(loadPlanFrozenFields).toHaveBeenCalledTimes(2);
    expect(insert).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('070 §86/4 — SKIPS the re-query on the hot path: no anchoring (steady-state) → loadPlanFrozenFields called ONCE', async () => {
    // The common on-paid / onboarding case: periodFrom is already at the
    // current period (no anchorToCurrentPeriod, or anchoring within the same
    // year). The provisional and definitive years coincide → the :249 guard is
    // false → the definitive re-lookup is SKIPPED and the provisional result is
    // reused. Proves the two-step path does NOT cost an extra query on the
    // steady-state hot path.
    const { deps, loadPlanFrozenFields } = makeDeps();

    const out = await createCycleInTx(deps, fakeTx, baseInput);

    expect(out.kind).toBe('created');
    expect(loadPlanFrozenFields).toHaveBeenCalledTimes(1);
    expect(loadPlanFrozenFields).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      planId: 'regular',
      fiscalYear: 2026,
      mode: 'freeze',
    });
  });

  it('068 cluster F — anchorToCurrentPeriod advances a HISTORICAL periodFrom to the current period (anniversary preserved)', async () => {
    const { deps, insert, emitInTx } = makeDeps();
    // Member registered 2020-03-15 (5+ years ago); now = 2026-06-14. With a
    // 12-month term the current period anchors at 2020+6yr = 2026-03-15 (period
    // 2026-03-15 → 2027-03-15 covers `now`). The anniversary (March 15) is kept.
    const out = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2020-03-15T00:00:00.000Z',
      anchorToCurrentPeriod: { nowIso: '2026-06-14T00:00:00.000Z' },
    });
    expect(out.kind).toBe('created');
    const [, , newCycle] = insert.mock.calls[0]!;
    expect(newCycle).toMatchObject({
      periodFrom: '2026-03-15T00:00:00.000Z',
      periodTo: '2027-03-15T00:00:00.000Z',
    });
    // Audit payload carries the ANCHORED periodFrom (matches the cycle row).
    const [, event] = emitInTx.mock.calls[0]!;
    expect(event.payload).toMatchObject({
      period_from: '2026-03-15T00:00:00.000Z',
      period_to: '2027-03-15T00:00:00.000Z',
    });
  });

  it('068 cluster F — anchorToCurrentPeriod is a no-op when periodFrom is already in the current/future period', async () => {
    const { deps, insert } = makeDeps();
    // A current-period registration: 2026-05-20, now = 2026-06-14. period_to
    // 2027-05-20 already covers `now` → the FIRST iteration returns unchanged.
    const out = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2026-05-20T00:00:00.000Z',
      anchorToCurrentPeriod: { nowIso: '2026-06-14T00:00:00.000Z' },
    });
    expect(out.kind).toBe('created');
    const [, , newCycle] = insert.mock.calls[0]!;
    expect(newCycle).toMatchObject({
      periodFrom: '2026-05-20T00:00:00.000Z',
      periodTo: '2027-05-20T00:00:00.000Z',
    });
  });

  it('068 cluster F — WITHOUT anchorToCurrentPeriod a historical periodFrom is used VERBATIM (non-import paths unchanged)', async () => {
    const { deps, insert } = makeDeps();
    const out = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      periodFrom: '2020-03-15T00:00:00.000Z',
      // no anchorToCurrentPeriod — on-paid / onboarding / lapsed-comeback paths.
    });
    expect(out.kind).toBe('created');
    const [, , newCycle] = insert.mock.calls[0]!;
    expect(newCycle).toMatchObject({
      periodFrom: '2020-03-15T00:00:00.000Z',
      periodTo: '2021-03-15T00:00:00.000Z',
    });
  });

  it('emits renewal_cycle_created in the same tx after insert, with the canonical payload shape', async () => {
    const { deps, emitInTx, insert } = makeDeps();

    await createCycleInTx(deps, fakeTx, baseInput);

    expect(emitInTx).toHaveBeenCalledTimes(1);
    const [emitTx, event, ctx] = emitInTx.mock.calls[0]!;
    expect(emitTx).toBe(fakeTx);
    expect(event.type).toBe('renewal_cycle_created');
    // Canonical F8AuditPayloadShapes.renewal_cycle_created shape.
    expect(event.payload).toEqual({
      cycle_id: FIXED_CYCLE_ID,
      member_id: baseInput.memberId,
      tier_bucket: 'regular',
      period_from: '2026-01-01T00:00:00.000Z',
      period_to: '2027-01-01T00:00:00.000Z',
    });
    expect(ctx).toMatchObject({
      tenantId: 'tenant-a',
      actorUserId: null,
      actorRole: 'system',
      correlationId: 'corr-1',
    });
    // Audit emit happens AFTER insert (atomic ordering — state then audit).
    const insertOrder = insert.mock.invocationCallOrder[0]!;
    const emitOrder = emitInTx.mock.invocationCallOrder[0]!;
    expect(emitOrder).toBeGreaterThan(insertOrder);
  });

  it('throws a typed PlanNotResolvableError when the plan cannot be resolved (not_found) — caller decides to roll back', async () => {
    const { deps, insert, emitInTx } = makeDeps({
      planResult: { status: 'not_found' },
    });

    // Item B — the throw is a typed sentinel (callers narrow via
    // `instanceof PlanNotResolvableError`, NOT a brittle message string-match).
    const err = await createCycleInTx(deps, fakeTx, baseInput).then(
      () => {
        throw new Error('expected createCycleInTx to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanNotResolvableError);
    const typed = err as PlanNotResolvableError;
    expect(typed.planId).toBe(baseInput.planId);
    expect(typed.memberId).toBe(baseInput.memberId);
    expect(typed.planStatus).toBe('not_found');
    // The original human-readable message text is preserved (forensic logs).
    expect(typed.message).toMatch(/not resolvable/);
    expect(typed.name).toBe('PlanNotResolvableError');
    expect(insert).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('throws a typed PlanNotResolvableError when the plan is inactive — caller decides to roll back', async () => {
    const { deps, insert } = makeDeps({
      planResult: { status: 'plan_inactive' },
    });

    const err = await createCycleInTx(deps, fakeTx, baseInput).then(
      () => {
        throw new Error('expected createCycleInTx to throw');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanNotResolvableError);
    expect((err as PlanNotResolvableError).planStatus).toBe('plan_inactive');
    expect(insert).not.toHaveBeenCalled();
  });

  it('honours an explicit startStatus (Slice 3 awaiting-start) — default is upcoming', async () => {
    const { deps, insert } = makeDeps();

    await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      startStatus: 'awaiting_payment',
    });

    const [, , newCycle] = insert.mock.calls[0]!;
    expect(newCycle.startStatus).toBe('awaiting_payment');
  });

  it('defaults startStatus to upcoming when omitted', async () => {
    const { deps, insert } = makeDeps();

    await createCycleInTx(deps, fakeTx, baseInput);

    const [, , newCycle] = insert.mock.calls[0]!;
    // The helper passes startStatus through; default resolves to 'upcoming'.
    expect(newCycle.startStatus ?? 'upcoming').toBe('upcoming');
  });
});
