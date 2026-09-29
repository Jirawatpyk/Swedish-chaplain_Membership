/**
 * 122 US5b-1 (T558) — the member timeline page's markup once loaded (board
 * `Admin-member-timeline`), shared with the no-DB preview route: the title
 * with "Back to member" (from `lg`; below it the shell's back link does the
 * same), then one AURA card named by the company with the event count, the
 * filters and the stream (both already AURA).
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { DynamicBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { TimelineFilters } from '@/components/members/timeline-filters';
import { TimelineStream } from '@/components/members/timeline-stream';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

export interface MemberTimelineViewProps {
  readonly member: { readonly memberId: string; readonly companyName: string };
  readonly initialEvents: readonly TimelineItemProps[];
  readonly initialCursor: string | null;
  readonly totalEvents: number;
  readonly hasFilter: boolean;
  /** Remounts the stream on a filter change so its paging resets. */
  readonly filterKey: string;
}

export async function renderMemberTimelineView({
  member,
  initialEvents,
  initialCursor,
  totalEvents,
  hasFilter,
  filterKey,
}: MemberTimelineViewProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.timeline');
  const tPage = await getTranslations('timeline.page');
  return (
    <DetailContainer>
      <DynamicBreadcrumbLabel segment={member.memberId} label={member.companyName} />
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href={`/admin/members/${member.memberId}`}
            className={buttonClass({ variant: 'secondary', className: 'max-lg:hidden' })}
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t('backToDetail')}
          </Link>
        }
      />
      <Card
        as="section"
        title={member.companyName}
        titleId="member-timeline-heading"
        headingLevel={2}
        actions={
          totalEvents > 0 ? (
            <span className="whitespace-nowrap text-sm text-[var(--aura-fg-secondary)]">
              {t('totalEvents', { count: totalEvents })}
            </span>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          <TimelineFilters />
          <TimelineStream
            key={filterKey}
            fetchPath={`/api/members/${member.memberId}/timeline`}
            initialEvents={[...initialEvents]}
            initialCursor={initialCursor}
            emptyLabel={hasFilter ? tPage('emptyFiltered') : tPage('empty')}
            listLabel={t('title')}
          />
        </div>
      </Card>
    </DetailContainer>
  );
}
