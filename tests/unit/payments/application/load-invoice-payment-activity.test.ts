/**
 * Verify-fix CG-2 (2026-04-26) — unit coverage for
 * `loadInvoicePaymentActivity` including the verify-fix C2
 * try/catch branch.
 *
 * Cross-tenant correctness is covered by the integration test
 * (`list-invoice-activity-tenant-isolation.test.ts`); here we only
 * pin the Application-layer contract:
 *   - happy path passes through the repo result
 *   - thrown repo error is wrapped in `Result.err({kind:'repo_unavailable'})`
 *     instead of propagating
 */
import { describe, expect, it, vi } from 'vitest';
import { loadInvoicePaymentActivity } from '@/modules/payments/application/use-cases/load-invoice-payment-activity';
import type { PaymentsRepo } from '@/modules/payments/application/ports/payments-repo';

function makeStubRepo(override: Partial<PaymentsRepo> = {}): PaymentsRepo {
  return {
    withTx: vi.fn(),
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(),
    insert: vi.fn(),
    updateStatus: vi.fn(),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(),
    nextAttemptSeq: vi.fn(),
    listSucceededMethodByInvoiceIds: vi.fn(),
    listInvoiceActivity: vi.fn().mockResolvedValue({ payments: [], refunds: [] }),
    ...override,
  };
}

describe('loadInvoicePaymentActivity', () => {
  it('passes through the repo activity on the happy path', async () => {
    const activity = {
      payments: [],
      refunds: [],
    };
    const paymentsRepo = makeStubRepo({
      listInvoiceActivity: vi.fn().mockResolvedValue(activity),
    });

    const result = await loadInvoicePaymentActivity(
      { paymentsRepo },
      { tenantId: 'swecham', invoiceId: 'inv-1' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(activity);
    }
    expect(paymentsRepo.listInvoiceActivity).toHaveBeenCalledWith(
      'swecham',
      'inv-1',
    );
  });

  it('wraps a thrown repo error into Result.err({kind:"repo_unavailable"}) (verify-fix C2)', async () => {
    const cause = new Error('Postgres connection lost');
    const paymentsRepo = makeStubRepo({
      listInvoiceActivity: vi.fn().mockRejectedValue(cause),
    });

    const result = await loadInvoicePaymentActivity(
      { paymentsRepo },
      { tenantId: 'swecham', invoiceId: 'inv-1' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('repo_unavailable');
      expect(result.error.cause).toBe(cause);
    }
  });
});
