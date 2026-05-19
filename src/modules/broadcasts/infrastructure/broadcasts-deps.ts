/**
 * F7 broadcasts composition root.
 *
 * Mirrors F4 `invoicing-deps.ts` shape. Factories are per-call (per
 * tenant) for repos that need bound tenant context; stateless adapters
 * are module-level constants.
 */
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { makeDrizzleBroadcastsRepo } from './db/drizzle-broadcasts-repo';
import { makeDrizzleBroadcastSegmentDefinitionsRepo } from './db/drizzle-broadcast-segment-definitions-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from './db/drizzle-marketing-unsubscribes-repo';
import { rfc5321EmailValidator } from './email-validator/rfc5321-email-validator';
import { emailTransactionalBridge } from './email-transactional-bridge';
import { membersBridge } from './members-bridge';
import { plansBridge } from './plans-bridge';
import { eventAttendeesStub } from './event-attendees-stub';
import { f7AuditAdapter } from './audit-adapter';
import { broadcastsRateLimiter } from './rate-limiter';
import { dompurifySanitizer } from './sanitizer/dompurify-sanitizer';
import { resendBroadcastsGateway } from './resend/resend-broadcasts-gateway';
import { resendBroadcastsWebhookVerifier } from './resend/resend-broadcasts-webhook-verifier';
import { makeDrizzleBroadcastDeliveriesRepo } from './db/drizzle-broadcast-deliveries-repo';
import { unsubscribeTokenSigner } from './unsubscribe-token/hmac-signer';

import type { ClockPort } from '../application/ports/clock-port';
import type { ProcessWebhookEventDeps } from '../application/use-cases/process-webhook-event';
import type { ReconcileStuckSendingDeps } from '../application/use-cases/reconcile-stuck-sending';
import type { UnsubscribeRecipientDeps } from '../application/use-cases/unsubscribe-recipient';
import type { SaveDraftDeps } from '../application/use-cases/save-draft';
import type { SubmitBroadcastDeps } from '../application/use-cases/submit-broadcast';
import type { ComputeQuotaDeps } from '../application/use-cases/compute-quota-counter';
import type { EnforceTenantContextDeps } from '../application/use-cases/enforce-tenant-context';
import type { ApproveBroadcastDeps } from '../application/use-cases/approve-broadcast';
import type { RejectBroadcastDeps } from '../application/use-cases/reject-broadcast';
import type { CancelBroadcastDeps } from '../application/use-cases/cancel-broadcast';
import type { ProxySubmitBroadcastDeps } from '../application/use-cases/proxy-submit-broadcast';
import type { ClearHaltDeps } from '../application/use-cases/clear-halt';
import type { DispatchScheduledBroadcastDeps } from '../application/use-cases/dispatch-scheduled-broadcast';
import type { PruneExpiredDraftsDeps } from '../application/use-cases/prune-expired-drafts';
import type { AcknowledgeBroadcastsTermsDeps } from '../application/use-cases/acknowledge-broadcasts-terms';
import type { GetMemberBroadcastDeps } from '../application/use-cases/get-member-broadcast';
import type { ListMemberBroadcastsDeps } from '../application/use-cases/list-member-broadcasts';
// F7.1a Phase 3 Cluster B (US1 — Pagination 5k→50k)
import type { SplitBroadcastIntoBatchesDeps } from '../application/use-cases/split-broadcast-into-batches';
import type { RetryFailedBatchesDeps } from '../application/use-cases/retry-failed-batches';
import type { AcceptPartialDeliveryDeps } from '../application/use-cases/accept-partial-delivery';
import type { AutoRetryFailedBatchesDeps } from '../application/use-cases/auto-retry-failed-batches';
import type { ApplyBatchWebhookEventDeps } from '../application/use-cases/apply-batch-webhook-event';
import { makeDrizzleBatchManifestsRepo } from './drizzle-batch-manifests-repo';
import { makeDrizzleBroadcastsRetryRepo } from './drizzle-broadcasts-retry-repo';
import { pgAdvisoryLockAdapter } from './pg-advisory-lock-adapter';

export const systemClock: ClockPort = {
  now: () => new Date(),
};

export function makeSaveDraftDeps(tenantId: string): SaveDraftDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    sanitizer: dompurifySanitizer,
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeSubmitBroadcastDeps(
  tenantId: string,
): SubmitBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    sanitizer: dompurifySanitizer,
    membersBridge,
    plansBridge,
    emailValidator: rfc5321EmailValidator,
    eventAttendees: eventAttendeesStub,
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantId),
    rateLimiter: broadcastsRateLimiter,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeComputeQuotaDeps(tenantId: string): ComputeQuotaDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    plansBridge,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    clock: systemClock,
  };
}

export function makeEnforceTenantContextDeps(
  tenantId: string,
): EnforceTenantContextDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    audit: f7AuditAdapter,
  };
}

/**
 * Composition root for the member-facing broadcast detail route
 * (`GET /api/broadcasts/[id]`). Returns the broadcasts repo + the
 * tenant-context enforcer the route uses to bind RLS and resolve the
 * member-actor before dispatching to the use-case.
 */
export function makeGetBroadcastDeps(tenantId: string): {
  readonly tenantId: string;
  readonly broadcastsRepo: ReturnType<typeof makeDrizzleBroadcastsRepo>;
  readonly enforceTenantContext: EnforceTenantContextDeps;
} {
  return {
    tenantId,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    enforceTenantContext: makeEnforceTenantContextDeps(tenantId),
  };
}

/** Segment definitions for the compose surface dropdown. */
export function makeListSegmentDefinitionsDeps(tenantId: string): {
  readonly segmentDefinitionsRepo: ReturnType<
    typeof makeDrizzleBroadcastSegmentDefinitionsRepo
  >;
  readonly tenantId: string;
} {
  return {
    tenantId,
    segmentDefinitionsRepo:
      makeDrizzleBroadcastSegmentDefinitionsRepo(tenantId),
  };
}

// =====================================================================
// Phase 4 US2 — admin review use-case factories
// =====================================================================

export function makeApproveBroadcastDeps(
  tenantId: string,
): ApproveBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
    // G2 closure (verify-fix 2026-05-02 — US2 wire-up).
    emailTransactional: emailTransactionalBridge,
    // R4 Types-#6 — member-preferred-locale lookup (today returns
    // null; future-extensibility for F12 white-label).
    membersBridge,
  };
}

export function makeRejectBroadcastDeps(
  tenantId: string,
): RejectBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
    // G2 closure (verify-fix 2026-05-02 — US2 wire-up).
    emailTransactional: emailTransactionalBridge,
    // R4 Types-#6 — member-preferred-locale lookup (today returns
    // null; future-extensibility for F12 white-label).
    membersBridge,
  };
}

export function makeCancelBroadcastDeps(
  tenantId: string,
): CancelBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
    // G2 closure (verify-fix 2026-05-02 — US2 wire-up).
    emailTransactional: emailTransactionalBridge,
    // R4 Types-#6 — member-preferred-locale lookup (today returns
    // null; future-extensibility for F12 white-label).
    membersBridge,
  };
}

export function makeProxySubmitBroadcastDeps(
  tenantId: string,
): ProxySubmitBroadcastDeps {
  // Same shape as submit-broadcast deps; use case delegates to
  // submitBroadcast under the hood.
  return makeSubmitBroadcastDeps(tenantId);
}

export function makeClearHaltDeps(tenantId: string): ClearHaltDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * Cron worker composition root. Wires the live Resend Broadcasts SDK
 * adapter.
 *
 * `fromEmail` is sourced from `env.broadcasts.fromEmail` (zod-validated
 * at boot — refuses IANA reserved TLDs per review C1 — 2026-04-30) so
 * this factory cannot accidentally dispatch from a placeholder address.
 *
 * `tenantDisplayName` + `locale` are resolved per-call via the F7
 * route helpers (no per-tenant settings table for support email yet —
 * F12 scope). MVP: locale defaults to the static tenant default
 * resolved by `tenantDefaultLocaleFor(...)` below.
 */
export async function makeDispatchScheduledBroadcastDeps(
  tenantId: string,
): Promise<DispatchScheduledBroadcastDeps> {
  const tenant = asTenantContext(tenantId);
  const { resolveTenantDisplayName } = await import(
    '@/lib/broadcasts-route-helpers'
  );
  // Best-effort: a tenant-settings outage MUST NOT wedge the cron loop
  // in `approved` indefinitely (the row would never reach the use-case
  // body and so the `broadcast_failed_to_dispatch` audit would never
  // fire). Fall back to the tenant id as a degraded display name so
  // dispatch still proceeds with an observable signal.
  let tenantDisplayName: string;
  try {
    tenantDisplayName = await resolveTenantDisplayName(tenantId);
  } catch (e) {
    logger.error(
      { err: (e as Error).message, tenantId },
      'broadcast_dispatch_tenant_displayname_lookup_failed',
    );
    tenantDisplayName = tenantId;
  }
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    broadcastsGateway: resendBroadcastsGateway,
    membersBridge,
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantId),
    eventAttendees: eventAttendeesStub,
    audit: f7AuditAdapter,
    clock: systemClock,
    fromEmail: env.broadcasts.fromEmail,
    tenantDisplayName,
    locale: tenantDefaultLocaleFor(tenantId),
    // Phase 8 Slice B (T171 / AS5) — used to compare originating
    // member's CURRENT plan vs the snapshot at submit time, emitting
    // `broadcast_sent_with_expired_member_plan` audit on mismatch.
    plansBridge,
    // Phase 8 Slice E (FR-021 / AS2) — used to enqueue the dispatch-
    // failure transactional notification when the 1h retry budget is
    // exhausted OR a permanent failure transitions the row to
    // failed_to_dispatch. Routes through F4 outbox dispatcher's
    // `broadcast_failed_to_dispatch_notification` render branch.
    emailTransactional: emailTransactionalBridge,
  };
}

/**
 * Phase 8 / T171a — daily draft-expiry prune cron worker composition.
 * Stateless deps — no external SDK calls. Pure DB DELETE inside
 * `runInTenant` for RLS-scoped execution.
 */
export function makePruneExpiredDraftsDeps(
  tenantId: string,
): PruneExpiredDraftsDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    clock: systemClock,
    // Defaults to 30 days inside the use-case per FR-001a.
  };
}

/**
 * Static per-tenant default locale (F12 white-label scope will move
 * this to tenant settings). Used by the dispatch composition root + the
 * public unsubscribe page's locale-resolution fallback. Unknown tenant
 * ids fall through to `'en'` — the default-of-defaults.
 */
const TENANT_DEFAULT_LOCALE: Readonly<Record<string, 'en' | 'th' | 'sv'>> = {
  swecham: 'th',
  jcc: 'en',
};

export function tenantDefaultLocaleFor(tenantId: string): 'en' | 'th' | 'sv' {
  return TENANT_DEFAULT_LOCALE[tenantId] ?? 'en';
}

/**
 * Phase 9 / T178a — F3 archival/erasure cascade composition.
 * Walks `submitted` + `approved` broadcasts owned by the archived/erased
 * member and transitions each to `cancelled` with actor_role='system'.
 * Stateless — pure DB UPDATE inside `runInTenant` for RLS-scoped tx.
 */
export function makeCancelInFlightBroadcastsForMemberDeps(tenantId: string) {
  return {
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

// =====================================================================
// Phase 5 US3 — member quota + history surface use-case factories
// =====================================================================

export function makeAcknowledgeBroadcastsTermsDeps(
  tenantId: string,
): AcknowledgeBroadcastsTermsDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeGetMemberBroadcastDeps(
  tenantId: string,
): GetMemberBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
  };
}

export function makeListMemberBroadcastsDeps(
  tenantId: string,
): ListMemberBroadcastsDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
  };
}

// =====================================================================
// Phase 7 US5 — Webhook ingest + 24h reconciliation factories
// =====================================================================

export function makeProcessWebhookEventDeps(
  tenantId: string,
): ProcessWebhookEventDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    deliveriesRepo: makeDrizzleBroadcastDeliveriesRepo(tenantId),
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantId),
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
    emailTransactional: emailTransactionalBridge,
  };
}

export function makeReconcileStuckSendingDeps(
  tenantId: string,
): ReconcileStuckSendingDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    broadcastsGateway: resendBroadcastsGateway,
    audit: f7AuditAdapter,
    clock: systemClock,
    notification: {
      membersBridge,
      emailTransactional: emailTransactionalBridge,
      deliveriesRepo: makeDrizzleBroadcastDeliveriesRepo(tenantId),
    },
  };
}

/**
 * Webhook signature verifier — exposed at the composition root for the
 * route handler. The verifier is stateless; tests inject a stub via the
 * ports module rather than swapping the singleton.
 */
export { resendBroadcastsWebhookVerifier };

// =====================================================================
// Phase 6 US4 — Public unsubscribe + suppression factories
// =====================================================================

/**
 * Build deps for `unsubscribeRecipient` use-case. Tenant display name is
 * resolved per-call via the existing F4 tenant-invoice-settings shim
 * (mirrors the submit/draft routes); support email defaults to the
 * chamber's verified Resend `fromEmail` until a per-tenant support
 * mailbox is added (F12 white-label config).
 */
export function makeUnsubscribeRecipientDeps(
  tenantId: string,
  tenantDisplayName: string,
  tenantSupportEmail: string,
): UnsubscribeRecipientDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantId),
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
    tenantDisplayName,
    tenantSupportEmail,
  };
}

/**
 * Public unsubscribe-token signer — exposed at the barrel because the
 * dispatch path (Resend gateway / email-template renderer) calls
 * `sign(...)` per recipient when stamping out per-recipient HTML bodies
 * (T147). The verifier side is reached through the same singleton.
 */
export { unsubscribeTokenSigner };

/**
 * F7 webhook resolver — pre-tenant lookup. Mirrors F5
 * `resolveTenantByProcessorAccountId`. Reads via the schema-owner role
 * which has BYPASSRLS so the tenant id can be located before
 * `app.current_tenant` is bound. Idempotent: returns `null` for
 * unknown ids; the route handler 200-OKs to prevent Resend retry storm.
 */
export async function resolveTenantByResendBroadcastId(
  resendBroadcastId: string,
): Promise<{
  readonly tenantId: string;
  readonly broadcastId: string;
} | null> {
  // Build a temporary repo bound to a placeholder slug — the bypass
  // method ignores the `tenantId` ctx (it is the cross-tenant
  // resolution path). We use a known-valid slug to satisfy the
  // constructor's `asTenantContext` invariant.
  const placeholderRepo = makeDrizzleBroadcastsRepo('lookup');
  const lookup =
    await placeholderRepo.findByResendBroadcastIdBypassRls(resendBroadcastId);
  if (lookup === null) return null;
  return {
    tenantId: lookup.tenantId,
    broadcastId: lookup.broadcast.broadcastId,
  };
}

// =====================================================================
// F7.1a Phase 3 Cluster B (US1 — Pagination 5k→50k) — use-case factories
// =====================================================================

/**
 * T044 — composition root for `splitBroadcastIntoBatches` use case.
 * Called by the cron dispatcher (Phase 3 T055) after recipient
 * resolution completes; runs inside `runInTenant(ctx)` provided by the
 * factory-bound `batchManifests` adapter.
 */
export function makeSplitBroadcastIntoBatchesDeps(
  tenantId: string,
): SplitBroadcastIntoBatchesDeps {
  return {
    batchManifests: makeDrizzleBatchManifestsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * T047 — composition root for `retryFailedBatches` use case (admin
 * route T050). The `advisoryLock` slot is currently wired to the
 * `noOpAdvisoryLock` stub — see that file's header for the SC-007
 * mitigation rationale + Phase 3 Cluster 3D hardening plan.
 */
export function makeRetryFailedBatchesDeps(
  tenantId: string,
): RetryFailedBatchesDeps {
  return {
    broadcasts: makeDrizzleBroadcastsRetryRepo(tenantId),
    batchManifests: makeDrizzleBatchManifestsRepo(tenantId),
    // Phase 3E production AdvisoryLockPort — replaces the 3C.1 noOp
    // stub. T047 retry use case now wraps its body in
    // `broadcasts.withTx` so the lock holds across snapshot read +
    // increment + batch fan-out + audit emit (true SC-007 semantics).
    advisoryLock: pgAdvisoryLockAdapter,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * T048 — composition root for `acceptPartialDelivery` use case (admin
 * route T051). No advisory lock needed — the underlying
 * `acceptPartial` SQL uses `WHERE status='partially_sent'` so
 * concurrent clicks serialise via DB row lock; the loser surfaces
 * INVALID_STATE_TRANSITION.
 */
export function makeAcceptPartialDeliveryDeps(
  tenantId: string,
): AcceptPartialDeliveryDeps {
  return {
    broadcasts: makeDrizzleBroadcastsRetryRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * T056 — composition root for `autoRetryFailedBatches` /
 * `sweepAutoRetryFailedBatches` (reconcile-stuck-sending cron
 * extension). FR-005: 5-attempt auto-retry budget per batch.
 */
export function makeAutoRetryFailedBatchesDeps(
  tenantId: string,
): AutoRetryFailedBatchesDeps {
  return {
    batchManifests: makeDrizzleBatchManifestsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * T057 — composition root for `applyBatchWebhookEvent`. Called by
 * `/api/webhooks/resend-broadcasts/route.ts` after the bypass-RLS
 * batch lookup resolves the tenant context.
 */
export function makeApplyBatchWebhookEventDeps(
  tenantId: string,
): ApplyBatchWebhookEventDeps {
  return {
    batchManifests: makeDrizzleBatchManifestsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * Bypass-RLS lookup helper for the F7.1a webhook routing fallback.
 * Mirrors `resolveTenantByResendBroadcastId` (F7 MVP single-audience
 * lookup) but scans `broadcast_batch_manifests` instead of `broadcasts`.
 * Caller is the webhook route handler — runs BEFORE
 * `app.current_tenant` is bound, so we use a placeholder repo and
 * call the bypass-RLS method directly.
 */
export async function resolveTenantByBatchProviderBroadcastId(
  providerBroadcastId: string,
): Promise<{
  readonly tenantId: string;
  readonly broadcastId: string;
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly recipientCount: number;
} | null> {
  const placeholderRepo = makeDrizzleBatchManifestsRepo('lookup');
  const lookup =
    await placeholderRepo.findBatchByProviderBroadcastIdBypassRls(
      providerBroadcastId,
    );
  if (lookup === null) return null;
  return {
    tenantId: lookup.tenantId,
    broadcastId: lookup.broadcastId as unknown as string,
    batchManifestId: lookup.batchManifestId,
    batchIndex: lookup.batchIndex,
    recipientCount: lookup.recipientCount,
  };
}
