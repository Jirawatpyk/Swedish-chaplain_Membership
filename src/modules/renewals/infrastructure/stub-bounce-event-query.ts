/**
 * Test-only stub `BounceEventQuery` adapter.
 *
 * Returns `{ hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 }`
 * for every member — `detectBounceThreshold` always returns
 * `no_threshold_crossed` outcome under this stub. Production wires
 * `makeDrizzleBounceEventQuery` against F1's `email_delivery_events`
 * (with the `bounce_type` column populated by the F1 Resend webhook).
 * This stub is reserved for unit-test deps composition that wants
 * deterministic zero counts.
 *
 * **Production guard**: throws on call when `NODE_ENV === 'production'`.
 * Preserves the audit-trail invariant (Constitution Principle VIII)
 * by failing loudly if a code path accidentally wires the stub into
 * a production deployment.
 */
import { logger } from '@/lib/logger';
import type {
  BounceCounts,
  BounceEventQuery,
} from '../application/ports/bounce-event-query';

export const stubBounceEventQuery: BounceEventQuery = {
  async countBounces(
    tenantId: string,
    memberId: string,
    args: { readonly cycleStartedAt: string | null; readonly nowIso: string },
  ): Promise<BounceCounts> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `stubBounceEventQuery.countBounces called in production ` +
          `(tenantId=${tenantId}, memberId=${memberId}). Wave I4 must swap ` +
          `this stub for the real Drizzle adapter that reads ` +
          `email_delivery_events with bounce_type classification before ` +
          `flipping FEATURE_F8_RENEWALS=true.`,
      );
    }
    logger.info(
      {
        stub: true,
        tenantId,
        memberId,
        cycleStartedAt: args.cycleStartedAt,
        nowIso: args.nowIso,
      },
      'stubBounceEventQuery.countBounces (returns zeros — Wave I4 swaps this)',
    );
    return {
      hardBounces: 0,
      softBouncesInCycle: args.cycleStartedAt === null ? null : 0,
      softBouncesIn30Days: 0,
    };
  },
};
