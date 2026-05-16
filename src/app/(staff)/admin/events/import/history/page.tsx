/**
 * T046 (F6.1 · Feature 013 — Phase 5 US5) —
 * /admin/events/import/history — CSV import history admin page.
 *
 * Server component. Admin-only via `requireSession('staff')` + role
 * check (manager/member → 404 surface-disclosure per FR-035). Renders
 * the paginated history table inside `TableContainer` (96rem,
 * content-type "data table") per 006-layout convention.
 *
 * Pagination via search params: `?page=N&perPage=M`. The page passes
 * a `pageHref` builder to the client component so URL construction
 * stays in one place.
 *
 * Feature-flag gated by `env.features.f6EventCreate`: when off,
 * `notFound()` returns 404.
 */
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { runListCsvImportRecords } from '@/lib/events-csv-import-deps';
import {
  CsvImportHistoryTable,
  type CsvImportHistoryRow,
} from '@/components/events/csv-import-history-table';

interface PageProps {
  readonly searchParams: Promise<{
    readonly page?: string;
    readonly perPage?: string;
  }>;
}

export default async function CsvImportHistoryPage({
  searchParams,
}: PageProps) {
  if (!env.features.f6EventCreate) {
    notFound();
  }
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') {
    notFound();
  }

  const tenantSlug = resolveTenantFromHeaders(await headers()).slug;
  const t = await getTranslations('admin.events.import.history');
  const locale = await getLocale();

  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const perPage = Math.min(
    100,
    Math.max(1, Number.parseInt(params.perPage ?? '30', 10) || 30),
  );

  const result = await runListCsvImportRecords({
    tenantSlug,
    page,
    perPage,
  });

  // Defensive: use-case typed as never-failing today; if a future repo
  // change introduces a hard-fail, surface a user-friendly error
  // banner without crashing the route.
  if (!result.ok) {
    return (
      <TableContainer>
        <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
        <div
          className="text-body rounded-md border border-destructive/30 bg-destructive/5 p-4"
          role="status"
        >
          {t('loadError')}
        </div>
      </TableContainer>
    );
  }

  const formatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const rows: CsvImportHistoryRow[] = result.value.rows.map((row) => ({
    recordId: row.record.recordId,
    uploadedAt: row.record.uploadedAt.toISOString(),
    actor: { userId: row.record.actorUserId },
    event: { eventId: row.record.eventId },
    sourceFormat: row.record.sourceFormat,
    originalFilename: row.record.originalFilename,
    originalSizeBytes: row.record.originalSizeBytes,
    counts: {
      total: row.record.rowsTotal,
      processed: row.record.rowsProcessed,
      alreadyImported: row.record.rowsAlreadyImported,
      skipped: row.record.rowsSkipped,
      failed: row.record.rowsFailed,
    },
    outcome: row.record.outcome,
    durationMs: row.record.durationMs,
    errorCsvAvailable: row.errorCsvAvailable,
    errorCsvExpiresAt: row.record.errorCsvExpiresAt?.toISOString() ?? null,
  }));

  const pageHref = (targetPage: number): string => {
    const params = new URLSearchParams();
    params.set('page', String(targetPage));
    if (perPage !== 30) params.set('perPage', String(perPage));
    return `/admin/events/import/history?${params.toString()}`;
  };

  return (
    <TableContainer>
      <PageHeader
        title={t('pageTitle')}
        subtitle={t('pageSubtitle')}
        actions={
          <Link
            href="/admin/events/import"
            className={cn(buttonVariants({ variant: 'outline' }))}
          >
            {t('backToImport')}
          </Link>
        }
      />
      <CsvImportHistoryTable
        rows={rows}
        pagination={result.value.pagination}
        pageHref={pageHref}
        formatTimestamp={(iso) => formatter.format(new Date(iso))}
      />
    </TableContainer>
  );
}
