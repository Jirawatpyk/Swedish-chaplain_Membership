/**
 * Pass A · Section 2 — inline benefits quota preview (async server component).
 *
 * The dedicated benefits page (`/admin/members/[id]/benefits`) was fully
 * built but ORPHANED — nothing on the member-detail page linked to it
 * (marquee smart-feature #1). This inline preview surfaces the member's
 * quota usage (E-Blast quota, cultural tickets) at a glance on the detail
 * page, with a "Full benefits →" link to the dedicated page.
 *
 * Reuses the SAME read (`computeBenefitUsage`) + the SAME presentational
 * component (`BenefitUsageCard`, in `compact` mode) as the dedicated page so
 * the figures + the visual never diverge. RLS-safe — `computeBenefitUsage`
 * threads the tenant slug into its Drizzle deps which wrap queries in
 * `runInTenant` (never the raw `db` singleton).
 *
 * PII-read trail (FR-036): emits `member_benefit_viewed` best-effort via
 * `recordStaffBenefitView` — the same staff-view audit the dedicated page
 * writes — since the inline preview exposes the same benefit data. The emit
 * logs+meters+swallows on failure, so the read never blocks the page.
 *
 * F9-gated at the call site (the benefits feature ships behind the F9 flag).
 * A read failure renders nothing rather than crashing the parent page.
 */
import { getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
  recordStaffBenefitView,
} from '@/modules/insights';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';

export async function MemberBenefitsPreviewSection({
  tenant,
  memberId,
  actorUserId,
  actorRole,
}: {
  readonly tenant: TenantContext;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager';
}): Promise<React.JSX.Element | null> {
  const locale = await getLocale();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);

  const result = await computeBenefitUsage(
    tenant,
    { memberId },
    makeComputeBenefitUsageDeps(tenant.slug),
  );
  if (!result.ok) {
    logger.warn(
      { event: 'member_benefits_preview_read_err', memberId },
      '[Pass A] benefits preview read failed — omitting section',
    );
    return null;
  }
  const usage = result.value;

  // Same staff PII-read audit the dedicated benefits page emits (FR-036).
  // Best-effort: logs+meters+swallows on failure, never blocks the read.
  await recordStaffBenefitView({
    tenantId: tenant.slug,
    requestId,
    actorUserId,
    actorRole,
    subjectMemberId: memberId,
    membershipYear: usage.membershipYear,
  });

  return (
    <section aria-labelledby="member-benefits-preview-heading" className="h-full">
      <BenefitUsageCard
        headingId="member-benefits-preview-heading"
        locale={locale}
        membershipYear={usage.membershipYear}
        elapsedYearPct={usage.elapsedYearPct}
        quantifiable={usage.quantifiable}
        active={usage.active}
        aggregateConsumedPct={usage.aggregateConsumedPct}
        underUseWarning={usage.underUseWarning}
        compact
        previewHref={`/admin/members/${memberId}/benefits`}
        className="h-full flex flex-col"
      />
    </section>
  );
}

/**
 * Suspense fallback matching the compact card (title + link + 2 quota bars)
 * for CLS-stable layout. Canonical <Skeleton> (shimmer + reduced-motion).
 */
export function MemberBenefitsPreviewSkeleton(): React.JSX.Element {
  return (
    <Card aria-busy="true" aria-hidden="true" className="h-full">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
