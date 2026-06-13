/**
 * F8-completion Slice 1 · Task 1.4 — `createNextCycleOnPaidInTx` thin
 * wrapper unit tests.
 *
 * Runs as `f8OnPaidCallbacks[2]`, AFTER callback[0] flips the prior
 * cycle →completed in the SAME F4 tx. Resolves the just-paid cycle via
 * `findByInvoiceIdInTx`, anchors the next cycle at `prior.periodTo`
 * (gapless), and delegates to `createCycleInTx` with `source: 'on_paid'`.
 *
 * THROWS on failure (in-tx state work — F4 tx must roll back so the
 * Stripe at-least-once retry heals via the idempotency guard). Does NOT
 * swallow.
 *
 * The live-Neon proof (prior →completed AND new cycle created on the
 * FIRST delivery; retry idempotent) is the Task 1.4 integration test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { createNextCycleOnPaidInTx } from '@/modules/renewals/application/use-cases/create-next-cycle-on-paid';
import { asCycleId, type RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { CreateCycleInTxDeps } from '@/modules/renewals/application/use-cases/create-cycle-in-tx';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type { RenewalCycleRepo } from '@/modules/renewals/application/ports/renewal-cycle-repo';
import type { TenantTx } from '@/lib/db';

const fakeTx = {} as TenantTx;

const PRIOR_CYCLE: RenewalCycle = {
  tenantId: 'tenant-a',
  cycleId: asCycleId('00000000-0000-0000-0000-0000000000aa'),
  memberId: '11111111-1111-1111-1111-111111111111',
  status: 'completed',
  periodFrom: '2025-01-01T00:00:00.000Z',
  periodTo: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:00:00.000Z',
  cycleLengthMonths: 12,
  tierAtCycleStart: 'regular',
  planIdAtCycleStart: 'regular',
  frozenPlanPriceThb: '15000.00',
  frozenPlanTermMonths: 12,
  frozenPlanCurrency: 'THB',
  enteredPendingAt: null,
  linkedInvoiceId: '99999999-9999-9999-9999-999999999999',
  linkedCreditNoteId: null,
  closedAt: '2026-01-01T00:00:00.000Z',
  closedReason: 'paid',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as RenewalCycle;

function buildEvent(): F4InvoicePaidEvent {
  return {
    tenantId: 'tenant-a',
    invoiceId: '99999999-9999-9999-9999-999999999999',
    memberId: '11111111-1111-1111-1111-111111111111',
    paidAt: '2026-01-01T00:00:00.000Z',
    amountSatang: asSatang(1_605_000n),
    vatSatang: asSatang(105_000n),
    currency: 'THB',
    paymentMethod: 'stripe_card',
    triggeredBy: 'webhook',
  };
}

type WrapperDeps = CreateCycleInTxDeps & {
  cyclesRepo: Pick<
    RenewalCycleRepo,
    'findByInvoiceIdInTx' | 'findActiveForMemberInTx' | 'insert'
  >;
};

function makeDeps(opts?: {
  prior?: RenewalCycle | null;
  active?: RenewalCycle | null;
}): {
  deps: WrapperDeps;
  findByInvoiceIdInTx: ReturnType<typeof vi.fn>;
  findActiveForMemberInTx: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  loadPlanFrozenFields: ReturnType<typeof vi.fn>;
  emitInTx: ReturnType<typeof vi.fn>;
} {
  const findByInvoiceIdInTx = vi
    .fn()
    .mockResolvedValue(opts?.prior === undefined ? PRIOR_CYCLE : opts.prior);
  const findActiveForMemberInTx = vi
    .fn()
    .mockResolvedValue(opts?.active ?? null);
  const insert = vi
    .fn()
    .mockImplementation(async (_tx, _t, input) => ({ ...input }) as unknown as RenewalCycle);
  const loadPlanFrozenFields = vi.fn().mockResolvedValue({
    status: 'found',
    plan: { tierBucket: 'regular', priceTHB: '15000.00', termMonths: 12, currency: 'THB' },
  });
  const emitInTx = vi.fn().mockResolvedValue(undefined);

  const deps: WrapperDeps = {
    cyclesRepo: {
      findByInvoiceIdInTx,
      findActiveForMemberInTx,
      insert,
    } as unknown as WrapperDeps['cyclesRepo'],
    planLookup: { loadPlanFrozenFields },
    auditEmitter: { emit: vi.fn(), emitInTx, bulkEmitInTx: vi.fn() },
    idFactory: { cycleId: () => asCycleId('00000000-0000-0000-0000-0000000000c2') },
  };
  return {
    deps,
    findByInvoiceIdInTx,
    findActiveForMemberInTx,
    insert,
    loadPlanFrozenFields,
    emitInTx,
  };
}

describe('createNextCycleOnPaidInTx — Slice 1 / Task 1.4', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops when the paid invoice is not linked to any cycle (not a renewal invoice)', async () => {
    const { deps, insert, loadPlanFrozenFields } = makeDeps({ prior: null });

    await createNextCycleOnPaidInTx(deps, buildEvent(), fakeTx);

    expect(insert).not.toHaveBeenCalled();
    expect(loadPlanFrozenFields).not.toHaveBeenCalled();
  });

  it('anchors the next cycle at prior.periodTo (gapless) and creates it on first delivery', async () => {
    const { deps, insert } = makeDeps();

    await createNextCycleOnPaidInTx(deps, buildEvent(), fakeTx);

    expect(insert).toHaveBeenCalledTimes(1);
    const [, , newCycle] = insert.mock.calls[0]!;
    expect(newCycle).toMatchObject({
      memberId: PRIOR_CYCLE.memberId,
      // periodFrom = prior.periodTo (gapless)
      periodFrom: '2026-01-01T00:00:00.000Z',
      // periodTo = periodFrom + 12 months
      periodTo: '2027-01-01T00:00:00.000Z',
      planIdAtCycleStart: 'regular',
    });
  });

  it('delegates to createCycleInTx with source=on_paid and a deterministic correlationId from the invoice id', async () => {
    const { deps, emitInTx } = makeDeps();

    await createNextCycleOnPaidInTx(deps, buildEvent(), fakeTx);

    expect(emitInTx).toHaveBeenCalledTimes(1);
    const [, event, ctx] = emitInTx.mock.calls[0]!;
    expect(event.type).toBe('renewal_cycle_created');
    expect(ctx).toMatchObject({
      tenantId: 'tenant-a',
      actorUserId: null,
      actorRole: 'system',
      correlationId: 'on-paid:99999999-9999-9999-9999-999999999999',
    });
  });

  it('no-ops (idempotent) when the member already has an active cycle — webhook retry safety', async () => {
    const stillActive = { cycleId: asCycleId('00000000-0000-0000-0000-0000000000bb') } as RenewalCycle;
    const { deps, insert } = makeDeps({ active: stillActive });

    await createNextCycleOnPaidInTx(deps, buildEvent(), fakeTx);

    // createCycleInTx short-circuits on the active-exists guard.
    expect(insert).not.toHaveBeenCalled();
  });

  it('RE-THROWS (does NOT swallow) when createCycleInTx fails — F4 tx must roll back so Stripe retry heals', async () => {
    const { deps, loadPlanFrozenFields } = makeDeps();
    // Force createCycleInTx to throw via an unresolvable plan.
    loadPlanFrozenFields.mockResolvedValueOnce({ status: 'not_found' });

    await expect(
      createNextCycleOnPaidInTx(deps, buildEvent(), fakeTx),
    ).rejects.toThrow(/not resolvable/);
  });

  it('RE-THROWS when the prior-cycle lookup itself throws (DB fault propagates)', async () => {
    const { deps, findByInvoiceIdInTx } = makeDeps();
    findByInvoiceIdInTx.mockRejectedValueOnce(new Error('db connection reset'));

    await expect(
      createNextCycleOnPaidInTx(deps, buildEvent(), fakeTx),
    ).rejects.toThrow(/db connection reset/);
  });
});
