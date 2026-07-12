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
    acquireInitiateLock: vi.fn(),
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(),
    insert: vi.fn(),
    updateStatus: vi.fn(),
    markAutoRefunded: vi.fn(),
    attachAutoRefundMarkerIfAbsent: vi.fn(),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(),
    nextAttemptSeq: vi.fn(),
    listSucceededMethodByInvoiceIds: vi.fn(),
    listInvoiceActivity: vi.fn().mockResolvedValue({ payments: [], refunds: [] }),
    findStaleInvoiceAutoRefund: vi.fn().mockResolvedValue(null),
    findFailedAutoRefundForInvoice: vi.fn().mockResolvedValue(null),
    findAutoRefundByProcessorRefundId: vi.fn().mockResolvedValue(null),
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

  // verify-fix C2 + CG-B: catch declares `cause: unknown`, so the
  // wrapper must accept any thrown shape — `Error`, plain string
  // (`ECONNRESET` from postgres-js / node-postgres), and bare
  // `reject()` (Drizzle timeout paths). `expect.assertions(3)` (S1)
  // guards against the `if (!result.ok)` block silently passing if
  // result IS ok.
  it.each([
    ['Error instance', new Error('Postgres connection lost')],
    ['string', 'ECONNRESET'],
    ['undefined (bare reject)', undefined],
  ] as const)('wraps a thrown %s into Result.err({kind:"repo_unavailable"})', async (_label, cause) => {
    const paymentsRepo = makeStubRepo({
      listInvoiceActivity: vi.fn().mockRejectedValue(cause),
    });
    const result = await loadInvoicePaymentActivity(
      { paymentsRepo },
      { tenantId: 'swecham', invoiceId: 'inv-1' },
    );
    expect.assertions(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('repo_unavailable');
      expect(result.error.cause).toBe(cause);
    }
  });
});
