/**
 * F5R3v3 M-7 (2026-05-16) — F5→F4 invoicing-bridge unit tests.
 *
 * Pre-fix R3v3 review flagged that the H-1 rewrite (typed
 * `corrupted_total` err in place of silent zero-clamp) had no unit
 * coverage — the path is exercised at integration level by the
 * happy + atomicity scenarios in invoicing-bridge-atomicity.test.ts
 * but neither asserts the rewrite behavior. A future refactor could
 * collapse the try/catch and no test would fail.
 *
 * This file mocks `@/modules/invoicing` so the bridge sees a F4 DTO
 * with a negative `totalSatang` (the data-corruption class the H-1
 * fix exists for). Asserts:
 *   - bridge.getInvoiceForPayment returns Result.err({code:'corrupted_total', invoiceId})
 *   - paymentsMetrics.f4BridgeUnknownErrorShape('f4_invoice_total_negative') fires
 *   - logger.error fires with full triage context
 *
 * No DB, no HTTP, no Stripe — pure unit on the bridge composition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { paymentsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';

const tenantId = '00000000-0000-0000-0000-000000000001';
const invoiceId = '11111111-1111-1111-1111-111111111111';
const memberId = '22222222-2222-2222-2222-222222222222';

// Mock the F4 barrel — return a negative totalSatang so the bridge's
// asSatang call throws. Use top-level vi.hoisted so the mock factory
// is hoisted alongside the import.
const f4Mock = vi.hoisted(() => ({
  getInvoiceForPayment: vi.fn(),
  markPaidFromProcessor: vi.fn(),
  issueCreditNoteFromRefund: vi.fn(),
  makeGetInvoiceDeps: vi.fn(() => ({})),
}));

vi.mock('@/modules/invoicing', () => f4Mock);

// Import AFTER vi.mock so the bridge sees the mock.
async function loadBridge() {
  const mod = await import('@/modules/payments/infrastructure/invoicing-bridge');
  return mod.invoicingBridge;
}

describe('invoicingBridge.getInvoiceForPayment — H-1 corrupted_total path', () => {
  let metricsSpy: ReturnType<typeof vi.spyOn>;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    metricsSpy = vi.spyOn(paymentsMetrics, 'f4BridgeUnknownErrorShape');
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    f4Mock.getInvoiceForPayment.mockReset();
  });

  afterEach(() => {
    metricsSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  it('returns Result.err({code:"corrupted_total"}) when F4 returns negative totalSatang', async () => {
    // F4 happily returns a DTO with totalSatang = -100n. This could
    // happen via dropped DB CHECK constraint, OOB SQL admin write,
    // or a future F4 bug. The bridge MUST refuse to forward this
    // upstream — fabricating `asSatang(0n)` would let initiate-payment
    // call Stripe with amount=0n → retry storm + misleading audit.
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        status: 'issued',
        totalSatang: -100n,
        memberId,
        tenantId,
      }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('corrupted_total');
      if (result.error.code === 'corrupted_total') {
        expect(result.error.invoiceId).toBe(invoiceId);
      }
    }
  });

  it('fires paymentsMetrics.f4BridgeUnknownErrorShape with the right label', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        status: 'overdue',
        totalSatang: -1n,
        memberId,
        tenantId,
      }),
    );

    const bridge = await loadBridge();
    await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(metricsSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledWith('f4_invoice_total_negative');
  });

  it('fires logger.error with full triage context', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        status: 'issued',
        totalSatang: -42n,
        memberId,
        tenantId,
      }),
    );

    const bridge = await loadBridge();
    await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
    expect(msg).toBe('invoicing-bridge.f4_invoice_total_brand_failed');
    const c = ctx as Record<string, unknown>;
    expect(c['tenantId']).toBe(tenantId);
    expect(c['invoiceId']).toBe(invoiceId);
    expect(c['rawTotalSatang']).toBe('-42');
    expect(c['errKind']).toBe('RangeError');
  });

  it('happy path (positive totalSatang) returns Result.ok with branded value', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        status: 'issued',
        totalSatang: 535_000n,
        memberId,
        tenantId,
      }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalSatang).toBe(535_000n);
      expect(result.value.status).toBe('issued');
    }
    // No metric / error log on happy path.
    expect(metricsSpy).not.toHaveBeenCalled();
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('zero totalSatang passes through (asSatang accepts 0n)', async () => {
    // Edge case — `totalSatang: 0n` is valid per asSatang's "minimum
    // non-negative" contract. F4 already rejects 0-total invoices at
    // `getInvoiceForPayment` (see F4 not_payable branch), so this is
    // defence-in-depth: even if F4 surfaces 0n, the brand check
    // accepts it and the use-case's `invoice.status === 'paid'` gate
    // (or other validators) decides if the row is actually payable.
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        status: 'issued',
        totalSatang: 0n,
        memberId,
        tenantId,
      }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalSatang).toBe(0n);
    }
    expect(metricsSpy).not.toHaveBeenCalled();
  });

  it('F4 not_payable error propagates as bridge not_payable error', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      err({ code: 'not_payable', status: 'paid' as const }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'not_payable') {
      expect(result.error.status).toBe('paid');
    }
  });

  // REMOVE-WITH-064-REMEDIATION — S0 money-trap guard. The F4 payability
  // read rejects LEGACY issued no-TIN event invoices; the bridge must
  // carry the discriminator VERBATIM (not collapse to `not_payable`) so
  // initiate-payment's warn log + the route's `useCaseErrorCode` keep the
  // remediation-runbook pointer. Delete with the master checklist in
  // record-payment.ts.
  it('F4 legacy_no_tin_event_not_payable propagates verbatim (REMOVE-WITH-064-REMEDIATION)', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      err({ code: 'legacy_no_tin_event_not_payable' as const }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('legacy_no_tin_event_not_payable');
    }
  });
});
