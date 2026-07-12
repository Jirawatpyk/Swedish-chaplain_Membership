/**
 * Cluster 4 (2026-07-12) — F3 undelete → F8 renewal-cycle RESTORE.
 *
 * The symmetric counterpart of `cancelInFlightCyclesForMember`. When a
 * member is ARCHIVED, F3's `archive-member` cancels the in-flight cycle
 * (`cancelInFlightCyclesForMember`, POST-COMMIT best-effort). Undeleting
 * the member (status archived→active) previously restored ONLY the member
 * row — the member silently dropped out of the renewal pipeline because
 * no active cycle existed. This use-case closes that asymmetry: it
 * idempotently RE-CREATES one active renewal cycle for the un-deleted
 * member.
 *
 * Design — RE-CREATE FRESH (not un-cancel the exact cancelled row):
 *
 *   The cascade cancel writes `status='cancelled'` + `closed_reason=
 *   'cancelled'` on the row; the *cascade discriminator* lives only in the
 *   `renewal_cycle_cancelled` audit payload, NOT on the cycle row. So the
 *   row carries no durable "cancelled-by-archive-cascade" marker to safely
 *   pick out for un-cancelling. More importantly, the cancelled cycle's
 *   frozen `period_from`/`period_to` window is FROZEN at archive time and
 *   may be long expired by the time the member is undeleted (archive can
 *   sit up to 90 days) — resurrecting it would immediately re-lapse the
 *   restored member on the next lapse-cron pass.
 *
 *   Instead we re-use the EXACT cold-start creation path the member import
 *   (`scripts/import-members.ts`) and the create-member onboarding listener
 *   (`f8-on-create-member-callbacks.ts`) use: `createCycleInTx` with
 *   `anchorToCurrentPeriod`. That anchors at the member's registration
 *   ANNIVERSARY and advances by whole term multiples to the CURRENT
 *   membership period (068 cluster F) — correct, non-expired dates — and
 *   freezes the plan's live price at creation. The old cancelled cycle is
 *   left cancelled (append-only forensic trail: "cancelled at archive"),
 *   and a fresh `renewal_cycle_created` audit records the restore. No new
 *   `audit_event_type` enum value is introduced.
 *
 *   Trade-off vs un-cancelling: the restored cycle gets a NEW `cycle_id`
 *   and does not resurrect the old cycle's reminder/escalation history —
 *   which is the desired behaviour (those reminders were correctly
 *   cancelled at archive; re-arming stale reminders on an expired window
 *   would be wrong). Priority per the fix brief: correct dates + no
 *   duplicate active cycles.
 *
 * Idempotency: `createCycleInTx`'s in-tx `findActiveForMemberInTx` guard
 * no-ops when the member already holds an active (non-terminal) cycle, so
 * a double-undelete (or a concurrent re-create) does not create a second
 * active cycle. The partial unique index
 * `renewal_cycles_active_member_uniq` is the defence-in-depth backstop —
 * a 23505 from a lost race maps to `skipped_active_exists`, not a server
 * error.
 *
 * Tx semantics: opens its OWN `runInTenant` (re-establishing RLS) — the
 * member row + primary contact + `member_undeleted` audit have already
 * committed durably in F3's undelete tx; this runs as a POST-COMMIT
 * best-effort follow-up (mirrors the F3→F8 cancel cascade + the
 * create-member onboarding listener). A failure is non-fatal: the F3
 * caller (`undelete-member`) logs + emits a metric and does NOT fail the
 * undelete.
 *
 * Pure Application — orchestrates Domain via port interfaces only
 * (Constitution Principle III). No ORM / HTTP / framework / React imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { isUniqueViolation, errorChainMessage } from '@/lib/db-errors';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  createCycleInTx,
  PlanNotResolvableError,
  type CreateCycleInTxDeps,
} from './create-cycle-in-tx';

/**
 * The partial UNIQUE index enforcing "at most one active cycle per member"
 * (`(tenant_id, member_id) WHERE status NOT IN
 * ('lapsed','cancelled','completed')`, migration 0087). A concurrent
 * double-undelete where the loser's in-tx idempotency guard misses (the
 * winner has not committed yet) lets the loser's `createCycleInTx` insert
 * reach this index → 23505. We map THAT 23505 to `skipped_active_exists`
 * (idempotent no-op), NOT an opaque server error. Named explicitly so an
 * unrelated unique constraint's 23505 still surfaces as a genuine error.
 */
const RENEWAL_CYCLES_ACTIVE_MEMBER_UNIQ = 'renewal_cycles_active_member_uniq';

/**
 * Deps subset. Mirrors `admin-renew-lapsed-member`'s `CreateCycleInTxDeps`
 * projection so the unit test mocks a small surface. `makeRenewalsDeps`
 * (full `RenewalsDeps`) satisfies this.
 */
export interface RestoreCycleForMemberDeps
  extends Pick<RenewalsDeps, 'cyclesRepo' | 'auditEmitter' | 'clock'> {
  readonly planLookupForRenewal: CreateCycleInTxDeps['planLookup'];
  readonly cycleIdFactory: CreateCycleInTxDeps['idFactory'];
}

export interface RestoreCycleForMemberInput {
  readonly tenant: TenantContext;
  readonly memberId: MemberId;
  /** The member's current F2 plan id (server-resolved by the F3 adapter). */
  readonly planId: string;
  /**
   * ISO 8601 UTC anchor — the member's `registration_date`. Advanced to
   * the CURRENT membership period by `anchorToCurrentPeriod` so a
   * long-standing member does not land on a years-past (already-lapsed)
   * window.
   */
  readonly registrationDateIso: string;
  /**
   * The F3 admin who initiated the undelete. Recorded as the audit
   * `actor_user_id` for forensic linkage (member → undelete → restore).
   * The `renewal_cycle_created` audit `actor_role` is still `'system'`
   * because the cycle creation is a system-initiated side-effect of the
   * undelete, not a direct admin cycle-create (mirrors the cancel cascade).
   */
  readonly initiatedByUserId: string | null;
  readonly requestId: string | null;
  readonly correlationId: string;
}

export type RestoreCycleForMemberOutput =
  | { readonly outcome: 'restored'; readonly cycleId: string }
  | { readonly outcome: 'skipped_active_exists' };

export type RestoreCycleForMemberError =
  | { readonly kind: 'restore.plan_not_resolvable'; readonly planId: string }
  | {
      readonly kind: 'restore.server_error';
      readonly message: string;
      readonly errName: string;
    };

export async function restoreCycleForMember(
  deps: RestoreCycleForMemberDeps,
  input: RestoreCycleForMemberInput,
): Promise<Result<RestoreCycleForMemberOutput, RestoreCycleForMemberError>> {
  const createDeps: CreateCycleInTxDeps = {
    cyclesRepo: deps.cyclesRepo,
    planLookup: deps.planLookupForRenewal,
    auditEmitter: deps.auditEmitter,
    idFactory: deps.cycleIdFactory,
  };

  try {
    const outcome = await runInTenant(input.tenant, (tx) =>
      createCycleInTx(createDeps, tx, {
        tenantId: input.tenant.slug,
        memberId: input.memberId as string,
        // Anchor at registration_date, advanced to the CURRENT membership
        // period (068 cluster F). Same as the import cold-start + the
        // create-member onboarding listener. A restored cycle re-enters
        // the normal pipeline as `'upcoming'` (the createCycleInTx default)
        // — restore is NOT a bill, so it is NOT `awaiting_payment`.
        periodFrom: input.registrationDateIso,
        planId: input.planId,
        actorUserId: input.initiatedByUserId,
        actorRole: 'system',
        correlationId: input.correlationId,
        anchorToCurrentPeriod: { nowIso: deps.clock.now().toISOString() },
      }),
    );

    if (outcome.kind === 'skipped_active_exists') {
      return ok({ outcome: 'skipped_active_exists' });
    }
    return ok({ outcome: 'restored', cycleId: outcome.cycle.cycleId });
  } catch (e) {
    // Concurrent double-undelete lost the active-cycle uniq race — the
    // member already has an active cycle, so this is the same idempotent
    // no-op as `skipped_active_exists` (no cycle was created by the loser).
    if (
      isUniqueViolation(e) &&
      errorChainMessage(e).includes(RENEWAL_CYCLES_ACTIVE_MEMBER_UNIQ)
    ) {
      return ok({ outcome: 'skipped_active_exists' });
    }
    // `createCycleInTx` throws the typed `PlanNotResolvableError` ONLY when
    // the member's plan cannot be resolved to a frozen price (not_found /
    // plan_inactive). Surface it distinctly so the F3 caller can log the
    // "restored member has no active cycle — plan unresolvable" case; the
    // undelete itself still succeeds (best-effort).
    if (e instanceof PlanNotResolvableError) {
      return err({
        kind: 'restore.plan_not_resolvable',
        planId: input.planId,
      });
    }
    return err({
      kind: 'restore.server_error',
      message: e instanceof Error ? e.message : String(e),
      errName: e instanceof Error ? e.name : 'UnknownError',
    });
  }
}
