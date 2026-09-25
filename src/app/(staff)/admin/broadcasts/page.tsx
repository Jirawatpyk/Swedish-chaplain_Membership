import type { Metadata } from 'next';
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { LayoutTemplateIcon } from 'lucide-react';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { QueueTable } from '@/components/broadcast/admin/queue-table';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import { SlaBanner, type SlaStats } from '@/components/broadcast/admin/sla-banner';
import { OverdueBanner } from '@/components/broadcast/admin/overdue-banner';
import { isDefaultBroadcastView } from './_lib/is-default-view';
import { queueOrderOf, queuePageHref, queueViewKey, queueViewNarrowed, queueViewTotal } from './_lib/queue-view';
import { HaltStateBanner } from '@/components/broadcast/admin/halt-state-banner';
import { HaltStateUnavailableBanner } from '@/components/broadcast/admin/halt-state-unavailable-banner';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { ManagerReadonlyBanner } from '@/components/broadcast/admin/manager-readonly-banner';
import { isF71aUs7Enabled } from '@/modules/broadcasts';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
  membersBridge,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { isUpcomingPreset, loadAdminBroadcastQueue, queueSortFor, upcomingFrom } from '@/lib/admin-broadcast-queue';
import { readEblastStageChips } from '@/lib/eblast-waiting-count';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { isYmd, tenantDayRangeUtc } from '@/lib/tenant-day-range';
import { unstable_cache } from 'next/cache';

/**
 * R6 staff-review W-P2 fix — cache the PERCENTILE_CONT SLA stats
 * computation per tenant for 5 minutes. The PERCENTILE_CONT WITHIN
 * GROUP query is an O(n) sort on the 30-day broadcasts window with no
 * dedicated index covering `(submitted_at, status)` — for the SweCham
 * MVP the absolute time is sub-100ms, but on every page load it sat
 * on the critical path of the 500ms admin-queue TTFB budget
 * (SLO-F7-003) and would scale poorly when SaaS multi-tenant lands.
 *
 * 5-min TTL is a balance between:
 *   - admin-decision-latency dashboards needing to reflect new
 *     `approved`/`rejected` transitions reasonably promptly, and
 *   - avoiding unnecessary re-aggregation when the page is refreshed
 *     repeatedly during a review session.
 *
 * The cache key is per-tenant (mandatory for tenant isolation —
 * Constitution Principle I clause 1; the `runInTenant` boundary is
 * preserved inside the cached fetcher so RLS still applies during the
 * actual SQL execution that produces the cached value).
 */
const computeSlaStatsForTenant = unstable_cache(
  async (tenantSlug: string): Promise<{
    decision_count: number;
    median_hours: string | number | null;
    p95_hours: string | number | null;
  } | null> => {
    const tenantCtx = resolveTenantFromRequest();
    // Sanity: cache key tenantSlug must match the resolved tenant ctx
    // (defence in depth; in single-tenant SweCham they always agree).
    if (tenantCtx.slug !== tenantSlug) return null;
    const slaRows = (await runInTenant(tenantCtx, async (tx) =>
      tx.execute(sql`
        SELECT
          COUNT(*)::int AS decision_count,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              COALESCE(approved_at, rejected_at) - submitted_at
            )) / 3600.0
          ) AS median_hours,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              COALESCE(approved_at, rejected_at) - submitted_at
            )) / 3600.0
          ) AS p95_hours
        FROM broadcasts
        WHERE tenant_id = ${tenantSlug}
          AND submitted_at >= NOW() - INTERVAL '30 days'
          AND status IN ('approved', 'rejected', 'sending', 'sent')
      `),
    )) as unknown as Array<{
      decision_count: number;
      median_hours: string | number | null;
      p95_hours: string | number | null;
    }>;
    return slaRows[0] ?? null;
  },
  ['admin-broadcasts-sla-stats'],
  { revalidate: 300, tags: ['admin-broadcasts-sla-stats'] },
);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.queue');
  return { title: t('title') };
}

// A type alias, not an interface: the view helpers (`_lib/queue-view.ts`)
// take any string-keyed parameter record, and only an alias carries the
// implicit index signature that assignment needs.
type SearchParams = {
  readonly status?: string | string[];
  /**
   * Sentinel — `status_all=1` means the user explicitly chose "show
   * every status" (unchecked the last filter chip). Distinguished from
   * "no `status` param at all" which is a fresh visit and defaults to
   * `['submitted']` per FR-010 default-view semantics. See `queue-
   * filters.tsx` toggleStatus() for the client-side writer.
   */
  readonly status_all?: string;
  readonly memberId?: string;
  /**
   * FR-030 — `YYYY-MM-DD` days in the tenant's timezone bounding `submitted_at`,
   * both days whole. One that is not a real calendar day is ignored here (the
   * list API refuses it with a 400 instead).
   */
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly cursor?: string;
  /**
   * F119 T119 — `sort=scheduled_for&from=now` is the Upcoming sends preset
   * (with `status=approved`): scheduled E-Blasts from now on, in send-time
   * order. Any other `sort` is the dashboard's default order (UX review H1:
   * longest in stage first on a view of waiting stages, most recent first on
   * any other); any other `from` is no bound.
   */
  readonly sort?: string;
  readonly from?: string;
};

export default async function AdminBroadcastsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<React.ReactElement> {
  // T172 NOTE: SLO-F7-003 admin queue list TTFB is measured via
  // Vercel Speed Insights per docs/observability.md § 22.2 source-
  // signal table — NOT via OTel histogram. React 19 server-component
  // purity rule (`react-hooks/purity`) forbids `Date.now()` in
  // component body. Auto-instrumented span comes from `@vercel/otel`.
  const t = await getTranslations('admin.broadcasts.queue');
  const tBroadcasts = await getTranslations('admin.broadcasts');
  const session = await requirePagePermission('broadcasts.read');
  // 016 re-review D — evaluator-derived: the `role === 'manager'` literal
  // treated every non-manager as a writer, so a promoted super_admin was fine
  // by luck but PR-4 marketing (holds broadcasts.write) would have been
  // read-only-banner'd — and any future read-only staff role would silently
  // get write CTAs. OFF leg `legacyAdminOnly` reproduces admin-only writes.
  // (Banner copy still says "manager"; revisit wording at PR 4.)
  const isReadOnlyManager = !canPerform(session.user.role, 'broadcasts.write');

  const tenant = resolveTenantFromRequest();
  const params = await searchParams;

  // Status filter resolution — three cases (D1 sentinel pattern):
  //   1) `?status_all=1` (sentinel): explicit "show every status" →
  //      empty filter, list all rows regardless of state.
  //   2) `?status=X[&status=Y...]`: filter to the listed statuses.
  //   3) no params at all: fresh visit → default to `['submitted']`
  //      per FR-010 (admin's primary task is review of pending).
  const explicitShowAll = params.status_all === '1';
  const statusRaw = explicitShowAll
    ? []
    : params.status === undefined
      ? ['submitted']
      : Array.isArray(params.status)
        ? params.status
        : [params.status];
  const status = statusRaw.filter((s) =>
    (BROADCAST_STATUSES as readonly string[]).includes(s),
  ) as BroadcastStatus[];

  // F119 T117 / T119 — ONE projection for the page and the list API
  // (`loadAdminBroadcastQueue`): the FR-026 columns, the member name, and the
  // delivery results of sent rows. Order (UX review H1, `queueSortFor`):
  // longest in the current stage first on a view of waiting stages only (on
  // the default Awaiting-review view that is the old submitted-first order —
  // submit stamps `stage_entered_at`); most recent first on every other view.
  const scheduledFrom = upcomingFrom(params.from);
  const submitted = tenantDayRangeUtc(
    typeof params.fromDate === 'string' && isYmd(params.fromDate) ? params.fromDate : undefined,
    typeof params.toDate === 'string' && isYmd(params.toDate) ? params.toDate : undefined,
    env.tenant.timezone,
  );
  // Round-4 B7 — the send-time order only WITH its `from=now` bound (a keyset
  // over the nullable `scheduled_for` loses the unscheduled rows otherwise);
  // an unbounded `sort=scheduled_for` falls back to the view's own order.
  const sort = queueSortFor(status, isUpcomingPreset(params.sort, params.from));
  const [listResult, stageChips] = await Promise.all([
    loadAdminBroadcastQueue(tenant, {
      statusFilter: status,
      pageSize: 50,
      sort,
      ...(params.memberId !== undefined && { memberId: params.memberId }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
      ...(scheduledFrom !== undefined && { scheduledFrom }),
      ...(submitted.fromInclusive !== undefined && { submittedFrom: submitted.fromInclusive }),
      ...(submitted.toExclusive !== undefined && { submittedBefore: submitted.toExclusive }),
    }),
    // F119 T116 (FR-025, R18) — the per-stage chip counts + the flag the chip
    // strip's "flag ON or rows exist" rule needs. A failed read degrades to
    // chips without numbers; it never fails the page.
    readEblastStageChips(tenant, 'M119.admin.broadcasts.stage_counts_failed'),
  ]);

  const rows = listResult.items;

  // UX review H3 — the announcement counts the VIEW, not this page of ≤ 50:
  // the chip counts summed over the view's stages, when nothing they cannot
  // see (a member, the Upcoming bound, the FR-030 date range) narrows it. H4 — the view's identity,
  // so a change of view is announced even when it lands on the same rows.
  const viewTotal = queueViewTotal({
    stageCounts: stageChips.kind === 'ok' ? stageChips.counts : null,
    statusFilter: status,
    allStatuses: BROADCAST_STATUSES,
    narrowed: queueViewNarrowed({
      ...(params.memberId !== undefined && { memberId: params.memberId }),
      ...(scheduledFrom !== undefined && { scheduledFrom }),
      submitted,
    }),
    firstPage: params.cursor === undefined,
    rowsOnPage: rows.length,
    hasNextPage: listResult.nextCursor !== null,
  });
  const viewKey = queueViewKey(params);

  // SLA stats — R6 W-P2: 5-min cached PERCENTILE_CONT aggregate (see
  // `computeSlaStatsForTenant` above). Result is per-tenant.
  const slaRow = await computeSlaStatsForTenant(tenant.slug);
  const median =
    slaRow?.median_hours !== null && slaRow?.median_hours !== undefined
      ? Number(slaRow.median_hours)
      : null;
  const p95 =
    slaRow?.p95_hours !== null && slaRow?.p95_hours !== undefined
      ? Number(slaRow.p95_hours)
      : null;
  const severity: SlaStats['bannerSeverity'] =
    median === null || p95 === null
      ? 'green'
      : p95 > 48
        ? 'red'
        : median > 24 || p95 > 40
          ? 'amber'
          : 'green';
  const slaStats: SlaStats = {
    targetSlaHours: 48,
    medianTimeToDecisionHours: median,
    p95TimeToDecisionHours: p95,
    decisionCount: slaRow?.decision_count ?? 0,
    bannerSeverity: severity,
  };

  // Halt-state members (Q14 banner). Review 2026-09-07 — the bridge THROWS
  // on a failed read (it used to answer `[]`, so an outage rendered a clean
  // queue with the red banner silently gone). Render an explicit
  // "unavailable" notice instead: staff must not approve against a queue
  // that may be hiding a halted member.
  let haltedSerialised: ReadonlyArray<{
    memberId: string;
    displayName: string;
    haltedSinceAt: Date;
  }> = [];
  let haltStateUnavailable = false;
  try {
    const halted = await membersBridge.getMembersHaltedInTenant(tenant);
    haltedSerialised = halted.map((m) => ({
      memberId: m.memberId,
      displayName: m.displayName,
      haltedSinceAt: m.haltedSinceAt,
    }));
  } catch (e) {
    haltStateUnavailable = true;
    logger.error(
      { tenantId: tenant.slug, err: errKind(e) },
      'admin.broadcasts.queue.halt_read_failed',
    );
  }

  // Member options for filter dropdown (≤200 for SweCham MVP)
  const memberOptionsRows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT member_id::text AS member_id, company_name
      FROM members
      WHERE tenant_id = ${tenant.slug}
        AND status = 'active'
      ORDER BY company_name ASC
      LIMIT 200
    `),
  )) as unknown as Array<{ member_id: string; company_name: string }>;
  const memberOptions = memberOptionsRows.map((r) => ({
    memberId: r.member_id,
    displayName: r.company_name,
  }));

  // Pending count for header subtitle.
  // Round-4 CRIT-A: routed through `runInTenant` so RLS+FORCE on
  // `broadcasts` applies (Constitution Principle I two-layer isolation).
  const pendingRows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM broadcasts
      WHERE tenant_id = ${tenant.slug} AND status = 'submitted'
    `),
  )) as unknown as Array<{ n: number }>;
  const totalPending = pendingRows[0]?.n ?? 0;

  // Overdue-now count — `submitted` broadcasts waiting > 48h. Distinct
  // from `slaStats`'s 30-day rolling median/p95 (decided broadcasts
  // only): this is a point-in-time CURRENT-backlog count over the
  // still-`submitted` queue, so a healthy 30-day trend can't mask a
  // pile-up sitting in the queue right now. Routed through
  // `runInTenant` for the same RLS+FORCE reason as `totalPending`.
  const overdueRows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM broadcasts
      WHERE tenant_id = ${tenant.slug}
        AND status = 'submitted'
        AND submitted_at < NOW() - INTERVAL '48 hours'
    `),
  )) as unknown as Array<{ n: number }>;
  const overdueCount = overdueRows[0]?.n ?? 0;

  // Overdue banner only on the default `submitted`
  // view — a filtered/searched subset would mislead (mirror
  // erasure-log unfiltered gating in
  // `compliance/erasure-log/page.tsx`). Delegated to a pure helper
  // (`_lib/is-default-view.ts`) that mirrors `queue-filters.tsx`'s
  // `hasAnyFilter` — including `fromDate`/`toDate` — so this gate can
  // never drift from what the filter bar's "Reset" button considers
  // an active filter (Task 3 review fix, Important).
  const isDefaultView = isDefaultBroadcastView(params);
  const showOverdue = isDefaultView && overdueCount > 0;
  // UX review H1 — every view pages, not only the default one: a Sent view
  // with no way past its first 50 rows hid everything older. Keyset pages
  // forward ("Next page") and back to the start ("First page").
  const nextPageHref =
    listResult.nextCursor !== null ? queuePageHref(params, listResult.nextCursor) : null;
  const firstPageHref = params.cursor !== undefined ? queuePageHref(params, null) : null;

  // F7.1a US7 (T112+) — surface admin templates entry-point on the
  // queue header. Gated by isF71aUs7Enabled so when the flag is OFF
  // the link doesn't render a path that would 404 via notFound() on
  // /admin/broadcasts/templates. Manager (read-only) sees it too —
  // template CRUD requires admin role enforced at the route level,
  // but a manager visiting the page gets a clean 404 not a forbidden
  // hidden link (parity with how /admin/broadcasts/[id] read-only
  // works for managers).
  const templatesEnabled = isF71aUs7Enabled();

  return (
    <TableContainer>
      {/* T155 finding U2 — the actions go through `PageHeader`'s own `actions`
          slot, as `templates/page.tsx` does. The hand-rolled
          `flex items-center gap-2` row that stood here had no `flex-wrap`,
          and `buttonVariants` bakes in `whitespace-nowrap`, so the two links
          overflowed 320 px in every locale (SV +260 px, EN +172 px, TH +32 px
          — measured 2026-09-22). `PageHeader` stacks title and actions below
          `sm`, wraps the action row, and stretches each child to a full-width
          tap target there. axe has no horizontal-scroll rule, so T139 could
          never have caught this; `eblast-a11y.spec.ts` now measures it. */}
      <PageHeader
        title={t('title')}
        subtitle={
          totalPending > 0
            ? `${t('subtitle')} · ${t('totalPending', { count: totalPending })}`
            : t('subtitle')
        }
        actions={
          <>
            {templatesEnabled ? (
              <Link
                href="/admin/broadcasts/templates"
                className={buttonVariants({ variant: 'outline' })}
              >
                <LayoutTemplateIcon
                  className="mr-2 size-4"
                  aria-hidden="true"
                />
                {t('templatesEntryButton')}
              </Link>
            ) : null}
            {/* DV-4 — admin-only proxy-submit entry. Hidden entirely for
                manager (read-only): the e2e asserts the link is absent for
                manager, so this is gated, not merely disabled. Uses the
                `buttonVariants` default (primary CTA, h-9 36px tap target)
                applied to a <Link> — the repo `Button` has no `asChild`
                (Base UI), matching the sibling templates-entry pattern. */}
            {!isReadOnlyManager ? (
              <Link
                href="/admin/broadcasts/new"
                className={buttonVariants()}
              >
                {tBroadcasts('proxySubmitButton')}
              </Link>
            ) : null}
          </>
        }
      />
      <OverdueBanner count={showOverdue ? overdueCount : 0} />
      <SlaBanner stats={slaStats} compact={showOverdue} />
      {haltStateUnavailable ? (
        // Round 2 (UX M-2): the same anatomy as the sibling banner in this slot.
        <HaltStateUnavailableBanner />
      ) : (
        <HaltStateBanner halted={haltedSerialised} readOnly={isReadOnlyManager} />
      )}
      {isReadOnlyManager ? <ManagerReadonlyBanner /> : null}
      <QueueFilters
        memberOptions={memberOptions}
        stageCounts={stageChips.kind === 'ok' ? stageChips.counts : null}
        approvalRoundEnabled={stageChips.approvalRoundEnabled}
      />
      {/* Round 2 (UX M-1): the warning travels to the decision point — the
          bulk-approve confirm dialog repeats it when the halt state is
          unknown. A NEW prop, not `readOnly`: "manager cannot approve" and
          "the halt read failed" are different facts. */}
      <QueueTable
        rows={rows}
        readOnly={isReadOnlyManager}
        haltUnknown={haltStateUnavailable}
        order={queueOrderOf(sort)}
        viewTotal={viewTotal}
        viewKey={viewKey}
        // T086a V10 — rendered by the queue between the list and the bulk
        // toolbar: the toolbar is fixed to the bottom of the viewport, so it is
        // visually last and must come last in Tab order too (it came first).
        pagination={
          nextPageHref !== null || firstPageHref !== null ? (
            <nav
              aria-label={t('pagination.label')}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <p className="text-sm tabular-nums">
                {/* On the first page only: keyset pages have no offset, so on page 2
                    "Showing 50 of 132" would read as the same first 50. */}
                {viewTotal !== null && firstPageHref === null
                  ? t('pagination.summary', { shown: rows.length, total: viewTotal })
                  : null}
              </p>
              <div className="flex flex-wrap gap-2">
                {firstPageHref !== null ? (
                  <Link href={firstPageHref} className={buttonVariants({ variant: 'outline' })}>
                    {t('pagination.first')}
                  </Link>
                ) : null}
                {nextPageHref !== null ? (
                  <Link href={nextPageHref} className={buttonVariants({ variant: 'outline' })}>
                    {t('pagination.next')}
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null
        }
      />
    </TableContainer>
  );
}
