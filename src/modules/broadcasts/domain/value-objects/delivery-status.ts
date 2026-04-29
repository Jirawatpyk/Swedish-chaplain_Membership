/**
 * T024 — `BroadcastDeliveryStatus` Domain value object (F7).
 *
 * 5-value Resend webhook event taxonomy (FR-024 + FR-027). Mirror of
 * `broadcastDeliveryStatusEnum` in Infrastructure schema.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const BROADCAST_DELIVERY_STATUSES = [
  'sent',
  'delivered',
  'bounced',
  'soft_bounced',
  'complained',
] as const;

export type BroadcastDeliveryStatus =
  (typeof BROADCAST_DELIVERY_STATUSES)[number];

/**
 * `bounced` and `complained` are **suppression-triggering** events
 * (FR-027 cascade to `marketing_unsubscribes`). `soft_bounced` is NOT
 * — Resend retries internally; we only persist it for member detail
 * timeline visibility.
 */
export function isSuppressionTriggering(
  status: BroadcastDeliveryStatus,
): boolean {
  return status === 'bounced' || status === 'complained';
}

export function isBroadcastDeliveryStatus(
  value: unknown,
): value is BroadcastDeliveryStatus {
  return (
    typeof value === 'string' &&
    (BROADCAST_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}
