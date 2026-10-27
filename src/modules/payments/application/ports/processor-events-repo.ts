/**
 * ProcessorEventsRepo port (F5 Application).
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
   * the resolved tenant_id from the start. A `chamber_app` UPDATE cannot
   * resolve a NULL row later (the SELECT policy hides it — data-model.md
   * § 5.4), so a duplicate with a non-null `tenantId` adopts such a row
   * itself, on the owner connection (D-031): `tenant_id` set,
   * `outcome = 'processed'`, bounded to the row's account and livemode,
   * never a `rejected_signature` row. `adoptedFrom` is then the outcome it
   * replaced; absent on every other result.
   *
   * `onAdopted` runs inside the adoption's own transaction (`ownerTx`), so
   * the record of the adoption commits with it: if it throws, the adoption
   * rolls back and the error propagates, and the next replay adopts again.
   * Without `onAdopted` nothing is adopted: an adoption is never unrecorded.
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
    onAdopted?: (
      ownerTx: unknown,
      adoptedFrom: ProcessorEventOutcome,
      event: ProcessorEvent,
    ) => Promise<void>,
  ): Promise<{
    readonly inserted: boolean;
    readonly event: ProcessorEvent;
    readonly adoptedFrom?: ProcessorEventOutcome;
  }>;

  /** Stamp `processed_at = now()`. Called at pipeline step 10. */
  markProcessed(tx: unknown, id: string): Promise<void>;

  /** Update the outcome column (e.g., acknowledged_only → processed). */
  updateOutcome(
    tx: unknown,
    input: { readonly id: string; readonly outcome: ProcessorEventOutcome },
  ): Promise<void>;

  findById(id: string): Promise<ProcessorEvent | null>;
}
