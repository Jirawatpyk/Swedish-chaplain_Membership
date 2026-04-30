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
import { db, runInTenant } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.queue');
  return { title: t('title') };
}

interface SearchParams {
  readonly status?: string | string[];
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
  const t = await getTranslations('admin.broadcasts.queue');
  const session = await requireSession('staff');
  const isReadOnlyManager = session.user.role === 'manager';

  const tenant = resolveTenantFromRequest();
  const params = await searchParams;

  const statusRaw = params.status === undefined
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

  // Member display-name map for queue rows
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

  // SLA stats (re-uses route logic inline; cheap read)
  const slaRows = (await runInTenant(tenant, async (tx) =>
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
      WHERE tenant_id = ${tenant.slug}
        AND submitted_at >= NOW() - INTERVAL '30 days'
        AND status IN ('approved', 'rejected', 'sending', 'sent')
    `),
  )) as unknown as Array<{
    decision_count: number;
    median_hours: string | number | null;
    p95_hours: string | number | null;
  }>;
  const slaRow = slaRows[0];
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

  // Pending count for header subtitle
  const pendingRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM broadcasts
    WHERE tenant_id = ${tenant.slug} AND status = 'submitted'
  `) as unknown as Array<{ n: number }>;
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
      <QueueFilters
        current={{
          status,
          memberId: params.memberId ?? null,
          fromDate: params.fromDate ?? null,
          toDate: params.toDate ?? null,
        }}
        memberOptions={memberOptions}
      />
      <div className="mt-4">
        <QueueTable rows={rows} readOnly={isReadOnlyManager} />
      </div>
    </TableContainer>
  );
}
