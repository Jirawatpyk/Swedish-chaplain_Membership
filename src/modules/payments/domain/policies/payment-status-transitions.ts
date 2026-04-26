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
 * Generic guard scaffold lives in `_state-machine.ts` (shared with
 * `refund.ts`); this file declares only the payment-specific table.
 *
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
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import type { PaymentStatus } from '../payment';
import {
  makeStateMachine,
  type StateMachineError,
} from './_state-machine';

export type TransitionError = StateMachineError<PaymentStatus>;

const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ['succeeded', 'failed', 'canceled'],
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: [],
  canceled: [],
  refunded: [],
};

const _stateMachine = makeStateMachine<PaymentStatus>(TRANSITIONS);

export const canTransition = _stateMachine.canTransition;
export const isLegalTransition = _stateMachine.isLegalTransition;
