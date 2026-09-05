/**
 * /admin/marketing/audience — 108 PR-D (US4 — FR-027a, FR-034, FR-035,
 * FR-035a, FR-035b, FR-035c).
 *
 * The permanent Marketing audience page: every non-removed contact of the
 * tenant with its marketing state, who switched it and when, filterable by
 * member / role / state / eligibility, 50 rows per page. It is also the
 * FR-027a pre-flight surface — the header offers the "secondary, on,
 * eligible" preset that lists exactly the people who will NEWLY receive a
 * broadcast under the 1:N audience rule.
 *
 * Gate: `contacts.read` (admin, super_admin, marketing, and manager
 * read-only). The inline switch renders only for `contacts.marketing`
 * holders — a read-only viewer gets a badge and a note, never a disabled
 * control (FR-035). Columns are the FR-035 allow-list and nothing more
 * (FR-035a): no `pii_sensitive` field, no download.
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { SearchXIcon, UsersIcon } from 'lucide-react';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMarketingAudienceDeps } from '@/lib/contact-marketing-deps';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import {
  MARKETING_AUDIENCE_PREFLIGHT_QUERY,
  parseMarketingAudienceParams,
  type MarketingAudienceSearchParams,
} from '@/lib/marketing-audience-filter';
import { listMarketingAudience } from '@/modules/members';
import { resolveActorIdentities } from '@/modules/auth';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { EmptyState } from '@/components/shell/empty-state';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { buttonVariants } from '@/components/ui/button';
import { AudienceFilters } from './_components/audience-filters';
import { AudienceTable, type AudienceTableRow } from './_components/audience-table';
import { AudienceTableSkeleton } from './_components/audience-table-skeleton';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.marketing.audience');
  return { title: t('title') };
}

const AUDIENCE_HREF = '/admin/marketing/audience';

export default async function MarketingAudiencePage({
  searchParams,
}: {
  searchParams: Promise<MarketingAudienceSearchParams>;
}) {
  const { user } = await requirePagePermission('contacts.read');
  const query = await searchParams;
  const t = await getTranslations('admin.marketing.audience');
  const canMarketing = canPerform(user.role, 'contacts.marketing');

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href={`${AUDIENCE_HREF}?${MARKETING_AUDIENCE_PREFLIGHT_QUERY}`}
            className={buttonVariants({ variant: 'outline' })}
            data-testid="audience-preflight-preset"
          >
            {t('preflightPreset')}
          </Link>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {!canMarketing && (
            <p className="text-sm text-muted-foreground" data-testid="audience-read-only">
              {t('readOnly')}
            </p>
          )}
          {/* `useSearchParams` in the filters needs a Suspense boundary so the
              route keeps server rendering. */}
          <Suspense
            fallback={
              <FilterBar aria-hidden>
                <Skeleton className="h-9 sm:flex-1" />
                <Skeleton className="h-9 sm:w-44" />
                <Skeleton className="h-9 sm:w-48" />
                <Skeleton className="h-9 sm:w-52" />
              </FilterBar>
            }
          >
            <AudienceFilters />
          </Suspense>
          <Suspense fallback={<AudienceTableSkeleton withSwitch={canMarketing} />}>
            <AudienceBody query={query} canMarketing={canMarketing} />
          </Suspense>
        </CardContent>
      </Card>
    </TableContainer>
  );
}

async function AudienceBody({
  query,
  canMarketing,
}: {
  query: MarketingAudienceSearchParams;
  canMarketing: boolean;
}) {
  const tenant = resolveTenantFromRequest();
  const locale = await getLocale();
  const t = await getTranslations('admin.marketing.audience');
  const { filter, page, hasFilters } = parseMarketingAudienceParams(query);

  const result = await listMarketingAudience({ filter, page }, buildMarketingAudienceDeps(tenant));
  if (!result.ok) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title={t('error.title')}
        description={t('error.description')}
        bordered={false}
        data-testid="audience-error"
      />
    );
  }
  const { rows, total, pageSize, degraded } = result.value;

  // "Changed by": a staff user id → display name (data minimisation: name
  // only, never email — same rule as the audit viewer); the contact's own
  // change → "the contact". Erased staff users simply fall back to "Staff".
  const staffIds = [
    ...new Set(
      rows
        .filter((r) => r.changedSource === 'staff' && r.changedByUserId !== null)
        .map((r) => r.changedByUserId as string),
    ),
  ];
  const identities = staffIds.length > 0 ? await resolveActorIdentities(staffIds) : new Map();

  const tableRows: AudienceTableRow[] = rows.map((r) => ({
    contactId: r.contactId,
    memberId: r.memberId,
    companyName: r.companyName,
    contactName: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email,
    isPrimary: r.isPrimary,
    memberStatus: r.memberStatus,
    memberHalted: r.memberHalted,
    memberErased: r.memberErased,
    state: r.state,
    reasons: r.reasons,
    changedBy:
      r.changedSource === null
        ? null
        : r.changedSource === 'self'
          ? t('changedBy.contact')
          : (identities.get(r.changedByUserId ?? '')?.displayName ?? t('changedBy.staff')),
    changedAt:
      r.changedAt === null
        ? null
        : formatLocalisedDate(r.changedAt.toISOString(), locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
  }));

  return (
    <>
      {/* FR-040-style honesty for the count: announced to AT on every filter change. */}
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        data-testid="audience-count"
      >
        {t('count', { count: total })}
      </p>

      {degraded && (
        <div
          role="status"
          className="rounded-md border border-amber-600 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="audience-degraded"
        >
          <p className="font-medium">{t('empty.unavailable.title')}</p>
          <p>{t('empty.unavailable.description')}</p>
        </div>
      )}

      {total === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={SearchXIcon}
            title={t('empty.filtered.title')}
            description={t('empty.filtered.description')}
            bordered={false}
            data-testid="audience-empty-filtered"
            action={
              <Link href={AUDIENCE_HREF} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('empty.filtered.cta')}
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={UsersIcon}
            title={t('empty.none.title')}
            description={t('empty.none.description')}
            bordered={false}
            data-testid="audience-empty-none"
          />
        )
      ) : (
        <>
          <AudienceTable rows={tableRows} canMarketing={canMarketing} />
          <TablePagination page={page} pageSize={pageSize} total={total} baseHref={AUDIENCE_HREF} />
        </>
      )}
    </>
  );
}
