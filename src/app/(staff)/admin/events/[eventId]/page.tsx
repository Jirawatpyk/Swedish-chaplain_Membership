/**
 * T066 — /admin/events/[eventId] detail page (F6 Phase 4 / US2 AS2-AS4).
 *
 * Server component. Loads event metadata + paginated attendee table.
 * 404 when event missing or cross-tenant. Authz: admin OR manager.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import { isMatchType, MATCH_TYPES } from '@/modules/events';
import type { MatchType } from '@/modules/events';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { buttonVariants } from '@/components/ui/button';
import { EventDetailHeader } from '@/components/events/event-detail-header';
import {
  AttendeeTable,
  type AttendeeRow,
} from '@/components/events/attendee-table';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<Metadata> {
  const t = await getTranslations('admin.events.detail');
  await params;
  return { title: t('title') };
}

interface SearchParams {
  readonly page?: string;
  readonly pageSize?: string;
  readonly unmatchedOnly?: string;
  readonly matchTypeFilter?: string;
  readonly q?: string;
}

const PAGE_SIZE = 50;

function isTruthy(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function clampPage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

function parseMatchTypeFilter(raw: string | undefined): MatchType | null {
  if (raw === undefined || raw === '') return null;
  return isMatchType(raw) ? raw : null;
}

export default async function AdminEventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  if (!env.features.f6EventCreate) {
    notFound();
  }
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
    notFound();
  }

  const { eventId } = await params;
  const query = await searchParams;
  const t = await getTranslations('admin.events.detail');
  const tShared = await getTranslations('shared');

  const page = clampPage(query.page);
  const unmatchedOnly = isTruthy(query.unmatchedOnly);
  const matchTypeFilter = parseMatchTypeFilter(query.matchTypeFilter);
  const q = query.q && query.q.trim() !== '' ? query.q.trim() : null;

  const reqHeaders = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: reqHeaders });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await runLoadEventDetail(tenantCtx.slug, {
    eventId,
    page,
    pageSize: PAGE_SIZE,
    unmatchedOnly,
    matchTypeFilter,
    q,
  });

  if (!result.ok && result.error.kind === 'not_found') {
    notFound();
  }

  if (!result.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('errorSubtitle')} />
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-destructive">{t('errorBody')}</p>
        </div>
      </DetailContainer>
    );
  }

  const { event, registrations, pagination } = result.value;

  return (
    <DetailContainer>
      <Link
        href="/admin/events"
        className={buttonVariants({
          variant: 'ghost',
          size: 'sm',
          className: 'self-start',
        })}
      >
        <ArrowLeft className="size-4" />
        {t('backToList')}
      </Link>
      <PageHeader title={event.name} subtitle={t('subtitle')} />
      <EventDetailHeader event={event} />
      <section
        aria-labelledby="attendees-heading"
        className="flex flex-col gap-4"
      >
        <h3 id="attendees-heading" className="text-h3 font-semibold">
          {t('attendees.heading')}
        </h3>
        <AttendeeTable
          rows={
            registrations.map((r) => ({
              registrationId: r.registrationId as string,
              attendeeEmail: r.attendeeEmail,
              attendeeName: r.attendeeName,
              attendeeCompany: r.attendeeCompany,
              matchType: r.matchType,
              ticketType: r.ticketType,
              ticketPriceThb: r.ticketPriceThb,
              paymentStatus: r.paymentStatus,
              countedAgainstPartnership: r.countedAgainstPartnership,
              countedAgainstCulturalQuota: r.countedAgainstCulturalQuota,
              isOverQuota: r.isOverQuota,
              registeredAt: r.registeredAt,
            })) satisfies AttendeeRow[]
          }
          unmatchedOnly={unmatchedOnly}
          initialSearch={q ?? ''}
        />
        <TablePagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.totalCount}
          baseHref={`/admin/events/${eventId}`}
        />
      </section>
      <span className="sr-only">{tShared('loaded')}</span>
      {/* Reserved for future US3 filter chips — keep MATCH_TYPES referenced
          so tree-shaking does not drop the constant when this page is the
          only consumer of the matchTypeFilter URL param. */}
      <span aria-hidden="true" className="hidden">
        {MATCH_TYPES.join(',')}
      </span>
    </DetailContainer>
  );
}
