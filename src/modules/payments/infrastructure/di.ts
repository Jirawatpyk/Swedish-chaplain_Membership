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

// Ports (type-only) — canonical Deps shapes live on the use-case modules.
import type { InitiatePaymentDeps } from '../application/use-cases/initiate-payment';
import type { ProcessWebhookEventDeps } from '../application/use-cases/process-webhook-event';
import type { ConfirmPaymentDeps } from '../application/use-cases/confirm-payment';
import type { FailPaymentDeps } from '../application/use-cases/fail-payment';
import type { CancelPaymentDeps } from '../application/use-cases/cancel-payment';
import type { HandleCancelEventDeps } from '../application/use-cases/handle-cancel-event';
import type { RefundsRepo } from '../application/ports/refunds-repo';

import { systemClock } from '../application/ports/clock-port';
import { asPaymentId, type PaymentId } from '../domain/payment';

// Infrastructure adapters.
import { makeDrizzlePaymentsRepo } from './repos/drizzle-payments-repo';
import { makeDrizzleProcessorEventsRepo } from './repos/drizzle-processor-events-repo';
import { makeDrizzleTenantPaymentSettingsRepo } from './repos/drizzle-tenant-payment-settings-repo';
import { stripeGateway } from './stripe/stripe-gateway';
import { stripeWebhookVerifier } from './stripe/stripe-webhook-verifier';
import { invoicingBridge } from './invoicing-bridge';

// Re-exported so Group F's webhook route handler can import the verifier
// adapter from the DI module (composition-root convention) rather than
// reaching into `./stripe/stripe-webhook-verifier` directly.
export { stripeWebhookVerifier };
import { f5AuditAdapter } from './audit/drizzle-payments-audit';

// ---------------------------------------------------------------------------
// RefundsRepo — TEMPORARY STUB.
//
// The `refunds` table schema + migration (0034) is shipped, but the
// concrete `DrizzleRefundsRepo` has NOT been implemented yet — it is
// scoped to Group F's refund HTTP route + full refund use-case work
// (charge.refunded webhook branch + admin-initiated refund flow).
//
// Today this stub is reachable ONLY through `processWebhookEvent`'s
// refund branch. All unit tests mock the repo, and the existing
// integration tests exercise paths that never call into it. A
// production `charge.refunded` event with this stub in place would
// throw (loud failure → logged → next webhook retry re-tries), which
// is the correct behaviour until Group F lands. See Group F gap-note
// at bottom of file.
// ---------------------------------------------------------------------------
function makeUnimplementedRefundsRepo(): RefundsRepo {
  const unimplemented = (method: string): never => {
    throw new Error(
      `[F5] RefundsRepo.${method} is not wired yet — Group F lands the Drizzle adapter ` +
        `(scoped with the refund HTTP route + charge.refunded webhook branch). ` +
        `Today only refund-specific webhook replay paths reach this; routes MUST NOT ship until Group F.`,
    );
  };
  return {
    insert: () => unimplemented('insert'),
    updateStatus: () => unimplemented('updateStatus'),
    findByProcessorRefundId: () => unimplemented('findByProcessorRefundId'),
    sumSucceededForPayment: () => unimplemented('sumSucceededForPayment'),
  };
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
    refundsRepo: makeUnimplementedRefundsRepo(),
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
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
  };
}

// --- Internal test hooks (NOT re-exported from the public barrel) ----------
/** @internal — test-only: unit tests for the DI module assert this stub is in place. */
export const __internal = { makeUnimplementedRefundsRepo, generatePaymentId };
