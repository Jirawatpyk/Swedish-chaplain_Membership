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
  /**
   * 108 PR-C (FR-024) — the contact that unsubscribed, when the address
   * resolved to a live contact row; `null` from the webhook paths (a bounce
   * or complaint is not a person's act) and when resolution fails. On
   * conflict the repo keeps a prior non-null attribution (COALESCE), so a
   * later webhook event never blanks it.
   */
  readonly contactId: string | null;
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
   * 108 PR-D — every suppressed `email_lower` of the tenant. The members
   * Marketing audience page answers EVERY one of its state filters from this
   * list (`on` and both `off_*` exclude it; `unsubscribed` IS it)
   * (`state=on` excludes suppressed rows at the query; `state=unsubscribed`
   * IS the list), which a per-page `lookupBatch` cannot do truthfully.
   * Bounded: one row per unsubscribe, never per contact.
   *
   * OPTIONAL for the same reason as `upsertStandalone`: the many partial
   * test fixtures of this port need not stub it; the production Drizzle
   * adapter always implements it and the members-side adapter throws when
   * it is absent (never in prod).
   */
  listEmailLowers?(tenantId: string): Promise<ReadonlySet<EmailLower>>;

  /**
   * Sever the `member_id` back-reference on every suppression row that
   * referenced a given member, RETAINING the row (and its plaintext
   * `email_lower`, so suppression survives).
   *
   * SUPERSEDED by `severMemberRefs` (108 PR-C T104), which nulls
   * `contact_id` as well. Still unwired; kept only because ~20 port
   * fixtures stub it — delete together with those stubs in the flag-removal
   * PR (tasks T099).
   */
  setMemberIdNull(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly affected: number }>;

  /**
   * 108 PR-C T104 (FR-056) — the deferred US3 decision, taken: on member
   * erasure, null BOTH back-references (`member_id`, `contact_id`) on every
   * suppression row attributed to the member, RETAINING the row and its
   * `email_lower` (the address-keyed promise outlives the person's record —
   * GDPR Art. 21 / PDPA §32; `email_lower` stays the documented COMP-1
   * residual). Called inside the content-scrub tx by
   * `scrubBroadcastContentForMember`; idempotent (a re-drive affects 0).
   *
   * OPTIONAL for the same reason as `upsertStandalone` / `listEmailLowers`:
   * the partial fixtures of this port need not stub it; the production
   * Drizzle adapter always implements it and the use case throws when it is
   * absent (never in prod).
   */
  severMemberRefs?(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly affected: number }>;
}
