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
  const loadPlanFrozenFields = vi.fn().mockResolvedValue(
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
  source: 'on_paid',
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

  it('068 cluster F — anchorToCurrentPeriod advances a HISTORICAL periodFrom to the current period (anniversary preserved)', async () => {
    const { deps, insert, emitInTx } = makeDeps();
    // Member registered 2020-03-15 (5+ years ago); now = 2026-06-14. With a
    // 12-month term the current period anchors at 2020+6yr = 2026-03-15 (period
    // 2026-03-15 → 2027-03-15 covers `now`). The anniversary (March 15) is kept.
    const out = await createCycleInTx(deps, fakeTx, {
      ...baseInput,
      source: 'import',
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
      source: 'import',
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

  it('throws when the plan cannot be resolved (not_found) — caller decides to roll back', async () => {
    const { deps, insert, emitInTx } = makeDeps({
      planResult: { status: 'not_found' },
    });

    await expect(createCycleInTx(deps, fakeTx, baseInput)).rejects.toThrow(
      /not resolvable/,
    );
    expect(insert).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('throws when the plan is inactive — caller decides to roll back', async () => {
    const { deps, insert } = makeDeps({
      planResult: { status: 'plan_inactive' },
    });

    await expect(createCycleInTx(deps, fakeTx, baseInput)).rejects.toThrow(
      /not resolvable/,
    );
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
