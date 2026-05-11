/**
 * F8 Phase 9 / T238 — F3 archival/erasure cascade for in-flight
 * renewal cycles.
 *
 * Invoked by F3's `archive-member` use-case AFTER the member row
 * mutation commits. Per `data-model.md § renewal_cycles Invariants`
 * ("at most ONE cycle in status NOT IN
 * ('completed','lapsed','cancelled') per (tenant_id, member_id)")
 * there is at most ONE non-terminal cycle per member, so this is a
 * single-cycle cascade — but we route through the
 * `findActiveForMember` port to stay robust if the invariant is
 * ever relaxed.
 *
 * Behaviour:
 *   1. Look up the active cycle (status NOT IN
 *      `lapsed | cancelled | completed`). Returns `outcome: 'ok'` with
 *      `cancelledCount: 0` when none exists (idempotent — safe to
 *      replay).
 *   2. Open `runInTenant` + acquire per-cycle advisory lock to defeat
 *      a concurrent admin cancel.
 *   3. Re-load inside the lock (TOCTOU defence).
 *   4. Transition to `cancelled` with `closedReason: 'cancelled'`.
 *   5. Emit `renewal_cycle_cancelled` audit with `payload.reason`
 *      carrying the cascade discriminator (`'originator_member_archived'`,
 *      `'gdpr_erasure_request'`, or `'pdpa_deletion_request'`) so
 *      forensic dashboards can distinguish the system-initiated
 *      cascade from an admin manual cancel.
 *
 * Reuse-existing-event design choice: F8 does NOT introduce a new
 * audit event type for the cascade. The `renewal_cycle_cancelled`
 * payload's `reason` field is a free-form string (sanitized) — passing
 * the cascade discriminator there avoids:
 *   - bumping `F8_AUDIT_EVENT_TYPES` count (concurrent-PR coordination)
 *   - shipping a new pgEnum migration
 *   - re-running the 64-event audit catalogue downstream consumers
 *
 * Mirrors F7's `cancelInFlightBroadcastsForMember` design (no new
 * `f7_cascade_for_archived_member` event — reuses `broadcast_cancelled`
 * with a system-actor + cascade reason).
 *
 * Concurrency: per-(tenant, cycle) advisory lock + WHERE-status
 * optimistic check. A concurrent admin cancel that wins the race
 * leaves this cascade as a no-op (cycle already terminal — safe).
 *
 * Failure modes are aggregated into `CascadeResult`:
 *   - `'ok'`                       — cascade ran end-to-end (count may
 *                                    be 0 when no in-flight cycle
 *                                    existed; idempotent replay).
 *   - `'cascade_partial_failure'`  — cycle existed but the transition
 *                                    failed (typically a
 *                                    `CycleTransitionConflictError`
 *                                    from a concurrent cancel).
 *   - `'cascade_failed'`           — the cascade use-case ITSELF errored
 *                                    before it could run (e.g. lookup
 *                                    query threw). F3 archival still
 *                                    commits per F7 precedent.
 */
import { err, ok, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';
import { isTerminalCycleStatus } from '../../domain/value-objects/cycle-status';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

/**
 * Cascade discriminator. Mirrors F7's `SystemCancellationReason` for
 * consistency across cascade ports — chamber DPO compliance reports
 * filter on the same enum across F7 + F8.
 */
export type RenewalsCascadeReason =
  | 'originator_member_archived'
  | 'gdpr_erasure_request'
  | 'pdpa_deletion_request';

export interface CancelInFlightCyclesForMemberInput {
  readonly tenant: TenantContext;
  readonly memberId: MemberId;
  /**
   * Reason recorded in `renewal_cycle_cancelled.payload.reason`. Default
   * `'originator_member_archived'` matches the F3 archive call path; F3
   * callers may pass a more specific value for compliance
   * differentiation (GDPR Art. 17 vs PDPA §33 vs default archive).
   */
  readonly cascadeReason?: RenewalsCascadeReason;
  /**
   * F3 admin who initiated the archive/erasure. Recorded as the audit
   * `actorUserId` so the forensic chain links member → archive event
   * → cascade event. Pass `null` for system-driven flows (cron
   * housekeeping, GDPR self-service erasure).
   */
  readonly initiatedByUserId: string | null;
  readonly requestId: string | null;
  readonly correlationId: string;
}

/**
 * Phase 9 verify-fix Round-2 close — typed marker class for audit-emit
 * failures. Replaces the prior Round-1 substring heuristic (`message
 * .includes('audit')`) which had documented false-positive risk
 * (Postgres `audit_log` table errors masquerade) AND false-negative
 * risk (custom `AuditEmitError` whose message is "Resend webhook
 * unavailable" wouldn't match).
 *
 * Audit emitter adapters (e.g. `drizzleRenewalAuditEmitter`) wrap
 * `audit_log` insert errors in this class so the cascade use-case
 * can classify via `instanceof AuditEmitError` — structural typing,
 * not lexical heuristic.
 *
 * Carries `cause` per ES2022 Error options so the underlying
 * Postgres / Drizzle error stack stays intact for triage.
 */
export class AuditEmitError extends Error {
  override readonly name = 'AuditEmitError';
  /**
   * Underlying Postgres / Drizzle / network error class name —
   * e.g. `'PostgresError'`, `'NeonDbError'`. Surfaces in adapter
   * logs + cascade use-case Output's `auditEmitErrorName` field.
   */
  readonly underlyingErrorName: string;
  /**
   * Phase 9 Round-3 close — Postgres / Drizzle SQLSTATE code if the
   * underlying error carried one. Without this, operators triaging
   * an "audit-emit failure" surge see `errName: 'NeonDbError'` but
   * cannot distinguish `22P02` (invalid pgEnum) from `40001`
   * (serialization failure) from `08006` (connection lost).
   * `cause.code` is opaque to most call paths because pino's default
   * Error serializer drops it (logger logs `err: errMessage` string,
   * not the Error object), so capture it at construction time.
   */
  readonly underlyingErrorCode: string | undefined;

  constructor(
    message: string,
    options: {
      cause: unknown;
      underlyingErrorName: string;
      underlyingErrorCode?: string;
    },
  ) {
    super(message, { cause: options.cause });
    this.underlyingErrorName = options.underlyingErrorName;
    this.underlyingErrorCode = options.underlyingErrorCode;
  }
}

/**
 * Discriminated union over cascade outcome — Phase 9 verify-fix
 * close-on-review: replaces a flat `{outcome, counts}` interface where
 * `{outcome: 'cascade_failed', cancelledCount: 5}` was compile-
 * constructible. Now field-presence is tied to discriminant, mirroring
 * the port-level `RenewalsCascadeResult` shape exactly.
 *
 *   - `'ok'`                       → cascade ran end-to-end. Counts
 *                                    may be 0 when no in-flight cycle
 *                                    existed (idempotent replay).
 *   - `'cascade_partial_failure'`  → cycle existed but transition
 *                                    failed via concurrent admin
 *                                    cancel race. Counts surface the
 *                                    skipped row.
 *   - `'cascade_audit_emit_failed'`→ distinct outcome for audit-emit
 *                                    failure inside the cascade tx
 *                                    (the tx rolled back per
 *                                    Principle VIII; the cycle stayed
 *                                    in its prior state).
 *                                    Operationally distinct from
 *                                    concurrent-skip — implies the
 *                                    audit pipeline itself is broken,
 *                                    not a benign race.
 *                                    Round-2 close: carries
 *                                    `auditEmitErrorName` +
 *                                    `auditEmitErrorMessage` from the
 *                                    typed `AuditEmitError` so the
 *                                    F3 adapter can log the
 *                                    underlying class without losing
 *                                    forensic context across the
 *                                    use-case ↔ adapter boundary.
 */
export type CancelInFlightCyclesForMemberOutput =
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
  | {
      readonly outcome: 'cascade_audit_emit_failed';
      readonly cancelledCount: number;
      readonly skippedConcurrentCount: number;
      /**
       * Round-2 close: the underlying error class name from the
       * typed `AuditEmitError.underlyingErrorName` (e.g.
       * `'PostgresError'` / `'NeonDbError'`). Adapter logs this so
       * dashboards can group on a stable label.
       */
      readonly auditEmitErrorName: string;
      /**
       * The raw `Error.message` from the underlying audit-emit
       * failure. Sanitised at the adapter logging boundary
       * (`renewals-cascade-adapter.ts`) — no PII per FR-049.
       */
      readonly auditEmitErrorMessage: string;
      /**
       * Round-3 close — Postgres / Drizzle SQLSTATE code when
       * present (e.g. `'22P02'` for invalid pgEnum, `'40001'` for
       * serialization-failure retry, `'08006'` for connection-lost).
       * `undefined` when the underlying error has no SQLSTATE
       * (e.g. plain `TypeError` from a programming bug).
       * Distinguishes "audit pipeline broken" sub-classes that
       * `auditEmitErrorName` alone cannot.
       */
      readonly auditEmitErrorCode: string | undefined;
    };

/**
 * Phase 9 verify-fix close-on-review — extend the Result error to
 * carry both `message` AND `errName` so the adapter can log the
 * underlying error class. Round-2 close: `errName` is now REQUIRED
 * (was optional). Producer at line ~365 uses sentinel fallback
 * `'UnknownError'` when `e` is not an `Error` instance — eliminates
 * the `?? 'unknown'` cast every dashboard query previously needed.
 */
export type CancelInFlightCyclesForMemberError = {
  readonly kind: 'cascade.server_error';
  readonly message: string;
  readonly errName: string;
};

const DEFAULT_REASON: RenewalsCascadeReason = 'originator_member_archived';

function reasonSummary(reason: RenewalsCascadeReason): string {
  switch (reason) {
    case 'gdpr_erasure_request':
      return 'GDPR Art. 17 erasure of originator member';
    case 'pdpa_deletion_request':
      return 'PDPA §33 deletion of originator member';
    case 'originator_member_archived':
      return 'originator member archived';
  }
}

export async function cancelInFlightCyclesForMember(
  deps: RenewalsDeps,
  input: CancelInFlightCyclesForMemberInput,
): Promise<
  Result<
    CancelInFlightCyclesForMemberOutput,
    CancelInFlightCyclesForMemberError
  >
> {
  const reason = input.cascadeReason ?? DEFAULT_REASON;

  try {
    // Look up the at-most-one active cycle (status NOT IN terminal).
    // Per data-model.md § renewal_cycles Invariants ("at most ONE
    // cycle in status NOT IN ('completed','lapsed','cancelled') per
    // (tenant_id, member_id)") there is at most one non-terminal
    // cycle per member; an archived member with no active cycle is
    // the common case (idempotent replay returns 0).
    const activeCycle = await deps.cyclesRepo.findActiveForMember(
      input.tenant.slug,
      input.memberId as string,
    );

    if (!activeCycle) {
      return ok({
        outcome: 'ok',
        cancelledCount: 0,
        skippedConcurrentCount: 0,
      });
    }

    // Defence-in-depth: if the cycle is somehow terminal here (RLS
    // race / weakened invariant), treat as no-op rather than throw.
    if (isTerminalCycleStatus(activeCycle.status)) {
      return ok({
        outcome: 'ok',
        cancelledCount: 0,
        skippedConcurrentCount: 0,
      });
    }

    const closedAt = deps.clock.now().toISOString();

    let cancelledCount = 0;
    let skippedConcurrentCount = 0;

    try {
      await runInTenant(input.tenant, async (tx) => {
        // Per-(tenant, cycle) advisory lock — prevents a concurrent
        // admin cancel from racing past the pre-load check. Same lock
        // namespace as cancel-cycle / mark-paid-offline so the three
        // paths serialise correctly.
        await deps.cyclesRepo.acquireCycleLockInTx(
          tx,
          input.tenant.slug,
          activeCycle.cycleId,
        );

        // Re-load inside the lock (TOCTOU defence).
        const lockedCycle = await deps.cyclesRepo.findByIdInTx(
          tx,
          input.tenant.slug,
          activeCycle.cycleId,
        );
        if (!lockedCycle || isTerminalCycleStatus(lockedCycle.status)) {
          // Concurrent cancel won the race — record as a skipped
          // concurrent transition, not as an error.
          skippedConcurrentCount += 1;
          return;
        }

        await deps.cyclesRepo.transitionStatus(
          tx,
          input.tenant.slug,
          activeCycle.cycleId,
          {
            from: lockedCycle.status,
            to: 'cancelled',
            closedAt,
            closedReason: 'cancelled',
          },
        );

        // Phase 9 verify-fix Round-2 — wrap the audit emit so the
        // outer catch can structurally classify via `instanceof
        // AuditEmitError` (replaces the prior fragile `'audit'`
        // substring heuristic). Re-throw the typed error so
        // `runInTenant` rolls back per Principle VIII.
        try {
          await deps.auditEmitter.emitInTx(
            tx,
            {
              type: 'renewal_cycle_cancelled',
              payload: {
                cycle_id: activeCycle.cycleId,
                member_id: input.memberId,
                // Cascade discriminator goes in `reason` — dashboards
                // pivot on this value to distinguish system-initiated
                // cascades from admin manual cancels.
                reason,
                previous_status: lockedCycle.status,
              },
            },
          {
            tenantId: input.tenant.slug,
            actorUserId: input.initiatedByUserId,
            // System-initiated cancellation — `actorRole: 'system'`
            // even when `initiatedByUserId` is non-null (the admin
            // triggered the F3 archive, not the cycle cancel itself).
            actorRole: 'system',
            correlationId: input.correlationId,
            requestId: input.requestId,
            summary: `Renewal cycle ${activeCycle.cycleId} cancelled — ${reasonSummary(reason)}`,
          },
          );
        } catch (auditErr) {
          // Wrap any audit-emit throw in the typed marker so the
          // outer `txErr` catch can classify structurally. Re-throw
          // INSIDE the runInTenant callback so the tx rolls back
          // per Principle VIII (cycle UPDATE + audit emit are an
          // atomic state↔audit pair). Round-3 close: capture
          // SQLSTATE `code` from the underlying error so dashboards
          // can distinguish pgEnum-violation vs connection-lost vs
          // serialization-failure without re-parsing message text.
          const underlyingCode =
            auditErr !== null &&
            typeof auditErr === 'object' &&
            'code' in auditErr &&
            typeof (auditErr as { code: unknown }).code === 'string'
              ? (auditErr as { code: string }).code
              : undefined;
          throw new AuditEmitError(
            auditErr instanceof Error
              ? auditErr.message
              : String(auditErr),
            {
              cause: auditErr,
              underlyingErrorName:
                auditErr instanceof Error ? auditErr.name : 'UnknownError',
              ...(underlyingCode !== undefined
                ? { underlyingErrorCode: underlyingCode }
                : {}),
            },
          );
        }

        cancelledCount += 1;
      });
    } catch (txErr) {
      if (txErr instanceof CycleTransitionConflictError) {
        // Concurrent admin cancel between lock acquisition + transition
        // — typed conflict, surface as partial.
        return ok({
          outcome: 'cascade_partial_failure',
          cancelledCount,
          skippedConcurrentCount: skippedConcurrentCount + 1,
        });
      }
      if (txErr instanceof CycleNotFoundError) {
        // RLS-hidden between findActiveForMember + lock — treat as ok-empty.
        return ok({
          outcome: 'ok',
          cancelledCount,
          skippedConcurrentCount,
        });
      }
      // Phase 9 verify-fix Round-2 close — distinguish audit-emit
      // failure (Principle VIII rollback path) from concurrent-skip
      // via STRUCTURAL `instanceof AuditEmitError` check (was a
      // fragile `'audit'/'emit'` substring heuristic in Round-1).
      // `runInTenant` rollback already reverted the cycle transition;
      // this branch records the operational signal + threads the
      // typed underlying-error class through the discriminated-union
      // arm so the F3 adapter can log + emit the right metric label
      // without losing forensic context.
      const errMessage =
        txErr instanceof Error ? txErr.message : String(txErr);
      const errName =
        txErr instanceof Error ? txErr.name : 'UnknownError';
      if (txErr instanceof AuditEmitError) {
        logger.error(
          {
            err: errMessage,
            errName,
            underlyingErrorName: txErr.underlyingErrorName,
            underlyingErrorCode: txErr.underlyingErrorCode,
            tenantId: input.tenant.slug,
            memberId: input.memberId as string,
            cycleId: activeCycle.cycleId,
            cascade: 'f3_member_archival_or_erasure',
          },
          'renewals.cascade.audit_emit_failed',
        );
        return ok({
          outcome: 'cascade_audit_emit_failed',
          cancelledCount,
          skippedConcurrentCount,
          auditEmitErrorName: txErr.underlyingErrorName,
          auditEmitErrorMessage: errMessage,
          auditEmitErrorCode: txErr.underlyingErrorCode,
        });
      }
      logger.error(
        {
          err: errMessage,
          errName,
          tenantId: input.tenant.slug,
          memberId: input.memberId as string,
          cycleId: activeCycle.cycleId,
          cascade: 'f3_member_archival_or_erasure',
        },
        'renewals.cascade.tx_failed',
      );
      return ok({
        outcome: 'cascade_partial_failure',
        cancelledCount,
        skippedConcurrentCount,
      });
    }

    logger.info(
      {
        tenantId: input.tenant.slug,
        memberId: input.memberId as string,
        cancelledCount,
        skippedConcurrentCount,
        cascade: 'f3_member_archival_or_erasure',
      },
      'renewals.cascade.completed',
    );

    return ok({
      outcome: 'ok',
      cancelledCount,
      skippedConcurrentCount,
    });
  } catch (e) {
    // Phase 9 Round-3 close — defense-in-depth `instanceof
    // AuditEmitError` check at the outer catch. Currently
    // unreachable (the inner runInTenant catch handles it), but a
    // future refactor that extracts audit emit OUTSIDE runInTenant
    // would otherwise mis-classify it as `cascade.server_error`,
    // losing the `cascade_audit_emit_failed` outcome forensics.
    if (e instanceof AuditEmitError) {
      logger.error(
        {
          err: e.message,
          errName: e.name,
          underlyingErrorName: e.underlyingErrorName,
          underlyingErrorCode: e.underlyingErrorCode,
          tenantId: input.tenant.slug,
          memberId: input.memberId as string,
          cascade: 'f3_member_archival_or_erasure',
        },
        'renewals.cascade.audit_emit_failed_outer_catch',
      );
      return ok({
        outcome: 'cascade_audit_emit_failed',
        cancelledCount: 0,
        skippedConcurrentCount: 0,
        auditEmitErrorName: e.underlyingErrorName,
        auditEmitErrorMessage: e.message,
        auditEmitErrorCode: e.underlyingErrorCode,
      });
    }
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        // Round-3 M1 close — sentinel `'UnknownError'` for non-Error
        // throws (was `undefined`). Matches the producer convention
        // at the Result.err return below + the runInTenant inner-
        // catch convention. Single dashboard label across all
        // cascade.server_error log lines.
        errName: e instanceof Error ? e.name : 'UnknownError',
        tenantId: input.tenant.slug,
        memberId: input.memberId as string,
        cascade: 'f3_member_archival_or_erasure',
      },
      'renewals.cascade.lookup_failed',
    );
    // Phase 9 verify-fix Round-2 — `errName` is REQUIRED
    // (sentinel `'UnknownError'` for non-Error throws). Eliminates
    // the `?? 'unknown'` cast every dashboard query previously
    // needed and makes group-by-errName statements safe.
    return err({
      kind: 'cascade.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
      errName: e instanceof Error ? e.name : 'UnknownError',
    });
  }
}
