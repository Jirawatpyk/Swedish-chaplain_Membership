/**
 * B18 / FR-007a — read one member's F8 risk score + band for the engagement
 * projection on the admin member-profile page.
 *
 * Deliberately a NARROW read (not folded into `getMember`) so the `Member`
 * aggregate stays free of risk fields, and the members module stays
 * insights-free: the pure `projectEngagementScore` projection is applied in the
 * presentation layer (the same place the directory LIST page already calls it),
 * not here. This use-case just passes the raw {riskScore, riskScoreBand}
 * through, mapping the repo error to a small read-only error union.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo, MemberRisk } from '../ports/member-repo';

export type GetMemberEngagementDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type GetMemberEngagementError =
  | { readonly type: 'not_found' }
  | { readonly type: 'server_error' };

export async function getMemberEngagement(
  memberId: MemberId,
  deps: GetMemberEngagementDeps,
): Promise<Result<MemberRisk, GetMemberEngagementError>> {
  const r = await deps.memberRepo.findRiskById(deps.tenant, memberId);
  if (r.ok) return ok(r.value);
  if (r.error.code === 'repo.not_found') return err({ type: 'not_found' });
  return err({ type: 'server_error' });
}
