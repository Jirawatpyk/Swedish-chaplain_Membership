/**
 * T065 — /admin/events list page (F6 Phase 4 / US2 AS1 + AS5).
 *
 * Server component — fetches the events list + emptyStateContext via
 * the `runListEvents` composition adapter (which wraps `runInTenant`).
 * Server-side filter chips + pagination.
 *
 * Empty-state strategy (US2 AS5 + CHK028):
 *   (a) !integrationConfigured           → "Set up EventCreate integration" CTA
 *   (b) integrationConfigured && !everReceivedDelivery → "Waiting for first event…" hint
 *   (c) items.length===0 && totalArchived>0 → "All events archived" with toggle
 *   (d) hasFilters && items.length===0 → "No events match your filters" + clear
 *
 * Authz:
 *   - admin OR manager (read)
 *   - member → 404 (FR-035 surface disclosure)
 *   - kill-switch off → 404
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { PlusIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runListEvents } from '@/lib/events-admin-deps';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import {
  EventsListTable,
  type EventsListTableRow,
} from '@/components/events/events-list-table';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.events.list');
  return { title: t('title') };
}

interface SearchParams {
  readonly page?: string;
  readonly pageSize?: string;
  readonly includeArchived?: string;
  readonly partnerBenefitOnly?: string;
  readonly culturalEventOnly?: string;
  readonly categoryFilter?: string;
}

const PAGE_SIZE = 25;

function isTruthy(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function clampPage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

export default async function AdminEventsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // FR-035 — kill-switch: 404 (surface disclosure prevention).
  if (!env.features.f6EventCreate) {
    notFound();
  }

  // FR-035 — auth + role gate. Member returns 404.
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
    notFound();
  }

  const query = await searchParams;
  const t = await getTranslations('admin.events.list');
  const tShared = await getTranslations('shared');

  const page = clampPage(query.page);
  const includeArchived = isTruthy(query.includeArchived);
  const partnerBenefitOnly = isTruthy(query.partnerBenefitOnly);
  const culturalEventOnly = isTruthy(query.culturalEventOnly);
  const categoryFilter =
    query.categoryFilter && query.categoryFilter.trim() !== ''
      ? query.categoryFilter.trim()
      : null;
  const hasFilters =
    includeArchived ||
    partnerBenefitOnly ||
    culturalEventOnly ||
    categoryFilter !== null;

  const reqHeaders = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: reqHeaders });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await runListEvents(tenantCtx.slug, {
    page,
    pageSize: PAGE_SIZE,
    includeArchived,
    partnerBenefitOnly,
    culturalEventOnly,
    categoryFilter,
  });

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {!result.ok ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">{t('errorState')}</p>
            </div>
          ) : (
            <>
              <FilterChips
                hasFilters={hasFilters}
                includeArchived={includeArchived}
                partnerBenefitOnly={partnerBenefitOnly}
                culturalEventOnly={culturalEventOnly}
              />
              {result.value.items.length === 0 ? (
                <EmptyState
                  emptyContext={result.value.emptyStateContext}
                  hasFilters={hasFilters}
                />
              ) : (
                <>
                  <EventsListTable
                    rows={
                      result.value.items.map((it) => ({
                        eventId: it.eventId as string,
                        name: it.name,
                        startDate: it.startDate,
                        category: it.category,
                        totalRegistrations: it.totalRegistrations,
                        matchedRegistrations: it.matchedRegistrations,
                        matchRatePct: it.matchRatePct,
                        isPartnerBenefit: it.isPartnerBenefit,
                        isCulturalEvent: it.isCulturalEvent,
                        archivedAt: it.archivedAt,
                      })) satisfies EventsListTableRow[]
                    }
                  />
                  <TablePagination
                    page={result.value.pagination.page}
                    pageSize={result.value.pagination.pageSize}
                    total={result.value.pagination.totalCount}
                    baseHref="/admin/events"
                  />
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <span className="sr-only">{tShared('loaded')}</span>
    </TableContainer>
  );
}

// --- Subcomponents (server components — kept inline for clarity) ----------

async function FilterChips({
  hasFilters,
  includeArchived,
  partnerBenefitOnly,
  culturalEventOnly,
}: {
  hasFilters: boolean;
  includeArchived: boolean;
  partnerBenefitOnly: boolean;
  culturalEventOnly: boolean;
}) {
  const t = await getTranslations('admin.events.list.filters');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterChipLink
        active={partnerBenefitOnly}
        href={
          partnerBenefitOnly ? '/admin/events' : '/admin/events?partnerBenefitOnly=1'
        }
      >
        {t('partnerBenefitOnly')}
      </FilterChipLink>
      <FilterChipLink
        active={culturalEventOnly}
        href={
          culturalEventOnly ? '/admin/events' : '/admin/events?culturalEventOnly=1'
        }
      >
        {t('culturalEventOnly')}
      </FilterChipLink>
      <FilterChipLink
        active={includeArchived}
        href={
          includeArchived ? '/admin/events' : '/admin/events?includeArchived=1'
        }
      >
        {includeArchived
          ? t('hideArchived')
          : t('showArchived')}
      </FilterChipLink>
      {hasFilters && (
        <Link
          href="/admin/events"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          {t('clearAll')}
        </Link>
      )}
    </div>
  );
}

function FilterChipLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={buttonVariants({
        variant: active ? 'default' : 'outline',
        size: 'sm',
      })}
      aria-pressed={active}
    >
      {children}
    </Link>
  );
}

async function EmptyState({
  emptyContext,
  hasFilters,
}: {
  emptyContext: {
    integrationConfigured: boolean;
    everReceivedDelivery: boolean;
    totalArchived: number;
  };
  hasFilters: boolean;
}) {
  const t = await getTranslations('admin.events.list.emptyState');

  if (hasFilters) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">{t('filteredEmpty')}</p>
        <Link
          href="/admin/events"
          className={buttonVariants({ variant: 'outline', className: 'mt-4' })}
        >
          {t('clearFilters')}
        </Link>
      </div>
    );
  }

  // Variant (a) — no integration configured
  if (!emptyContext.integrationConfigured) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <h2 className="text-h3 font-semibold">{t('noIntegration.title')}</h2>
        <p className="max-w-md text-muted-foreground">
          {t('noIntegration.body')}
        </p>
        <Link
          href="/admin/integrations/eventcreate"
          className={buttonVariants({ variant: 'default' })}
        >
          <PlusIcon className="size-4" />
          {t('noIntegration.cta')}
        </Link>
      </div>
    );
  }

  // Variant (b) — configured but no deliveries yet
  if (!emptyContext.everReceivedDelivery) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <h2 className="text-h3 font-semibold">{t('noDeliveries.title')}</h2>
        <p className="max-w-md text-muted-foreground">
          {t('noDeliveries.body')}
        </p>
        <Link
          href="/admin/integrations/eventcreate"
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('noDeliveries.cta')}
        </Link>
      </div>
    );
  }

  // Variant (c) — all events archived
  if (emptyContext.totalArchived > 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <h2 className="text-h3 font-semibold">{t('allArchived.title')}</h2>
        <p className="max-w-md text-muted-foreground">
          {t('allArchived.body', { count: emptyContext.totalArchived })}
        </p>
        <Link
          href="/admin/events?includeArchived=1"
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('allArchived.cta')}
        </Link>
      </div>
    );
  }

  // Fallback — unusual combination (configured + delivered + no items
  // + no filters + 0 archived). Render the generic "no events found"
  // copy so the page never appears blank.
  return (
    <div className="py-12 text-center">
      <p className="text-muted-foreground">{t('genericEmpty')}</p>
    </div>
  );
}
