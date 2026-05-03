/**
 * BroadcastsCascadePort adapter — bridges F3 archival/erasure → F7
 * `cancelInFlightBroadcastsForMember` (T178a, Coverage Gap C2).
 *
 * Single allowed F3 → F7 crossing point. Imports F7's public barrel
 * (`@/modules/broadcasts`) — Constitution Principle III barrel-guard
 * permits cross-module reads of public exports. Internal F7 modules
 * (`./application`, `./infrastructure`) are NOT imported.
 */
import {
  cancelInFlightBroadcastsForMember,
  makeCancelInFlightBroadcastsForMemberDeps,
} from '@/modules/broadcasts';
import { logger } from '@/lib/logger';
import type { BroadcastsCascadePort } from '../../application/ports/broadcasts-cascade-port';

/**
 * No-op cascade adapter for tests that don't exercise the F7 boundary
 * (T199 H-1 closure — `BroadcastsCascadePort` is required in
 * production deps; tests inject this stub instead of leaving the dep
 * `undefined`).
 */
export const noopBroadcastsCascadeAdapter: BroadcastsCascadePort = {
  async cancelInFlightForMember() {
    return {
      outcome: 'ok',
      cancelledCount: 0,
      skippedConcurrentCount: 0,
    };
  },
};

export const f7BroadcastsCascadeAdapter: BroadcastsCascadePort = {
  async cancelInFlightForMember(tenant, memberId, opts) {
    const deps = makeCancelInFlightBroadcastsForMemberDeps(tenant.slug);
    const result = await cancelInFlightBroadcastsForMember(deps, {
      tenant,
      memberId,
      ...(opts.cancellationReason !== undefined
        ? { cancellationReason: opts.cancellationReason }
        : {}),
      requestId: opts.requestId,
      initiatedByUserId: opts.initiatedByUserId,
    });
    if (!result.ok) {
      // F7 cascade failure is non-fatal for F3 archival — the member
      // archive should succeed even if a broadcast cascade glitch
      // leaves a few broadcasts in-flight. Log + return `cascade_failed`
      // outcome so the F3 caller can emit a metric / audit signal that
      // distinguishes this from the no-in-flight case (which returns
      // `outcome: 'ok'` with zeros). Ops can re-run cascade manually
      // via the audit-driven cleanup runbook.
      logger.error(
        {
          err: result.error.message,
          tenantId: tenant.slug,
          memberId: memberId as string,
          cascade: 'f7_in_flight_broadcast_cancel',
        },
        'members.archive.broadcasts_cascade_failed',
      );
      return { outcome: 'cascade_failed' };
    }
    // Round 5 review fix — translate per-broadcast unexpected-error
    // signal from the use-case into the third port-level outcome
    // variant so the F3 caller can audit a partial cascade explicitly,
    // not only via metric.
    if (result.value.unexpectedErrorCount > 0) {
      return {
        outcome: 'cascade_partial_failure',
        cancelledCount: result.value.cancelledCount,
        skippedConcurrentCount: result.value.skippedConcurrentCount,
        unexpectedErrorCount: result.value.unexpectedErrorCount,
      };
    }
    return {
      outcome: 'ok',
      cancelledCount: result.value.cancelledCount,
      skippedConcurrentCount: result.value.skippedConcurrentCount,
    };
  },
};
