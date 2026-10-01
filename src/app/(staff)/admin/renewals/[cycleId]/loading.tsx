/**
 * F8 admin cycle-detail loading skeleton — the page's shape on AURA (spec
 * 122 US7b-1, T724; board `Admin-renewal-cycle` + `-mobile`): the header
 * with its title, subtitle and actions, then the four cards in the page's
 * grid (Linked invoice first on a phone), so the swap to content holds
 * CLS 0. `PageSkeletonShell` is the one live region that announces the load;
 * the placeholders are plain `<div>`s, never landmarks (K27 I-4).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function AdminCycleDetailLoading() {
  const t = await getTranslations('admin.renewals.cycleDetail');
  return (
    <PageSkeletonShell ariaLabel={t('loading')}>
      <DetailContainer aria-busy="true">
        <PageHeader
          title={<SkeletonBlock className="h-8 w-72" />}
          subtitle={<SkeletonBlock className="h-4 w-40" />}
          actions={
            <>
              <SkeletonBlock className="h-9 w-56 max-sm:w-full" />
              <SkeletonBlock className="h-9 w-32 max-sm:hidden" />
            </>
          }
        />
        <div className="grid grid-cols-1 items-start gap-[var(--aura-space-5)] lg:grid-cols-2">
          {/* Member & plan: seven fields and the technical-ids line. */}
          <CardSkeletonFrame fields={7} disclosure />
          {/* Linked invoice: three fields and the "View invoice" link. */}
          <CardSkeletonFrame fields={3} link className="max-sm:order-first" />
          {/* Period & timeline: the three always-shown dates (the common
              upcoming / reminded path) and the audit-timestamps line. */}
          <CardSkeletonFrame fields={3} disclosure />
          {/* Activity: a heading and two rows. */}
          <Card header={<SkeletonBlock className="h-6 w-24" />}>
            <div className="flex flex-col gap-[var(--aura-space-3)]">
              <SkeletonBlock className="h-4 w-36" />
              <SkeletonBlock className="h-11 w-full" />
              <SkeletonBlock className="h-11 w-full" />
            </div>
          </Card>
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}

/** A card of label-over-value pairs in two columns, as the page draws them. */
function CardSkeletonFrame({
  fields,
  disclosure = false,
  link = false,
  className,
}: {
  readonly fields: number;
  readonly disclosure?: boolean;
  readonly link?: boolean;
  readonly className?: string;
}) {
  return (
    <Card header={<SkeletonBlock className="h-6 w-40" />} {...(className ? { className } : {})}>
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        <div className="grid grid-cols-2 gap-x-[var(--aura-space-6)] gap-y-[var(--aura-space-4)]">
          {Array.from({ length: fields }, (_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-5 w-32 max-w-full" />
            </div>
          ))}
        </div>
        {link ? <SkeletonBlock className="h-4 w-44" /> : null}
        {disclosure ? <SkeletonBlock className="h-4 w-36" /> : null}
      </div>
    </Card>
  );
}
