/**
 * The member's renewal posture (F8) and engagement (F9), read once per
 * request and shared by the Renewal & Health card and the figures strip
 * (122 US5b-1, T552): `cache()` dedupes the two callers within a render.
 *
 * Reads (both RLS-safe — adapters wrap queries in `runInTenant`, never the raw
 * `db` singleton):
 *   1. `loadMemberRenewalStatus` (F8) — most-recent cycle of any status.
 *   2. `getMemberEngagement` (F3 narrow risk read) → `projectEngagementScore`
 *      (F9 projection, applied in presentation per the directory-list
 *      precedent). Only fetched when the F9 dashboard flag is on.
 *
 * Both degrade gracefully: a renewal-read failure is `readFailed` (a DISTINCT
 * "unavailable" state, never the empty state, which would claim the member has
 * no cycle — Cluster 7 / G18); an engagement-read failure leaves the score
 * null. Neither throws.
 */
import { cache } from 'react';
import { loadMemberRenewalStatus, makeRenewalsDeps, daysUntilExpiry } from '@/modules/renewals';
import { getMemberEngagement } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { projectEngagementScore } from '@/modules/insights';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';

type Cycle = NonNullable<
  Extract<Awaited<ReturnType<typeof loadMemberRenewalStatus>>, { ok: true }>['value']['cycle']
>;

export interface MemberRenewalHealth {
  readonly readFailed: boolean;
  readonly status: Cycle['status'] | null;
  readonly expiryIso: string | null;
  /** Negative once the cycle is overdue; null without a cycle. */
  readonly daysRemaining: number | null;
  readonly engagementScore: number | null;
  readonly engagementBand: ReturnType<typeof projectEngagementScore>['band'];
}

export const loadMemberRenewalHealth = cache(
  async (tenant: TenantContext, memberId: string): Promise<MemberRenewalHealth> => {
    const renewalRes = await loadMemberRenewalStatus(makeRenewalsDeps(tenant.slug), {
      tenantId: tenant.slug,
      memberId,
    });
    if (!renewalRes.ok) {
      // errKind (class only, never raw error/PII) mirrors the timeline-preview
      // path + the portal RecentActivitySection precedent so an operator can
      // tell a Neon timeout from an RLS denial without reproducing.
      logger.warn(
        {
          event: 'member_renewal_health_read_err',
          memberId,
          errKind: errKind(rootCause(renewalRes.error)),
        },
        '[Pass A] renewal-health read failed — rendering unavailable state',
      );
    }
    const cycle = renewalRes.ok ? renewalRes.value.cycle : null;

    let engagementScore: number | null = null;
    let engagementBand: MemberRenewalHealth['engagementBand'] = null;
    if (env.features.f9Dashboard) {
      const membersDeps = buildMembersDeps(tenant);
      const engRes = await getMemberEngagement(memberId as MemberId, {
        tenant: membersDeps.tenant,
        memberRepo: membersDeps.memberRepo,
      });
      if (engRes.ok) {
        const projected = projectEngagementScore({
          riskScore: engRes.value.riskScore,
          riskScoreBand: engRes.value.riskScoreBand,
        });
        engagementScore = projected.score;
        engagementBand = projected.band;
      }
    }

    // Days remaining from the cycle's expiry (single "now" per render).
    const days = cycle !== null ? daysUntilExpiry(cycle, new Date()) : null;
    return {
      readFailed: !renewalRes.ok,
      status: cycle?.status ?? null,
      expiryIso: cycle?.expiresAt ?? null,
      daysRemaining: days !== null && Number.isFinite(days) ? days : null,
      engagementScore,
      engagementBand,
    };
  },
);
