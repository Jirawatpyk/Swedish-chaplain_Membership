/**
 * F9 US6 (FR-031) — admin on-behalf GDPR data-export section.
 *
 * Server component on the admin member-detail page (admin-only, F9-gated):
 * lets an admin produce a member's GDPR archive on their behalf for a
 * data-subject request + download a ready archive. Reuses the shared
 * `DataExportPanel` with the admin endpoints (`/api/admin/members/[id]/…`).
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { listMemberDataExports, type ExportStatus } from '@/modules/insights';
import type { TenantContext } from '@/modules/tenants';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DataExportPanel,
  type DataExportRow,
} from '@/components/data-export/data-export-panel';

const STATUS_LABEL_KEY: Record<ExportStatus, string> = {
  requested: 'statusPending',
  processing: 'statusPending',
  ready: 'statusReady',
  delivered: 'statusDelivered',
  expired: 'statusExpired',
  failed: 'statusFailed',
};

export async function MemberDataExportSection({
  tenant,
  memberId,
}: {
  readonly tenant: TenantContext;
  readonly memberId: string;
}): Promise<React.JSX.Element> {
  const t = await getTranslations('dataExport');
  const locale = await getLocale();
  const jobs = await listMemberDataExports(tenant, memberId);

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

  const base = `/api/admin/members/${memberId}/data-export`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('adminHeading')}</CardTitle>
        <CardDescription>{t('adminDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataExportPanel
          rows={rows}
          requestUrl={base}
          downloadUrlBase={base}
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
      </CardContent>
    </Card>
  );
}
