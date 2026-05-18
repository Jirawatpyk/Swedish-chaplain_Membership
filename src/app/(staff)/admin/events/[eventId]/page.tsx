/**
 * /admin/events/[eventId] detail page (F6 Phase 4 / US2 AS2-AS4).
 *
 * Server component. Loads event metadata + paginated attendee table.
 * 404 when event missing or cross-tenant. Authz: admin OR manager.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import { isMatchType, isPaymentStatus } from '@/modules/events';
import type { MatchType } from '@/modules/events';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { DynamicBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { EventDetailHeader } from '@/components/events/event-detail-header';
import { EventCategoryToggles } from '@/components/events/event-category-toggles';
import { ArchiveEventButton } from '@/components/events/archive-event-button';
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
  // Next.js delivers repeated query params as string[].
  // See /admin/events/page.tsx for full rationale + firstParam helper.
  readonly page?: string | string[];
  readonly pageSize?: string | string[];
  readonly unmatchedOnly?: string | string[];
  readonly matchTypeFilter?: string | string[];
  readonly q?: string | string[];
  readonly paymentStatus?: string | string[];
}

const PAGE_SIZE = 50;

/**
 * UUID v4 regex — mirrors the canonical pattern in
 * `src/modules/events/application/use-cases/load-event-detail.ts`.
 * Duplicated (not imported) because the use-case is in the Application
 * layer and re-exporting a regex through the module barrel would widen
 * the public surface for a single Presentation-layer guard. Keep both
 * patterns byte-identical; a future UUID v7 migration must touch both.
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/**
 * Discriminated-union return for clear consumer-side `switch` (Type#3
 * round-3 fix 2026-05-12 — previously `MatchType | null | 'INVALID'`
 * which was a literal-typed sentinel that couldn't exhaustively switch).
 *
 * - `{ kind: 'filter', value }` — valid MatchType present, apply filter
 * - `{ kind: 'none' }` — no filter (absent / empty / null / undefined)
 * - `{ kind: 'invalid' }` — garbage param present; redirect to clean URL
 */
type ParsedMatchType =
  | { readonly kind: 'filter'; readonly value: MatchType }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' };

function parseMatchTypeFilter(
  raw: string | string[] | undefined,
): ParsedMatchType {
  const s = firstParam(raw);
  if (s === undefined || s === '') return { kind: 'none' };
  return isMatchType(s) ? { kind: 'filter', value: s } : { kind: 'invalid' };
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
  const parsedMatchType = parseMatchTypeFilter(query.matchTypeFilter);
  // page + Type#3 round-3 discriminated union: when
  // the URL carries garbage `matchTypeFilter`, redirect to the clean
  // URL stripping the bad param. Exhaustive switch ensures any 4th
  // future state surfaces as a compile error here.
  let matchTypeFilter: MatchType | null;
  switch (parsedMatchType.kind) {
    case 'filter':
      matchTypeFilter = parsedMatchType.value;
      break;
    case 'none':
      matchTypeFilter = null;
      break;
    case 'invalid': {
      // Strip both the bad `matchTypeFilter` AND the `page` param.
      // Removing the filter usually narrows the result set, so the
      // user's previous page index is likely empty — resetting to
      // page 1 avoids "No attendees" on what was a valid cursor.
      const cleaned = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (k === 'matchTypeFilter' || k === 'page') continue;
        const first = firstParam(v);
        if (first !== undefined && first !== '') {
          cleaned.set(k, first);
        }
      }
      const qs = cleaned.toString();
      // R007 (staff-review fix 2026-05-13): validate `eventId`
      // path-param shape BEFORE composing the redirect URL. The
      // use-case downstream already rejects malformed eventIds via
      // its own UUID_V4 guard, but a malformed eventId surviving the
      // round-trip would still be reflected in a 302 Location header
      // — wasteful (extra round-trip to a 404) and a minor surface
      // for redirect-class probes. Bail to `notFound()` instead.
      if (!UUID_V4.test(eventId)) {
        notFound();
      }
      redirect(`/admin/events/${eventId}${qs ? `?${qs}` : ''}`);
    }
  }
  const qRaw = firstParam(query.q);
  const q = qRaw && qRaw.trim() !== '' ? qRaw.trim() : null;
  // F6.1 follow-up — paymentStatus filter. `isPaymentStatus()` guards
  // against URL hand-typing arbitrary strings — anything outside the
  // 6 closed values silently drops the filter (fail-safe; don't 500
  // the page on a typo).
  //
  // R2-7 (2026-05-18 /speckit-review Round 2) — log on the guard-drop
  // path so operator troubleshooting of "filter dropped" complaints
  // surfaces in the structured log stream (silent drop was previously
  // invisible). R2-5 sibling fix on `LoadEventDetailInput` made the
  // field required + nullable for consistency with `matchTypeFilter` /
  // `q` — we pass `null` (not undefined) when the filter is absent.
  const paymentStatusRaw = firstParam(query.paymentStatus);
  let paymentStatusFilter: import('@/modules/events').PaymentStatus | null = null;
  if (isPaymentStatus(paymentStatusRaw)) {
    paymentStatusFilter = paymentStatusRaw;
  } else if (paymentStatusRaw !== undefined && paymentStatusRaw !== '') {
    logger.debug(
      {
        event: 'f6_admin_event_detail_payment_status_filter_dropped',
        eventId,
        paymentStatusRaw,
      },
      '[F6.1] invalid paymentStatus URL parameter — filter dropped',
    );
  }

  const reqHeaders = await headers();
  const tenantCtx = resolveTenantFromHeaders(reqHeaders);

  // mirror list-page pattern —
  // try/catch the use-case dispatch + log on either failure path so a
  // raw `runInTenant` rejection cannot bypass the bespoke error card.
  let result: Awaited<ReturnType<typeof runLoadEventDetail>> | null = null;
  try {
    result = await runLoadEventDetail(tenantCtx.slug, {
      eventId,
      page,
      pageSize: PAGE_SIZE,
      unmatchedOnly,
      matchTypeFilter,
      q,
      paymentStatusFilter,
    });
    if (!result.ok && result.error.kind !== 'not_found') {
      logger.error(
        { event: 'admin_event_detail_page_render_error', error: result.error, eventId },
        '[F6] /admin/events/[eventId] detail page — use-case returned err',
      );
    }
  } catch (e) {
    // R9-I1 staff-review fix (2026-05-14) — round-8 W2 contract carry.
    // Scrub container paths from stack before pino captures it.
    logger.error(
      {
        event: 'admin_event_detail_page_render_throw',
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
        eventId,
      },
      '[F6] /admin/events/[eventId] detail page — runLoadEventDetail threw',
    );
  }

  if (result && !result.ok && result.error.kind === 'not_found') {
    notFound();
  }

  if (!result || !result.ok) {
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
    /* P4 (round-10) — 120ms fade-in when the loaded content replaces
       the loading.tsx skeleton. `motion-safe:` honours
       prefers-reduced-motion (WCAG 2.3.3) — reduced-motion users get
       an instant swap. Lives on the loaded-state container only;
       loading.tsx renders the same DetailContainer without these
       classes so the skeleton itself does not fade. */
    <DetailContainer className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[120ms]">
      {/* Register the event name as the breadcrumb label for the
          dynamic `[eventId]` segment so the trail reads
          "Events / <Event Name>" instead of
          "Events / a1b2c3d4-1234-...". Client component effect runs
          AFTER hydration; intermediate render uses the raw UUID
          briefly (typical <100ms). */}
      <DynamicBreadcrumbLabel segment={event.eventId} label={event.name} />
      <PageHeader title={event.name} subtitle={t('subtitle')} />
      {/* C4-lite (round-10) — Phase 6 toggles + archive flow into the
          EventDetailHeader card as an actions slot. The fragment block
          that used to render below the header is gone; the buttons now
          live inside the same card, separated by a top border. Admin-
          only per FR-035 surface-level access matrix + hidden when
          archived per FR-019a (archived events are quota-neutral and
          cannot be re-flagged). The header omits the strip entirely
          when `actions` is undefined. */}
      <EventDetailHeader
        event={event}
        actions={
          currentUser.role === 'admin' && !event.archivedAt ? (
            <>
              <EventCategoryToggles
                eventId={event.eventId}
                isPartnerBenefit={event.isPartnerBenefit}
                isCulturalEvent={event.isCulturalEvent}
              />
              <ArchiveEventButton eventId={event.eventId} />
            </>
          ) : undefined
        }
      />
      <section
        aria-labelledby="attendees-heading"
        className="flex flex-col gap-4"
      >
        {/* R6-B5 staff-review fix (2026-05-13): h3 → h2 to close the
            heading-level skip (PageHeader emits h1; EventDetailHeader
            intentionally renders no heading). WCAG 2.1 SC 1.3.1 (Info
            and Relationships, Level A): skipping a heading level
            signals a missing section to AT users. Visual `text-h3`
            class preserves the existing size — semantic level and
            visual size are decoupled. */}
        <h2 id="attendees-heading" className="text-h3 font-semibold">
          {t('attendees.heading')}
        </h2>
        <AttendeeTable
          rows={
            registrations.map((r) => ({
              registrationId: r.registrationId,
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
              // Round-1 type-H3 — pass branded MemberId | null straight
              // through; the prop boundary preserves the brand. No
              // String() coercion needed.
              currentMatchedMemberId: r.matchedMemberId,
              isPseudonymised: r.isPseudonymised,
            })) satisfies AttendeeRow[]
          }
          unmatchedOnly={unmatchedOnly}
          initialSearch={q ?? ''}
          {...(paymentStatusFilter !== null && {
            initialPaymentStatus: paymentStatusFilter,
          })}
          // F6 Phase 9 / US6 — admin-only column; manager render path
          // hides it. Archived events disable relink because the
          // use-case short-circuits with `event_archived`.
          eventId={event.eventId}
          canRelink={currentUser.role === 'admin' && !event.archivedAt}
        />
        <TablePagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.totalCount}
          baseHref={`/admin/events/${eventId}`}
        />
      </section>
      <span className="sr-only">{tShared('loaded')}</span>
    </DetailContainer>
  );
}
