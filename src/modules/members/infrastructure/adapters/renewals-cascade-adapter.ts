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
  makeRenewalsDeps,
} from '@/modules/renewals';
import { logger } from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import type {
  RenewalsCascadePort,
  RenewalsCascadeResult,
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
        // caller emits a metric / audit signal.
        logger.error(
          {
            err: result.error.message,
            tenantId: tenant.slug,
            memberId: memberId as string,
            cascade: 'f8_in_flight_cycle_cancel',
          },
          'members.archive.renewals_cascade_failed',
        );
        return { outcome: 'cascade_failed' };
      }

      // Translate the F8 outcome to the F3-port outcome. F8's union
      // already covers `'ok' | 'cascade_partial_failure' | 'cascade_failed'`
      // 1-to-1 with F3 — pass through.
      if (result.value.outcome === 'cascade_partial_failure') {
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
};
