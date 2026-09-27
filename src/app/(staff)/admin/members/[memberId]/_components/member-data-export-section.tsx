/**
 * F9 US6 (FR-031) — admin on-behalf GDPR data-export section.
 *
 * Server component on the admin member-detail page (admin-only, F9-gated):
 * lets an admin produce a member's GDPR archive on their behalf for a
 * data-subject request + download a ready archive. Reuses the shared
 * `DataExportPanel` with the admin endpoints (`/api/admin/members/[id]/…`).
 *
 * PDPA §30 / GDPR Art. 15 — staff choose whom the archive is prepared for: the
 * whole company (colleagues by name and role) or one contact, incl. a former
 * one (`AdminDataExportRequest`); each past archive says whom it was for.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { listMemberDataExports } from '@/modules/insights';
import type { TenantContext } from '@/modules/tenants';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import type { Contact } from '@/modules/members';
import { AdminDataExportRequest } from '@/components/data-export/admin-data-export-request';
import {
  buildDataExportLabels,
  buildDataExportRows,
} from '@/components/data-export/data-export-view-model';

export async function MemberDataExportSection({
  tenant,
  memberId,
  contacts,
}: {
  readonly tenant: TenantContext;
  readonly memberId: string;
  /** The member's contacts, incl. removed ones (a former contact keeps the right of access). */
  readonly contacts: readonly Contact[];
}): Promise<React.JSX.Element> {
  const t = await getTranslations('dataExport');
  const locale = await getLocale();
  const jobs = await listMemberDataExports(tenant, memberId);
  const base = `/api/admin/members/${memberId}/data-export`;
  const nameOf = new Map(
    contacts.map((c) => [String(c.contactId), `${c.firstName} ${c.lastName}`.trim()]),
  );
  const options = contacts.map((c) => {
    const name = nameOf.get(String(c.contactId)) ?? '';
    const role = c.roleTitle ? ` — ${c.roleTitle}` : '';
    const removed = c.removedAt ? ` (${t('adminScopeRemoved')})` : '';
    return { contactId: String(c.contactId), label: `${name}${role}${removed}` };
  });

  return (
    <section aria-labelledby="member-data-export-heading">
      <Card data-testid="member-data-export-card">
        <CardHeader>
          {/* 056 fix #1 — real <h2> so the export section is reachable via
              SR heading navigation under the page <h1>. */}
          <h2
            id="member-data-export-heading"
            className="font-heading text-base font-medium leading-snug"
          >
            {t('adminHeading')}
          </h2>
          <CardDescription>{t('adminDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminDataExportRequest
            contacts={options}
            rows={buildDataExportRows(jobs, t, locale, (job) =>
              job.subjectContactId
                ? t('forContact', { name: nameOf.get(job.subjectContactId) ?? job.subjectContactId })
                : t('forCompany'),
            )}
            baseUrl={base}
            labels={{ ...buildDataExportLabels(t), colFor: t('colFor') }}
          />
        </CardContent>
      </Card>
    </section>
  );
}
