/**
 * T048 — PaymentMethod value object (F5).
 *
 * Sum type for the processor rail chosen by the member at payment
 * initiation. Mirrors the `payments.method` CHECK at the DB level
 * (migration 0033): `'card' | 'promptpay'`.
 *
 * Kept as a minimal sum type (not a class) — the method is picked once
 * at attempt creation and is immutable thereafter. The `isCard` /
 * `isPromptPay` predicates let Application use-cases branch without
 * string-comparing literals at call sites.
 *
 * Pure TypeScript — no framework/ORM imports.
 */

export const PAYMENT_METHODS = ['card', 'promptpay'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PaymentMethodError = {
  readonly kind: 'invalid_payment_method';
  readonly raw: string;
};

/**
 * Parse an untrusted string into a PaymentMethod. Use at system
 * boundaries (zod route-handler input, webhook payload).
 */
export function parsePaymentMethod(
  raw: string,
): { ok: true; value: PaymentMethod } | { ok: false; error: PaymentMethodError } {
  if ((PAYMENT_METHODS as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as PaymentMethod };
  }
  return { ok: false, error: { kind: 'invalid_payment_method', raw } };
}

export function isCard(m: PaymentMethod): m is 'card' {
  return m === 'card';
}

export function isPromptPay(m: PaymentMethod): m is 'promptpay' {
  return m === 'promptpay';
}
