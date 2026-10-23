/**
 * Spec 122 US8c-2 (T854) — the invoice settings page body, rendered by the
 * page and by the no-DB preview route (`/test-fixtures/aura-admin?view=
 * invoice-settings`), board `Admin-invoice-settings` (spec Session
 * 2026-10-03, US8c-2 start):
 *
 *   the page header → the "future invoices only" note (the first-time copy
 *   while no settings exist) → the section tabs → the form: one card per
 *   section, then the save bar.
 *
 * Maintainer, 22 Oct: the US8c-2 side rail moves to the top as in-page tabs
 * (the member page's `SectionLinks`), so the form is one column aligned to
 * the start like the other forms. The tabs carry short labels (`tabs.*`), the
 * cards keep the full names, and on a phone the tabs scroll away with the
 * page rather than stick.
 *
 * The legacy wrapper card and its "Invoice configuration" title go: the board
 * has none, and the note keeps its two descriptions.
 */
import { getTranslations } from 'next-intl/server';
import { Alert } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { SectionLinks } from '@/components/layout/section-links';
import { INVOICE_SETTINGS_SECTION_IDS } from '@/components/invoices/invoice-settings/section-ids';
import {
  InvoiceSettingsForm,
  type InvoiceSettingsFormInitialValues,
} from '@/components/invoices/invoice-settings-form';

export interface InvoiceSettingsViewProps {
  readonly initialValues: InvoiceSettingsFormInitialValues;
  /** Server-derived write authorization — never a role literal (016 review I13). */
  readonly canEdit: boolean;
  /** False on the first-ever load (no settings row yet). */
  readonly exists: boolean;
}

export async function renderInvoiceSettingsView({ initialValues, canEdit, exists }: InvoiceSettingsViewProps) {
  const t = await getTranslations('admin.invoiceSettings');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Alert tone="info" role="note">
        {exists ? t('card.description') : t('card.firstTimeDescription')}
      </Alert>
      <SectionLinks
        label={t('nav.label')}
        stickyFrom="sm"
        links={INVOICE_SETTINGS_SECTION_IDS.map((id) => ({ id, label: t(`tabs.${id}`) }))}
      />
      <InvoiceSettingsForm initialValues={initialValues} canEdit={canEdit} exists={exists} />
    </>
  );
}
