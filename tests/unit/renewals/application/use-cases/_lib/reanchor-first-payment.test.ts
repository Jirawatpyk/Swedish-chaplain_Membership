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

function fakeDeps(): {
  deps: ReanchorFirstPaymentDeps;
  mocks: {
    reanchorPeriodInTx: ReturnType<typeof vi.fn>;
    emitInTx: ReturnType<typeof vi.fn>;
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
  return {
    deps: {
      cyclesRepo: { reanchorPeriodInTx },
      planLookup: { loadPlanFrozenFields: vi.fn() },
      auditEmitter: { emitInTx },
    },
    mocks: { reanchorPeriodInTx, emitInTx },
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
