/**
 * T011 — F4 barrel export surface contract test.
 *
 * Asserts the public surface of `src/modules/invoicing/index.ts` includes:
 *   - 3 new F5 bridge use-cases (markPaidFromProcessor, issueCreditNoteFromRefund,
 *     getInvoiceForPayment) exposed at Application layer
 *   - Money VO re-exported as `AmountSatang` alias for F5 consumer semantics
 *   - Existing F4 surface UNCHANGED (spot-check recordPayment, issueCreditNote,
 *     Money, Invoice type)
 *
 * TDD discipline (Constitution Principle II NON-NEGOTIABLE): this test is
 * authored RED before T010/T012/T013/T014 land; once the barrel + 3 wrapper
 * files exist the surface assertion goes GREEN.
 */
import { describe, expect, it } from 'vitest';

describe('F4 barrel — F5 bridge export surface (T010–T014)', () => {
  // See tests/unit/payments/index-barrel.test.ts for the rationale —
  // same dynamic-import alias-resolution pattern, same parallel-load
  // flake profile. 30s ceiling under CPU contention; isolated run ~1.8s.
  it('re-exports the 3 F5 bridge use-cases + Money aliased as AmountSatang', { timeout: 30_000 }, async () => {
    const mod = await import('@/modules/invoicing');

    // F5 bridge use-cases (T012, T013, T014)
    expect(typeof mod.markPaidFromProcessor).toBe('function');
    expect(typeof mod.issueCreditNoteFromRefund).toBe('function');
    expect(typeof mod.getInvoiceForPayment).toBe('function');

    // Money VO aliased as AmountSatang for F5 semantic naming (T010)
    // — the alias points at the same class; F5 consumers use the
    // satang-centric name without altering F4 domain vocabulary.
    expect(mod.AmountSatang).toBeDefined();
    expect(mod.AmountSatang).toBe(mod.Money);
  });

  it('preserves the existing F4 public surface (no regression)', async () => {
    const mod = await import('@/modules/invoicing');

    // Spot-check a handful of existing F4 exports to guard against
    // accidental removal during the barrel edit.
    expect(typeof mod.recordPayment).toBe('function');
    expect(typeof mod.issueCreditNote).toBe('function');
    expect(typeof mod.issueInvoice).toBe('function');
    expect(typeof mod.voidInvoice).toBe('function');
    expect(typeof mod.listInvoices).toBe('function');
    expect(typeof mod.getInvoice).toBe('function');
    expect(typeof mod.makeRecordPaymentDeps).toBe('function');
    expect(typeof mod.makeIssueCreditNoteDeps).toBe('function');
    expect(mod.Money).toBeDefined();
  });
});
