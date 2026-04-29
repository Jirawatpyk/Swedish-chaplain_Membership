/**
 * T028 — `BroadcastDeliveriesRepo` Application port (F7).
 *
 * Insert-only repository over the `broadcast_deliveries` table.
 * Webhook idempotency primitive: UNIQUE
 * `(tenant_id, resend_event_id)` — duplicate webhook delivery returns
 * the existing row (FR-025).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type {
  BroadcastDelivery,
  BroadcastDeliveryId,
  BounceType,
} from '../../domain/broadcast-delivery';
import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastDeliveryStatus } from '../../domain/value-objects/delivery-status';
import type { EmailLower } from '../../domain/value-objects/email-lower';

export interface NewBroadcastDeliveryInput {
  readonly tenantId: string;
  readonly deliveryId: BroadcastDeliveryId;
  readonly broadcastId: BroadcastId;
  readonly resendEventId: string;
  readonly resendMessageId: string;
  readonly recipientEmailLower: EmailLower;
  readonly recipientMemberId: string | null;
  readonly recipientMemberLookupAttemptedAt: Date | null;
  readonly status: BroadcastDeliveryStatus;
  readonly eventTimestamp: Date;
  readonly errorMessage: string | null;
  readonly bounceType: BounceType | null;
}

export interface BroadcastDeliveryAggregate {
  readonly broadcastId: BroadcastId;
  readonly sent: number;
  readonly delivered: number;
  readonly bounced: number;
  readonly softBounced: number;
  readonly complained: number;
}

export interface BroadcastDeliveriesRepo {
  /**
   * Idempotent insert via `ON CONFLICT (tenant_id, resend_event_id)
   * DO NOTHING RETURNING *`. Returns the existing row if a duplicate
   * webhook event has already been recorded (FR-025).
   *
   * Returns `{inserted: true, ...}` on first write; `{inserted: false, ...}`
   * on duplicate (caller should NOT re-emit downstream side effects).
   */
  upsertByResendEventId(
    tx: unknown,
    input: NewBroadcastDeliveryInput,
  ): Promise<{
    readonly inserted: boolean;
    readonly delivery: BroadcastDelivery;
  }>;

  findByBroadcastId(
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<ReadonlyArray<BroadcastDelivery>>;

  /**
   * Per-broadcast aggregation — `(tenant_id, broadcast_id, status)`
   * index. Powers admin-queue + broadcast-detail page delivery
   * summary widget.
   */
  aggregateByBroadcast(
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<BroadcastDeliveryAggregate>;
}
