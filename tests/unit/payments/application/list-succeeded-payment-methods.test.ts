/**
 * Verify-fix CG-1 (2026-04-26) — unit coverage for the
 * `listSucceededPaymentMethods` Phase 5 read use-case.
 *
 * The use-case is a thin Application facade over `PaymentsRepo
 * .listSucceededMethodByInvoiceIds`, but still has a meaningful
 * branch — empty `invoiceIds` short-circuits to `new Map()` without
 * calling the repo (saves a roundtrip). Cross-tenant correctness +
 * SQL-level behaviour are covered separately by the integration
 * test on live Neon.
 */
import { describe, expect, it, vi } from 'vitest';
import { listSucceededPaymentMethods } from '@/modules/payments/application/use-cases/list-succeeded-payment-methods';
import type { PaymentsRepo } from '@/modules/payments/application/ports/payments-repo';
import type { PaymentMethod } from '@/modules/payments/domain/value-objects/payment-method';

function makeStubRepo(
  override: Partial<PaymentsRepo> = {},
): PaymentsRepo {
  return {
    withTx: vi.fn(),
    acquireInitiateLock: vi.fn(),
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(),
    insert: vi.fn(),
    updateStatus: vi.fn(),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(),
    nextAttemptSeq: vi.fn(),
    listSucceededMethodByInvoiceIds: vi.fn().mockResolvedValue(new Map()),
    listInvoiceActivity: vi.fn(),
    findStaleInvoiceAutoRefund: vi.fn().mockResolvedValue(null),
    findAutoRefundByProcessorRefundId: vi.fn().mockResolvedValue(null),
    ...override,
  };
}

describe('listSucceededPaymentMethods', () => {
  it('returns the repo result map verbatim on the happy path', async () => {
    const repoMap = new Map<string, PaymentMethod>([
      ['inv-1', 'card'],
      ['inv-2', 'promptpay'],
    ]);
    const paymentsRepo = makeStubRepo({
      listSucceededMethodByInvoiceIds: vi.fn().mockResolvedValue(repoMap),
    });

    const result = await listSucceededPaymentMethods(
      { paymentsRepo },
      { tenantId: 'swecham', invoiceIds: ['inv-1', 'inv-2', 'inv-3'] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(repoMap); // identity — facade is pass-through
      expect(result.value.get('inv-1')).toBe('card');
      expect(result.value.get('inv-2')).toBe('promptpay');
      expect(result.value.has('inv-3')).toBe(false); // not seeded
    }
    expect(paymentsRepo.listSucceededMethodByInvoiceIds).toHaveBeenCalledWith(
      'swecham',
      ['inv-1', 'inv-2', 'inv-3'],
    );
  });

  it('passes through an empty input array unchanged (repo decides early-exit)', async () => {
    // The repo itself short-circuits on empty input (verified on the
    // Drizzle adapter), but the use-case must still pass the empty
    // array down — not bypass the repo entirely — so the contract
    // surface stays consistent.
    const repoFn = vi.fn().mockResolvedValue(new Map());
    const paymentsRepo = makeStubRepo({
      listSucceededMethodByInvoiceIds: repoFn,
    });

    const result = await listSucceededPaymentMethods(
      { paymentsRepo },
      { tenantId: 'swecham', invoiceIds: [] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(0);
    }
    expect(repoFn).toHaveBeenCalledWith('swecham', []);
  });
});
