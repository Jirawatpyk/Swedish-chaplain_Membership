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
  // B.1 review Minor#1 — `getInvoiceCreditedTotal` wraps F4's `getInvoice`;
  // mocked so the throw-path (Neon down) can be exercised.
  getInvoice: vi.fn(),
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
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

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
    await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

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
    await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

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
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

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
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

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
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

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
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('legacy_no_tin_event_not_payable');
    }
  });

  // 088 SEC-MED — new-flow bill paid after a flag rollback. The bridge carries
  // the F4 discriminator VERBATIM (not collapsed into `not_payable`) so the
  // initiate warn log + route `useCaseErrorCode` keep the flag-rollback pointer.
  it('F4 new_flow_bill_requires_flag_on propagates verbatim (088 SEC-MED)', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      err({ code: 'new_flow_bill_requires_flag_on' as const }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({ tenantId, invoiceId, taxAtPayment: 'off', reconciliationPath: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('new_flow_bill_requires_flag_on');
    }
  });
});

// B.1 review Minor#1 — `getInvoiceCreditedTotal` must return a graceful typed
// `read_failed` when F4's `getInvoice` THROWS (e.g. Neon down / tx aborted /
// externalTx tenant-mismatch guard), so the refund pre-flight gets a 502
// (`f4_preflight_read_error`) instead of the exception escaping Phase A →
// rollback → a raw 500. Money-safe either way (Stripe never called), but this
// pins the intended code + observability.
describe('invoicingBridge.getInvoiceCreditedTotal — Minor#1 graceful read-throw', () => {
  let metricsSpy: ReturnType<typeof vi.spyOn>;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    metricsSpy = vi.spyOn(paymentsMetrics, 'f4BridgeUnknownErrorShape');
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    f4Mock.getInvoice.mockReset();
  });

  afterEach(() => {
    metricsSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  it('returns Result.err({code:"read_failed"}) when F4 getInvoice THROWS (Neon down)', async () => {
    f4Mock.getInvoice.mockRejectedValueOnce(new Error('neon connection reset'));

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceCreditedTotal({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('read_failed');
    }
    // Observability: dedicated counter + structured error log (no PII / no raw
    // error message — only the constructor name).
    expect(metricsSpy).toHaveBeenCalledWith('getInvoiceCreditedTotal_read_threw');
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
    expect(msg).toBe('invoicing-bridge.getInvoiceCreditedTotal_read_threw');
    const c = ctx as Record<string, unknown>;
    expect(c['tenantId']).toBe(tenantId);
    expect(c['invoiceId']).toBe(invoiceId);
    expect(c['errKind']).toBe('Error');
  });

  it('threads externalTx into makeGetInvoiceDeps (Fix#2 — shared connection)', async () => {
    // A sentinel tx object stands in for the F5 Phase A tx. The bridge must
    // forward it to `makeGetInvoiceDeps(tenantId, externalTx)` so F4's read
    // runs on the SAME connection (no nested `runInTenant`).
    const sentinelTx = Symbol('phase-a-tx');
    f4Mock.getInvoice.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        total: { satang: 107_000n },
        creditedTotal: { satang: 53_500n },
      }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceCreditedTotal({
      tenantId,
      invoiceId,
      externalTx: sentinelTx,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalSatang).toBe(107_000n);
      expect(result.value.creditedTotalSatang).toBe(53_500n);
    }
    // The tx is threaded as the 2nd arg of makeGetInvoiceDeps.
    expect(f4Mock.makeGetInvoiceDeps).toHaveBeenCalledWith(tenantId, sentinelTx);
  });
});

// B.2 (tax#5) — `getInvoiceStatus` wraps F4's `getInvoice` and returns the
// invoice's AUTHORITATIVE post-CN status, narrowed to the credited pair. A
// non-credited status (data anomaly) OR a read throw surfaces a typed error so
// the finaliser falls back to its payment-derived projection rather than
// propagate a wrong tax status.
describe('invoicingBridge.getInvoiceStatus — F4-authoritative status read', () => {
  let metricsSpy: ReturnType<typeof vi.spyOn>;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    metricsSpy = vi.spyOn(paymentsMetrics, 'f4BridgeUnknownErrorShape');
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    f4Mock.getInvoice.mockReset();
    f4Mock.makeGetInvoiceDeps.mockClear();
  });

  afterEach(() => {
    metricsSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  it.each(['credited', 'partially_credited'] as const)(
    'returns ok(%s) when F4 reports that credited status',
    async (status) => {
      f4Mock.getInvoice.mockResolvedValueOnce(ok({ id: invoiceId, status }));

      const bridge = await loadBridge();
      const result = await bridge.getInvoiceStatus({ tenantId, invoiceId });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(status);
    },
  );

  it('threads externalTx into makeGetInvoiceDeps (shared connection — B.1 lesson)', async () => {
    const sentinelTx = Symbol('finalize-tx');
    f4Mock.getInvoice.mockResolvedValueOnce(
      ok({ id: invoiceId, status: 'credited' }),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceStatus({
      tenantId,
      invoiceId,
      externalTx: sentinelTx,
    });

    expect(result.ok).toBe(true);
    expect(f4Mock.makeGetInvoiceDeps).toHaveBeenCalledWith(tenantId, sentinelTx);
  });

  it('returns err({code:"not_found"}) when F4 getInvoice returns not_found', async () => {
    f4Mock.getInvoice.mockResolvedValueOnce(err({ code: 'not_found' }));

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceStatus({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('returns err({code:"unexpected_status"}) + logs when F4 status is not a credited state', async () => {
    // Post-CN F4 is always credited/partially_credited; a `paid` here is a data
    // anomaly the caller must NOT report as a tax status.
    f4Mock.getInvoice.mockResolvedValueOnce(ok({ id: invoiceId, status: 'paid' }));

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceStatus({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unexpected_status');
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
    expect(msg).toBe('invoicing-bridge.getInvoiceStatus_unexpected');
    expect((ctx as Record<string, unknown>)['status']).toBe('paid');
  });

  it('returns err({code:"read_failed"}) + counter + log when F4 getInvoice THROWS', async () => {
    f4Mock.getInvoice.mockRejectedValueOnce(new Error('neon connection reset'));

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceStatus({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('read_failed');
    expect(metricsSpy).toHaveBeenCalledWith('getInvoiceStatus_read_threw');
    const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
    expect(msg).toBe('invoicing-bridge.getInvoiceStatus_read_threw');
    expect((ctx as Record<string, unknown>)['errKind']).toBe('Error');
  });
});

// LOCK (a) — the bridge MUST forward BOTH orthogonal axes (the 2-state flow flag
// AND the reconciliation bit) verbatim into F4's getInvoiceForPayment. If a future
// refactor drops either forward, the F4 stranded-funds guard silently re-arms or
// disarms (a money-path regression). These tests fail on a dropped forward.
describe('invoicingBridge.getInvoiceForPayment — LOCK (a): forwards BOTH axes into F4', () => {
  beforeEach(() => f4Mock.getInvoiceForPayment.mockReset());

  it('initiate read: forwards { taxAtPayment: "on", reconciliationPath: false } verbatim', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({ id: invoiceId, status: 'issued', totalSatang: 535_000n, memberId, tenantId }),
    );
    const bridge = await loadBridge();
    await bridge.getInvoiceForPayment({
      tenantId,
      invoiceId,
      taxAtPayment: 'on',
      reconciliationPath: false,
    });
    expect(f4Mock.getInvoiceForPayment).toHaveBeenCalledTimes(1);
    // Bridge calls f4GetInvoiceForPayment(deps, input) — assert the INPUT (2nd arg).
    const [, f4Input] = f4Mock.getInvoiceForPayment.mock.calls[0]!;
    expect(f4Input).toMatchObject({
      tenantId,
      invoiceId,
      taxAtPayment: 'on',
      reconciliationPath: false,
    });
  });

  it('webhook reconciliation read: forwards { taxAtPayment: "off", reconciliationPath: true } verbatim', async () => {
    f4Mock.getInvoiceForPayment.mockResolvedValueOnce(
      ok({ id: invoiceId, status: 'issued', totalSatang: 535_000n, memberId, tenantId }),
    );
    const bridge = await loadBridge();
    await bridge.getInvoiceForPayment({
      tenantId,
      invoiceId,
      taxAtPayment: 'off',
      reconciliationPath: true,
    });
    const [, f4Input] = f4Mock.getInvoiceForPayment.mock.calls[0]!;
    expect(f4Input).toMatchObject({ taxAtPayment: 'off', reconciliationPath: true });
  });
});
