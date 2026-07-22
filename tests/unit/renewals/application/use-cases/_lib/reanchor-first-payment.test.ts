/**
 * F2 (final-review, 2026-07-09) — `reanchorFirstPaymentCycleInTx` orphaned-
 * linked-invoice loud log.
 *
 * A first-payment cycle can carry a `linkedInvoiceId` that is NOT the
 * invoice actually being paid (e.g. confirm-renewal or an F8-dispatched
 * reminder parked a different invoice; the member instead settled an
 * unrelated ad-hoc invoice out of band). The re-anchor must still proceed
 * (never blocked on the orphan), but a `logger.error` must fire so staff
 * can void the now-orphaned parked invoice — mirrors
 * `resolve-unlinked-membership-payment.ts`'s `renewalComplete` branch,
 * which already logs this for the `renewal` classification.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  reanchorFirstPaymentCycleInTx,
  type ReanchorFirstPaymentDeps,
} from '@/modules/renewals/application/use-cases/_lib/reanchor-first-payment';
import { asSatang } from '@/lib/money';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { buildCycle } from '../../../_helpers/build-cycle';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { unlinkedPaymentResolved: vi.fn() },
}));

import { logger } from '@/lib/logger';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-1';
const PAYING_INVOICE_UUID = '00000000-0000-0000-0000-0000000aaaaa';
const PARKED_INVOICE_UUID = '00000000-0000-0000-0000-0000000bbbbb';

function buildEvent(
  overrides: Partial<F4InvoicePaidEvent> = {},
): F4InvoicePaidEvent {
  return {
    tenantId: TENANT_ID,
    invoiceId: PAYING_INVOICE_UUID,
    memberId: MEMBER_ID,
    paidAt: '2026-06-16T10:00:00Z',
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

function fakeDeps(opts?: { fiscalYearStartMonth?: number }): {
  deps: ReanchorFirstPaymentDeps;
  mocks: {
    reanchorPeriodInTx: ReturnType<typeof vi.fn>;
    emitInTx: ReturnType<typeof vi.fn>;
    loadPlanFrozenFields: ReturnType<typeof vi.fn>;
    getFiscalYearStartMonthInTx: ReturnType<typeof vi.fn>;
  };
} {
  const reanchorPeriodInTx = vi.fn(async () => ({
    cycle: buildCycle({
      status: 'upcoming' as const,
      anchoredAt: '2026-06-01T00:00:00.000Z',
      anchorInvoiceId: PAYING_INVOICE_UUID,
      linkedInvoiceId: null,
      periodFrom: '2026-06-01T00:00:00.000Z',
      periodTo: '2027-06-01T00:00:00.000Z',
    }),
    reminderEventsReset: 0,
  }));
  const emitInTx = vi.fn(async () => undefined);
  const loadPlanFrozenFields = vi.fn(async () => ({ status: 'not_found' as const }));
  // FIX-3 (PR #173 review, 2026-07-09) — default to January so pre-existing
  // tests (which build same-FY cycles) never exercise the re-freeze branch.
  // R2-FIX-1 — reads on the caller's tx (`getFiscalYearStartMonthInTx`).
  const getFiscalYearStartMonthInTx = vi.fn(
    async () => opts?.fiscalYearStartMonth ?? 1,
  );
  return {
    deps: {
      cyclesRepo: { reanchorPeriodInTx },
      planLookup: { loadPlanFrozenFields },
      auditEmitter: { emitInTx },
      fiscalYearSettings: { getFiscalYearStartMonthInTx },
    },
    mocks: { reanchorPeriodInTx, emitInTx, loadPlanFrozenFields, getFiscalYearStartMonthInTx },
  };
}

// Same fiscal year (2026) as the cycle's periodFrom — never exercises the
// FY-crossing re-freeze branch (out of scope for this suite).
function unanchoredCycle(overrides: Record<string, unknown> = {}): RenewalCycle {
  return buildCycle({
    status: 'awaiting_payment' as const,
    anchoredAt: null,
    anchorInvoiceId: null,
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2027-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('reanchorFirstPaymentCycleInTx — orphaned-linked-invoice log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cycle linked to a DIFFERENT invoice → logs orphaned-invoice error, still re-anchors', async () => {
    const { deps, mocks } = fakeDeps();
    const cycle = unanchoredCycle({ linkedInvoiceId: PARKED_INVOICE_UUID });

    const result = await reanchorFirstPaymentCycleInTx(
      deps,
      buildEvent(),
      {} as never,
      cycle,
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleId: cycle.cycleId,
        orphanedInvoiceId: PARKED_INVOICE_UUID,
        payingInvoiceId: PAYING_INVOICE_UUID,
        tenantId: TENANT_ID,
        memberId: MEMBER_ID,
      }),
      expect.stringContaining('orphaned invoice'),
    );
    // Never blocked by the orphan — the re-anchor still proceeds.
    expect(result).not.toBeNull();
    expect(mocks.reanchorPeriodInTx).toHaveBeenCalled();
  });

  it('cycle with NO linked invoice (null) → no log', async () => {
    const { deps } = fakeDeps();
    const cycle = unanchoredCycle({ linkedInvoiceId: null });

    await reanchorFirstPaymentCycleInTx(deps, buildEvent(), {} as never, cycle);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('cycle linked to the SAME invoice being paid (site-2 linked path) → no log', async () => {
    const { deps } = fakeDeps();
    const cycle = unanchoredCycle({ linkedInvoiceId: PAYING_INVOICE_UUID });

    await reanchorFirstPaymentCycleInTx(deps, buildEvent(), {} as never, cycle);

    expect(logger.error).not.toHaveBeenCalled();
  });
});

// FIXED-ANCHOR (2026-07-22): first payment must NOT move the period to the
// payment month — it keeps the cycle's registration/backfill anchor and only
// stamps `anchored_at` + activates the status. This reverses the #173
// payment-anchor bug, so there is no fiscal-year boundary crossing and no
// plan re-freeze on first payment.
describe('reanchorFirstPaymentCycleInTx — fixed-anchor: period is NOT moved to the payment month', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the cycle EXISTING period to the repo, not the payment month', async () => {
    const { deps, mocks } = fakeDeps();
    // cycle period is Jan 2026; the payment lands in June.
    const cycle = unanchoredCycle();

    await reanchorFirstPaymentCycleInTx(
      deps,
      buildEvent({ paidAt: '2026-06-16T10:00:00Z', paymentDate: '2026-06-16' }),
      {} as never,
      cycle,
    );

    expect(mocks.reanchorPeriodInTx).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      cycle.cycleId,
      expect.objectContaining({
        periodFrom: cycle.periodFrom,
        periodTo: cycle.periodTo,
        anchorInvoiceId: PAYING_INVOICE_UUID,
      }),
    );
  });

  it('does NOT read the fiscal-year start-month or re-freeze the plan (no period move → no boundary crossing)', async () => {
    const { deps, mocks } = fakeDeps({ fiscalYearStartMonth: 4 });

    const result = await reanchorFirstPaymentCycleInTx(
      deps,
      buildEvent({ paymentDate: '2026-05-16' }),
      {} as never,
      unanchoredCycle({ periodFrom: '2026-02-01T00:00:00.000Z' }),
    );

    expect(mocks.getFiscalYearStartMonthInTx).not.toHaveBeenCalled();
    expect(mocks.loadPlanFrozenFields).not.toHaveBeenCalled();
    expect(result?.refrozePlanFields).toBe(false);
  });

  it('EXPIRED period at payment → re-anchors to the payment month (comeback), NOT the dead period', async () => {
    const { deps, mocks } = fakeDeps();
    // Period fully elapsed (2024-2025) but the invoice is paid June 2026 —
    // keeping the dead period would leave the payer suspended. Treat as comeback.
    const cycle = unanchoredCycle({
      periodFrom: '2024-01-01T00:00:00.000Z',
      periodTo: '2025-01-01T00:00:00.000Z',
      frozenPlanTermMonths: 12,
    });

    await reanchorFirstPaymentCycleInTx(
      deps,
      buildEvent({ paidAt: '2026-06-16T10:00:00Z', paymentDate: '2026-06-16' }),
      {} as never,
      cycle,
    );

    // Re-anchored to a FRESH June 2026 period (not the dead 2024 one).
    expect(mocks.reanchorPeriodInTx).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      cycle.cycleId,
      expect.objectContaining({
        periodFrom: '2026-06-01T00:00:00.000Z',
        periodTo: '2027-06-01T00:00:00.000Z',
        anchoredAt: '2026-06-01T00:00:00.000Z',
      }),
    );
  });
});
