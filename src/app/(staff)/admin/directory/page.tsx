/**
 * F9 US5 (T082) — staff member directory (`/admin/directory`).
 *
 * Searchable internal directory (FR-024: keyword across company/industry/
 * description + listed filter) plus async E-Book (PDF) + JSON generation
 * (FR-026/027) with a recent-exports list + private download links. Staff-only
 * (admin + manager; member never reaches `/admin/*`). Gated behind
 * `FEATURE_F9_DASHBOARD` (notFound when dark). Server-rendered; the client
 * `<DirectorySearchFilters>` syncs filters to the URL.
 */
import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { DirectorySearchFilters } from '@/components/directory/directory-search-filters';
import { DirectoryTable, type DirectoryTableRow } from '@/components/directory/directory-table';
import { GenerateExportActions } from '@/components/directory/generate-export-actions';
import { RecentExports, type RecentExportRow } from '@/components/directory/recent-exports';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import {
  listDirectoryExports,
  makeGenerateDirectoryExportDeps,
  makeSearchDirectoryDeps,
  searchDirectory,
  type SearchDirectoryInput,
} from '@/modules/insights';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.directory');
  return { title: t('title') };
}

type SearchParams = Record<string, string | string[] | undefined>;

function str(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw ?? '').trim();
}

function locationText(city: string | null, country: string | null): string | null {
  const parts = [city, country].filter((p): p is string => p !== null && p !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

export default async function DirectoryPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<React.JSX.Element> {
  const { user } = await requireSession('staff');
  if (!env.features.f9Dashboard) notFound();

  const params = await searchParams;
  const t = await getTranslations('admin.directory');
  const tExports = await getTranslations('admin.directory.exports');
  const tKind = await getTranslations('admin.directory.exports.kind');
  const tStatus = await getTranslations('admin.directory.exports.status');
  const locale = await getLocale();
  const tenant = resolveTenantFromRequest();

  const q = str(params.q);
  const listedOnly = str(params.listed) === 'true';
  const pageNum = Math.max(1, Number.parseInt(str(params.page) || '1', 10) || 1);

  const meta = {
    actorUserId: user.id as string,
    actorRole: user.role,
    requestId: randomUUID(),
  };

  const input: SearchDirectoryInput = {
    ...(q ? { q } : {}),
    ...(listedOnly ? { listedOnly: true } : {}),
    page: pageNum,
    pageSize: 50,
  };

  const result = await searchDirectory(input, meta, tenant, makeSearchDirectoryDeps(tenant.slug));
  const exportsResult = await listDirectoryExports(
    meta,
    tenant,
    makeGenerateDirectoryExportDeps(tenant.slug),
  );

  const header = (
    <PageHeader
      title={t('title')}
      subtitle={t('subtitle')}
      actions={result.ok ? <GenerateExportActions /> : undefined}
    />
  );

  if (!result.ok) {
    return (
      <TableContainer>
        {header}
        <p className="rounded-md border py-10 text-center text-muted-foreground">
          {t('forbidden')}
        </p>
      </TableContainer>
    );
  }

  const rows: readonly DirectoryTableRow[] = result.value.items.map((item) => ({
    memberId: item.memberId,
    companyName: item.companyName,
    tier: item.tier,
    industry: item.industry,
    location: locationText(item.locationCity, item.locationCountry),
    listed: item.listed,
    hasLogo: item.hasLogo,
    contactName: item.contactName,
  }));

  const dateFmt = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: env.tenant.timezone,
  });
  const exportRows: readonly RecentExportRow[] = exportsResult.ok
    ? exportsResult.value.map((job) => ({
        jobId: job.id,
        kindLabel: tKind(job.kind),
        statusLabel: tStatus(job.status),
        downloadable: job.status === 'ready' || job.status === 'delivered',
        requestedAt: dateFmt.format(job.createdAt),
      }))
    : [];

  return (
    <TableContainer>
      {header}

      <DirectorySearchFilters />

      <p role="status" className="sr-only">
        {t('resultCount', { count: result.value.total })}
      </p>

      <DirectoryTable
        rows={rows}
        labels={{
          caption: t('table.caption'),
          company: t('table.company'),
          tier: t('table.tier'),
          industry: t('table.industry'),
          location: t('table.location'),
          listed: t('table.listed'),
          logo: t('table.logo'),
          contact: t('table.contact'),
          hasLogo: t('table.hasLogo'),
          yes: t('table.yes'),
          no: t('table.no'),
          emptyTitle: t('table.emptyTitle'),
          empty: t('table.empty'),
        }}
      />

      <RecentExports
        rows={exportRows}
        labels={{
          heading: tExports('heading'),
          empty: tExports('empty'),
          caption: tExports('caption'),
          kindLabel: tExports('kindLabel'),
          statusLabel: tExports('statusLabel'),
          requestedLabel: tExports('requestedLabel'),
          download: tExports('download'),
        }}
      />
    </TableContainer>
  );
}
