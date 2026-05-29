/**
 * F9 US6 (FR-031) — admin on-behalf GDPR data-export section.
 *
 * Server component on the admin member-detail page (admin-only, F9-gated):
 * lets an admin produce a member's GDPR archive on their behalf for a
 * data-subject request + download a ready archive. Reuses the shared
 * `DataExportPanel` with the admin endpoints (`/api/admin/members/[id]/…`).
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { listMemberDataExports } from '@/modules/insights';
import type { TenantContext } from '@/modules/tenants';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataExportPanel } from '@/components/data-export/data-export-panel';
import {
  buildDataExportLabels,
  buildDataExportRows,
} from '@/components/data-export/data-export-view-model';

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
  const base = `/api/admin/members/${memberId}/data-export`;

  return (
    <Card data-testid="member-data-export-card">
      <CardHeader>
        <CardTitle className="text-base">{t('adminHeading')}</CardTitle>
        <CardDescription>{t('adminDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataExportPanel
          rows={buildDataExportRows(jobs, t, locale)}
          requestUrl={base}
          downloadUrlBase={base}
          labels={buildDataExportLabels(t)}
        />
      </CardContent>
    </Card>
  );
}
