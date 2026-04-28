/**
 * T061–T068 — F5 composition root (Infrastructure layer).
 *
 * Real per-request dependency-graph factories for the 6 Group D
 * use-cases. Replaces the Group D stub `application/deps-factories.ts`
 * (deleted in Group E3 — composition roots belong at Infrastructure,
 * not Application, per Architect D-02 blocker resolution).
 *
 * Each factory is a THIN composition: it wires the Application
 * use-case's `Deps` interface to the concrete Drizzle / Stripe /
 * Resend adapters. No business logic lives here.
 *
 * Tenant-bound adapters (PaymentsRepo, TenantPaymentSettingsRepo) are
 * constructed per-call with the caller's `tenantId` so RLS + FORCE
 * policies are enforced on every DB statement. Stateless adapters
 * (gateway, webhook verifier, audit, invoicing-bridge) are imported
 * as module singletons.
 */
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';

// Ports (type-only) — canonical Deps shapes live on the use-case modules.
import type { InitiatePaymentDeps } from '../application/use-cases/initiate-payment';
import type { ProcessWebhookEventDeps } from '../application/use-cases/process-webhook-event';
import type { ConfirmPaymentDeps } from '../application/use-cases/confirm-payment';
import type { FailPaymentDeps } from '../application/use-cases/fail-payment';
import type { CancelPaymentDeps } from '../application/use-cases/cancel-payment';
import type { HandleCancelEventDeps } from '../application/use-cases/handle-cancel-event';
import type { ListSucceededPaymentMethodsDeps } from '../application/use-cases/list-succeeded-payment-methods';
import type { LoadInvoicePaymentActivityDeps } from '../application/use-cases/load-invoice-payment-activity';
import type { IssueRefundDeps } from '../application/use-cases/issue-refund';

import { systemClock } from '../application/ports/clock-port';
import { asPaymentId, type PaymentId } from '../domain/payment';

// Infrastructure adapters.
import { makeDrizzlePaymentsRepo } from './repos/drizzle-payments-repo';
import { makeDrizzleProcessorEventsRepo } from './repos/drizzle-processor-events-repo';
import { makeDrizzleRefundsRepo } from './repos/drizzle-refunds-repo';
import { makeDrizzleTenantPaymentSettingsRepo } from './repos/drizzle-tenant-payment-settings-repo';
import { stripeGateway } from './stripe/stripe-gateway';
import { stripeWebhookVerifier } from './stripe/stripe-webhook-verifier';
import { invoicingBridge } from './invoicing-bridge';

// Re-exported so Group F's webhook route handler can import the verifier
// adapter from the DI module (composition-root convention) rather than
// reaching into `./stripe/stripe-webhook-verifier` directly.
export { stripeWebhookVerifier };
import { f5AuditAdapter } from './audit/drizzle-payments-audit';
import { paymentsLogger } from './logger/payments-logger';

/**
 * Generate a fresh F5 Refund ID of the form `rfnd_<hex>` (mirrors
 * `generatePaymentId`). Stripped UUIDv4 → 32 hex chars inside the
 * Domain regex's allowed set; the `rfnd_` prefix is the F5 Refund
 * convention (data-model.md § 3.1).
 */
function generateRefundId(): string {
  return `rfnd_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Generate a fresh F5 Payment ID of the form `pmt_<hex>` matching the
 * Domain regex (RE_ULID_LIKE — base32-Crockford-like char set, 20–40
 * chars). A UUIDv4 with dashes stripped yields 32 hex chars inside the
 * allowed set; the `pmt_` prefix is added by the Domain-side convention.
 */
function generatePaymentId(): PaymentId {
  const id = `pmt_${randomUUID().replace(/-/g, '')}`;
  return asPaymentId(id);
}

// ---------------------------------------------------------------------------
// T061 — initiatePayment composition.
// ---------------------------------------------------------------------------
export function makeInitiatePaymentDeps(tenantId: string): InitiatePaymentDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
    generatePaymentId,
    // Idempotency-Key strategy. Production: identity → seq-based key
    // is the dedupe contract for true retries (two concurrent retries
    // map to the same Stripe PI). Dev: `-d-<ms>` salt because Stripe
    // caches keys 24h + rejects re-use with mismatched params
    // (StripeIdempotencyError 400 → route 502 processor_unavailable),
    // making manual repeat-testing impossible without the salt.
    idempotencyKeyFactory: env.isDevelopment
      ? (baseKey: string) => `${baseKey}-d-${Date.now()}`
      : (baseKey: string) => baseKey,
  };
}

// ---------------------------------------------------------------------------
// T062 — processWebhookEvent composition.
//
// NOTE on pre-resolution: webhook arrives with no tenant in the body;
// the route handler (Group F) MUST resolve tenant via a bypass-RLS
// lookup on `payments.stripe_payment_intent_id` BEFORE calling this
// factory. The tenantId passed in here is the resolved tenant; it
// parameterises the RLS session variable that every subsequent DB
// statement runs under (Principle I two-layer isolation). The idempotency
// INSERT into `processor_events` intentionally runs against `db` directly
// inside the adapter (not through `runInTenant`) to preserve the
// pre-resolution window semantics documented in data-model.md § 5.4 —
// this is independent of the tenantId we bind the other repos with.
// ---------------------------------------------------------------------------
export function makeProcessWebhookEventDeps(tenantId: string): ProcessWebhookEventDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    // CR-3 (review 2026-04-27): wire real refunds-repo so the
    // `charge.refunded` dispatcher can `findByProcessorRefundId` —
    // previous stub threw on every call, causing webhook dispatch_threw
    // 5xx → Stripe retry storm for 72h on legitimate refund webhooks.
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
    // Audit 2026-04-25 finding #5: route Application-layer warn lines
    // through pino instead of console.warn.
    logger: paymentsLogger,
  };
}

// ---------------------------------------------------------------------------
// T063 — confirmPayment composition.
// ---------------------------------------------------------------------------
export function makeConfirmPaymentDeps(tenantId: string): ConfirmPaymentDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
    // Audit 2026-04-25 finding #4: pass processorEventsRepo so the
    // dispatch tx can fold markProcessed in atomically.
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
  };
}

// ---------------------------------------------------------------------------
// T064 — failPayment composition.
// ---------------------------------------------------------------------------
export function makeFailPaymentDeps(tenantId: string): FailPaymentDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    audit: f5AuditAdapter,
    clock: systemClock,
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
  };
}

// ---------------------------------------------------------------------------
// T065 — cancelPayment composition.
// ---------------------------------------------------------------------------
export function makeCancelPaymentDeps(tenantId: string): CancelPaymentDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    audit: f5AuditAdapter,
    clock: systemClock,
  };
}

// ---------------------------------------------------------------------------
// T066 — handleCancelEvent composition (webhook-side `payment_intent.canceled`).
// ---------------------------------------------------------------------------
export function makeHandleCancelEventDeps(tenantId: string): HandleCancelEventDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    audit: f5AuditAdapter,
    clock: systemClock,
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
  };
}

// ---------------------------------------------------------------------------
// T096 (Phase 5) — listSucceededPaymentMethods composition.
//
// Read-only — the use-case is a thin facade over the repo, but kept on
// the use-case side so Presentation does not import a Repo port.
// ---------------------------------------------------------------------------
export function makeListSucceededPaymentMethodsDeps(
  tenantId: string,
): ListSucceededPaymentMethodsDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
  };
}

// ---------------------------------------------------------------------------
// T097 (Phase 5) — loadInvoicePaymentActivity composition.
// ---------------------------------------------------------------------------
export function makeLoadInvoicePaymentActivityDeps(
  tenantId: string,
): LoadInvoicePaymentActivityDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
  };
}

// ---------------------------------------------------------------------------
// T108 (Phase 6) — issueRefund composition.
//
// CR-3 (review 2026-04-27) wired the real `makeDrizzleRefundsRepo` into
// `makeProcessWebhookEventDeps` for the `charge.refunded` branch, closing
// the last residual stub path. Staff-review R2 R007 (2026-04-28) deleted
// the legacy `makeUnimplementedRefundsRepo` stub.
// ---------------------------------------------------------------------------
export function makeIssueRefundDeps(tenantId: string): IssueRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
    generateRefundId,
    // Same dev-mode salt strategy as `makeInitiatePaymentDeps`. In
    // production the seq-based key is the Stripe dedupe contract;
    // dev adds a millisecond suffix so manual repeat-testing is not
    // blocked by Stripe's 24h key cache.
    idempotencyKeyFactory: env.isDevelopment
      ? (baseKey: string) => `${baseKey}-d-${Date.now()}`
      : (baseKey: string) => baseKey,
    // R2 reliability (2026-04-27): wire paymentsLogger so the
    // double-fault `.catch()` at the failure-finalise tail emits a
    // structured warn instead of silent swallow.
    logger: paymentsLogger,
  };
}

// ---------------------------------------------------------------------------
// T130a — sweepStalePendingRefunds composition.
// ---------------------------------------------------------------------------
import type { SweepStalePendingRefundsDeps } from '../application/use-cases/sweep-stale-pending-refunds';

export function makeSweepStalePendingRefundsDeps(
  tenantId: string,
): SweepStalePendingRefundsDeps {
  return {
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    audit: f5AuditAdapter,
    clock: systemClock,
    // R2 M-2 (2026-04-27): logger threaded through DI per Constitution
    // Principle III. Use-case sees only `LoggerPort`, never `@/lib/logger`.
    logger: paymentsLogger,
  };
}

// --- Internal test hooks (NOT re-exported from the public barrel) ----------
/** @internal — test-only: ID generators exposed for unit-test injection. */
export const __internal = {
  generatePaymentId,
  generateRefundId,
};
