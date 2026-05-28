/**
 * F9 US2 (T047) — staff audit-log viewer (`/admin/audit`).
 *
 * Read-only, filterable, keyset-paginated view over the append-only
 * `audit_log` (FR-008..013). Staff-only: admin + the read-only-on-finance
 * manager (member never reaches `/admin/*`). Managers see actor identity but
 * have sensitive payload fields redacted (FR-011) — enforced by the
 * `auditQuery` use-case, not here. Gated behind `FEATURE_F9_DASHBOARD`
 * (notFound when dark). Server-rendered: the client `<AuditFilters>` syncs
 * filters to the URL, pagination is a cursor link, and the header carries the
 * CSV export download link.
 */
import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { DashboardErrorState } from '@/components/dashboard/dashboard-error-state';
import { AuditFilters } from '@/components/audit/audit-filters';
import { AuditTable, type AuditTableRow } from '@/components/audit/audit-table';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { humanizeEventType, resolveEventLabel } from '@/lib/audit-event-label';
import { tenantDayStartUtc, tenantDayEndUtc, isYmd } from '@/lib/tenant-day-range';
import { AUDIT_EVENT_TYPES } from '@/modules/auth';
import {
  auditQuery,
  makeAuditQueryDeps,
  F9_AUDIT_EVENT_TYPES,
  type AuditQueryInput,
} from '@/modules/insights';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.audit');
  return { title: t('title') };
}

/** Selectable event-type codes — the F1/F5 enum set plus the F9 read events. */
const EVENT_TYPE_OPTIONS: readonly string[] = [
  ...new Set<string>([...AUDIT_EVENT_TYPES, ...F9_AUDIT_EVENT_TYPES]),
].sort();

type SearchParams = Record<string, string | string[] | undefined>;

/** First value of a possibly-repeated query param, trimmed. */
function str(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? '').trim();
}

/** Render a redacted payload value as a compact, readable string. */
function formatPayloadValue(value: unknown, noneLabel: string): string {
  if (value === null || value === undefined) return noneLabel;
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((v) => String(v)).join(', ') : noneLabel;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default async function AuditLogPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const { user } = await requireSession('staff');
  if (!env.features.f9Dashboard) notFound();

  const params = await searchParams;
  const t = await getTranslations('admin.audit');
  const locale = await getLocale();
  const tenant = resolveTenantFromRequest();

  const eventType = str(params.eventType);
  const actorUserId = str(params.actorUserId);
  const targetRef = str(params.targetRef);
  const from = str(params.from);
  const to = str(params.to);
  const cursor = str(params.cursor);

  // A malformed `from`/`to` (tampered URL) must surface as the invalid-range
  // state, NOT throw inside js-joda (`tenantDayParse`) → generic error card. Guard
  // the format up front and render the same invalid-range UI the use-case uses.
  const tz = env.tenant.timezone;
  if ((from !== '' && !isYmd(from)) || (to !== '' && !isYmd(to))) {
    return (
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <AuditFilters eventTypeOptions={EVENT_TYPE_OPTIONS} />
        <DashboardErrorState
          title={t('invalidRange.title')}
          description={t('invalidRange.body')}
        />
      </TableContainer>
    );
  }

  // Date inputs are `YYYY-MM-DD` CALENDAR days in the tenant's timezone; convert
  // to the exact UTC instants that bound that local day (FR-009 — a UTC-literal
  // boundary would silently drop a partial day for non-UTC tenants like
  // Asia/Bangkok).
  const input: AuditQueryInput = {
    ...(eventType ? { eventType: [eventType] } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(targetRef ? { targetRef } : {}),
    ...(from ? { from: tenantDayStartUtc(from, tz) } : {}),
    ...(to ? { to: tenantDayEndUtc(to, tz) } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };

  const meta = {
    actorUserId: user.id as string,
    actorRole: user.role,
    requestId: randomUUID(),
  };

  const result = await auditQuery(input, meta, tenant, makeAuditQueryDeps());

  // The export link preserves the active filters (never the page cursor — it
  // streams the whole filtered set).
  const exportParams = new URLSearchParams();
  if (eventType) exportParams.set('eventType', eventType);
  if (actorUserId) exportParams.set('actorUserId', actorUserId);
  if (targetRef) exportParams.set('targetRef', targetRef);
  if (from) exportParams.set('from', from);
  if (to) exportParams.set('to', to);
  const exportQuery = exportParams.toString();
  const exportHref = `/api/admin/audit/export.csv${exportQuery ? `?${exportQuery}` : ''}`;

  const header = (
    <PageHeader
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        result.ok ? (
          <a href={exportHref} download className={buttonVariants({ variant: 'outline' })}>
            {t('export')}
          </a>
        ) : undefined
      }
    />
  );

  if (!result.ok) {
    return (
      <TableContainer>
        {header}
        {result.error === 'forbidden' ? (
          <p className="rounded-md border py-10 text-center text-muted-foreground">
            {t('forbidden')}
          </p>
        ) : (
          <>
            <AuditFilters eventTypeOptions={EVENT_TYPE_OPTIONS} />
            <DashboardErrorState
              title={t('invalidRange.title')}
              description={t('invalidRange.body')}
            />
          </>
        )}
      </TableContainer>
    );
  }

  // `timeZone: tz` is essential — the Vercel runtime is UTC, so without it the
  // "local" column would render UTC and duplicate the UTC line (FR-012 dual
  // timestamp). Render the instant in the tenant's timezone.
  const dateFmt = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  });
  const tEvents = await getTranslations('admin.dashboard.activity.events');
  const noneLabel = t('table.none');
  const rows: readonly AuditTableRow[] = result.value.rows.map((r) => ({
    id: r.id,
    occurredAtUtc: r.occurredAt,
    occurredAtLocal: dateFmt.format(new Date(r.occurredAt)),
    eventTypeLabel: resolveEventLabel(tEvents, r.eventType),
    eventType: r.eventType,
    actorLabel: r.actorLabel,
    actorUserId: r.actorUserId,
    targetLabel: r.targetLabel,
    targetUserId: r.targetUserId,
    summary: r.summary,
    payloadEntries: r.payload
      ? Object.entries(r.payload).map(([key, value]) => ({
          label: humanizeEventType(key),
          value: formatPayloadValue(value, noneLabel),
        }))
      : [],
  }));

  const nextParams = new URLSearchParams(exportParams);
  if (result.value.nextCursor !== null) nextParams.set('cursor', result.value.nextCursor);
  const nextHref =
    result.value.nextCursor !== null ? `/admin/audit?${nextParams.toString()}` : null;

  return (
    <TableContainer>
      {header}

      <Card>
        <CardContent className="flex flex-col gap-4">
          <AuditFilters eventTypeOptions={EVENT_TYPE_OPTIONS} />

          {/* SR result-count announcement — re-rendered on every filter navigation. */}
          <p role="status" className="sr-only">
            {t('resultCount', { count: rows.length })}
          </p>

          <AuditTable
            rows={rows}
            labels={{
              caption: t('table.caption'),
              time: t('table.time'),
              event: t('table.event'),
              actor: t('table.actor'),
              target: t('table.target'),
              summary: t('table.summary'),
              payload: t('table.payload'),
              emptyTitle: t('table.emptyTitle'),
              empty: t('table.empty'),
              none: t('table.none'),
              utcLabel: t('table.utcLabel'),
            }}
          />

          {nextHref ? (
            <div className="flex justify-center">
              <a href={nextHref} className={buttonVariants({ variant: 'outline' })}>
                {t('pagination.next')}
              </a>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </TableContainer>
  );
}
