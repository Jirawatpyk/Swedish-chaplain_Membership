/**
 * T054 — ProcessorEventsRepo port (F5 Application).
 *
 * Backs the idempotency layer for Stripe webhook deliveries
 * (stripe-webhook.md § 3 step 6). Natural PK = Stripe `event.id`.
 */
import type {
  ProcessorEvent,
  ProcessorEventOutcome,
} from '../../domain/processor-event';

export interface ProcessorEventsRepo {
  /**
   * Insert-if-new — ON CONFLICT (id) DO NOTHING semantics. Returns
   *   - `{ inserted: true, event }` on first delivery
   *   - `{ inserted: false, event }` on duplicate (short-circuit; skip dispatch)
   *
   * `tenantId` MAY be null ONLY for rejection-audit rows written by
   * `insertRejectedProcessorEvent` (env mismatch / api-version mismatch /
   * unknown-account `acknowledged_only`). Successful events INSERT with
   * the resolved tenant_id from the start. The original "pre-resolution
   * NULL → UPDATE" flow (data-model.md § 5.4 historical) is unimplement-
   * able under the SELECT policy — see audit 2026-04-25 reality-check
   * block in data-model.md.
   */
  insertIfNew(
    tx: unknown,
    input: {
      readonly id: string;
      readonly tenantId: string | null;
      readonly eventType: string;
      readonly apiVersion: string;
      readonly livemode: boolean;
      readonly processorAccountId: string;
      readonly outcome: ProcessorEventOutcome;
      readonly payloadSha256: string;
      readonly correlationId: string;
      readonly receivedAt: Date;
    },
  ): Promise<{ readonly inserted: boolean; readonly event: ProcessorEvent }>;

  /** Stamp `processed_at = now()`. Called at pipeline step 10. */
  markProcessed(tx: unknown, id: string): Promise<void>;

  /** Update the outcome column (e.g., acknowledged_only → processed). */
  updateOutcome(
    tx: unknown,
    input: { readonly id: string; readonly outcome: ProcessorEventOutcome },
  ): Promise<void>;

  findById(id: string): Promise<ProcessorEvent | null>;
}
