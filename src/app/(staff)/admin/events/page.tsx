/**
 * /admin/events list page (F6 Phase 4 / US2 AS1 + AS5).
 *
 * Server component — fetches the events list + emptyStateContext via
 * the `runListEvents` composition adapter (which wraps `runInTenant`).
 * Server-side filter chips + pagination.
 *
 * Empty-state strategy (US2 AS5 + CHK028):
 * (a) !integrationConfigured           → "Set up EventCreate integration" CTA
 * (b) integrationConfigured && !everReceivedDelivery → "Waiting for first event…" hint
 * (c) items.length===0 && totalArchived>0 → "All events archived" with toggle
 * (d) hasFilters && items.length===0 → "No events match your filters" + clear
 *
 * Authz:
 * - admin OR manager (read)
 * - member → 404 (FR-035 surface disclosure)
 * - kill-switch off → 404
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { PlusIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
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
  // Next.js delivers repeated query
  // params as `string[]` (e.g., `?q=a&q=b` → `q: ['a','b']`). Typing
  // these as bare `string` was a lie that would have crashed on
  // `.trim()`. We normalise to the first-occurrence string at read
  // time via `firstParam()` below.
  readonly page?: string | string[];
  readonly pageSize?: string | string[];
  readonly includeArchived?: string | string[];
  readonly partnerBenefitOnly?: string | string[];
  readonly culturalEventOnly?: string | string[];
  readonly categoryFilter?: string | string[];
}

const PAGE_SIZE = 25;

/**
 * Normalise a Next.js SearchParams value to the first-occurrence
 * string, ignoring repeated keys (`?q=a&q=b` → `'a'`). Returns
 * `undefined` for absent / empty / non-string entries.
 */
function firstParam(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function isTruthy(v: string | string[] | undefined): boolean {
  const s = firstParam(v);
  return s === '1' || s === 'true';
}

function clampPage(raw: string | string[] | undefined): number {
  const s = firstParam(raw);
  const n = Number.parseInt(s ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

export default async function AdminEventsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // kill-switch: 404 (surface disclosure prevention).
  if (!env.features.f6EventCreate) {
    notFound();
  }

  // auth + role gate. Member returns 404.
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
  const categoryRaw = firstParam(query.categoryFilter);
  const categoryFilter =
    categoryRaw && categoryRaw.trim() !== '' ? categoryRaw.trim() : null;
  const hasFilters =
    includeArchived ||
    partnerBenefitOnly ||
    culturalEventOnly ||
    categoryFilter !== null;

  const reqHeaders = await headers();
  const tenantCtx = resolveTenantFromHeaders(reqHeaders);

  // wrap the use-case dispatch
  // in try/catch — `runInTenant` rejections (DB outage, role-grant
  // failure, etc.) would otherwise bubble to the Next.js framework
  // error boundary, bypassing the bespoke error card. Wrapping here
  // gives consistent UX whether the failure is a use-case `db_error`
  // Result OR a raw rejection.
  let result: Awaited<ReturnType<typeof runListEvents>> | null = null;
  try {
    result = await runListEvents(tenantCtx.slug, {
      page,
      pageSize: PAGE_SIZE,
      includeArchived,
      partnerBenefitOnly,
      culturalEventOnly,
      categoryFilter,
    });
    if (!result.ok) {
      logger.error(
        { event: 'admin_events_page_render_error', error: result.error },
        '[F6] /admin/events list page — use-case returned err',
      );
    }
  } catch (e) {
    logger.error(
      {
        event: 'admin_events_page_render_throw',
        err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
      },
      '[F6] /admin/events list page — runListEvents threw',
    );
  }

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {!result || !result.ok ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">{t('errorState')}</p>
            </div>
          ) : (
            <>
              <FilterChips
                query={
                  query as unknown as Record<
                    string,
                    string | string[] | undefined
                  >
                }
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
                        eventId: it.eventId,
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

/**
 * build chip hrefs from a fresh
 * URLSearchParams over the CURRENT query so toggling one filter does
 * not silently drop the others. Also strips `page=` so toggles reset
 * to page 1 (matches AttendeeTable's `toggleUnmatched` pattern at
 * `src/components/events/attendee-table.tsx:113-122`).
 */
function buildChipHref(
  query: Record<string, string | string[] | undefined>,
  toggleKey: string,
  currentlyActive: boolean,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === 'page' || k === toggleKey) continue;
    const first = firstParam(v);
    if (first !== undefined && first !== '') {
      next.set(k, first);
    }
  }
  if (!currentlyActive) {
    next.set(toggleKey, '1');
  }
  const qs = next.toString();
  return qs ? `/admin/events?${qs}` : '/admin/events';
}

async function FilterChips({
  query,
  hasFilters,
  includeArchived,
  partnerBenefitOnly,
  culturalEventOnly,
}: {
  query: Record<string, string | string[] | undefined>;
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
        href={buildChipHref(query, 'partnerBenefitOnly', partnerBenefitOnly)}
      >
        {partnerBenefitOnly
          ? t('partnerBenefitOnlyActive')
          : t('partnerBenefitOnly')}
      </FilterChipLink>
      <FilterChipLink
        active={culturalEventOnly}
        href={buildChipHref(query, 'culturalEventOnly', culturalEventOnly)}
      >
        {culturalEventOnly
          ? t('culturalEventOnlyActive')
          : t('culturalEventOnly')}
      </FilterChipLink>
      <FilterChipLink
        active={includeArchived}
        href={buildChipHref(query, 'includeArchived', includeArchived)}
      >
        {includeArchived ? t('hideArchived') : t('showArchived')}
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
  // `aria-pressed` is invalid on anchors —
  // ARIA 1.2 restricts it to role="button". `aria-current="true"` is
  // the canonical idiom for active nav/filter links on anchor elements.
  return (
    <Link
      href={href}
      className={buttonVariants({
        variant: active ? 'default' : 'outline',
        size: 'sm',
      })}
      {...(active ? { 'aria-current': 'true' as const } : {})}
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
          <PlusIcon aria-hidden="true" className="size-4" />
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
