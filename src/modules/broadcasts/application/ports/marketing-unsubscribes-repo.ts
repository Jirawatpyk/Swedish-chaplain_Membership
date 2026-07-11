/**
 * T028 — `MarketingUnsubscribesRepo` Application port (F7).
 *
 * Tenant-scoped suppression list repository. Natural composite PK
 * `(tenant_id, email_lower)`; idempotent upsert is the primary write
 * pattern (replaying an unsubscribe is safe — last-write-wins with
 * appropriate audit chain).
 *
 * Retention: indefinite per GDPR Art. 21 + PDPA §32. Per the COMP-1
 * member-erasure design, `marketing_unsubscribes` rows are NEVER erased:
 * the WHOLE row — including the plaintext `email_lower` — is RETAINED so
 * the suppression invariant ("we will never contact this email again")
 * keeps working after the member is erased. `email_lower` is an
 * intentional, documented residual (see
 * `docs/superpowers/specs/2026-06-16-member-erasure-design.md` Known
 * limitations / deferred). The `setMemberIdNull` method below is currently
 * UNWIRED — no production code calls it, and the erasure path does NOT
 * sever `member_id`. Whether to sever the `member_id` back-reference while
 * retaining `email_lower` is a deferred US3 decision.
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

/**
 * Result of an idempotent `upsert(...)`. `wasNew` distinguishes a
 * first-time suppression (caller emits audit) from an idempotent replay
 * (caller skips audit per FR-030). Named so use-cases don't need to
 * spell out `Awaited<ReturnType<...>>` shapes.
 */
export interface UpsertSuppressionResult {
  readonly wasNew: boolean;
  readonly suppression: MarketingUnsubscribe;
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
  ): Promise<UpsertSuppressionResult>;

  /**
   * Bug #10 (code-review) — idempotent suppression upsert that opens its OWN
   * tenant-scoped tx (no caller tx required). Used by the multi-batch webhook
   * path (`applyBatchWebhookEvent`), which — unlike the MVP `processWebhookEvent`
   * — has no surrounding `withTx`. Runs the identical ON CONFLICT precedence
   * SQL as `upsert`. Same `{wasNew}` semantics for audit gating.
   *
   * OPTIONAL so the many partial MarketingUnsubscribesRepo test fixtures need
   * not stub it; the production Drizzle adapter always implements it and the
   * batch webhook path guards on its presence.
   */
  upsertStandalone?(input: NewSuppressionInput): Promise<UpsertSuppressionResult>;

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
   * Sever the `member_id` back-reference on every suppression row that
   * referenced a given member, RETAINING the row (and its plaintext
   * `email_lower`, so suppression survives).
   *
   * CURRENTLY UNWIRED — no production code calls this. The COMP-1
   * member-erasure design retains `marketing_unsubscribes` rows whole
   * (never-erased; `email_lower` is a documented residual), so the
   * erasure cascade does NOT call this. Kept for a deferred US3 decision
   * on whether to sever `member_id` while keeping `email_lower`. Do not
   * delete — US3 may adopt it.
   */
  setMemberIdNull(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly affected: number }>;
}
