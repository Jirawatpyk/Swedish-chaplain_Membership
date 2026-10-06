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
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { runListEvents } from '@/lib/events-admin-deps';
import { TableContainer } from '@/components/layout';
import { TablePagination } from '@/components/layout/table-pagination';
import { buttonVariants } from '@/components/ui/button';
import {
  EventsListTable,
  type EventsListTableRow,
} from '@/components/events/events-list-table';
import { EventsListSearchToolbar } from '@/components/events/events-list-search-toolbar';
import { EventsEmptyState } from './_components/events-empty-state';
import { renderEventsListView } from './_components/events-list-view';

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
  readonly q?: string | string[];
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
  const { user: currentUser } = await requirePagePermission('events.read');

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
  const searchRaw = firstParam(query.q);
  const searchQuery =
    searchRaw && searchRaw.trim().length > 0 ? searchRaw.trim() : undefined;
  const hasFilters =
    includeArchived ||
    partnerBenefitOnly ||
    culturalEventOnly ||
    categoryFilter !== null ||
    searchQuery !== undefined;

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
      ...(searchQuery !== undefined && { searchQuery }),
    });
    if (!result.ok) {
      logger.error(
        { event: 'admin_events_page_render_error', error: result.error },
        '[F6] /admin/events list page — use-case returned err',
      );
    }
  } catch (e) {
    // R9-I1 staff-review fix (2026-05-14) — scrub container paths
    // (Vercel `/var/task/...`, node_modules, webpack-internal:///)
    // from stack before pino captures it. Round-8 W2 contract carry.
    logger.error(
      {
        event: 'admin_events_page_render_throw',
        err:
          e instanceof Error
            ? {
                name: e.name,
                message: e.message,
                stack:
                  typeof e.stack === 'string'
                    ? (redactStack(e.stack) ?? null)
                    : null,
              }
            : String(e),
      },
      '[F6] /admin/events list page — runListEvents threw',
    );
  }

  // T098 Phase 7 — "Import CSV" (`events.write`, what the import page and API
  // admit) and PR 2.2 "Erase by email" (`events.erasure`, the key its
  // destination page admits) — both in the header; manager sees neither.
  const canImport = canPerform(currentUser.role, 'events.write');
  const canEraseByEmail = canPerform(currentUser.role, 'events.erasure');

  return (
    <TableContainer>
      {await renderEventsListView({
        canImport,
        canEraseByEmail,
        children: (
        <div className="flex flex-col gap-4">
          {!result || !result.ok ? (
            <div className="py-12 text-center" role="alert">
              <p className="text-muted-foreground">{t('errorState')}</p>
            </div>
          ) : (
            <>
              {/* User UX (2026-05-18): search input and filter chips
                  on the same row on ≥sm viewports so admins can see
                  both controls without scrolling. Wraps to a
                  2-line stack on narrow viewports (<sm) since the
                  search field needs ~28rem and the chips group needs
                  ~24rem — a forced single-line at 320px would crush
                  both. `gap-y-3` keeps vertical rhythm when wrapped. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <EventsListSearchToolbar initialSearch={searchQuery ?? ''} />
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
              </div>
              {/* R2-2b (2026-05-18 /speckit-review Round 2 Blocker) —
                  screen-reader live-region announcing the filtered
                  result count. Mirrors the attendee-table parity:
                  when the server re-renders after a search submit /
                  filter chip toggle, the DOM text changes and
                  aria-live="polite" causes assistive tech to read
                  "5 events for 'midsummer'" without disrupting input
                  focus. `sr-only` keeps it visually hidden — sighted
                  users see the table itself. */}
              <output
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
              >
                {searchQuery !== undefined
                  ? t('resultsAnnouncementWithQuery', {
                      count: result.value.items.length,
                      query: searchQuery,
                    })
                  : t('resultsAnnouncement', {
                      count: result.value.items.length,
                    })}
              </output>
              {result.value.items.length === 0 ? (
                <EventsEmptyState
                  emptyContext={result.value.emptyStateContext}
                  hasFilters={hasFilters}
                  canManageIntegration={canPerform(
                    currentUser.role,
                    'settings.integrations',
                  )}
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
        </div>
        ),
      })}
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
  // `aria-pressed` is invalid on anchors — ARIA 1.2 restricts it to
  // role="button". `aria-current="true"` is the canonical idiom for
  // active nav/filter LINKS on anchor elements (preserves middle-
  // click open + bookmarkability + share-URL semantics).
  //
  // Round-12 review note: the ui-design-specialist agent suggested
  // converting to `<button aria-pressed>` for canonical toggle
  // semantics. Rejected: the conversion would require client-side
  // router.push to mutate the URL, breaking middle-click open + URL
  // copy-paste workflows that admins routinely use on filter chips.
  // `aria-current="true"` is accepted by all WCAG-conformant SRs
  // (NVDA / JAWS / VoiceOver) as a filter-active signal.
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
