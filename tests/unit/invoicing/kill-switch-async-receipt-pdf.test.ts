/**
 * R1-IG-1 — kill-switch env→deps wiring test for T166-13
 * (FEATURE_F5_ASYNC_RECEIPT_PDF).
 *
 * Pins the env-var → deps boolean read so a regression in
 * `makeRecordPaymentDeps` (e.g. dropped reference, wrong key, default
 * inversion) is caught at unit-test speed instead of during a prod
 * incident.
 *
 * The other unit tests in `record-payment-async-pdf.test.ts` exercise
 * the BEHAVIOUR of the flag by passing `asyncReceiptPdf` directly via
 * a hand-rolled deps object — they don't cover whether the env var
 * actually flows to that boolean. This file does.
 */
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';

describe('R1-IG-1 — FEATURE_F5_ASYNC_RECEIPT_PDF env→deps wiring', () => {
  it('makeRecordPaymentDeps surfaces env.features.f5AsyncReceiptPdf as deps.asyncReceiptPdf', () => {
    const deps = makeRecordPaymentDeps('test-tenant');
    expect(deps.asyncReceiptPdf).toBe(env.features.f5AsyncReceiptPdf);
  });

  it('env.features.f5AsyncReceiptPdf is a boolean (not a string from raw env)', () => {
    // Defensive: catches a regression where the zod parser stops
    // coercing the string env var to bool.
    expect(typeof env.features.f5AsyncReceiptPdf).toBe('boolean');
  });

  it('makeRecordPaymentDeps wires receiptPdfRenderEnqueue port (regardless of flag)', () => {
    // Worker enqueue port MUST always be wired; it's the flag value
    // alone that decides whether to call it. If the port were missing,
    // turning the flag on at runtime would crash record-payment.
    const deps = makeRecordPaymentDeps('test-tenant');
    expect(deps.receiptPdfRenderEnqueue).toBeDefined();
    expect(typeof deps.receiptPdfRenderEnqueue!.enqueue).toBe('function');
  });
});
