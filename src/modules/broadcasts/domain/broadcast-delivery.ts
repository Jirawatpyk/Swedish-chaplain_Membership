/**
 * T027 — `BroadcastDelivery` aggregate (F7).
 *
 * One row per Resend webhook delivery event (per recipient × per
 * broadcast). Insert-only; never updated. Mirrors `broadcast_deliveries`
 * Infrastructure schema, domain-typed.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { BroadcastDeliveryStatus } from './value-objects/delivery-status';
import type { EmailLower } from './value-objects/email-lower';
import type { BroadcastId } from './broadcast';

declare const BroadcastDeliveryIdBrand: unique symbol;
export type BroadcastDeliveryId = string & {
  readonly [BroadcastDeliveryIdBrand]: true;
};

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BroadcastDeliveryIdError = {
  readonly kind: 'invalid_broadcast_delivery_id';
  readonly raw: string;
};

export function asBroadcastDeliveryId(raw: string): BroadcastDeliveryId {
  return raw as BroadcastDeliveryId;
}

export function parseBroadcastDeliveryId(
  raw: string,
): Result<BroadcastDeliveryId, BroadcastDeliveryIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_broadcast_delivery_id', raw });
  }
  return ok(raw as BroadcastDeliveryId);
}

/**
 * Bounce subtype carried alongside `status='bounced'`. `'hard'` triggers
 * the FR-027 auto-suppression cascade; `'soft'` does NOT (Resend
 * retries internally).
 *
 * NOTE: `'soft'` is recorded here for completeness but the domain
 * primary signal lives in `delivery-status.soft_bounced` —
 * `bounceType='soft'` is just the additional detail Resend includes
 * on the event payload.
 */
export type BounceType = 'hard' | 'soft';

export interface BroadcastDelivery {
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

  readonly createdAt: Date;
}
