/**
 * T049 — ProcessorEvent read model (F5).
 *
 * Append-only idempotency record — one row per Stripe webhook delivery
 * we processed. Natural PK = Stripe event id. Backing table mapping
 * lives in `infrastructure/schema.ts`; this file is the Domain
 * projection used by the webhook dispatcher + audit surfaces.
 *
 * `tenantId` is nullable during the pre-resolution bypass window
 * (data-model.md § 5.4): the webhook handler MUST insert with NULL
 * tenant_id BEFORE it can resolve the tenant from `event.account`.
 * A subsequent UPDATE inside `runInTenant(resolvedCtx, ...)` sets it.
 *
 * Pure TypeScript — no framework/ORM imports.
 */

// ---------------------------------------------------------------------------
// Outcome enum (matches DB CHECK in migration 0036)
// ---------------------------------------------------------------------------

export const PROCESSOR_EVENT_OUTCOMES = [
  'processed',
  'acknowledged_only',
  'rejected_signature',
  'rejected_environment_mismatch',
  'rejected_api_version_mismatch',
] as const;
export type ProcessorEventOutcome = (typeof PROCESSOR_EVENT_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export interface ProcessorEvent {
  /** Stripe event id, e.g. "evt_1Nxyz…". */
  readonly id: string;

  /** NULL during the pre-resolution bypass window. */
  readonly tenantId: string | null;

  readonly eventType: string;      // e.g. 'payment_intent.succeeded'
  readonly apiVersion: string;     // e.g. '2024-06-20'
  readonly livemode: boolean;

  readonly processorAccountId: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;

  readonly outcome: ProcessorEventOutcome;

  /** 64-char lowercase hex SHA-256 of the raw body — tamper audit. */
  readonly payloadSha256: string;

  readonly correlationId: string;
}

/**
 * Invariant: rejected_signature rows NEVER bind a tenant (we never got
 * past verification — there is no trusted tenantId to attach).
 * Mirrors DB CHECK `(outcome = 'rejected_signature') = (tenant_id IS NULL)`.
 */
export function isTenantBindable(outcome: ProcessorEventOutcome): boolean {
  return outcome !== 'rejected_signature';
}
