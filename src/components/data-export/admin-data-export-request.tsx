'use client';

/**
 * Admin GDPR export — choose whom the archive is prepared for (PDPA §30 /
 * GDPR Art. 15).
 *
 * The whole-company archive (colleagues by name and role only) stays the
 * default. Choosing a contact — including a former one, whose right of access
 * outlives the membership — builds the archive for that person: their own
 * record in full, their own account activity and change requests. The admin
 * route re-checks that the contact belongs to the member.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@jirawatpyk/aura-react';
import { DataExportPanel, type DataExportLabels, type DataExportRow } from './data-export-panel';

const COMPANY = 'company';

export interface AdminExportContactOption {
  readonly contactId: string;
  /** Display label, e.g. "Nils Berg — Accountant (removed)". */
  readonly label: string;
}

export function AdminDataExportRequest({
  contacts,
  rows,
  labels,
  baseUrl,
  initialContactId,
}: {
  readonly contacts: readonly AdminExportContactOption[];
  readonly rows: readonly DataExportRow[];
  readonly labels: DataExportLabels;
  /** `/api/admin/members/[id]/data-export` — request + download base. */
  readonly baseUrl: string;
  /** Pre-selected contact (tests / deep links); defaults to the whole company. */
  readonly initialContactId?: string;
}): React.JSX.Element {
  const t = useTranslations('dataExport');
  const [scope, setScope] = React.useState<string>(initialContactId ?? COMPANY);
  return (
    <div className="space-y-4">
      {/* Spec 122 (data-export is on AURA): a labelled native select, the hint says what the archive holds. */}
      <Select
        id="admin-export-scope"
        label={t('adminScopeLabel')}
        hint={scope === COMPANY ? t('adminScopeCompanyHint') : t('adminScopeContactHint')}
        className="sm:max-w-[360px]"
        value={scope}
        onChange={(e) => setScope(e.target.value || COMPANY)}
        options={[
          { value: COMPANY, label: t('adminScopeCompany') },
          ...contacts.map((c) => ({ value: c.contactId, label: c.label })),
        ]}
      />
      <DataExportPanel
        rows={rows}
        labels={labels}
        requestUrl={baseUrl}
        downloadUrlBase={baseUrl}
        requestBody={scope === COMPANY ? {} : { subjectContactId: scope }}
      />
    </div>
  );
}
