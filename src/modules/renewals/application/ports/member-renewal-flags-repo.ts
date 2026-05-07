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
 *
 * `tx: TenantTx` brand (J6-H6): the platform-wide Drizzle pg-transaction
 * type from `@/lib/db`. Importing the type alias is permitted by the
 * Application-layer ESLint guard (only the `drizzle-orm` package itself
 * is forbidden, not the project's `@/lib/db` re-export). Replacing the
 * prior `tx: unknown` prevents accidentally passing the wrong arg in
 * the first slot — TS now rejects `null`, the deps object, etc.
 */
import type { TenantTx } from '@/lib/db';

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

/**
 * Phase 5 Wave A (T124 / T135) — generic toggle-result for boolean
 * flag mutations on `members`. `previousValue` is the prior flag state
 * BEFORE the mutation so the use-case can branch on idempotency
 * without an extra round-trip read.
 */
export interface MemberFlagToggleResult {
  readonly previousValue: boolean;
  readonly affectedRows: number;
}

/**
 * Phase 5 Wave A (T135) — input shape for setting the
 * `blocked_from_auto_reactivation` flag. Migration 0094's CHECK
 * constraint requires `_at IS NOT NULL` AND `_set_by_user_id IS NOT
 * NULL` whenever the flag is TRUE; `_reason` is optional but
 * recommended for forensic clarity. Adapter sets `_at = NOW()`.
 */
export interface SetBlockedFromAutoReactivationInput {
  readonly memberId: string;
  readonly actorUserId: string;
  readonly reason?: string;
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
    tx: TenantTx,
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
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberRenewalFlagsMutationResult>;

  /**
   * Phase 5 Wave A (T124) — Set `members.renewal_reminders_opted_out=TRUE`
   * + `renewal_reminders_opted_out_at=NOW()` per FR-016. Member self-
   * service portal route exposes this as a single toggle. Cron skips
   * email but still lists the cycle in pipeline + creates tasks.
   * Idempotent — re-setting preserves the original opt-out timestamp.
   */
  setRenewalRemindersOptedOut(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave A (T124) — Clear opt-out (member opts back in).
   * `renewal_reminders_opted_out=FALSE` + `renewal_reminders_opted_out_at=NULL`.
   */
  clearRenewalRemindersOptedOut(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave A (T135) — Admin override to block auto-reactivation
   * on lapsed cycles per FR-005b. Sets `blocked_from_auto_reactivation=
   * TRUE` + `_at=NOW()` + `_set_by_user_id=actorUserId` + `_reason=...`
   * atomically. CHECK constraint guarantees the four columns stay
   * consistent. Idempotent — re-block by the same admin preserves
   * original `_at`.
   */
  setBlockedFromAutoReactivation(
    tx: TenantTx,
    tenantId: string,
    input: SetBlockedFromAutoReactivationInput,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave A (T135) — Clear block (admin unblocks). All four
   * columns reset to (FALSE, NULL, NULL, NULL) atomically per the
   * CHECK constraint.
   */
  clearBlockedFromAutoReactivation(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<MemberFlagToggleResult>;

  /**
   * Phase 5 Wave B (T123) — read the `blocked_from_auto_reactivation`
   * flag in the same tx as a downstream cycle transition. The F4
   * onPaidCallback uses this to decide whether a paid lapsed cycle
   * should auto-complete (default) or hold in `pending_admin_reactivation`
   * (override). Returns `null` when the member row is RLS-hidden or
   * non-existent.
   */
  readBlockedFromAutoReactivation(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<boolean | null>;
}
