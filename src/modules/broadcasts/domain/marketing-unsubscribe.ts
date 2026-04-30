/**
 * T027 — `MarketingUnsubscribe` aggregate (F7).
 *
 * Tenant-scoped suppression record. Natural composite PK
 * (tenantId, emailLower) per FR-018 + Q8. No separate `id` column —
 * the `(tenantId, emailLower)` pair IS the identity.
 *
 * Retention: indefinite per GDPR Art. 21 + PDPA §32. On member-erasure
 * (Art. 17), `memberId` is set to NULL but the row is retained — the
 * regulatory invariant is "we will not contact this email again,"
 * which outlives the underlying member record.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { EmailLower } from './value-objects/email-lower';
import type { BroadcastId } from './broadcast';

/**
 * Suppression reason taxonomy (FR-018 + FR-027 + FR-029).
 * Mirrors `marketingUnsubscribeReasonEnum` in Infrastructure schema.
 */
export const MARKETING_UNSUBSCRIBE_REASONS = [
  'recipient_initiated',
  'hard_bounce',
  'complaint',
  'admin_added',
] as const;

export type MarketingUnsubscribeReason =
  (typeof MARKETING_UNSUBSCRIBE_REASONS)[number];

export function isMarketingUnsubscribeReason(
  value: unknown,
): value is MarketingUnsubscribeReason {
  return (
    typeof value === 'string' &&
    (MARKETING_UNSUBSCRIBE_REASONS as readonly string[]).includes(value)
  );
}

export interface MarketingUnsubscribe {
  readonly tenantId: string;
  readonly emailLower: EmailLower;
  readonly memberId: string | null;

  readonly reason: MarketingUnsubscribeReason;
  readonly reasonText: string | null;
  readonly sourceBroadcastId: BroadcastId | null;
  readonly sourceTokenHash: string | null;

  readonly unsubscribedAt: Date;
}
