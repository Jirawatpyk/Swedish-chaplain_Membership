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
import { formatLocalisedDate } from '@/lib/format-date-localised';
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
    // role="alert" (assertive live region) ensures screen readers
    // interrupt current speech to announce the error immediately —
    // WCAG SC 4.1.3. role="status" is polite + non-blocking; wrong
    // semantic for an error.
    return (
      <TableContainer>
        <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
        <div
          className="text-body rounded-md border border-destructive/30 bg-destructive/5 p-4"
          role="alert"
        >
          {t('loadError')}{' '}
          <Link
            href="/admin/events/import/history"
            className="font-medium underline-offset-2 hover:underline"
          >
            {t('loadErrorRetry')}
          </Link>
        </div>
      </TableContainer>
    );
  }

  // Bangkok TZ is mandatory — Vercel runtime is UTC; without an
  // explicit timeZone all rendered timestamps drift 7 h behind. The
  // shared helper also handles Thai Buddhist Era display for th-TH.
  //
  // Staff-review T060 follow-up (2026-05-16): pre-format on the server
  // because function props from a Server Component to a Client
  // Component are rejected at the RSC serialization boundary in
  // Next.js 15+ App Router. The Client Component renders the
  // pre-formatted string verbatim.
  const formatTimestamp = (iso: string): string =>
    formatLocalisedDate(iso, locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Bangkok',
    });

  const rows: CsvImportHistoryRow[] = result.value.rows.map((row) => ({
    recordId: row.record.recordId,
    uploadedAt: row.record.uploadedAt.toISOString(),
    uploadedAtDisplay: formatTimestamp(row.record.uploadedAt.toISOString()),
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

  // Staff-review T060 follow-up (2026-05-16): pre-compute prev/next
  // pagination URLs on the server (serializable strings) instead of
  // passing a `pageHref(page) => string` function prop. Only the two
  // neighbouring pages are ever linked, so per-page URL pre-building
  // is bounded + cheap.
  const buildPageHref = (targetPage: number): string => {
    const params = new URLSearchParams();
    params.set('page', String(targetPage));
    if (perPage !== 30) params.set('perPage', String(perPage));
    return `/admin/events/import/history?${params.toString()}`;
  };
  const { page: currentPage, totalPages } = result.value.pagination;
  const prevPageHref =
    currentPage > 1 ? buildPageHref(currentPage - 1) : null;
  const nextPageHref =
    currentPage < totalPages ? buildPageHref(currentPage + 1) : null;

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
        prevPageHref={prevPageHref}
        nextPageHref={nextPageHref}
      />
    </TableContainer>
  );
}
