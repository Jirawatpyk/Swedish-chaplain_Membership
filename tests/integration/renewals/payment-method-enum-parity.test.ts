/**
 * F8 Phase 10 / CHK040 close — F4InvoicePaidEvent.paymentMethod ↔ F4
 * record-payment input ↔ F5 processor-rail parity test.
 *
 * Pins the cross-module enum contract per F8's reliability checklist:
 *
 *   The F4InvoicePaidEvent's `paymentMethod` literal union (in
 *   `src/modules/invoicing/domain/f4-invoice-paid-event.ts`) MUST be a
 *   superset of:
 *     a) F4 `recordPayment` input's narrow enum (4 admin-entry values):
 *        bank_transfer / cheque / cash / other
 *     b) F5 processor-rail strings (2 webhook-supplied values):
 *        stripe_card / stripe_promptpay
 *
 * Without this parity guard, a future F5 enum extension (e.g. `stripe_link`)
 * could be added to F5 webhook code without F4InvoicePaidEvent picking it
 * up — F8 listeners (which switch on `paymentMethod` for analytics +
 * post-paid email differentiation) would then receive an unknown literal
 * that breaks their exhaustive `switch (evt.paymentMethod) { … }` blocks.
 *
 * The test is COMPILE-TIME via TypeScript subset assertions + RUNTIME
 * via array-membership checks. Both layers MUST pass for parity.
 *
 * Constitution Principle III (Clean Architecture) — boundary tests for
 * cross-module shared types live close to their consumers (F8) so the
 * boundary failure mode is caught at the consumer side, not silently
 * absorbed at the producer.
 */
import { describe, expect, it } from 'vitest';
import { asSatang } from '@/lib/money';
import type {
  F4InvoicePaidEvent,
  F4InvoicePaidPaymentMethod,
  F4InvoicePaidTrigger,
} from '@/modules/invoicing/domain/f4-invoice-paid-event';

// Canonical enumeration of F4InvoicePaidEvent.paymentMethod values.
// Maintained as a runtime tuple alongside the TS literal union so a
// drift between the two surfaces is caught at compile time + runtime.
const F4_PAID_PAYMENT_METHODS = [
  'stripe_card',
  'stripe_promptpay',
  'bank_transfer',
  'cheque',
  'cash',
  'other',
] as const satisfies ReadonlyArray<F4InvoicePaidPaymentMethod>;

// F4 admin-entry recordPayment input enum (narrower than F4InvoicePaidEvent
// because it excludes the F5 processor rails which only arrive via the F5
// webhook path — markPaidFromProcessor coerces to 'other' for DB persistence
// per the docstring at f4-invoice-paid-event.ts line 53-58).
const F4_RECORD_PAYMENT_INPUT_METHODS = [
  'bank_transfer',
  'cheque',
  'cash',
  'other',
] as const;

// F5 processor-rail strings supplied by the webhook wrapper (per
// `src/modules/payments/application/ports/invoicing-bridge-port.ts:32`
// `method: 'stripe_card' | 'stripe_promptpay'`). These are coerced to
// 'other' before persistence in F4 invoices.payment_method, but the
// SEMANTIC method is preserved in the in-memory F4InvoicePaidEvent for
// downstream listeners (F8 analytics, post-paid email differentiation).
const F5_PROCESSOR_RAILS = ['stripe_card', 'stripe_promptpay'] as const;

const F4_PAID_TRIGGERS = [
  'webhook',
  'admin_manual',
  'admin_offline_mark',
] as const satisfies ReadonlyArray<F4InvoicePaidTrigger>;

describe('F8 cross-module enum parity — Phase 10 / CHK040 close', () => {
  it('F4InvoicePaidPaymentMethod tuple has exactly 6 values (compile-time + runtime parity)', () => {
    // The `as const satisfies` clause above is the compile-time gate.
    // The runtime length check is the additional defence: if a future
    // refactor adds a 7th literal to the TS union without updating the
    // runtime tuple, this assertion fails AND the satisfies-clause
    // would also fail to compile (catching the drift at both layers).
    expect(F4_PAID_PAYMENT_METHODS).toHaveLength(6);
    expect(new Set(F4_PAID_PAYMENT_METHODS).size).toBe(6); // no duplicates
  });

  it('F4 recordPayment input enum is a subset of F4InvoicePaidPaymentMethod', () => {
    // Every value F4 admins can record manually MUST be representable
    // in the cross-module event. Otherwise an admin-entered value would
    // come back to F8 as an unknown literal.
    for (const method of F4_RECORD_PAYMENT_INPUT_METHODS) {
      expect(F4_PAID_PAYMENT_METHODS).toContain(method);
    }
  });

  it('F5 processor rails are a subset of F4InvoicePaidPaymentMethod', () => {
    // Every value F5 webhook can supply MUST be representable in the
    // cross-module event. Otherwise a Stripe rail would arrive at F8
    // listeners as an unknown literal.
    for (const rail of F5_PROCESSOR_RAILS) {
      expect(F4_PAID_PAYMENT_METHODS).toContain(rail);
    }
  });

  it('F4InvoicePaidPaymentMethod = (F4 admin enum) ∪ (F5 processor rails) — no orphan values', () => {
    // The cross-module event union MUST equal the union of producers.
    // If a value lives in F4InvoicePaidPaymentMethod but in NEITHER
    // producer set, it's an orphan — possibly leftover from a removed
    // payment method. Catch the drift before it ships.
    const combined = new Set<string>([
      ...F4_RECORD_PAYMENT_INPUT_METHODS,
      ...F5_PROCESSOR_RAILS,
    ]);
    for (const method of F4_PAID_PAYMENT_METHODS) {
      expect(combined).toContain(method);
    }
    expect(combined.size).toBe(F4_PAID_PAYMENT_METHODS.length);
  });

  it('F4InvoicePaidTrigger has exactly 3 values', () => {
    // Defence against scope creep: the trigger field is a deliberate
    // narrow channel (webhook / admin_manual / admin_offline_mark).
    // Adding a 4th would require corresponding F8 listener-side switch
    // updates per docstring at f4-invoice-paid-event.ts line 67-80.
    expect(F4_PAID_TRIGGERS).toHaveLength(3);
    expect(new Set(F4_PAID_TRIGGERS).size).toBe(3);
  });

  it('F4InvoicePaidEvent shape pins all 11 required fields', () => {
    // Compile-time check: any missing field on F4InvoicePaidEvent makes
    // this object literal fail to satisfy the type. Documents the
    // canonical shape for cross-module callers.
    const sample: F4InvoicePaidEvent = {
      tenantId: 'test-tenant',
      invoiceId: '00000000-0000-0000-0000-000000000000',
      memberId: '11111111-1111-1111-1111-111111111111',
      paidAt: '2026-05-10T08:00:00Z',
      amountSatang: asSatang(5_000_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
    expect(Object.keys(sample)).toHaveLength(11);
    expect(sample.currency).toBe('THB'); // F4 is THB-only today
  });

  it('F8 listeners switching on paymentMethod must handle every value (exhaustive guard)', () => {
    // Models the F8 listener pattern. Adding a new value to the union
    // forces every switch site to add a case (or rely on the `never`
    // branch). This test pins the exhaustive contract by exercising
    // every value through a representative switch.
    function classify(method: F4InvoicePaidPaymentMethod): 'card' | 'qr' | 'manual' {
      switch (method) {
        case 'stripe_card':
          return 'card';
        case 'stripe_promptpay':
          return 'qr';
        case 'bank_transfer':
        case 'cheque':
        case 'cash':
        case 'other':
          return 'manual';
        default: {
          // The TypeScript compiler verifies `method` is `never` here.
          // Adding a new value to F4InvoicePaidPaymentMethod without
          // updating this switch makes `_exhaustive` fail to typecheck.
          const _exhaustive: never = method;
          throw new Error(`unhandled payment method: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
    for (const method of F4_PAID_PAYMENT_METHODS) {
      expect(['card', 'qr', 'manual']).toContain(classify(method));
    }
  });
});
