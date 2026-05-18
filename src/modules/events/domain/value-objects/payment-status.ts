/**
 * T016 — `PaymentStatus` value object (F6).
 *
 * Mirrors EventCreate's authoritative `Status` field. F6 has zero payment
 * surface — these statuses are RECORD-ONLY from the upstream CSV/webhook
 * payload. F5's payment state machine is unaffected.
 *
 *   - `paid`        — attendee confirmed by host (EventCreate Status=Attending)
 *   - `pending`     — registered but not yet confirmed (Status=Pending)
 *   - `refunded`    — payment reversed; F6 credits back quota flags per FR-018
 *                      (Status=Cancelled/Canceled flips an existing paid row)
 *   - `free`        — complimentary ticket via admin override
 *                      (counts toward quota same as `paid`)
 *   - `waitlisted`  — event capacity reached (Status=Waitlisted; F6.1+)
 *   - `no_show`     — registered + didn't attend (Status=No Show; F6.1+)
 *
 * Quota counting rule (F6.1 Option B+): only `paid` and `free` contribute
 * to partnership / cultural quota. All other statuses are quota-neutral —
 * see `applyQuotaEffect` in `process-attendee-in-tx.ts`.
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
  'waitlisted',
  'no_show',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === 'string' &&
    (PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}
