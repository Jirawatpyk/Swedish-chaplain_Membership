/**
 * Public barrel for the `payments` bounded context (F5 Online Payment).
 *
 * The ONLY surface that code OUTSIDE `src/modules/payments/**` may
 * import from. ESLint barrel-guard rule (eslint.config.mjs) blocks
 * deep imports into `./domain/**`, `./application/**`, and
 * `./infrastructure/**` per Constitution Principle III.
 */

// --- Domain re-exports ------------------------------------------------------
export {
  SYSTEM_ACTOR_STRIPE_WEBHOOK,
  SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY,
} from './domain/system-actors';
export {
  PAYMENT_METHODS,
  parsePaymentMethod,
  type PaymentMethod,
} from './domain/value-objects/payment-method';
export {
  PAYMENT_STATUSES,
  TERMINAL_PAYMENT_STATUSES,
  asPaymentId,
  parsePaymentId,
  isTerminalPaymentStatus,
  type Payment,
  type PaymentId,
  type PaymentStatus,
} from './domain/payment';
export {
  isAllowed,
  type F5Role,
  type F5Resource,
  type F5Action,
} from './domain/rbac-policy';

// --- Application use-cases (Group D T055–T060) ------------------------------
export {
  initiatePayment,
  type InitiatePaymentInput,
  type InitiatePaymentSuccess,
  type InitiatePaymentError,
  type InitiatePaymentDeps,
} from './application/use-cases/initiate-payment';
export {
  processWebhookEvent,
  type ProcessWebhookEventInput,
  type ProcessWebhookEventOutcome,
  type ProcessWebhookEventError,
  type ProcessWebhookEventDeps,
  type WebhookDispatchEnvelope,
} from './application/use-cases/process-webhook-event';
export type { VerifiedStripeEvent } from './application/ports/webhook-verifier-port';
export {
  confirmPayment,
  type ConfirmPaymentInput,
  type ConfirmPaymentOutcome,
  type ConfirmPaymentError,
  type ConfirmPaymentDeps,
} from './application/use-cases/confirm-payment';
export {
  failPayment,
  type FailPaymentInput,
  type FailPaymentOutcome,
  type FailPaymentError,
  type FailPaymentDeps,
} from './application/use-cases/fail-payment';
export {
  cancelPayment,
  type CancelPaymentInput,
  type CancelPaymentSuccess,
  type CancelPaymentError,
  type CancelPaymentDeps,
} from './application/use-cases/cancel-payment';
export {
  handleCancelEvent,
  type HandleCancelEventInput,
  type HandleCancelEventOutcome,
  type HandleCancelEventError,
  type HandleCancelEventDeps,
} from './application/use-cases/handle-cancel-event';
export {
  listSucceededPaymentMethods,
  type ListSucceededPaymentMethodsInput,
  type ListSucceededPaymentMethodsOutput,
  type ListSucceededPaymentMethodsError,
  type ListSucceededPaymentMethodsDeps,
} from './application/use-cases/list-succeeded-payment-methods';
export {
  loadInvoicePaymentActivity,
  type LoadInvoicePaymentActivityInput,
  type LoadInvoicePaymentActivityOutput,
  type LoadInvoicePaymentActivityError,
  type LoadInvoicePaymentActivityDeps,
} from './application/use-cases/load-invoice-payment-activity';
export type { RefundActivityDto } from './application/ports/payments-repo';
export {
  issueRefund,
  type IssueRefundInput,
  type IssueRefundSuccess,
  type IssueRefundError,
  type IssueRefundDeps,
} from './application/use-cases/issue-refund';
export {
  REFUND_STATUSES,
  TERMINAL_REFUND_STATUSES,
  asRefundId,
  parseRefundId,
  isTerminalRefundStatus,
  isLegalRefundTransition,
  type Refund,
  type RefundId,
  type RefundStatus as DomainRefundStatus,
} from './domain/refund';

// --- Composition-root factories (Group E3 — real Drizzle/Stripe wiring) ----
// Each factory returns the per-request `Deps` graph a route handler
// (Group F) passes into the matching use-case. Tenant-bound repos are
// constructed per-call so Postgres RLS + FORCE policies see the caller's
// `tenantId` on every statement.
export {
  makeInitiatePaymentDeps,
  makeProcessWebhookEventDeps,
  makeConfirmPaymentDeps,
  makeFailPaymentDeps,
  makeCancelPaymentDeps,
  makeHandleCancelEventDeps,
  makeListSucceededPaymentMethodsDeps,
  makeLoadInvoicePaymentActivityDeps,
  makeIssueRefundDeps,
} from './infrastructure/di';
