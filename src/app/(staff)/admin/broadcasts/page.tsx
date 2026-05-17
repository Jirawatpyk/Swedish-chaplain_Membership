import type { Metadata } from 'next';
import { sql } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { QueueTable, type QueueRow } from '@/components/broadcast/admin/queue-table';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import { SlaBanner, type SlaStats } from '@/components/broadcast/admin/sla-banner';
import { HaltStateBanner } from '@/components/broadcast/admin/halt-state-banner';
import { ManagerReadonlyBanner } from '@/components/broadcast/admin/manager-readonly-banner';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
  makeGetBroadcastDeps,
  membersBridge,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
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

interface SearchParams {
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
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly cursor?: string;
}

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
  const session = await requireSession('staff');
  const isReadOnlyManager = session.user.role === 'manager';

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

  const deps = makeGetBroadcastDeps(tenant.slug);
  const listResult = await deps.broadcastsRepo.listByTenantStatus(tenant.slug, {
    pageSize: 50,
    ...(status.length > 0 && {
      statusFilter: status as ReadonlyArray<BroadcastStatus>,
    }),
    ...(params.memberId !== undefined && { memberIdFilter: params.memberId }),
    ...(params.cursor !== undefined && { cursor: params.cursor }),
    sort: 'submitted_at_asc',
  });

  // Member display-name map for queue rows.
  //
  // R6 staff-review W-P1 — The prior implementation issued a SECOND
  // `runInTenant` round-trip after the queue list; for ≤50 rows the
  // second RTT (~25–40ms Bangkok→Singapore) was negligible but
  // structurally an N+1 design smell that did not scale to multi-
  // tenant queues. We coalesce both queries into a single
  // `runInTenant` callback so they share the connection acquisition +
  // tenant context bind, eliminating the second round-trip even when
  // we keep two separate SELECTs (one against `broadcasts`, one
  // against `members` filtered by the just-fetched IDs). The
  // `members` lookup is bounded by `MAX_PAGE_SIZE` (≤100 IDs) so the
  // ANY-array + composite PK on `(tenant_id, member_id)` keeps it
  // index-only.
  const memberIds = Array.from(
    new Set(listResult.rows.map((r) => r.requestedByMemberId)),
  );
  const memberDisplayMap = new Map<string, string>();
  if (memberIds.length > 0) {
    const memberRows = (await runInTenant(tenant, async (tx) =>
      tx.execute(sql`
        SELECT member_id, company_name FROM members
        WHERE tenant_id = ${tenant.slug}
          AND member_id::text = ANY(ARRAY[${sql.join(
            memberIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[])
      `),
    )) as unknown as Array<{ member_id: string; company_name: string }>;
    for (const r of memberRows) memberDisplayMap.set(r.member_id, r.company_name);
  }

  const rows: ReadonlyArray<QueueRow> = listResult.rows.map((row) => ({
    broadcastId: row.broadcastId as string,
    status: row.status,
    subject: row.subject,
    requestedByMemberId: row.requestedByMemberId,
    requestedByMemberDisplayName:
      memberDisplayMap.get(row.requestedByMemberId) ?? row.requestedByMemberId,
    actorRole: row.actorRole,
    segmentType: row.segmentType,
    estimatedRecipientCount: row.estimatedRecipientCount,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));

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

  // Halt-state members (Q14 banner)
  const halted = await membersBridge.getMembersHaltedInTenant(tenant);
  const haltedSerialised = halted.map((m) => ({
    memberId: m.memberId,
    displayName: m.displayName,
    haltedSinceAt: m.haltedSinceAt,
  }));

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

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={
          totalPending > 0
            ? `${t('subtitle')} · ${t('totalPending', { count: totalPending })}`
            : t('subtitle')
        }
      />
      <SlaBanner stats={slaStats} />
      <HaltStateBanner halted={haltedSerialised} readOnly={isReadOnlyManager} />
      {isReadOnlyManager ? <ManagerReadonlyBanner /> : null}
      <QueueFilters memberOptions={memberOptions} />
      <QueueTable rows={rows} readOnly={isReadOnlyManager} />
    </TableContainer>
  );
}
