/**
 * Spec 122 US8c-2 (T854) — the invoice settings page body, rendered by the
 * page and by the no-DB preview route (`/test-fixtures/aura-admin?view=
 * invoice-settings`), board `Admin-invoice-settings` (spec Session
 * 2026-10-03, US8c-2 start):
 *
 *   the page header → the "future invoices only" note (the first-time copy
 *   while no settings exist) → the form: the section rail and one card per
 *   section, then the save bar.
 *
 * The legacy wrapper card and its "Invoice configuration" title go: the board
 * has none, and the note keeps its two descriptions.
 */
import { getTranslations } from 'next-intl/server';
import { Alert } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
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
      <InvoiceSettingsForm initialValues={initialValues} canEdit={canEdit} exists={exists} />
    </>
  );
}
