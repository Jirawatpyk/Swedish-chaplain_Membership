/**
 * Money-remediation Task 1 — `payments_unreconciled_total` roll-up counter.
 *
 * Five separate counters already mark the five ways F4/F5 can end a request
 * with Stripe and the ledger disagreeing. Each is a useful dashboard input and
 * all five stay. What was missing is a single instrument an alert rule can
 * bind to: five rules drift, and a sixth divergence site added later gets no
 * rule at all.
 *
 * DESIGN NOTE — why the roll-up is emitted from inside the five façade
 * helpers rather than from their five call sites (which is what the
 * remediation plan proposed): the call sites are `confirm-payment.ts`,
 * `issue-refund.ts` and the sweep — three money-path files. Editing them
 * would give Task 1 a blast radius it is explicitly supposed to not have.
 * Emitting from the façade makes it structurally impossible for a site to
 * bump its specific counter without also bumping the roll-up, which is a
 * stronger guarantee than five hand-written call pairs, and it keeps the
 * whole change inside one non-money file.
 *
 * `permanence` is a mechanical property, not a judgement: does an automated
 * mechanism exist that will retry this divergence?
 *   - `transient`  — something will re-drive it (the stale-pending-refund
 *                    sweep re-reads `pending` refund rows).
 *   - `permanent`  — nothing will. The three `confirm-payment` Phase-B
 *                    counters all sit on paths that return 200 to Stripe, and
 *                    Stripe does not redeliver a 2xx; `stalePendingRefundEscalated`
 *                    fires only after the sweep has already tried and failed.
 *
 * (NB: `confirmPaymentLateChargePhaseBMarkFailed`'s own docstring claims
 * "Recovery is automatic via Stripe retry idempotency". That claim is false
 * for the same 200-ack reason and is finding F-2 part 2; correcting the
 * comment belongs to Task 3, so it is left alone here. The label follows the
 * mechanism, not the stale comment.)
 *
 * Approach mirrors `metrics-erasure-outcome.test.ts`: mock `@opentelemetry/api`
 * with a fake meter that captures `createCounter(name)` + `add(value, attrs)`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedAdd {
  readonly value: number;
  readonly attrs: Record<string, string>;
}
const counterAddsByName = new Map<string, CapturedAdd[]>();

function bucket(name: string): CapturedAdd[] {
  let b = counterAddsByName.get(name);
  if (!b) {
    b = [];
    counterAddsByName.set(name, b);
  }
  return b;
}

vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );
  return {
    ...actual,
    metrics: {
      getMeter: () => ({
        createCounter: (name: string) => ({
          add: (value: number, attrs: Record<string, string>) => {
            bucket(name).push({ value, attrs });
          },
        }),
        createHistogram: () => ({ record: () => {} }),
        createObservableGauge: () => ({ addCallback: () => {} }),
      }),
    },
  };
});

import { paymentsMetrics } from '@/lib/metrics';

const ROLLUP = 'payments_unreconciled_total';

function rollupAdds(): CapturedAdd[] {
  return counterAddsByName.get(ROLLUP) ?? [];
}

describe('payments_unreconciled_total — divergence roll-up', () => {
  beforeEach(() => {
    counterAddsByName.clear();
  });

  it('is emitted alongside — not instead of — the specific counter', () => {
    paymentsMetrics.refundFinaliseDoubleFault('swecham');

    // The dashboard input survives.
    expect(counterAddsByName.get('payments_refund_finalise_double_fault_total')).toEqual([
      { value: 1, attrs: { tenant: 'swecham' } },
    ]);
    // …and the alertable roll-up fires too.
    expect(rollupAdds()).toEqual([
      {
        value: 1,
        attrs: {
          path: 'refund_finalise_double_fault',
          permanence: 'transient',
          tenant: 'swecham',
        },
      },
    ]);
  });

  it.each([
    [
      'confirmPaymentGiveUpPhaseBMarkProcessedFailed',
      () => paymentsMetrics.confirmPaymentGiveUpPhaseBMarkProcessedFailed(),
      { path: 'confirm_payment_give_up_phase_b', permanence: 'permanent', tenant: 'unresolved' },
    ],
    [
      'confirmPaymentStaleRefundPhaseBMarkFailed',
      () => paymentsMetrics.confirmPaymentStaleRefundPhaseBMarkFailed(),
      { path: 'confirm_payment_stale_refund_phase_b', permanence: 'permanent', tenant: 'unresolved' },
    ],
    [
      'confirmPaymentLateChargePhaseBMarkFailed',
      () => paymentsMetrics.confirmPaymentLateChargePhaseBMarkFailed(),
      { path: 'confirm_payment_late_charge_phase_b', permanence: 'permanent', tenant: 'unresolved' },
    ],
    [
      'refundFinaliseDoubleFault',
      () => paymentsMetrics.refundFinaliseDoubleFault('t1'),
      { path: 'refund_finalise_double_fault', permanence: 'transient', tenant: 't1' },
    ],
    [
      'stalePendingRefundEscalated',
      () => paymentsMetrics.stalePendingRefundEscalated('t1'),
      { path: 'stale_pending_refund_escalated', permanence: 'permanent', tenant: 't1' },
    ],
  ])('%s rolls up exactly once with its own path label', (_name, emit, attrs) => {
    emit();
    expect(rollupAdds()).toEqual([{ value: 1, attrs }]);
  });

  it('gives every divergence site a DISTINCT path label', () => {
    // A copy-pasted path label would silently merge two failure modes into
    // one alert series and make the roll-up unable to say what broke.
    paymentsMetrics.confirmPaymentGiveUpPhaseBMarkProcessedFailed();
    paymentsMetrics.confirmPaymentStaleRefundPhaseBMarkFailed();
    paymentsMetrics.confirmPaymentLateChargePhaseBMarkFailed();
    paymentsMetrics.refundFinaliseDoubleFault('t1');
    paymentsMetrics.stalePendingRefundEscalated('t1');

    const paths = rollupAdds().map((a) => a.attrs.path);
    expect(paths).toHaveLength(5);
    expect(new Set(paths).size).toBe(5);
  });

  it('labels an unlabelled-tenant site "unresolved" rather than omitting the key', () => {
    // Mixed label sets on one instrument break PromQL aggregation across the
    // series; `String(undefined)` would read as the literal "undefined".
    paymentsMetrics.confirmPaymentGiveUpPhaseBMarkProcessedFailed();
    expect(rollupAdds()[0]!.attrs.tenant).toBe('unresolved');
  });
});
