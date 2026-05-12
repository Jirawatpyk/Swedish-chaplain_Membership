/**
 * T016 — `PaymentStatus` value object (F6).
 *
 * Mirrors EventCreate's ticket payment_status field. F6 has zero payment
 * surface — these statuses are RECORD-ONLY from the upstream webhook
 * payload. F5's payment state machine is unaffected.
 *
 *   - `paid`      — attendee has paid (default)
 *   - `pending`   — attendee registered without payment (e.g., bank transfer)
 *   - `refunded`  — payment reversed; F6 credits back the quota flags on
 *                    first refund delivery per FR-018
 *   - `free`      — non-paid event (early-bird, sponsor invite, etc.)
 *
 * DB CHECK constraint on `event_registrations.payment_status` enforces
 * the same closed set; this Domain VO provides compile-time enforcement.
 *
 * Pure TypeScript — Constitution Principle III.
 */

export const PAYMENT_STATUSES = [
  'paid',
  'pending',
  'refunded',
  'free',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === 'string' &&
    (PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}
