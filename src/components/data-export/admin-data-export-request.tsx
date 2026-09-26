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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
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
  const labelFor = (value: string): string =>
    value === COMPANY
      ? t('adminScopeCompany')
      : (contacts.find((c) => c.contactId === value)?.label ?? t('adminScopeCompany'));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="admin-export-scope">{t('adminScopeLabel')}</Label>
        <Select value={scope} onValueChange={(v) => setScope(typeof v === 'string' ? v : COMPANY)}>
          <SelectTrigger id="admin-export-scope" className="w-full sm:w-[360px]">
            <TranslatedSelectValue placeholder={t('adminScopeCompany')} translate={labelFor} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={COMPANY}>{t('adminScopeCompany')}</SelectItem>
            {contacts.map((c) => (
              <SelectItem key={c.contactId} value={c.contactId}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {scope === COMPANY ? t('adminScopeCompanyHint') : t('adminScopeContactHint')}
        </p>
      </div>
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
