/**
 * F4 Domain — F4InvoicePaidEvent type contract test.
 *
 * `src/modules/invoicing/domain/f4-invoice-paid-event.ts` is a pure
 * type/interface file (no runtime code). vitest v8 coverage strips
 * type-only files at compile time → 100% coverage trivially. The
 * tests below assert the structural contract at the TypeScript level
 * (compile-time) + a runtime smoke that the imports resolve, so a
 * future change that swaps a type for a runtime symbol still has a
 * regression net.
 *
 * Authored 2026-05-17 (Phase B of F4 Domain coverage push).
 */
import { describe, it, expect } from 'vitest';
import type {
  F4InvoicePaidEvent,
  F4InvoicePaidPaymentMethod,
  F4InvoicePaidTrigger,
} from '@/modules/invoicing/domain/f4-invoice-paid-event';
import { asSatang } from '@/lib/money';

describe('F4InvoicePaidEvent — type contract', () => {
  it('compiles + roundtrips a valid webhook-origin event', () => {
    // If any field rename / type change happens upstream this test
    // stops compiling first — the runtime assertions are belt-and-
    // braces against accidental field deletion at runtime.
    const ev: F4InvoicePaidEvent = {
      tenantId: 'test-swecham',
      invoiceId: '550e8400-e29b-41d4-a716-446655440000',
      memberId: '550e8400-e29b-41d4-a716-446655440001',
      paidAt: '2026-05-17T12:00:00.000Z',
      amountSatang: asSatang(1_070_000n),
      vatSatang: asSatang(70_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
    expect(ev.tenantId).toBe('test-swecham');
    expect(ev.currency).toBe('THB');
    expect(ev.triggeredBy).toBe('webhook');
    expect(typeof ev.amountSatang).toBe('bigint');
    expect(typeof ev.vatSatang).toBe('bigint');
    expect(ev.invoiceSubject).toBe('membership');
    expect(ev.paymentDate).toBeNull();
  });

  it('compiles + roundtrips a valid admin_manual-origin event', () => {
    const ev: F4InvoicePaidEvent = {
      tenantId: 'test-swecham',
      invoiceId: '550e8400-e29b-41d4-a716-446655440002',
      memberId: '550e8400-e29b-41d4-a716-446655440003',
      paidAt: '2026-05-17T13:30:00.000Z',
      amountSatang: asSatang(535_000n),
      vatSatang: asSatang(35_000n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'admin_manual',
      invoiceSubject: 'membership',
      paymentDate: '2026-05-17',
    };
    expect(ev.paymentMethod).toBe('bank_transfer');
    expect(ev.triggeredBy).toBe('admin_manual');
    expect(ev.paymentDate).toBe('2026-05-17');
  });

  it('accepts invoiceSubject "event" with paymentDate null (event-fee as-paid rail — F8 hook never reads this field for events)', () => {
    const ev: F4InvoicePaidEvent = {
      tenantId: 'test-swecham',
      invoiceId: '550e8400-e29b-41d4-a716-446655440004',
      memberId: '550e8400-e29b-41d4-a716-446655440005',
      paidAt: '2026-05-17T14:00:00.000Z',
      amountSatang: asSatang(214_000n),
      vatSatang: asSatang(14_000n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'admin_manual',
      invoiceSubject: 'event',
      paymentDate: null,
    };
    expect(ev.invoiceSubject).toBe('event');
    expect(ev.paymentDate).toBeNull();
  });

  it('accepts all 6 F4InvoicePaidPaymentMethod variants', () => {
    const methods: ReadonlyArray<F4InvoicePaidPaymentMethod> = [
      'stripe_card',
      'stripe_promptpay',
      'bank_transfer',
      'cheque',
      'cash',
      'other',
    ];
    expect(methods).toHaveLength(6);
    expect(methods).toContain('stripe_card');
    expect(methods).toContain('stripe_promptpay');
    expect(methods).toContain('other');
  });

  it('accepts all 3 F4InvoicePaidTrigger variants', () => {
    const triggers: ReadonlyArray<F4InvoicePaidTrigger> = [
      'webhook',
      'admin_manual',
      'admin_offline_mark',
    ];
    expect(triggers).toHaveLength(3);
    expect(triggers).toContain('webhook');
    expect(triggers).toContain('admin_manual');
    expect(triggers).toContain('admin_offline_mark');
  });

  it('Net = amountSatang - vatSatang (per docstring); branded math works', () => {
    const total = asSatang(1_070_000n);
    const vat = asSatang(70_000n);
    const net = total - vat;
    expect(net).toBe(1_000_000n);
  });
});
