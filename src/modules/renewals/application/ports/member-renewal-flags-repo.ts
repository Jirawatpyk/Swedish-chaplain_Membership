/**
 * F8 Phase 4 Wave I2b — `MemberRenewalFlagsRepo` Application port.
 *
 * F8-internal port for the F8-owned lifecycle of two flags on the F3
 * `members` table: `email_unverified` (BOOLEAN) +
 * `email_unverified_at` (TIMESTAMPTZ). F3 only DEFINES the schema (Phase
 * 2 Wave C migration 0094); F8 OWNS the writes:
 *
 *   - T090 `detectBounceThreshold` (Wave I2d) → `setEmailUnverified`
 *   - T091 `resetEmailUnverified` (this wave) → `clearEmailUnverified`
 *
 * Keeping the surface inside F8 avoids invasive changes to F3's public
 * `MemberRepo` port — F3 stays stable; F8 owns the renewal-relevant
 * mutations through its own port + adapter that deep-imports F3's
 * Drizzle schema (precedent: `drizzle-renewal-cycle-repo.ts` line 26).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface MemberRenewalFlagsMutationResult {
  /**
   * The PRIOR state of `email_unverified` BEFORE the mutation. Lets the
   * use-case branch on "was this a meaningful change" without an extra
   * round-trip read. Adapter computes via single `RETURNING old_value`
   * pattern.
   *
   * NOTE: when the member row is RLS-hidden (cross-tenant probe) or
   * non-existent, the adapter returns `previouslyUnverified=false` AND
   * `affectedRows=0` so the use-case can detect the no-op case.
   */
  readonly previouslyUnverified: boolean;
  /**
   * Number of rows affected by the UPDATE. `0` on RLS-hidden /
   * non-existent member; `1` on successful mutation.
   */
  readonly affectedRows: number;
}

export interface MemberRenewalFlagsRepo {
  /**
   * Set `members.email_unverified=TRUE` + `email_unverified_at=NOW()`.
   * Used by T090 detect-bounce-threshold when bounce thresholds cross.
   * Idempotent — re-setting an already-true flag does NOT update
   * `email_unverified_at` (preserves the original threshold-crossing
   * timestamp).
   */
  setEmailUnverified(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<MemberRenewalFlagsMutationResult>;

  /**
   * Set `members.email_unverified=FALSE` + `email_unverified_at=NULL`.
   * Used by T091 reset-email-unverified when F1 verification flow
   * succeeds. Idempotent — clearing an already-false flag is a no-op
   * silent return (`previouslyUnverified=false`, `affectedRows=1` if
   * the row exists).
   */
  clearEmailUnverified(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<MemberRenewalFlagsMutationResult>;
}
