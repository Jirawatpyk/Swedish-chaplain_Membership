/**
 * T028 — `MarketingUnsubscribesRepo` Application port (F7).
 *
 * Tenant-scoped suppression list repository. Natural composite PK
 * `(tenant_id, email_lower)`; idempotent upsert is the primary write
 * pattern (replaying an unsubscribe is safe — last-write-wins with
 * appropriate audit chain).
 *
 * Retention: indefinite per GDPR Art. 21 + PDPA §32. The
 * `setMemberIdNull` method is the Art. 17 cascade hook called by F3
 * member erasure; the suppression record is RETAINED but the
 * `member_id` foreign key reference is severed.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type {
  MarketingUnsubscribe,
  MarketingUnsubscribeReason,
} from '../../domain/marketing-unsubscribe';
import type { EmailLower } from '../../domain/value-objects/email-lower';
import type { BroadcastId } from '../../domain/broadcast';

export interface NewSuppressionInput {
  readonly tenantId: string;
  readonly emailLower: EmailLower;
  readonly memberId: string | null;
  readonly reason: MarketingUnsubscribeReason;
  readonly reasonText: string | null;
  readonly sourceBroadcastId: BroadcastId | null;
  readonly sourceTokenHash: string | null;
}

export interface MarketingUnsubscribesRepo {
  /**
   * Idempotent insert via `ON CONFLICT (tenant_id, email_lower)
   * DO UPDATE SET reason = EXCLUDED.reason, source_token_hash =
   * EXCLUDED.source_token_hash, ...`. Returns the canonical row
   * post-upsert.
   *
   * `{wasNew: true}` indicates first-time suppression (caller emits
   * `broadcast_unsubscribed` audit). `{wasNew: false}` indicates a
   * replay — caller skips re-emit (idempotent per FR-030).
   */
  upsert(
    tx: unknown,
    input: NewSuppressionInput,
  ): Promise<{
    readonly wasNew: boolean;
    readonly suppression: MarketingUnsubscribe;
  }>;

  findByEmailLower(
    tenantId: string,
    emailLower: EmailLower,
  ): Promise<MarketingUnsubscribe | null>;

  /**
   * Batch lookup — used by the dispatch path before sending to filter
   * out suppressed recipients in a single query. Returns the set of
   * suppressed `email_lower` values; recipients NOT in the set are
   * eligible.
   */
  lookupBatch(
    tenantId: string,
    emailLowers: ReadonlyArray<EmailLower>,
  ): Promise<ReadonlySet<EmailLower>>;

  /**
   * Art. 17 cascade — set `member_id` to NULL on every suppression
   * row that referenced the erased member. Suppression records are
   * RETAINED (we still must not contact the email).
   */
  setMemberIdNull(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly affected: number }>;
}
