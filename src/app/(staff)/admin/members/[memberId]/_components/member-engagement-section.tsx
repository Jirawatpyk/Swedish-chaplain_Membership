/**
 * B18 / FR-007a — engagement-score section on the admin member-profile page.
 *
 * Server component, F9-gated, staff-only (the route already requires a staff
 * session). Reads the member's F8 risk via the narrow `getMemberEngagement`
 * use-case, then applies the pure `projectEngagementScore` projection HERE (in
 * presentation) so the members module stays insights-free — the same place the
 * directory LIST page applies it. A failed/unscored read renders an em-dash
 * (the score is non-critical) rather than throwing. Score + band token satisfy
 * FR-035 (not colour-alone). Isolated in its own Suspense boundary so the risk
 * read never blocks the main profile paint.
 */
import { getFormatter, getTranslations } from 'next-intl/server';
import { getMemberEngagement } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { projectEngagementScore } from '@/modules/insights';
import type { TenantContext } from '@/modules/tenants';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export async function MemberEngagementSection({
  tenant,
  memberId,
}: {
  readonly tenant: TenantContext;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const tDetail = await getTranslations('admin.members.detail');
  const tDir = await getTranslations('admin.members.directory');
  const format = await getFormatter();
  const deps = buildMembersDeps(tenant);
  const res = await getMemberEngagement(memberId as MemberId, {
    tenant: deps.tenant,
    memberRepo: deps.memberRepo,
  });
  const eng = res.ok
    ? projectEngagementScore({
        riskScore: res.value.riskScore,
        riskScoreBand: res.value.riskScoreBand,
      })
    : { score: null, band: null };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {tDetail('fields.engagement')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {eng.score === null || eng.band === null ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <p className="flex items-center gap-2 text-sm">
            <span className="font-medium tabular-nums">
              {format.number(eng.score)}
            </span>
            <span className="text-caption text-muted-foreground">
              {tDir(`engagementBand.${eng.band}`)}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
