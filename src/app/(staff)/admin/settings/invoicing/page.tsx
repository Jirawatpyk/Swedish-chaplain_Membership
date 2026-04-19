/**
 * R7-B2 — /admin/settings/invoicing page (F4 US4 / FR-009 / FR-010).
 *
 * Server component — loads current settings via the same
 * `TenantSettingsRepo.getForIssue` port that `issue-invoice` uses, so
 * the UI renders a snapshot identical to what the API would accept.
 * On first-ever load (row missing) we render the form with empty
 * defaults — the admin fills it, submits, and the PATCH upserts the
 * row for the first time.
 *
 * RBAC: admin + manager may reach the page; the form disables inputs
 * + hides save for manager. Real security boundary is inside the
 * PATCH route via `requireAdminContext`.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { headers } from 'next/headers';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { InvoiceSettingsForm } from '@/components/invoices/invoice-settings-form';
import type { InvoiceSettingsFormInitialValues } from '@/components/invoices/invoice-settings-form';
// Direct infra import — same escape-hatch pattern used by
// /admin/users/page.tsx when the Application layer has nothing to
// add over the repo's read shape. We only read `getForIssue` here,
// which IS the public port.
// eslint-disable-next-line no-restricted-imports
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Invoice settings · SweCham' };
}

const DEFAULTS: InvoiceSettingsFormInitialValues = {
  legal_name_th: '',
  legal_name_en: '',
  tax_id: '',
  registered_address_th: '',
  registered_address_en: '',
  vat_percent: '7.00',
  registration_fee_baht: '0',
  invoice_number_prefix: 'INV',
  credit_note_number_prefix: 'CN',
  receipt_numbering_mode: 'combined',
  receipt_number_prefix: null,
  fiscal_year_start_month: 1,
  default_net_days: 30,
  pro_rate_policy: 'monthly',
  auto_email_enabled: true,
  logo_blob_key: null,
};

export default async function InvoiceSettingsPage() {
  const { user: currentUser } = await requireSession('staff');
  const t = await getTranslations('admin.invoiceSettings');

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const existing = await drizzleTenantSettingsRepo.getForIssue(tenantCtx.slug);

  const initialValues: InvoiceSettingsFormInitialValues = existing
    ? {
        legal_name_th: existing.identity.legal_name_th,
        legal_name_en: existing.identity.legal_name_en,
        tax_id: existing.identity.tax_id,
        registered_address_th: existing.identity.address_th,
        registered_address_en: existing.identity.address_en,
        // Domain VatRate.raw is "0.0700" — UI shows "7.00".
        vat_percent: (Number(existing.vatRate.raw) * 100).toFixed(2),
        registration_fee_baht: (
          Number(existing.registrationFeeSatang) / 100
        ).toFixed(2),
        invoice_number_prefix: existing.invoiceNumberPrefix,
        credit_note_number_prefix: existing.creditNoteNumberPrefix,
        receipt_numbering_mode: existing.receiptNumberingMode,
        receipt_number_prefix: existing.receiptNumberPrefix ?? null,
        fiscal_year_start_month: existing.fiscalYearStartMonth,
        default_net_days: existing.defaultNetDays,
        pro_rate_policy: existing.proRatePolicy,
        auto_email_enabled: existing.autoEmailEnabled,
        logo_blob_key: existing.identity.logo_blob_key ?? null,
      }
    : DEFAULTS;

  return (
    <FormContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<Badge variant="secondary">{currentUser.role}</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('card.title')}</CardTitle>
          <CardDescription>
            {existing ? t('card.description') : t('card.firstTimeDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InvoiceSettingsForm
            initialValues={initialValues}
            currentUserRole={currentUser.role}
            exists={existing !== null}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
