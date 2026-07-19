/**
 * Money-remediation Task 2 — the sweep's two failure channels stay separate.
 *
 * Before the retrofit, a deliberate F4-credit-note decline and a genuine
 * Postgres fault both arrived at the same `catch`, and were told apart by
 * `cause instanceof SweepFinalizeError`. Get that discrimination wrong and
 * the escalation branch — an ops page saying "money refunded at Stripe with
 * no §86/10 credit note booked" — starts firing on transient Neon blips, or
 * stops firing on real divergences.
 *
 * The retrofit makes the decline a VALUE (`rollbackTx`) and leaves `catch`
 * meaning "something broke". This file pins that both ways round, in one
 * place, because the discrimination is only observable as a CONTRAST: the
 * existing suite asserts each side in a separate test, which cannot fail if
 * the two channels silently merge.
 *
 * The per-row DB-fault side was previously uncovered — the existing suite's
 * only throw test targets the list-read tx, not the per-row tx.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@/modules/payments/application/use-cases/_finalize-succeeded-refund',
  () => ({ finalizeSucceededRefund: vi.fn() }),
);
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: {
      ...actual.paymentsMetrics,
      refundSucceededCount: vi.fn(),
      refundFailedCount: vi.fn(),
      stalePendingRefundEscalated: vi.fn(),
      refundPendingAwaitingProcessor: vi.fn(),
    },
  };
});

import { sweepStalePendingRefunds } from '@/modules/payments';
import type {
  SweepStalePendingRefundsDeps,
  SweepStalePendingRefundsInput,
} from '@/modules/payments';
import { finalizeSucceededRefund } from '@/modules/payments/application/use-cases/_finalize-succeeded-refund';
import { paymentsMetrics } from '@/lib/metrics';
import { ok, err } from '@/lib/result';
import { asPaymentId } from '@/modules/payments/domain/payment';
import { asRefundId, type Refund } from '@/modules/payments/domain/refund';
import { asSatang } from '@/lib/money';

const TENANT_ID = 'tnt-1';
const NOW_MS = Date.parse('2026-07-11T10:00:00.000Z');
const PAYMENT_ID = asPaymentId('pmt_01JABCDEFGHJKMNPQRSTVWXYZ');
const AMOUNT = asSatang(350_000n);
const HOUR_MS = 60 * 60 * 1000;

/** Older than ESCALATION_AGE_MS (3 days) so the escalation gate is open. */
const AGED_HOURS = 5 * 24;

const mockFinalize = vi.mocked(finalizeSucceededRefund);

function lockedRefund(): Refund {
  return {
    id: asRefundId('rfnd_01STALE'),
    tenantId: TENANT_ID,
    paymentId: PAYMENT_ID,
    invoiceId: 'inv-1',
    amountSatang: AMOUNT,
    reason: 'test refund',
    status: 'pending',
    processorRefundId: 're_stale1',
    failureReasonCode: null,
    creditNoteId: null,
    initiatedAt: new Date(NOW_MS - AGED_HOURS * HOUR_MS),
    completedAt: null,
    initiatorUserId: 'user-admin-1',
    correlationId: 'corr-stale',
  };
}

function makeDeps(): SweepStalePendingRefundsDeps {
  const tx = Symbol('tx');
  return {
    paymentsRepo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as SweepStalePendingRefundsDeps['paymentsRepo'],
    refundsRepo: {
      listPendingOlderThan: vi.fn(async () => [
        {
          id: 'rfnd_01STALE',
          paymentId: PAYMENT_ID,
          invoiceId: 'inv-1',
          amountSatang: AMOUNT,
          initiatedAt: new Date(NOW_MS - AGED_HOURS * HOUR_MS),
          correlationId: 'corr-stale',
          initiatorUserId: 'user-admin-1',
          processorRefundId: 're_stale1',
        },
      ]),
      lockForUpdateByProcessorRefundId: vi.fn(async () => lockedRefund()),
      updateStatus: vi.fn(async () => lockedRefund()),
    } as unknown as SweepStalePendingRefundsDeps['refundsRepo'],
    tenantSettingsRepo: {
      getByTenantId: vi.fn(async () => ({
        tenantId: TENANT_ID,
        processor: 'stripe' as const,
        processorEnvironment: 'test' as const,
        processorAccountId: 'acct_test_sweep01',
        processorPublishableKey: 'pk_test_sweep01',
        enabledMethods: ['card'] as const,
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
      })),
      findByProcessorAccountId: vi.fn(async () => null),
    } as unknown as SweepStalePendingRefundsDeps['tenantSettingsRepo'],
    processorGateway: {
      retrieveRefund: vi.fn(async () =>
        ok({
          id: 're_stale1',
          status: 'succeeded',
          chargeId: 'ch_1',
          paymentIntentId: 'pi_1',
          amountSatang: AMOUNT,
        }),
      ),
    } as unknown as SweepStalePendingRefundsDeps['processorGateway'],
    invoicingBridge: {
      issueCreditNoteFromRefund: vi.fn(async () =>
        ok({ creditNoteId: 'cn-1', creditNoteNumber: 'TC-1' }),
      ),
    } as unknown as SweepStalePendingRefundsDeps['invoicingBridge'],
    audit: { emit: vi.fn(async () => undefined) },
    clock: { nowIso: () => new Date(NOW_MS).toISOString(), nowMs: () => NOW_MS },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const input: SweepStalePendingRefundsInput = {
  tenantId: TENANT_ID,
  requestId: 'req-sweep-div',
};

function skipWarn(deps: SweepStalePendingRefundsDeps) {
  return vi
    .mocked(deps.logger!.warn)
    .mock.calls.find((c) => c[0] === 'sweep_stale_pending_refunds.row_skipped');
}

describe('sweep — deliberate F4 decline vs genuine per-row fault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('F4 credit-note DECLINE on an aged row → escalates, tagged SweepFinalizeError', async () => {
    const deps = makeDeps();
    mockFinalize.mockResolvedValue(err({ code: 'pdf_render_failed' }) as never);

    const r = await sweepStalePendingRefunds(deps, input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.sweptCount).toBe(0);
      // The money IS refunded at Stripe with no §86/10 credit note booked —
      // this must reach ops.
      expect(r.value.escalatedCount).toBe(1);
    }
    expect(skipWarn(deps)?.[1]).toMatchObject({ errKind: 'SweepFinalizeError' });
    expect(paymentsMetrics.stalePendingRefundEscalated).toHaveBeenCalledTimes(1);
  });

  it('per-row DB FAULT on an equally aged row → skips WITHOUT escalating', async () => {
    // Same row, same age, same everything — only the failure channel differs.
    // A transient Neon blip must not page ops with a money-divergence alert,
    // and must not be tagged with the divergence errKind.
    const deps = makeDeps();
    mockFinalize.mockResolvedValue(ok({ siblingWon: false }) as never);
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockRejectedValue(
      new TypeError('connection terminated unexpectedly'),
    );

    const r = await sweepStalePendingRefunds(deps, input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(0);
    }
    const warn = skipWarn(deps)?.[1];
    expect(warn).toMatchObject({ errKind: 'TypeError' });
    expect(warn).not.toMatchObject({ errKind: 'SweepFinalizeError' });
    expect(paymentsMetrics.stalePendingRefundEscalated).not.toHaveBeenCalled();
  });

  it('a fault does not abort the run — the sweep still returns ok', async () => {
    // Per-row isolation: one bad row must not cost the whole tenant sweep.
    const deps = makeDeps();
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockRejectedValue(
      new Error('boom'),
    );
    await expect(sweepStalePendingRefunds(deps, input)).resolves.toMatchObject({
      ok: true,
    });
  });
});
