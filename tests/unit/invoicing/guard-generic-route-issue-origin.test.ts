/**
 * 107-auto-invoice Task 10 — unit tests for `guardGenericRouteIssueOrigin`.
 *
 * Pure branch coverage on the guard's own decision (100% branch — this is
 * the paired ship gate closing Task 9's duplicate-§86/4 barrier bypass; the
 * ROUTE's HTTP-shape contract is pinned separately in
 * tests/contract/issue-route-auto-renewal-refusal.contract.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { guardGenericRouteIssueOrigin } from '@/modules/invoicing';
import type { InvoiceRepo } from '@/modules/invoicing/application/ports/invoice-repo';

function mockRepo(getOrigin: InvoiceRepo['getOrigin']): InvoiceRepo {
  return { getOrigin } as InvoiceRepo;
}

const TENANT = 'test-swecham-abcd1234';
const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440077';

describe('guardGenericRouteIssueOrigin (107-auto-invoice Task 10)', () => {
  it('refuses an auto_renewal draft with the typed code', async () => {
    const getOrigin = vi.fn().mockResolvedValue('auto_renewal');
    const result = await guardGenericRouteIssueOrigin(
      { invoiceRepo: mockRepo(getOrigin) },
      { tenantId: TENANT, invoiceId: INVOICE_ID },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'origin_auto_renewal_use_queue' },
    });
    expect(getOrigin).toHaveBeenCalledWith(INVOICE_ID, TENANT);
  });

  it('passes a manual draft through', async () => {
    const getOrigin = vi.fn().mockResolvedValue('manual');
    const result = await guardGenericRouteIssueOrigin(
      { invoiceRepo: mockRepo(getOrigin) },
      { tenantId: TENANT, invoiceId: INVOICE_ID },
    );
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('passes a not-found id through — issueInvoice owns that error + its cross-tenant-probe audit', async () => {
    const getOrigin = vi.fn().mockResolvedValue(null);
    const result = await guardGenericRouteIssueOrigin(
      { invoiceRepo: mockRepo(getOrigin) },
      { tenantId: TENANT, invoiceId: INVOICE_ID },
    );
    expect(result).toEqual({ ok: true, value: undefined });
  });
});
