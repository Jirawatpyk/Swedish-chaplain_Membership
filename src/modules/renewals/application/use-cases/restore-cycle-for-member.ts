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
 *   Instead we re-use `createCycleInTx` (the shared cold-start creator the
 *   member import + create-member onboarding listener use) with
 *   `anchorToCurrentPeriod`, anchored at the member's PAID-THROUGH FRONTIER.
 *
 *   Frontier anchoring (Cluster 4 review-fix — money BLOCKER):
 *   `periodFrom = maxPaidThrough ?? registration_date`, where
 *   `maxPaidThrough = MAX(period_to)` over the member's cycles that
 *   represent paid coverage (`status='completed' OR anchored_at IS NOT
 *   NULL` — `findMaxPaidThroughForMemberInTx`). Anchoring at the current
 *   membership period via the registration ANNIVERSARY (the naive choice)
 *   is WRONG for a member who has paid a renewal: the rolling-anchor model
 *   moves a paid period OFF the anniversary, so an anniversary-anchored
 *   restore could OVERLAP the already-paid window → the enter-awaiting cron
 *   issues a DUPLICATE invoice (double-bill) + two cycles cover the same
 *   span. Starting at the frontier makes the restored cycle GAPLESS after
 *   the last paid period. `anchorToCurrentPeriod` stays ON in ALL cases —
 *   it advances by whole term multiples until `periodTo > now`:
 *     - no paid history (`null` → registration_date, possibly years past):
 *       advances forward to the CURRENT period (not a decade-old expired
 *       cycle) — the fresh-import behaviour, unchanged.
 *     - frontier already >= now (paid-current / paid-ahead): the first
 *       iteration's `frontier + term > now` holds, so it returns the
 *       frontier UNCHANGED (no wrong advance) → the restored cycle starts
 *       exactly at the paid frontier, gapless, no overlap.
 *     - frontier in the past (paid then lapsed for a gap): advances past the
 *       unpaid gap years to the current period — correct, and still no
 *       overlap with the (older) paid window.
 *   `createCycleInTx` freezes the plan's live price at creation. The old
 *   cancelled cycle is left cancelled (append-only forensic trail:
 *   "cancelled at archive"), and a fresh `renewal_cycle_created` audit
 *   records the restore. No new `audit_event_type` enum value is introduced.
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
   * ISO 8601 UTC — the member's `registration_date`. This is the FALLBACK
   * anchor used ONLY when the member has NO paid coverage (fresh import;
   * `findMaxPaidThroughForMemberInTx` returns null). For a member WITH paid
   * history the restored cycle is anchored at the PAID-THROUGH frontier
   * instead (see the module docstring). Either way `anchorToCurrentPeriod`
   * advances the anchor to the CURRENT membership period so a long-standing
   * member does not land on a years-past (already-lapsed) window.
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
  /**
   * The F3 undelete's `requestId` (the SAME value stamped on the
   * `member_undeleted` audit row). Cluster 4 review-fix (FIX 2): threaded as
   * the `renewal_cycle_created` `correlationId` below so an auditor can
   * correlate the restore's cycle-creation with the undelete that triggered
   * it. Previously a dead param.
   */
  readonly requestId: string | null;
  /**
   * Fallback correlation id (a fresh UUID minted by the adapter) used only
   * when `requestId` is null — in practice never, since F3's undelete always
   * carries a non-null requestId. Kept as a defensive non-null anchor because
   * `createCycleInTx` requires a non-null `correlationId`.
   */
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

  // FIX 2 — link the restore's `renewal_cycle_created` audit to the
  // `member_undeleted` row via the shared undelete requestId (falls back to
  // the adapter-minted UUID only if requestId is null — never in practice).
  const correlationId = input.requestId ?? input.correlationId;

  try {
    const outcome = await runInTenant(input.tenant, async (tx) => {
      // FIX 1 (money BLOCKER) — anchor at the member's PAID-THROUGH frontier,
      // NOT the registration anniversary. `MAX(period_to)` over paid coverage
      // (completed OR anchored) → the restored cycle starts gapless AFTER the
      // last paid period, so it never overlaps an already-paid window
      // (double-bill). `null` (no paid history) falls back to registration_date.
      // `anchorToCurrentPeriod` (below) then advances the anchor to the current
      // period as needed — a no-op for a frontier already >= now, so the paid
      // frontier is preserved exactly. See the module docstring case analysis.
      const maxPaidThrough = await deps.cyclesRepo.findMaxPaidThroughForMemberInTx(
        tx,
        input.tenant.slug,
        input.memberId as string,
      );
      return createCycleInTx(createDeps, tx, {
        tenantId: input.tenant.slug,
        memberId: input.memberId as string,
        periodFrom: maxPaidThrough ?? input.registrationDateIso,
        planId: input.planId,
        actorUserId: input.initiatedByUserId,
        actorRole: 'system',
        correlationId,
        // A restored cycle re-enters the normal pipeline as `'upcoming'` (the
        // createCycleInTx default) — restore is NOT a bill, so it is NOT
        // `awaiting_payment`.
        //
        // KNOWN 065 §5.3 GAP (final-review S1, tracked in the design doc's
        // Post-review follow-ups): archive→undelete of a NEVER-PAID
        // born-`awaiting_payment` member re-enters here as `'upcoming'` =
        // full access, bypassing the §5.3 no-benefits-until-paid gate until
        // the T-0 flip re-suspends them at period end. NOT fixed in-place
        // because no safe discriminator exists in the DB: `maxPaidThrough`
        // is null for the imported-110 cohort too (their paid coverage
        // predates the system; cycles are unanchored), so gating on it
        // would restore PAID imported members as suspended — the exact
        // prod incident the §5.3 design MUST-NOTs forbid. The real fix
        // needs the pre-archive status preserved through the archive
        // cascade (e.g. a `closed_previous_status` column).
        anchorToCurrentPeriod: { nowIso: deps.clock.now().toISOString() },
      });
    });

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
