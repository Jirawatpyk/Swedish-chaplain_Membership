/**
 * T054 — F5 Application ports barrel.
 *
 * Internal to `src/modules/payments/application`; NOT re-exported via
 * the module-level barrel (ports are an infrastructure seam, not a
 * public API). Use-cases + composition-root factories import from here.
 */
export type { PaymentsRepo } from './payments-repo';
export type { RefundsRepo, RefundStatus, RefundRow } from './refunds-repo';
export type { TenantPaymentSettingsRepo } from './tenant-payment-settings-repo';
export type { ProcessorEventsRepo } from './processor-events-repo';
export type {
  ProcessorGatewayPort,
  ProcessorGatewayError,
  CreatedPaymentIntent,
  RetrievedPaymentIntent,
  CreatedRefund,
} from './processor-gateway-port';
export type { WebhookVerifierPort, VerifiedStripeEvent } from './webhook-verifier-port';
export { WebhookSignatureError } from './webhook-verifier-port';
export type {
  InvoicingBridgePort,
  InvoiceForPaymentDTO,
  GetInvoiceForPaymentBridgeError,
  MarkPaidFromProcessorInput,
} from './invoicing-bridge-port';
export type { AuditPort, F5AuditEvent, F5AuditEventType } from './audit-port';
export type { ClockPort } from './clock-port';
export { systemClock } from './clock-port';
export type { RateLimiterPort } from './rate-limiter-port';
