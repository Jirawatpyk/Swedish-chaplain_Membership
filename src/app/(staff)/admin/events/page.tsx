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
import { Alert } from '@jirawatpyk/aura-react/server';
import {
  EventsListTable,
  type EventsListTableRow,
} from '@/components/events/events-list-table';
import { EventsListFilters } from '@/components/events/events-list-filters';
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
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {!result || !result.ok ? (
              // A load error keeps its danger frame inside the list card.
              <Alert tone="danger" role="alert">
                {t('errorState')}
              </Alert>
            ) : (
              <>
                {/* The filter pattern: search, three toggle chips, and the count
                    (naming the search) as the bar's polite live region. */}
                <EventsListFilters
                  search={searchQuery ?? ''}
                  partnerBenefitOnly={partnerBenefitOnly}
                  culturalEventOnly={culturalEventOnly}
                  includeArchived={includeArchived}
                  resultCount={result.value.items.length}
                />
                {result.value.items.length === 0 ? (
                  <EventsEmptyState
                    emptyContext={result.value.emptyStateContext}
                    hasFilters={hasFilters}
                    canManageIntegration={canPerform(currentUser.role, 'settings.integrations')}
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
                    {/* The filter bar's count is the list's live region. */}
                    <TablePagination
                      page={result.value.pagination.page}
                      pageSize={result.value.pagination.pageSize}
                      total={result.value.pagination.totalCount}
                      baseHref="/admin/events"
                      live={false}
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

