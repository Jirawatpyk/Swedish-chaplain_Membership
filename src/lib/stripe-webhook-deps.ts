/**
 * T071 — Composition adapter for the Stripe-webhook route handler.
 *
 * The webhook route OWNS pipeline steps 4, 5, 6 (livemode check,
 * api_version check, tenant resolution) which each need to touch
 * infrastructure directly — without going through the `processWebhookEvent`
 * use-case. The per-tenant use-case deps factory lives at
 * `@/modules/payments` (composition-root convention) but route-level
 * helpers like "insert a rejected processor_events row before tenant is
 * known" and "resolve tenant by processor account id" are intentionally
 * kept OUT of that public barrel to preserve Principle III boundaries
 * (the barrel-boundary unit test in `tests/unit/payments/index-barrel`
 * explicitly forbids re-exporting `makeDrizzle*Repo`).
 *
 * This module sits on the composition adapter layer (`src/lib/**`,
 * allow-listed by the barrel guard) and wires the tiny route-level
 * operations the webhook route needs. In tests, this module is mocked
 * alongside the route (`@/lib/stripe-webhook-deps`). In production it
 * reaches through to the Drizzle repo factories.
 */
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { makeDrizzleTenantPaymentSettingsRepo } from '@/modules/payments/infrastructure/repos/drizzle-tenant-payment-settings-repo';

// Re-export the auth audit-repo through the `src/lib/` composition
// layer so route handlers don't need to reach into
// `@/modules/auth/infrastructure/**` directly (that deep path is
// restricted by the ESLint barrel guard — only `src/lib/**` is
// allow-listed as a composition adapter).
export { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
export type { ActorRef } from '@/modules/auth/domain/audit-event';

/**
 * Look up the tenant that owns a Stripe connected-account id.
 * Returns `null` when no tenant row maps to the account (webhook from
 * an unrecognised processor — route answers 200 OK without dispatch).
 */
export async function resolveTenantByProcessorAccountId(
  processorAccountId: string,
): Promise<string | null> {
  const repo = makeDrizzleTenantPaymentSettingsRepo();
  const settings = await repo.findByProcessorAccountId(processorAccountId);
  return settings ? settings.tenantId : null;
}

/**
 * Insert a `processor_events` row for a reject-branch outcome
 * (livemode mismatch / api_version drift / acknowledged-only) BEFORE
 * tenant resolution, using the repo's pre-resolution bypass window
 * (data-model.md § 5.4 + migration 0039). Best-effort: any DB error
 * is swallowed by the caller so the webhook still 200s and Stripe
 * does not retry storm.
 */
export async function insertRejectedProcessorEvent(input: {
  eventId: string;
  eventType: string;
  apiVersion: string;
  livemode: boolean;
  processorAccountId: string;
  outcome:
    | 'rejected_environment_mismatch'
    | 'rejected_api_version_mismatch'
    | 'acknowledged_only';
  payloadSha256: string;
  correlationId: string;
  receivedAt: Date;
}): Promise<void> {
  const repo = makeDrizzleProcessorEventsRepo();
  // `tx: unknown` in the port signature already accepts
  // `null` directly — no double-cast needed. The Drizzle adapter
  // ignores the tx arg in this pre-resolution path (see file-level
  // docstring in drizzle-processor-events-repo.ts).
  await repo.insertIfNew(null, {
    id: input.eventId,
    tenantId: null,
    eventType: input.eventType,
    apiVersion: input.apiVersion,
    livemode: input.livemode,
    processorAccountId: input.processorAccountId,
    outcome: input.outcome,
    payloadSha256: input.payloadSha256,
    correlationId: input.correlationId,
    receivedAt: input.receivedAt,
  });
}

