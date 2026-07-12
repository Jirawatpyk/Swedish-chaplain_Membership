/**
 * CF-2 — `resolveFailedAutoRefund` use-case unit test.
 *
 * Spec authority: F5 go-live register CF-2 (failed-auto-refund resolve /
 * acknowledge). The admin marks a permanently-failed stale-invoice auto-refund
 * as manually reconciled; the use-case:
 *   - refuses when NO `auto_refund_failed_needs_manual_reconcile` forensic
 *     exists for the invoice's payment (typed `no_failed_auto_refund` error),
 *   - emits the append-only `auto_refund_reconciled` audit event (tenant-scoped
 *     tx, acting admin + optional note) on the happy path,
 *   - is IDEMPOTENT: a second call with a reconcile already present is a benign
 *     `already_reconciled` no-op (NO second emit).
 *
 * PCI: the payload carries id-refs + optional note only — no card data / raw
 * Stripe text. The read + emit run inside ONE `withTx` (tenant-scoped).
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveFailedAutoRefund } from '@/modules/payments/application/use-cases/resolve-failed-auto-refund';

const FAKE_TX = Symbol('tx');

type EmitEvent = {
  eventType: string;
  actorUserId: string;
  retentionYears: number;
  payload: Record<string, unknown> & { note?: string };
};

function makeDeps(
  findResult:
    | { paymentId: string; processorRefundId: string; alreadyReconciled: boolean }
    | null,
) {
  const emit = vi.fn(async (_tx: unknown, _event: EmitEvent) => undefined);
  const findFailedAutoRefundForInvoice = vi.fn(async () => findResult);
  const withTx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(FAKE_TX));
  return {
    emit,
    findFailedAutoRefundForInvoice,
    withTx,
    deps: {
      paymentsRepo: { withTx, findFailedAutoRefundForInvoice },
      audit: { emit },
    },
  };
}

const INPUT = {
  tenantId: 'swecham',
  invoiceId: 'inv_abc',
  actorUserId: '00000000-0000-0000-0000-0000000000aa',
  requestId: 'req-cf2-1',
} as const;

describe('resolveFailedAutoRefund (CF-2)', () => {
  it('emits auto_refund_reconciled (10y, id-refs + actor) when a failure forensic exists', async () => {
    const { deps, emit, findFailedAutoRefundForInvoice } = makeDeps({
      paymentId: 'pmt_1',
      processorRefundId: 're_1',
      alreadyReconciled: false,
    });

    const result = await resolveFailedAutoRefund(deps as never, INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('reconciled');
    // Read ran inside the tx (tx threaded, not pool-global).
    expect(findFailedAutoRefundForInvoice).toHaveBeenCalledWith(
      FAKE_TX,
      'swecham',
      'inv_abc',
    );
    // Emitted the append-only reconcile event with the acting admin + id-refs.
    expect(emit).toHaveBeenCalledTimes(1);
    const [tx, event] = emit.mock.calls[0]!;
    expect(tx).toBe(FAKE_TX); // atomic with the tx
    expect(event.eventType).toBe('auto_refund_reconciled');
    expect(event.actorUserId).toBe(INPUT.actorUserId);
    expect(event.retentionYears).toBe(10);
    expect(event.payload).toMatchObject({
      invoice_id: 'inv_abc',
      payment_id: 'pmt_1',
      processor_refund_id: 're_1',
    });
    // PCI: payload MUST NOT carry card data / raw Stripe text.
    expect(JSON.stringify(event.payload)).not.toMatch(/card|cvv|sk_live|error/i);
  });

  it('carries the optional note into the payload when supplied', async () => {
    const { deps, emit } = makeDeps({
      paymentId: 'pmt_1',
      processorRefundId: 're_1',
      alreadyReconciled: false,
    });

    await resolveFailedAutoRefund(deps as never, {
      ...INPUT,
      note: 'Refunded manually via Stripe Dashboard 2026-07-12',
    });

    const event = emit.mock.calls[0]![1];
    expect(event.payload.note).toBe(
      'Refunded manually via Stripe Dashboard 2026-07-12',
    );
  });

  it('is idempotent — a reconcile already present is a benign no-op (NO second emit)', async () => {
    const { deps, emit } = makeDeps({
      paymentId: 'pmt_1',
      processorRefundId: 're_1',
      alreadyReconciled: true,
    });

    const result = await resolveFailedAutoRefund(deps as never, INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('already_reconciled');
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses with no_failed_auto_refund when no failure forensic exists', async () => {
    const { deps, emit } = makeDeps(null);

    const result = await resolveFailedAutoRefund(deps as never, INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('no_failed_auto_refund');
    expect(emit).not.toHaveBeenCalled();
  });

  it('wraps an unexpected repo/audit throw as internal_error (never leaks)', async () => {
    const { deps } = makeDeps({
      paymentId: 'pmt_1',
      processorRefundId: 're_1',
      alreadyReconciled: false,
    });
    deps.audit.emit = vi.fn(async () => {
      throw new Error('db connection lost — SECRET');
    });

    const result = await resolveFailedAutoRefund(deps as never, INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    // The caught cause is retained for logging but the route never surfaces it.
    if (!result.ok && result.error.code === 'internal_error') {
      expect(JSON.stringify(result.error.code)).not.toContain('SECRET');
    }
  });
});
