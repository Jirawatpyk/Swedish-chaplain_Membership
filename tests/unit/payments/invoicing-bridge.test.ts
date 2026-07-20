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

// F-4 (money-remediation Task 7) — the bridge now also derives §105
// creditability, so it imports `inferEventDocumentKind` +
// `resolveBuyerIsVatRegistrant` from this same barrel. A mock factory that
// omits them makes both `undefined`, and the bridge's call throws into its own
// catch — surfacing as a bogus `invalid_total` rather than a missing-export
// error. (That is exactly how this file failed when the fields were added.)
//
// They are wired to their REAL implementations, not stubs: the whole point of
// the derivation is that the pre-flight and F4's own credit gate share ONE
// discriminator, so a stub here would test the opposite of the invariant.
// Safe to import for real — `document-kind.ts` is pure Domain (Principle III:
// zero framework/ORM imports), so it drags in no DB or server-only module.
//
// I1 (Task 7 remediation) — they are wrapped in spies that DELEGATE to the real
// implementations rather than being passed through bare. The default behaviour
// is unchanged (still the real discriminator, so the lockstep invariant above
// still holds); the wrapper exists only so a test can inject a throw and prove
// the derivation's catch is distinguishable from the brand catch.
const docKindSpies = vi.hoisted(() => ({
  inferEventDocumentKind: vi.fn(),
  resolveBuyerIsVatRegistrant: vi.fn(),
}));

vi.mock('@/modules/invoicing', async () => {
  const docKind = await vi.importActual<
    typeof import('@/modules/invoicing/domain/document-kind')
  >('@/modules/invoicing/domain/document-kind');
  docKindSpies.inferEventDocumentKind.mockImplementation(
    docKind.inferEventDocumentKind,
  );
  docKindSpies.resolveBuyerIsVatRegistrant.mockImplementation(
    docKind.resolveBuyerIsVatRegistrant,
  );
  return {
    ...f4Mock,
    inferEventDocumentKind: docKindSpies.inferEventDocumentKind,
    resolveBuyerIsVatRegistrant: docKindSpies.resolveBuyerIsVatRegistrant,
  };
});

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
    expect(c['err']).toBe('RangeError');
  });

  it('I3: threads externalTx into makeGetInvoiceDeps (the third and last F4 read)', async () => {
    // The threading itself shipped with ZERO pinning: deleting `externalTx: tx`
    // in confirm-payment, or the second argument here, made nothing go red.
    // The un-threaded form works fine whenever the pool has a spare connection
    // — which is exactly why it survived review twice before. Under pool
    // pressure it self-deadlocks: `getInvoiceForPayment` opens a SECOND pooled
    // connection while confirm-payment's Phase-A tx still holds `FOR UPDATE`
    // on the payment row, and Stripe-captured payments stop being marked paid.
    // Same class as B.1 Fix#2, already fixed twice on the sibling reads; this
    // is the third, and the pattern for the other two already exists in this
    // file.
    const sentinelTx = Symbol('phase-a-tx');
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
    await bridge.getInvoiceForPayment({
      tenantId,
      invoiceId,
      taxAtPayment: 'off',
      reconciliationPath: true,
      externalTx: sentinelTx,
    });

    expect(f4Mock.makeGetInvoiceDeps).toHaveBeenCalledWith(tenantId, sentinelTx);
  });

  it('I3: the self-pay initiate path passes no tx (F4 opens its own)', async () => {
    // The counterpart assertion. `initiate-payment` is NOT inside a tx, so the
    // bridge must forward `undefined` and let `makeGetInvoiceDeps` open its own
    // tenant-bound transaction. Pinning both directions is what stops someone
    // "simplifying" the optional parameter away in either direction.
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
    await bridge.getInvoiceForPayment({
      tenantId,
      invoiceId,
      taxAtPayment: 'off',
      reconciliationPath: false,
    });

    expect(f4Mock.makeGetInvoiceDeps).toHaveBeenCalledWith(tenantId, undefined);
  });

  it('I4: returns read_failed (not a throw) when the F4 read throws', async () => {
    // Threading `externalTx` armed the invoice repo's tenant-mismatch guard,
    // which is a raw `throw new Error`. The webhook caller runs this inside its
    // Phase-A `withTx`, so an escaping throw aborted the tx and surfaced as an
    // unhandled 500 with no metric and no bounded log line.
    f4Mock.getInvoiceForPayment.mockRejectedValueOnce(
      new Error('tenant mismatch: expected acme, got other'),
    );

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceForPayment({
      tenantId,
      invoiceId,
      taxAtPayment: 'off',
      reconciliationPath: true,
      externalTx: Symbol('phase-a-tx'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('read_failed');
    expect(metricsSpy).toHaveBeenCalledWith('getInvoiceForPayment_read_threw');

    const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
    expect(msg).toBe('invoicing-bridge.getInvoiceForPayment_read_threw');
    const c = ctx as Record<string, unknown>;
    // Bounded discriminators that say WHICH caller shape hit it, and no more.
    expect(c['reconciliationPath']).toBe(true);
    expect(c['hasExternalTx']).toBe(true);
    expect(c['err']).toBe('Error');
    // Never the raw message — it carries the tenant slugs.
    expect(JSON.stringify(ctx)).not.toContain('tenant mismatch');
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
    // Log hygiene: the canonical shape is `err: errKind(e)` (src/lib/log-id.ts),
    // not a hand-rolled `errKind:` field.
    expect(c['err']).toBe('Error');
  });

  it('I1: a derivation throw is credit_gate_underivable, NOT invalid_total', async () => {
    // THE BUG THIS PINS. Before the fix, deriving the §105/receipt axes sat
    // inside the SAME try as the two `asSatang` brand calls. Its catch bumped
    // `…_brand_failed`, logged only satang values, and returned
    // `invalid_total` — which `issue-refund` maps to `f4_preflight_read_error`
    // and the route renders as a RETRYABLE 502 saying the refundable BALANCE
    // could not be read. So a document-kind fault was reported to the admin as
    // a transient money-read failure and to SRE as money corruption, with
    // nothing in the log that could identify it.
    //
    // Not hypothetical: the mock-factory comment at the top of this file
    // records this file failing exactly that way when the gate fields landed.
    // "The resolver is pure and total so it cannot throw" is the reasoning
    // that produced it — a call site throws when the BINDING is undefined
    // (dropped barrel export, circular-import TDZ, mock omission), which no
    // function body controls.
    f4Mock.getInvoice.mockResolvedValueOnce(
      ok({
        id: invoiceId,
        total: { satang: 107_000n },
        creditedTotal: { satang: 0n },
        status: 'paid',
        invoiceSubject: 'event',
        memberId,
        memberIdentitySnapshot: { buyer_is_vat_registrant: true },
        receiptPdfStatus: 'rendered',
      }),
    );
    docKindSpies.inferEventDocumentKind.mockImplementationOnce(() => {
      throw new TypeError('inferEventDocumentKind is not a function');
    });

    const bridge = await loadBridge();
    const result = await bridge.getInvoiceCreditedTotal({ tenantId, invoiceId });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('credit_gate_underivable');
      // The money is fine. Saying otherwise sends on-call after a Money VO bug.
      expect(result.error.code).not.toBe('invalid_total');
    }
    expect(metricsSpy).toHaveBeenCalledWith(
      'getInvoiceCreditedTotal_credit_gate_underivable',
    );
    expect(metricsSpy).not.toHaveBeenCalledWith(
      'getInvoiceCreditedTotal_brand_failed',
    );

    const [ctx, msg] = loggerErrorSpy.mock.calls[0]!;
    expect(msg).toBe(
      'invoicing-bridge.getInvoiceCreditedTotal_credit_gate_underivable',
    );
    const c = ctx as Record<string, unknown>;
    // Fields that actually identify the fault…
    expect(c['invoiceSubject']).toBe('event');
    expect(c['hasIdentitySnapshot']).toBe(true);
    expect(c['hasMemberId']).toBe(true);
    expect(c['receiptPdfStatus']).toBe('rendered');
    expect(c['err']).toBe('TypeError');
    // …and NOT the satang values, which are irrelevant here and were the only
    // thing the old shared catch logged.
    expect(c['rawTotalSatang']).toBeUndefined();
    expect(c['rawCreditedTotalSatang']).toBeUndefined();
    // LOG HYGIENE: the snapshot holds the buyer's name, address and TIN.
    // Presence is the whole diagnostic; the object must never be logged.
    expect(c['memberIdentitySnapshot']).toBeUndefined();
    expect(c['memberId']).toBeUndefined();
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

  // F-4 (money-remediation Task 7) — the three new axes are DERIVED here, off
  // the invoice already in hand. The §105 axis in particular cannot be reached
  // from the payments integration suite without seeding a full F6 event +
  // event_registration (the `invoices_subject_fields_ck` CHECK requires both),
  // so this is where that derivation is pinned.
  const derivationCases = [
    {
      name: 'membership invoice → creditable (§86/4 tax invoice)',
      invoice: {
        invoiceSubject: 'membership',
        memberId,
        memberIdentitySnapshot: { tax_id: '1234567890123', buyer_is_vat_registrant: true },
        receiptPdfStatus: 'rendered',
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'rendered', status: 'paid' },
    },
    {
      name: 'event invoice, NON-registrant buyer → NOT creditable (§105 receipt)',
      invoice: {
        invoiceSubject: 'event',
        memberId,
        // A passport number in `tax_id` must NOT read as VAT-registrant — the
        // gate keys on the recorded registrant flag, never on TIN presence.
        memberIdentitySnapshot: { tax_id: 'AA1234567', buyer_is_vat_registrant: false },
        receiptPdfStatus: 'rendered',
        status: 'paid',
      },
      expected: { creditable: false, receiptRenderState: 'rendered', status: 'paid' },
    },
    {
      name: 'event invoice, VAT-registrant buyer → creditable',
      invoice: {
        invoiceSubject: 'event',
        memberId,
        memberIdentitySnapshot: { tax_id: '1234567890123', buyer_is_vat_registrant: true },
        receiptPdfStatus: 'rendered',
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'rendered', status: 'paid' },
    },
    {
      // C2 — TRANSIENT. The reconcile cron's scan matches `pending` rows older
      // than the stuck interval, so this genuinely clears itself.
      name: 'receipt PDF pending → rendering (transient)',
      invoice: {
        invoiceSubject: 'membership',
        memberId,
        memberIdentitySnapshot: { tax_id: '1234567890123', buyer_is_vat_registrant: true },
        receiptPdfStatus: 'pending',
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'rendering', status: 'paid' },
    },
    {
      // C2 — NOT transient, deliberately. The reconcile cron RESETS
      // `receipt_pdf_render_attempts` to 0 on every re-enqueue, so no column
      // on the row distinguishes "the cron will retry this" from "the cron
      // gave up and paged". Classified as operator-action on the asymmetry: a
      // false "escalate" costs a self-resolving ticket, a false "wait a few
      // minutes" costs the member their refund indefinitely.
      name: 'receipt PDF failed → unrendered (operator action, NOT "wait")',
      invoice: {
        invoiceSubject: 'membership',
        memberId,
        memberIdentitySnapshot: { tax_id: '1234567890123', buyer_is_vat_registrant: true },
        receiptPdfStatus: 'failed',
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'unrendered', status: 'paid' },
    },
    {
      // C2 + I2 — the input that gave a silently wrong answer before. NULL is
      // matched by NEITHER arm of the reconcile cron's scan predicate
      // (`= 'failed'` OR `= 'pending' AND stuck`), because SQL NULL compares
      // equal to nothing. So a null-status row is swept by nobody, ever, and
      // telling the admin to wait a few minutes is simply false.
      name: 'receipt PDF status NULL → unrendered (cron never sweeps NULL)',
      invoice: {
        invoiceSubject: 'membership',
        memberId,
        memberIdentitySnapshot: { tax_id: '1234567890123', buyer_is_vat_registrant: true },
        receiptPdfStatus: null,
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'unrendered', status: 'paid' },
    },
    {
      // I2 / 066 relax — THE case with live production rows behind it. A
      // membership invoice is a valid §86/4 regardless of the buyer's
      // registrant status, so it stays creditable. Production holds 11 such
      // invoices; the wrong buyer-side §86/10 rationale, if ever acted on,
      // would break exactly these.
      name: 'membership invoice, NON-registrant buyer → still creditable (066 relax)',
      invoice: {
        invoiceSubject: 'membership',
        memberId,
        memberIdentitySnapshot: { tax_id: null, buyer_is_vat_registrant: false },
        receiptPdfStatus: 'rendered',
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'rendered', status: 'paid' },
    },
    {
      // I2 — the walk-in arm. `resolveBuyerIsVatRegistrant` falls back to TIN
      // presence when `memberId` is null; every case above passes a non-null
      // memberId, so this branch was unexercised here.
      name: 'walk-in (memberId null) event invoice WITH a TIN → creditable',
      invoice: {
        invoiceSubject: 'event',
        memberId: null,
        memberIdentitySnapshot: { tax_id: '1234567890123' },
        receiptPdfStatus: 'rendered',
        status: 'paid',
      },
      expected: { creditable: true, receiptRenderState: 'rendered', status: 'paid' },
    },
    {
      name: 'walk-in (memberId null) event invoice with NO TIN → not creditable',
      invoice: {
        invoiceSubject: 'event',
        memberId: null,
        memberIdentitySnapshot: { tax_id: null },
        receiptPdfStatus: 'rendered',
        status: 'paid',
      },
      expected: { creditable: false, receiptRenderState: 'rendered', status: 'paid' },
    },
    {
      name: 'voided invoice → status surfaced verbatim',
      invoice: {
        invoiceSubject: 'membership',
        memberId,
        memberIdentitySnapshot: { tax_id: '1234567890123', buyer_is_vat_registrant: true },
        receiptPdfStatus: 'rendered',
        status: 'void',
      },
      expected: { creditable: true, receiptRenderState: 'rendered', status: 'void' },
    },
  ];

  for (const c of derivationCases) {
    it(`F-4 derivation — ${c.name}`, async () => {
      f4Mock.getInvoice.mockResolvedValueOnce(
        ok({
          id: invoiceId,
          total: { satang: 107_000n },
          creditedTotal: { satang: 0n },
          ...c.invoice,
        }),
      );

      const bridge = await loadBridge();
      const result = await bridge.getInvoiceCreditedTotal({ tenantId, invoiceId });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.creditable).toBe(c.expected.creditable);
        expect(result.value.receiptRenderState).toBe(c.expected.receiptRenderState);
        expect(result.value.status).toBe(c.expected.status);
      }
    });
  }
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
    expect((ctx as Record<string, unknown>)['err']).toBe('Error');
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
