/**
 * F9 US6 (T093) — /portal/account/data-export (member GDPR self-service).
 *
 * Members exercise GDPR Art. 20 / PDPA portability: request a downloadable
 * archive of their own data + download a ready archive (single-use, expiring).
 * The member is resolved from the session (`findByLinkedUserId`), never the URL.
 * Gated behind `FEATURE_F9_DASHBOARD` (notFound when dark).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UserX } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { listMemberDataExports, type ExportStatus } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import {
  DataExportPanel,
  type DataExportRow,
} from '@/components/data-export/data-export-panel';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('dataExport');
  return { title: t('title') };
}

const STATUS_LABEL_KEY: Record<ExportStatus, string> = {
  requested: 'statusPending',
  processing: 'statusPending',
  ready: 'statusReady',
  delivered: 'statusDelivered',
  expired: 'statusExpired',
  failed: 'statusFailed',
};

export default async function PortalDataExportPage(): Promise<React.JSX.Element> {
  const { user } = await requireSession('member');
  if (!env.features.f9Dashboard) notFound();

  const t = await getTranslations('dataExport');
  const locale = await getLocale();
  const tenant = resolveTenantFromRequest();

  const memberResult = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        { errKind: errKind(memberResult.error) },
        'portal.data_export.member_lookup_failed',
      );
      throw new Error('Failed to load member for data export');
    }
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <UserX aria-hidden="true" className="size-10 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }

  const jobs = await listMemberDataExports(tenant, memberResult.value.memberId);
  const rows: DataExportRow[] = jobs.map((job) => ({
    jobId: job.id,
    status: job.status,
    statusLabel: t(STATUS_LABEL_KEY[job.status]),
    downloadable: job.status === 'ready' || job.status === 'delivered',
    requestedAt: formatLocalisedDate(job.createdAt.toISOString(), locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  }));

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <p className="max-w-prose text-sm text-muted-foreground">{t('description')}</p>
      <DataExportPanel
        rows={rows}
        labels={{
          requestButton: t('requestButton'),
          requesting: t('requesting'),
          requestedTitle: t('requestedTitle'),
          requestedBody: t('requestedBody'),
          statusHeading: t('statusHeading'),
          empty: t('empty'),
          download: t('download'),
          errorTitle: t('errorTitle'),
          errorBody: t('errorBody'),
          expiresHint: t('expiresHint'),
          colStatus: t('colStatus'),
          colRequested: t('colRequested'),
          caption: t('statusHeading'),
        }}
      />
    </DetailContainer>
  );
}
