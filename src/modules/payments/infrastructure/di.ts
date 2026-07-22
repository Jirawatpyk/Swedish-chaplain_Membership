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
import type { ListWaivedRefundTotalsByInvoiceDeps } from '../application/use-cases/list-waived-refund-totals-by-invoice';
import type { CountPendingRefundsForInvoiceDeps } from '../application/use-cases/count-pending-refunds-for-invoice';
import type { LoadInvoicePaymentActivityDeps } from '../application/use-cases/load-invoice-payment-activity';
import type { IssueRefundDeps } from '../application/use-cases/issue-refund';
import type { ResolveFailedAutoRefundDeps } from '../application/use-cases/resolve-failed-auto-refund';

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
import { taxAtPaymentFlag } from '@/modules/invoicing';

// Re-exported so Group F's webhook route handler can import the verifier
// adapter from the DI module (composition-root convention) rather than
// reaching into `./stripe/stripe-webhook-verifier` directly.
export { stripeWebhookVerifier };
import { f5AuditAdapter } from './audit/drizzle-payments-audit';
import { paymentsLogger } from './logger/payments-logger';
// F8 cross-module on-paid callbacks. Wired into the webhook + confirm
// composition roots so Stripe-paid renewal invoices transition the F8
// RenewalCycle inside F4's atomic tx. Gated by `FEATURE_F8_RENEWALS` so
// non-F8 deployments stay unchanged.
//
// dynamic import the renewals barrel ONLY when the feature
// is on. Previously a top-level static `import { f8OnPaidCallbacks }
// from '@/modules/renewals'` paid the cold-start cost (~50-150ms +
// bundle pollution from 32+ TS files in the renewals composition root)
// on EVERY Stripe webhook + confirm-payment request, even when F8 was
// dark. Vercel Fluid Compute caches the dynamic import after first
// hit, so F8-enabled tenants amortise the load cost across the
// process lifetime; F4/F5-only deploys never load the renewals
// barrel at all.
async function f8CallbacksFor(tenantId: string) {
  if (!env.features.f8Renewals) return undefined;
  const { f8OnPaidCallbacks } = await import('@/modules/renewals');
  return f8OnPaidCallbacks(tenantId);
}

/**
 * F8 POST-COMMIT callbacks (the F2 scheduled-plan-change finaliser). Wired
 * alongside the in-tx `f8CallbacksFor` on the webhook + confirm composition
 * roots; the settlement-commit owner (`confirmPayment`) fires these AFTER its
 * tx commits so the finaliser's `plan_change_applied` audit cannot deadlock
 * against the member-row lock the settlement held. Same dynamic-import
 * cold-start amortisation as `f8CallbacksFor`.
 */
async function f8AfterCommitFor(tenantId: string) {
  if (!env.features.f8Renewals) return undefined;
  const { f8AfterCommitCallbacks } = await import('@/modules/renewals');
  return f8AfterCommitCallbacks(tenantId);
}

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
    // 088 SEC-MED — thread FEATURE_088_TAX_AT_PAYMENT into the F4 payability
    // read so a new-flow bill minted under the flag cannot be self-paid after
    // the flag rolls back to OFF (stranded-funds guard). Mirrors how
    // `makeRecordPaymentDeps` wires the same flag on the webhook side.
    taxAtPayment: taxAtPaymentFlag(env.features.f088TaxAtPayment),
    // Idempotency-Key strategy, gated on Stripe LIVE vs TEST mode
    // (not NODE_ENV). Live mode: identity → the seq-based key is the
    // real dedupe contract (two concurrent retries map to the same
    // Stripe PI; no duplicate real charge). Any test-mode deploy
    // (local dev, CI, and a test-key production/staging box such as
    // swecham.zyncdata.app): `-d-<ms>` salt, because Stripe caches
    // idempotency keys 24h + rejects re-use with mismatched params
    // (StripeIdempotencyError 400 → route 502 processor_unavailable),
    // which permanently blocks manual repeat-testing of an invoice
    // whose key was already burned. Keying on `!liveMode` (was
    // `isDevelopment`) fixes repeat-testing on a NODE_ENV=production
    // deploy that still runs sk_test_ keys — the DB advisory lock +
    // resume path stay the primary dedupe layer, so salting the key
    // only ever affects a harmless duplicate TEST-mode PaymentIntent.
    idempotencyKeyFactory: env.stripe.liveMode
      ? (baseKey: string) => baseKey
      : (baseKey: string) => `${baseKey}-d-${Date.now()}`,
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
export async function makeProcessWebhookEventDeps(
  tenantId: string,
): Promise<ProcessWebhookEventDeps> {
  // async to await the dynamic F8 barrel import. Caller is
  // already async (Stripe webhook route handler).
  const f8Callbacks = await f8CallbacksFor(tenantId);
  const f8AfterCommit = await f8AfterCommitFor(tenantId);
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
    // 088 SEC-MED — thread the honest flow flag into the inner confirm read
    // (which sets reconciliationPath: true → guard dormant). Mirrors
    // makeInitiatePaymentDeps; no magic value.
    taxAtPayment: taxAtPaymentFlag(env.features.f088TaxAtPayment),
    // money-remediation Task 4 (F-1) — FEATURE_F5_SETTLEMENT_ABORT: roll back
    // the settlement tx when the F4 bridge declines. Default false (ships dark).
    settlementAbort: env.features.f5SettlementAbort,
    // Audit 2026-04-25 finding #5: route Application-layer warn lines
    // through pino instead of console.warn.
    logger: paymentsLogger,
    ...(f8Callbacks !== undefined ? { onPaidCallbacks: f8Callbacks } : {}),
    ...(f8AfterCommit !== undefined
      ? { onAfterCommitCallbacks: f8AfterCommit }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// T063 — confirmPayment composition.
// ---------------------------------------------------------------------------
export async function makeConfirmPaymentDeps(
  tenantId: string,
): Promise<ConfirmPaymentDeps> {
  // async to await the dynamic F8 barrel import.
  const f8Callbacks = await f8CallbacksFor(tenantId);
  const f8AfterCommit = await f8AfterCommitFor(tenantId);
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
    audit: f5AuditAdapter,
    clock: systemClock,
    // 088 SEC-MED — thread the honest flow flag into the confirm read (which
    // sets reconciliationPath: true → guard dormant). No magic value.
    taxAtPayment: taxAtPaymentFlag(env.features.f088TaxAtPayment),
    // money-remediation Task 4 (F-1) — FEATURE_F5_SETTLEMENT_ABORT: roll back
    // the settlement tx when the F4 bridge declines. Default false (ships dark).
    settlementAbort: env.features.f5SettlementAbort,
    // Audit 2026-04-25 finding #4: pass processorEventsRepo so the
    // dispatch tx can fold markProcessed in atomically.
    processorEventsRepo: makeDrizzleProcessorEventsRepo(),
    ...(f8Callbacks !== undefined ? { onPaidCallbacks: f8Callbacks } : {}),
    ...(f8AfterCommit !== undefined
      ? { onAfterCommitCallbacks: f8AfterCommit }
      : {}),
    // review-20260428-102639.md H2 closure — structured logger for
    // Phase B catch on stale-refund path.
    logger: {
      warn: (msg, ctx) => paymentsLogger.warn(msg, ctx),
    },
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

/**
 * Track B — deps for F9's waived-refund netting read. `makeDrizzleRefundsRepo`
 * now binds a tenant context because `sumWaivedByInvoice` is the repo's one
 * standalone read (no caller-supplied `tx`).
 */
export function makeListWaivedRefundTotalsByInvoiceDeps(
  tenantId: string,
): ListWaivedRefundTotalsByInvoiceDeps {
  return {
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
  };
}

// 8A — the payments-side count behind the invoicing PendingRefundGuardPort.
export function makeCountPendingRefundsForInvoiceDeps(
  tenantId: string,
): CountPendingRefundsForInvoiceDeps {
  return {
    refundsRepo: makeDrizzleRefundsRepo(tenantId),
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
    // Same salt strategy as `makeInitiatePaymentDeps`, gated on Stripe
    // LIVE vs TEST mode. Live mode: identity (seq-based key is the
    // Stripe dedupe contract — no duplicate real refund). Test mode
    // (incl. a test-key production box): `-d-<ms>` suffix so manual
    // repeat-testing is not blocked by Stripe's 24h key cache.
    idempotencyKeyFactory: env.stripe.liveMode
      ? (baseKey: string) => baseKey
      : (baseKey: string) => `${baseKey}-d-${Date.now()}`,
    // R2 reliability (2026-04-27): wire paymentsLogger so the
    // double-fault `.catch()` at the failure-finalise tail emits a
    // structured warn instead of silent swallow.
    logger: paymentsLogger,
  };
}

// ---------------------------------------------------------------------------
// CF-2 — resolveFailedAutoRefund composition (admin "mark as reconciled").
//
// Thin: the tenant-bound payments repo (whose `findFailedAutoRefundForInvoice`
// + `withTx` the use-case uses) + the F5 audit adapter (emits the append-only
// `auto_refund_reconciled` inside the caller's tenant-scoped tx).
// ---------------------------------------------------------------------------
export function makeResolveFailedAutoRefundDeps(
  tenantId: string,
): ResolveFailedAutoRefundDeps {
  return {
    paymentsRepo: makeDrizzlePaymentsRepo(tenantId),
    audit: f5AuditAdapter,
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
    // A.14 — Stripe-aware sweep: resolve the tenant's Connect account +
    // read the real refund status from Stripe, then finalise via the F4
    // credit-note bridge (idempotent) instead of blind-failing. The cron
    // route runs in a request context so the settings repo's
    // `unstable_cache` read is valid here.
    tenantSettingsRepo: makeDrizzleTenantPaymentSettingsRepo(),
    processorGateway: stripeGateway,
    invoicingBridge,
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
