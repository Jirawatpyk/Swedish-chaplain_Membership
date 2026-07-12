/**
 * RenewalsCascadePort adapter — bridges F3 archival/erasure → F8
 * `cancelInFlightCyclesForMember` (Phase 9 / T239). Mirror of
 * `broadcasts-cascade-adapter.ts`.
 *
 * Single allowed F3 → F8 crossing point. Imports F8's public barrel
 * (`@/modules/renewals`) — Constitution Principle III barrel-guard
 * permits cross-module reads of public exports. Internal F8 modules
 * (`./application`, `./infrastructure`) are NOT imported.
 */
import {
  cancelInFlightCyclesForMember,
  restoreCycleForMember,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { randomUUID } from 'node:crypto';
import { drizzleMemberRepo } from '../db/drizzle-member-repo';
import { asMemberId } from '../../domain/member';
import type {
  RenewalsCascadePort,
  RenewalsCascadeResult,
  RenewalsRestoreResult,
  SystemCancellationReason,
} from '../../application/ports/renewals-cascade-port';

/**
 * No-op cascade adapter for tests that don't exercise the F8 boundary.
 * `RenewalsCascadePort` is required in production deps; tests inject
 * this stub instead of leaving the dep `undefined` (mirrors F7's
 * `noopBroadcastsCascadeAdapter` policy).
 */
export const noopRenewalsCascadeAdapter: RenewalsCascadePort = {
  async cancelInFlightForMember(): Promise<RenewalsCascadeResult> {
    return {
      outcome: 'ok',
      cancelledCount: 0,
      skippedConcurrentCount: 0,
    };
  },
  async restoreForMember(): Promise<RenewalsRestoreResult> {
    // Test no-op: report the idempotent "nothing to do" outcome so callers
    // that assert on the restore outcome see a benign value.
    return { outcome: 'skipped_active_exists' };
  },
};

/**
 * Map F3's `SystemCancellationReason` enum (which uses the F7-canonical
 * `'originator_member_deleted'` value) to F8's internal cascade-reason
 * vocabulary. The mapping is 1-to-1; only the default arm renames.
 */
function toF8Reason(
  reason: SystemCancellationReason | undefined,
):
  | 'originator_member_archived'
  | 'gdpr_erasure_request'
  | 'pdpa_deletion_request' {
  switch (reason) {
    case 'gdpr_erasure_request':
      return 'gdpr_erasure_request';
    case 'pdpa_deletion_request':
      return 'pdpa_deletion_request';
    case 'originator_member_deleted':
    case undefined:
      return 'originator_member_archived';
  }
}

export const f8RenewalsCascadeAdapter: RenewalsCascadePort = {
  async cancelInFlightForMember(tenant, memberId, opts) {
    const deps = makeRenewalsDeps(tenant.slug);
    try {
      const result = await cancelInFlightCyclesForMember(deps, {
        tenant,
        memberId,
        cascadeReason: toF8Reason(opts.cancellationReason),
        initiatedByUserId: opts.initiatedByUserId,
        requestId: opts.requestId,
        // F8 use-case requires a correlationId for the audit emit
        // context. F3 caller doesn't propagate one for this side-effect
        // (the F3 archive's own correlationId belongs to the archive
        // event, not the cascade). Mint a fresh UUID here so the
        // cascade audit row carries its own correlation_id distinct
        // from the F3 archive row.
        correlationId: randomUUID(),
      });

      if (!result.ok) {
        // F8 cascade failure is non-fatal for F3 archival — the member
        // archive should succeed even if a cascade glitch leaves a
        // cycle in-flight. Log + return `cascade_failed` so the F3
        // caller emits a metric / audit signal. Phase 9 verify-fix —
        // propagate `errName` from the use-case Result for triage.
        logger.error(
          {
            err: result.error.message,
            errName: result.error.errName,
            tenantId: tenant.slug,
            memberId: memberId as string,
            cascade: 'f8_in_flight_cycle_cancel',
          },
          'members.archive.renewals_cascade_failed',
        );
        return { outcome: 'cascade_failed' };
      }

      // Translate the F8 outcome to the F3-port outcome. F8's union
      // covers `'ok' | 'cascade_partial_failure' |
      // 'cascade_audit_emit_failed'` — the audit-emit-failed variant
      // (Phase 9 verify-fix) maps to `cascade_partial_failure` at the
      // port level so F3 callers do not need to learn an F8-specific
      // outcome enum, but the inner classification is preserved in
      // the structured log line below for ops triage.
      if (result.value.outcome === 'cascade_partial_failure') {
        return {
          outcome: 'cascade_partial_failure',
          cancelledCount: result.value.cancelledCount,
          skippedConcurrentCount: result.value.skippedConcurrentCount,
        };
      }
      if (result.value.outcome === 'cascade_audit_emit_failed') {
        // Audit-emit failure during the cascade tx — Principle VIII
        // rollback already reverted the cycle transition. Phase 9
        // verify-fix Round-2 close: emit the metric counter with the
        // distinguishing `'audit_emit_failed'` label HERE (at the
        // adapter, BEFORE collapsing to port-level
        // `cascade_partial_failure`). This closes the runbook gap
        // where archive-member.ts emitted `'concurrent_skip'` for
        // ALL `cascade_partial_failure` outcomes — operators can now
        // page on `audit_emit_failed` distinctly via metric.
        renewalsMetrics.cascadeOutcome(tenant.slug, 'audit_emit_failed');
        logger.error(
          {
            tenantId: tenant.slug,
            memberId: memberId as string,
            cancelledCount: result.value.cancelledCount,
            skippedConcurrentCount: result.value.skippedConcurrentCount,
            // Round-2 close: log the underlying error class + message
            // from the typed `AuditEmitError` so dashboards can group
            // on a stable label (vs the prior "generic warn without
            // the underlying class" gap).
            auditEmitErrorName: result.value.auditEmitErrorName,
            auditEmitErrorMessage: result.value.auditEmitErrorMessage,
            cascade: 'f8_audit_emit_failure',
          },
          'members.archive.renewals_cascade_audit_emit_failed',
        );
        return {
          outcome: 'cascade_partial_failure',
          cancelledCount: result.value.cancelledCount,
          skippedConcurrentCount: result.value.skippedConcurrentCount,
        };
      }
      return {
        outcome: 'ok',
        cancelledCount: result.value.cancelledCount,
        skippedConcurrentCount: result.value.skippedConcurrentCount,
      };
    } catch (e) {
      // Adapter is supposed to translate failures to typed outcomes;
      // a throw here means the use-case itself blew up unexpectedly.
      // Treat as cascade_failed so F3 archival continues.
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          errName: e instanceof Error ? e.name : undefined,
          tenantId: tenant.slug,
          memberId: memberId as string,
          cascade: 'f8_in_flight_cycle_cancel',
        },
        'members.archive.renewals_cascade_threw',
      );
      return { outcome: 'cascade_failed' };
    }
  },

  /**
   * Cluster 4 (2026-07-12) — F3 undelete → F8 cycle restore.
   *
   * Reads the member's registration anchor + current plan from F3's OWN
   * member repo (a relative same-module import — NOT a cross-module barrel
   * crossing) inside a short `runInTenant` read tx, then hands the anchor
   * primitives to F8's `restoreCycleForMember` (which opens its own tx to
   * create the cycle + emit the `renewal_cycle_created` audit atomically).
   *
   * The two-tx split mirrors the create-member onboarding bridge (F3
   * supplies the anchor; F8 creates the cycle) and is safe for this
   * POST-COMMIT best-effort path: `createCycleInTx`'s in-tx idempotency
   * guard + the active-cycle unique index prevent duplicates even under a
   * concurrent re-create. Every branch returns a typed
   * `RenewalsRestoreResult` (never throws) so the F3 caller can log + emit
   * a metric without failing the undelete.
   */
  async restoreForMember(tenant, memberId, opts): Promise<RenewalsRestoreResult> {
    try {
      // Resolve the member's registration_date + current plan_id. Absent /
      // cross-tenant (RLS) / read error → skip (best-effort no-op).
      const memberResult = await runInTenant(tenant, (tx) =>
        drizzleMemberRepo.findByIdInTx(tx, asMemberId(memberId as string)),
      );
      if (!memberResult.ok) {
        logger.warn(
          {
            tenantId: tenant.slug,
            memberId: memberId as string,
            repoErrorCode: memberResult.error.code,
            cascade: 'f8_undelete_cycle_restore',
          },
          'members.undelete.renewals_restore_member_absent',
        );
        return { outcome: 'skipped_member_absent' };
      }

      const deps = makeRenewalsDeps(tenant.slug);
      const result = await restoreCycleForMember(deps, {
        tenant,
        memberId,
        planId: memberResult.value.planId,
        // registration_date is a non-null Date on the member aggregate;
        // ISO 8601 UTC anchor (createCycleInTx advances it to the current
        // membership period).
        registrationDateIso: memberResult.value.registrationDate.toISOString(),
        initiatedByUserId: opts.initiatedByUserId,
        requestId: opts.requestId,
        // Mint a fresh correlation id for the restore audit row — distinct
        // from the F3 undelete row's request id (mirrors the cancel adapter).
        correlationId: randomUUID(),
      });

      if (!result.ok) {
        logger.error(
          {
            err: result.error.kind,
            errName:
              result.error.kind === 'restore.server_error'
                ? result.error.errName
                : undefined,
            errMessage:
              result.error.kind === 'restore.server_error'
                ? result.error.message
                : undefined,
            planId:
              result.error.kind === 'restore.plan_not_resolvable'
                ? result.error.planId
                : undefined,
            tenantId: tenant.slug,
            memberId: memberId as string,
            cascade: 'f8_undelete_cycle_restore',
          },
          'members.undelete.renewals_restore_failed',
        );
        return { outcome: 'restore_failed' };
      }

      return result.value.outcome === 'restored'
        ? { outcome: 'restored', cycleId: result.value.cycleId }
        : { outcome: 'skipped_active_exists' };
    } catch (e) {
      // Defence-in-depth: `restoreCycleForMember` never throws, but the
      // member read / deps construction could. Treat any throw as a
      // best-effort failure so the undelete still succeeds.
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          errName: e instanceof Error ? e.name : undefined,
          tenantId: tenant.slug,
          memberId: memberId as string,
          cascade: 'f8_undelete_cycle_restore',
        },
        'members.undelete.renewals_restore_threw',
      );
      return { outcome: 'restore_failed' };
    }
  },
};
