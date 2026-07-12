/**
 * Application port — F8 renewals cascade for member lifecycle events.
 *
 * Auto-cancels in-flight renewal cycles owned by an archived/erased
 * member. Used by `archive-member` and future `erase-member` (F9 GDPR
 * Art. 17) use-cases. Mirrors `BroadcastsCascadePort` shape for
 * consistency — chamber DPO compliance reports filter on the same
 * `SystemCancellationReason` union across F7 + F8.
 *
 * Cross-module note: renewal cycles live in F8 (`renewals/application`).
 * The adapter is the single allowed crossing point for F3 use-cases;
 * Application-layer callers depend only on this port. Adapter calls
 * F8's barrel export `cancelInFlightCyclesForMember`.
 *
 * Tx semantics: F8's cascade use-case opens its own short transaction
 * inside `runInTenant` per cycle (per-cycle row lock; concurrent races
 * on individual cycles do not roll back the whole F3 archive). The F3
 * caller does NOT pass its own tx — F3 archival commits first, then
 * the cascade runs as a follow-up best-effort step (mirrors F7
 * pattern at `archive-member.ts:228`).
 */
import type { MemberId } from '../../domain/member';
import type { TenantContext } from '@/modules/tenants';
import type { SystemCancellationReason } from './broadcasts-cascade-port';

// Re-export the F7 union so a single SystemCancellationReason type
// flows across both cascades — chamber legal reports filter on one
// canonical enum, not two parallel-but-divergent ones.
export type { SystemCancellationReason } from './broadcasts-cascade-port';

export interface RenewalsCascadePort {
  /**
   * Cancel every in-flight renewal cycle owned by `memberId`.
   * Idempotent — replays return `{cancelledCount: 0}` once cascade has
   * run.
   *
   * `cancellationReason` is OPTIONAL at the port level (no default).
   * When omitted, the F8 adapter (`f8RenewalsCascadeAdapter` at
   * `infrastructure/adapters/renewals-cascade-adapter.ts`) records
   * the audit `payload.reason` as `'originator_member_archived'`
   * (F8's internal vocabulary — distinct from F7's
   * `'originator_member_deleted'` because F8 cascades only fire
   * from archive in MVP, not hard-delete). F3 callers may pass an
   * explicit `SystemCancellationReason` value (e.g.
   * `'gdpr_erasure_request'`) for compliance differentiation; the
   * adapter maps the F7-canonical enum into the F8 reason space
   * via `toF8Reason()`.
   *
   * `initiatedByUserId` records the F3 admin who initiated the
   * archive/erasure. Audit `actor_user_id` carries it for forensic
   * linkage; the F8 audit `actor_role` is `'system'` because the
   * cascade itself is system-initiated (the member is the subject,
   * not the actor).
   *
   * Returns the count of cycles cancelled + count skipped due to a
   * concurrent admin cancel that won the race.
   */
  cancelInFlightForMember(
    tenant: TenantContext,
    memberId: MemberId,
    opts: {
      readonly cancellationReason?: SystemCancellationReason;
      readonly initiatedByUserId: string | null;
      readonly requestId: string | null;
    },
  ): Promise<RenewalsCascadeResult>;

  /**
   * Cluster 4 (2026-07-12) — the SYMMETRIC counterpart of
   * `cancelInFlightForMember`. Called by F3's `undelete-member` use-case
   * (POST-COMMIT best-effort) when a member is restored
   * (`status='archived' → 'active'`).
   *
   * `cancelInFlightForMember` cancels the in-flight cycle on archive, so an
   * un-deleted member would otherwise have NO active cycle and silently drop
   * out of the renewal pipeline. This method idempotently RE-CREATES one
   * active cycle for the member, anchored to the CURRENT membership period
   * (registration anniversary) via the F8 `createCycleInTx` +
   * `anchorToCurrentPeriod` path (the same cold-start path the member import
   * and create-member onboarding use). It does NOT un-cancel the exact old
   * cancelled cycle — that window may be long-expired by undelete time; the
   * fresh cycle carries correct, non-expired dates. Reuses the existing
   * `renewal_cycle_created` audit event (no new `audit_event_type`).
   *
   * IDEMPOTENT — the F8 `findActiveForMemberInTx` in-tx guard no-ops when an
   * active cycle already exists (`outcome: 'skipped_active_exists'`), and the
   * `renewal_cycles_active_member_uniq` partial index is the concurrency
   * backstop. Best-effort: a failure returns a typed non-`restored` outcome;
   * the F3 caller logs + emits a metric and does NOT fail the undelete.
   *
   * `initiatedByUserId` records the F3 admin who undeleted the member
   * (audit `actor_user_id`); the `renewal_cycle_created` `actor_role` is
   * `'system'` (system-initiated side-effect of the undelete).
   */
  restoreForMember(
    tenant: TenantContext,
    memberId: MemberId,
    opts: {
      readonly initiatedByUserId: string | null;
      readonly requestId: string | null;
    },
  ): Promise<RenewalsRestoreResult>;
}

/**
 * Outcome of `restoreForMember`. Best-effort — the F3 undelete caller
 * branches on this for observability (a `restore_failed` means the member
 * has no active cycle and needs an operator follow-up), never to fail the
 * undelete.
 *
 *   - `'restored'`              → a fresh active cycle was created.
 *   - `'skipped_active_exists'` → the member already held an active cycle
 *                                 (idempotent replay / concurrent create) —
 *                                 no duplicate created.
 *   - `'skipped_member_absent'` → the member could not be read (absent /
 *                                 cross-tenant via RLS / read error). No-op.
 *   - `'restore_failed'`        → the F8 restore use-case errored (plan
 *                                 unresolvable, or an unexpected throw). The
 *                                 member is left WITHOUT an active cycle;
 *                                 ops must re-attempt (e.g. admin renew).
 */
export type RenewalsRestoreResult =
  | { readonly outcome: 'restored'; readonly cycleId: string }
  | { readonly outcome: 'skipped_active_exists' }
  | { readonly outcome: 'skipped_member_absent' }
  | { readonly outcome: 'restore_failed' };

/**
 * Discriminated union over the F3 ↔ F8 cascade outcome. Mirrors F7's
 * `CascadeResult` shape exactly — F3 caller branches symmetrically on
 * both port outcomes for partial-failure logging + cleanup runbook
 * reconciliation.
 *
 *   - `'ok'`                       → cascade ran end-to-end. Counts may
 *                                    legitimately be 0 when the member
 *                                    had no in-flight cycle (idempotent
 *                                    replay).
 *   - `'cascade_partial_failure'`  → cascade started but a concurrent
 *                                    admin cancel won the race for the
 *                                    cycle. F3 archival still commits;
 *                                    a follow-up audit row records the
 *                                    outcome so cleanup runbook can
 *                                    re-attempt cancellation.
 *   - `'cascade_failed'`           → the F8 cascade use-case ITSELF
 *                                    errored before it could iterate
 *                                    (e.g. lookup query threw). Counts
 *                                    are not surfaced. F3 archival
 *                                    still commits (cascade is best-
 *                                    effort).
 */
export type RenewalsCascadeResult =
  | {
      readonly outcome: 'ok';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
    }
  | {
      readonly outcome: 'cascade_partial_failure';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
    }
  | { readonly outcome: 'cascade_failed' };
