/**
 * T051 — Payment status transition policy (F5 / data-model.md § 2.5).
 *
 * Pure arithmetic/table-driven state-machine guard. Returns ok on a
 * legal transition, err with a typed reason otherwise. The Application
 * layer supplies the Postgres row-level lock (`SELECT … FOR UPDATE`);
 * this function does not know about persistence.
 *
 * Transition table (source → destination):
 *
 *   pending              → succeeded | failed | canceled
 *   succeeded            → partially_refunded | refunded
 *   partially_refunded   → partially_refunded | refunded
 *   failed               → (terminal — no transitions out)
 *   canceled             → (terminal)
 *   refunded             → (terminal)
 *
 * Refund-specific nuance: moving from `succeeded` or `partially_refunded`
 * to `refunded` requires the cumulative refund sum to equal the payment
 * amount — that arithmetic is enforced separately in `issue-refund.ts`
 * via FR-011b and the refund invariant; this function encodes only the
 * *shape* of the transition (which destinations are legal from which
 * source).
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import type { PaymentStatus } from '../payment';

export type TransitionError =
  | { readonly kind: 'terminal_state'; readonly from: PaymentStatus }
  | {
      readonly kind: 'illegal_transition';
      readonly from: PaymentStatus;
      readonly to: PaymentStatus;
    };

// Transition table. Values are the set of legal destinations from the key.
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ['succeeded', 'failed', 'canceled'],
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: [],
  canceled: [],
  refunded: [],
};

/**
 * ⚠️ Idempotency contract (reliability-guardian F-01, 2026-04-23):
 *
 * `succeeded → succeeded` is NOT legal — it returns `illegal_transition`.
 * A real Stripe webhook retry of an already-succeeded event is an
 * *idempotency event*, NOT a state transition; the Application layer
 * MUST dedupe via the `processor_events` PK-constraint INSERT BEFORE
 * ever calling this function on a re-delivered event. Skipping that
 * dedupe step causes every retry to bubble up `illegal_transition` →
 * route returns 5xx → Stripe retries again → endless retry storm →
 * webhook endpoint eventually circuit-breaks. `T056 processWebhookEvent`
 * owns that dedupe — see `contracts/stripe-webhook.md` § 3 step 6.
 */
export function canTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): { ok: true } | { ok: false; error: TransitionError } {
  const allowed = TRANSITIONS[from];
  if (allowed.length === 0) {
    return { ok: false, error: { kind: 'terminal_state', from } };
  }
  if (!allowed.includes(to)) {
    return { ok: false, error: { kind: 'illegal_transition', from, to } };
  }
  return { ok: true };
}

/**
 * Convenience predicate — useful at route boundaries where a boolean
 * guard is nicer than pattern-matching a Result.
 */
export function isLegalTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return canTransition(from, to).ok;
}
